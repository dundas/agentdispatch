/**
 * Inbox Service
 * Handles message delivery, leasing, and acknowledgment
 */

import { v4 as uuid } from 'uuid';
import { storage } from '../storage/index.js';
import { verifySignature, fromBase64, validateTimestamp } from '../utils/crypto.js';
import { agentService } from './agent.service.js';
import { webhookService } from './webhook.service.js';

export class InboxService {
  /**
   * Send message to agent's inbox
   * @param {Object} envelope - ADMP message envelope
   * @param {Object} options - Send options
   * @returns {Object} Message record
   */
  async send(envelope, options = {}) {
    // Validate envelope
    this.validateEnvelope(envelope);

    // Extract recipient agent ID
    const toAgentId = envelope.to;

    // Check recipient exists
    const recipient = await storage.getAgent(toAgentId);
    if (!recipient) {
      throw new Error(`Recipient agent ${toAgentId} not found`);
    }

    if (recipient.trusted_agents && recipient.trusted_agents.length > 0 && !recipient.trusted_agents.includes(envelope.from)) {
      throw new Error(`Sender ${envelope.from} is not trusted by recipient ${toAgentId}`);
    }

    // Verify signature if sender public key is available
    if (options.verify_signature !== false) {
      const sender = await storage.getAgent(envelope.from);
      if (sender) {
        const publicKey = fromBase64(sender.public_key);
        const valid = verifySignature(envelope, publicKey);
        if (!valid) {
          throw new Error('Invalid message signature');
        }
      }
    }

    // Create message record
    const message = {
      id: envelope.id || uuid(),
      to_agent_id: toAgentId,
      from_agent_id: envelope.from,
      envelope,
      status: 'queued',
      ttl_sec: envelope.ttl_sec || parseInt(process.env.MESSAGE_TTL_SEC) || 86400,
      lease_until: null,
      attempts: 0
    };

    const created = await storage.createMessage(message);

    // Try webhook delivery if configured (don't block on it)
    if (recipient.webhook_url) {
      // Fire and forget - webhook delivery happens in background
      this.deliverViaWebhook(recipient, created).catch(err => {
        // Webhook failed, message stays in queue for polling
        console.error(`Webhook delivery failed for ${created.id}:`, err.message);
      });
    }

    return created;
  }

  /**
   * Deliver message via webhook (async, non-blocking)
   * @param {Object} agent - Recipient agent
   * @param {Object} message - Message to deliver
   */
  async deliverViaWebhook(agent, message) {
    const result = await webhookService.deliverWithRetry(agent, message);

    if (result.success) {
      // Webhook delivered successfully - optionally auto-lease or mark as delivered
      // For now, keep it queued so agent can still pull if needed
      await storage.updateMessage(message.id, {
        webhook_delivered: true,
        webhook_delivered_at: Date.now()
      });
    } else if (result.will_retry) {
      // Schedule retry
      const delay = Math.pow(2, result.attempts) * 1000;
      webhookService.scheduleRetry(agent, message, delay);
    }

    return result;
  }

  /**
   * Pull message from inbox (with lease)
   * @param {string} agentId
   * @param {Object} options
   * @param {number} options.visibility_timeout - Lease duration in seconds
   * @returns {Object|null} Message or null if inbox empty
   */
  async pull(agentId, options = {}) {
    const visibility_timeout = options.visibility_timeout || 60;

    // Get available messages
    const messages = await storage.getInbox(agentId, 'queued');

    if (messages.length === 0) {
      return null;
    }

    // Get oldest message (FIFO)
    const message = messages.sort((a, b) => a.created_at - b.created_at)[0];

    // Lease the message
    const leaseUntil = Date.now() + (visibility_timeout * 1000);

    const leased = await storage.updateMessage(message.id, {
      status: 'leased',
      lease_until: leaseUntil,
      attempts: message.attempts + 1
    });

    return leased;
  }

  /**
   * Acknowledge message (removes from inbox)
   * @param {string} agentId
   * @param {string} messageId
   * @param {Object} result - Processing result
   * @returns {boolean}
   */
  async ack(agentId, messageId, result = {}) {
    const message = await storage.getMessage(messageId);

    if (!message) {
      throw new Error(`Message ${messageId} not found`);
    }

    if (message.to_agent_id !== agentId) {
      throw new Error('Message does not belong to this agent');
    }

    if (message.status !== 'leased') {
      throw new Error(`Message must be leased before ack (current status: ${message.status})`);
    }

    // Mark as acked
    await storage.updateMessage(messageId, {
      status: 'acked',
      result,
      acked_at: Date.now()
    });

    return true;
  }

  /**
   * Negative acknowledge (requeue or extend lease)
   * @param {string} agentId
   * @param {string} messageId
   * @param {Object} options
   * @param {number} options.extend_sec - Extend lease by seconds
   * @param {boolean} options.requeue - Requeue immediately
   * @returns {Object} Updated message
   */
  async nack(agentId, messageId, options = {}) {
    const message = await storage.getMessage(messageId);

    if (!message) {
      throw new Error(`Message ${messageId} not found`);
    }

    if (message.to_agent_id !== agentId) {
      throw new Error('Message does not belong to this agent');
    }

    // Extend lease
    if (options.extend_sec) {
      const base = message.lease_until && message.lease_until > Date.now()
        ? message.lease_until
        : Date.now();
      const newLeaseUntil = base + (options.extend_sec * 1000);
      return await storage.updateMessage(messageId, {
        lease_until: newLeaseUntil
      });
    }

    // Requeue
    return await storage.updateMessage(messageId, {
      status: 'queued',
      lease_until: null
    });
  }

  /**
   * Reply to a message
   * @param {string} agentId - Sender agent ID
   * @param {string} originalMessageId - Original message ID
   * @param {Object} envelope - Reply envelope
   * @returns {Object} Reply message record
   */
  async reply(agentId, originalMessageId, envelope) {
    const original = await storage.getMessage(originalMessageId);

    if (!original) {
      throw new Error(`Original message ${originalMessageId} not found`);
    }

    // Create reply envelope with correlation
    const replyEnvelope = {
      ...envelope,
      from: agentId,
      to: original.from_agent_id,
      correlation_id: originalMessageId,
      timestamp: new Date().toISOString()
    };

    return await this.send(replyEnvelope);
  }

  /**
   * Get message status
   * @param {string} messageId
   * @returns {Object} Status info
   */
  async getStatus(messageId) {
    const message = await storage.getMessage(messageId);

    if (!message) {
      throw new Error(`Message ${messageId} not found`);
    }

    return {
      id: message.id,
      status: message.status,
      created_at: message.created_at,
      updated_at: message.updated_at,
      attempts: message.attempts,
      lease_until: message.lease_until,
      acked_at: message.acked_at
    };
  }

  /**
   * Get inbox stats for agent
   * @param {string} agentId
   * @returns {Object} Inbox statistics
   */
  async getStats(agentId) {
    return await storage.getInboxStats(agentId);
  }

  /**
   * Reclaim expired leases
   * @returns {number} Number of messages reclaimed
   */
  async reclaimExpiredLeases() {
    return await storage.expireLeases();
  }

  /**
   * Validate ADMP message envelope
   * @param {Object} envelope
   * @throws {Error} If invalid
   */
  validateEnvelope(envelope) {
    const required = ['version', 'from', 'to', 'subject', 'timestamp'];

    for (const field of required) {
      if (!envelope[field]) {
        throw new Error(`Missing required field: ${field}`);
      }
    }

    if (envelope.version !== '1.0') {
      throw new Error(`Unsupported ADMP version: ${envelope.version}`);
    }

    // Validate agent URIs
    if (!envelope.from.startsWith('agent://')) {
      throw new Error('Invalid from URI (must start with agent://)');
    }

    if (!envelope.to.startsWith('agent://')) {
      throw new Error('Invalid to URI (must start with agent://)');
    }

    // Validate timestamp
    const timestamp = new Date(envelope.timestamp);
    if (isNaN(timestamp.getTime())) {
      throw new Error('Invalid timestamp format');
    }

    if (!validateTimestamp(envelope.timestamp)) {
      throw new Error('Invalid timestamp (outside allowed window)');
    }

    return true;
  }
}

export const inboxService = new InboxService();
