/**
 * Inbox Service
 * Handles message delivery, leasing, and acknowledgment
 */

import { v4 as uuid } from 'uuid';
import { storage } from '../storage/index.js';
import { verifySignature, fromBase64, validateTimestamp, parseTTL } from '../utils/crypto.js';
import { agentService } from './agent.service.js';
import { webhookService } from './webhook.service.js';

// Safe agent identifier patterns — module-level constants so they are compiled once,
// not recreated on every message send.
const SAFE_CHARS = /^[a-zA-Z0-9._:-]+$/;
// VALID_AGENT_URI is NOT a subset of SAFE_CHARS — agent://foo contains slashes which
// are not in the allowlist. It is the only branch that accepts legacy agent:// URIs.
// Do not delete it assuming it is a no-op; doing so would silently break backward
// compatibility for pre-PR#16 senders.
const VALID_AGENT_URI = /^agent:\/\/[a-zA-Z0-9._:-]+$/;

/**
 * Return true if `id` is a syntactically valid agent identifier for use in
 * message envelopes. Accepts bare agent IDs, legacy agent:// URIs (backward-compat
 * for pre-PR#16 senders), and did:seed: DIDs. Rejects injection characters and
 * oversized strings.
 *
 * NOTE: validation here is intentionally more permissive than registration.
 * For example, `agent:bare` (single colon, no slashes) passes SAFE_CHARS and
 * is accepted in envelopes but would be blocked at register() by the reserved-prefix
 * guard. This is by design — the envelope layer cannot know whether a given ID was
 * ever registered, so it only rejects clearly-unsafe inputs.
 *
 * DID:web agents: when sending messages, federated agents use their W3C canonical
 * DID form in `from` (e.g. `did:web:domain.com:users:alice`, colon-separated).
 * This passes SAFE_CHARS. Their stored agent_id uses slashes (`did-web:domain.com/users/alice`)
 * but that stored form is not used in envelope fields.
 *
 * A valid `id` does NOT imply the agent exists in storage or that the sender is
 * trusted. Signature verification is required for that.
 */
function isValidAgentId(id) {
  if (!id || id.length > 255) return false;
  return VALID_AGENT_URI.test(id) || SAFE_CHARS.test(id);
}

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

    // Resolve recipient — supports both agent:// IDs and did:seed: URIs
    let recipient;
    if (envelope.to.startsWith('did:seed:')) {
      recipient = await storage.getAgentByDid(envelope.to);
      if (!recipient) {
        throw new Error(`Recipient DID ${envelope.to} not found`);
      }
    } else {
      recipient = await storage.getAgent(envelope.to);
      if (!recipient) {
        throw new Error(`Recipient agent ${envelope.to} not found`);
      }
    }

    const toAgentId = recipient.agent_id;

    // Check trust list using both agent_id and DID of sender
    if (recipient.trusted_agents && recipient.trusted_agents.length > 0) {
      const senderAllowed = recipient.trusted_agents.includes(envelope.from);
      if (!senderAllowed) {
        throw new Error(`Sender ${envelope.from} is not trusted by recipient ${toAgentId}`);
      }
    }

    // Resolve sender for signature verification — supports both agent:// and did:seed:
    if (options.verify_signature !== false) {
      let sender;
      if (envelope.from.startsWith('did:seed:')) {
        sender = await storage.getAgentByDid(envelope.from);
      } else {
        sender = await storage.getAgent(envelope.from);
      }
      if (sender) {
        // Try all active keys, including those within their rotation window
        const activeKeys = sender.public_keys
          ? sender.public_keys.filter(k => k.active || (k.deactivate_at && k.deactivate_at > Date.now()))
          : [{ public_key: sender.public_key }];

        let valid = false;
        for (const keyEntry of activeKeys) {
          const pubKey = fromBase64(keyEntry.public_key);
          if (verifySignature(envelope, pubKey)) {
            valid = true;
            break;
          }
        }
        if (!valid) {
          throw new Error('Invalid message signature');
        }
      } else if (recipient.trusted_agents?.includes(envelope.from)) {
        // Sender claims a trusted identity but has no registered key material.
        // Reject to prevent impersonation when a trusted ID is missing from storage.
        throw new Error(`Sender ${envelope.from} is not registered — signature required for trust-list delivery`);
      }
    } else if (recipient.trusted_agents?.includes(envelope.from)) {
      // Sender is named in the trust list but is not registered — cannot verify identity.
      // Reject rather than silently skip: an unregistered sender cannot prove they are
      // the trusted agent they claim to be (deregistered agent impersonation attack).
      throw new Error(`Sender ${envelope.from} is not registered — signature required for trust-list delivery`);
    }

    // Parse ephemeral options (top-level on send body, not inside envelope)
    // Note: `ephemeral` controls purge-on-ack behavior; `ttl` controls time-based
    // auto-purge. Both are independent of envelope.ttl_sec which governs message
    // expiration (queued → expired status). The ephemeral ttl purges the body but
    // preserves the delivery log metadata.
    const ephemeral = options.ephemeral || false;
    let ephemeralTTLSec = null;
    if (options.ttl) {
      ephemeralTTLSec = parseTTL(options.ttl);
      if (ephemeralTTLSec === null) {
        throw new Error(`Invalid TTL value: ${options.ttl}`);
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
      attempts: 0,
      ephemeral,
      ephemeral_ttl_sec: ephemeralTTLSec,
      expires_at: ephemeralTTLSec ? Date.now() + (ephemeralTTLSec * 1000) : null
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
    const now = Date.now();
    let messages = await storage.getInbox(agentId, 'queued');

    // Filter out messages past their ephemeral TTL (security: don't serve expired secrets)
    messages = messages.filter(m => !m.expires_at || m.expires_at > now);

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

    // If ephemeral, ack and purge body in a single update (no extra fetch)
    if (message.ephemeral) {
      const purgedEnvelope = { ...message.envelope };
      delete purgedEnvelope.body;

      await storage.updateMessage(messageId, {
        status: 'purged',
        result,
        acked_at: Date.now(),
        envelope: purgedEnvelope,
        purged_at: Date.now(),
        purge_reason: 'acked'
      });
    } else {
      await storage.updateMessage(messageId, {
        status: 'acked',
        result,
        acked_at: Date.now()
      });
    }

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
   * Purge message body but preserve metadata (delivery log)
   * @param {string} messageId
   * @param {string} reason - Purge reason ('acked' | 'ttl_expired')
   */
  async purgeMessageBody(messageId, reason = 'acked') {
    const message = await storage.getMessage(messageId);
    if (!message) return;

    // Strip body from envelope but keep metadata
    const purgedEnvelope = { ...message.envelope };
    delete purgedEnvelope.body;

    await storage.updateMessage(messageId, {
      status: 'purged',
      envelope: purgedEnvelope,
      purged_at: Date.now(),
      purge_reason: reason
    });
  }

  /**
   * Purge ephemeral messages that have exceeded their TTL
   * @returns {number} Number of messages purged
   */
  async purgeExpiredEphemeralMessages() {
    return await storage.purgeExpiredEphemeralMessages();
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

    // Purged messages return limited info
    if (message.status === 'purged') {
      const err = new Error('MESSAGE_EXPIRED');
      err.code = 'MESSAGE_EXPIRED';
      err.statusCode = 410;
      err.details = {
        id: message.id,
        from: message.from_agent_id,
        to: message.to_agent_id,
        subject: message.envelope?.subject,
        status: 'purged',
        purged_at: message.purged_at,
        purge_reason: message.purge_reason,
        body: null
      };
      throw err;
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

    // Validate agent identifiers using module-level isValidAgentId().
    // NOTE: `from` is used for display and signature verification only. When the sender
    // is not found in storage, signature verification is skipped and `from` is UNTRUSTED.
    // Callers must not use `from` for authorization without first verifying the signature.
    // agent:// URIs are still accepted in envelopes for backward compatibility with senders
    // registered before the bare-ID format was introduced (PR #16).
    if (!isValidAgentId(envelope.from)) {
      throw new Error('Invalid from field (must be agent:// URI, did:seed: DID, or valid agent ID)');
    }

    if (!isValidAgentId(envelope.to)) {
      throw new Error('Invalid to field (must be agent:// URI, did:seed: DID, or valid agent ID)');
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
