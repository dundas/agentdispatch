/**
 * Webhook Service
 * Handles message delivery via HTTP webhooks
 */

import { signMessage } from '../utils/crypto.js';
import crypto from 'crypto';
import pino from 'pino';

const logger = pino();

export class WebhookService {
  constructor() {
    this.deliveryAttempts = new Map(); // messageId -> attempts
  }

  /**
   * Deliver message to agent's webhook
   * @param {Object} agent - Agent with webhook_url
   * @param {Object} message - Message to deliver
   * @returns {Object} Delivery result
   */
  async deliver(agent, message) {
    if (!agent.webhook_url) {
      return {
        success: false,
        error: 'No webhook URL configured'
      };
    }

    const messageId = message.id;
    const attempts = this.deliveryAttempts.get(messageId) || 0;
    const maxAttempts = 3;

    if (attempts >= maxAttempts) {
      logger.warn({ messageId, attempts }, 'Max webhook delivery attempts reached');
      return {
        success: false,
        error: 'Max delivery attempts exceeded',
        attempts
      };
    }

    try {
      // Prepare webhook payload
      const payload = {
        event: 'message.received',
        message_id: message.id,
        envelope: message.envelope,
        delivered_at: Date.now()
      };

      // Sign webhook payload if agent has secret key stored
      if (agent.webhook_secret) {
        payload.signature = this.signWebhook(payload, agent.webhook_secret);
      }

      logger.debug({
        agent_id: agent.agent_id,
        webhook_url: agent.webhook_url,
        message_id: messageId
      }, 'Delivering message via webhook');

      // Send POST request to webhook
      const response = await fetch(agent.webhook_url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': 'ADMP-Server/1.0',
          'X-ADMP-Event': 'message.received',
          'X-ADMP-Message-ID': message.id,
          'X-ADMP-Delivery-Attempt': (attempts + 1).toString()
        },
        body: JSON.stringify(payload),
        timeout: 10000 // 10 second timeout
      });

      if (response.ok) {
        logger.info({
          agent_id: agent.agent_id,
          message_id: messageId,
          status: response.status
        }, 'Webhook delivery successful');

        this.deliveryAttempts.delete(messageId);

        return {
          success: true,
          status: response.status,
          attempts: attempts + 1
        };
      }

      // Non-2xx response - will retry
      logger.warn({
        agent_id: agent.agent_id,
        message_id: messageId,
        status: response.status,
        attempts: attempts + 1
      }, 'Webhook delivery failed with non-2xx status');

      this.deliveryAttempts.set(messageId, attempts + 1);

      return {
        success: false,
        error: `HTTP ${response.status}`,
        status: response.status,
        attempts: attempts + 1,
        will_retry: attempts + 1 < maxAttempts
      };

    } catch (error) {
      logger.error({
        agent_id: agent.agent_id,
        message_id: messageId,
        error: error.message,
        attempts: attempts + 1
      }, 'Webhook delivery error');

      this.deliveryAttempts.set(messageId, attempts + 1);

      return {
        success: false,
        error: error.message,
        attempts: attempts + 1,
        will_retry: attempts + 1 < maxAttempts
      };
    }
  }

  /**
   * Deliver message with retry logic
   * Uses exponential backoff: 1s, 2s, 4s
   * @param {Object} agent
   * @param {Object} message
   * @returns {Promise<Object>}
   */
  async deliverWithRetry(agent, message) {
    const messageId = message.id;
    const attempts = this.deliveryAttempts.get(messageId) || 0;

    // Calculate backoff delay (exponential: 1s, 2s, 4s)
    if (attempts > 0) {
      const delay = Math.pow(2, attempts - 1) * 1000;
      logger.debug({ messageId, attempts, delay }, 'Waiting before retry');
      await new Promise(resolve => setTimeout(resolve, delay));
    }

    return await this.deliver(agent, message);
  }

  /**
   * Sign webhook payload
   * @param {Object} payload
   * @param {string} secret - Webhook secret
   * @returns {string} HMAC signature
   */
  signWebhook(payload, secret) {
    const hmac = crypto.createHmac('sha256', secret);
    hmac.update(JSON.stringify(payload));
    return hmac.digest('hex');
  }

  /**
   * Verify webhook signature
   * @param {Object} payload
   * @param {string} signature - Received signature
   * @param {string} secret - Webhook secret
   * @returns {boolean}
   */
  verifyWebhookSignature(payload, signature, secret) {
    const expected = this.signWebhook(payload, secret);
    return signature === expected;
  }

  /**
   * Schedule retry for failed delivery
   * @param {Object} agent
   * @param {Object} message
   * @param {number} delayMs - Delay before retry
   */
  scheduleRetry(agent, message, delayMs) {
    setTimeout(async () => {
      logger.debug({
        agent_id: agent.agent_id,
        message_id: message.id
      }, 'Retrying webhook delivery');

      await this.deliverWithRetry(agent, message);
    }, delayMs);
  }

  /**
   * Clear delivery attempts for a message
   * @param {string} messageId
   */
  clearAttempts(messageId) {
    this.deliveryAttempts.delete(messageId);
  }

  /**
   * Get delivery stats
   * @returns {Object}
   */
  getStats() {
    return {
      pending_retries: this.deliveryAttempts.size,
      messages: Array.from(this.deliveryAttempts.entries()).map(([id, attempts]) => ({
        message_id: id,
        attempts
      }))
    };
  }
}

export const webhookService = new WebhookService();
