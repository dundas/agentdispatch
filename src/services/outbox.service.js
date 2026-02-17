/**
 * Outbox Service
 * Handles outbound email delivery via Mailgun
 */

import crypto from 'crypto';
import { v4 as uuidv4 } from 'uuid';
import pino from 'pino';
import { storage } from '../storage/index.js';

const logger = pino();

const MAX_ATTEMPTS = 3;

// Read env vars dynamically so they can be overridden in tests
function getMailgunApiUrl() {
  return process.env.MAILGUN_API_URL || 'https://api.mailgun.net/v3';
}

function getMailgunApiKey() {
  return process.env.MAILGUN_API_KEY || '';
}

function getMailgunWebhookSigningKey() {
  return process.env.MAILGUN_WEBHOOK_SIGNING_KEY || '';
}

export class OutboxService {
  constructor() {
    this.deliveryAttempts = new Map(); // outboxMessageId -> attempts
  }

  // ============ MAILGUN HTTP HELPERS ============

  _authHeader() {
    return 'Basic ' + Buffer.from(`api:${getMailgunApiKey()}`).toString('base64');
  }

  async _mailgunRequest(path, { method = 'GET', body, formData } = {}) {
    const url = `${getMailgunApiUrl()}${path}`;
    const headers = {
      'Authorization': this._authHeader()
    };

    const init = { method, headers };

    if (formData) {
      init.body = formData;
    } else if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(body);
    }

    const res = await fetch(url, init);
    const text = await res.text();

    let json = null;
    try { json = JSON.parse(text); } catch { /* not json */ }

    return { status: res.status, ok: res.ok, json, text };
  }

  // ============ DOMAIN MANAGEMENT ============

  async addDomain(agentId, domain) {
    if (!getMailgunApiKey()) {
      throw new Error('MAILGUN_API_KEY is not configured');
    }

    const agent = await storage.getAgent(agentId);
    if (!agent) throw new Error(`Agent ${agentId} not found`);

    // Check if agent already has a domain
    const existing = await storage.getDomainConfig(agentId);
    if (existing) {
      throw new Error(`Agent ${agentId} already has domain ${existing.domain} configured. Remove it first.`);
    }

    // Add domain to Mailgun
    const form = new FormData();
    form.append('name', domain);

    const { ok, json, status } = await this._mailgunRequest('/domains', {
      method: 'POST',
      formData: form
    });

    if (!ok && status !== 409) {
      // 409 = domain already exists in Mailgun (may be shared across agents)
      throw new Error(`Failed to add domain to Mailgun: ${json?.message || `HTTP ${status}`}`);
    }

    // Fetch DNS records from Mailgun
    const dnsRecords = await this._getDomainDnsRecords(domain);

    // Store domain config
    const config = {
      domain,
      status: 'pending',
      dns_records: dnsRecords,
      mailgun_state: json?.domain?.state || 'unverified'
    };

    const stored = await storage.setDomainConfig(agentId, config);

    logger.info({ agent_id: agentId, domain }, 'Domain configured for outbox');

    return stored;
  }

  async _getDomainDnsRecords(domain) {
    const { ok, json } = await this._mailgunRequest(`/domains/${encodeURIComponent(domain)}`);

    if (!ok) return [];

    const records = [];

    // Sending records (SPF, DKIM)
    if (json?.sending_dns_records) {
      for (const r of json.sending_dns_records) {
        records.push({
          type: r.record_type,
          name: r.name,
          value: r.value,
          valid: r.valid
        });
      }
    }

    // Receiving records (MX) — not needed for outbox-only but included for completeness
    if (json?.receiving_dns_records) {
      for (const r of json.receiving_dns_records) {
        records.push({
          type: r.record_type,
          name: r.name,
          value: r.value,
          priority: r.priority,
          valid: r.valid
        });
      }
    }

    return records;
  }

  async getDomain(agentId) {
    return storage.getDomainConfig(agentId);
  }

  async verifyDomain(agentId) {
    const config = await storage.getDomainConfig(agentId);
    if (!config) throw new Error(`No domain configured for agent ${agentId}`);

    if (!getMailgunApiKey()) {
      throw new Error('MAILGUN_API_KEY is not configured');
    }

    // Ask Mailgun to verify DNS records
    const { ok, json } = await this._mailgunRequest(
      `/domains/${encodeURIComponent(config.domain)}/verify`,
      { method: 'PUT' }
    );

    if (!ok) {
      throw new Error(`Mailgun verification request failed: ${json?.message || 'unknown error'}`);
    }

    // Refresh DNS record status
    const dnsRecords = await this._getDomainDnsRecords(config.domain);

    const mailgunState = json?.domain?.state || config.mailgun_state;
    const verified = mailgunState === 'active';

    const updated = await storage.setDomainConfig(agentId, {
      ...config,
      status: verified ? 'verified' : 'pending',
      mailgun_state: mailgunState,
      dns_records: dnsRecords,
      verified_at: verified ? Date.now() : config.verified_at
    });

    logger.info({
      agent_id: agentId,
      domain: config.domain,
      verified
    }, 'Domain verification checked');

    return updated;
  }

  async removeDomain(agentId) {
    const config = await storage.getDomainConfig(agentId);
    if (!config) throw new Error(`No domain configured for agent ${agentId}`);

    // Note: We do NOT delete from Mailgun — domain may be shared or reused.
    // Only remove local config binding.
    await storage.deleteDomainConfig(agentId);

    logger.info({ agent_id: agentId, domain: config.domain }, 'Domain config removed');
    return true;
  }

  // ============ SENDING ============

  async send(agentId, { to, subject, body, html, from_name }) {
    const agent = await storage.getAgent(agentId);
    if (!agent) throw new Error(`Agent ${agentId} not found`);

    const domainConfig = await storage.getDomainConfig(agentId);
    if (!domainConfig) {
      throw new Error(`Agent ${agentId} has no outbox domain configured`);
    }
    if (domainConfig.status !== 'verified') {
      throw new Error(`Domain ${domainConfig.domain} is not verified (status: ${domainConfig.status})`);
    }

    if (!getMailgunApiKey()) {
      throw new Error('MAILGUN_API_KEY is not configured');
    }

    // Construct from address
    const fromLocal = agentId.replace(/[^a-zA-Z0-9._-]/g, '_');
    const displayName = from_name || agentId;
    const fromAddress = `${displayName} <${fromLocal}@${domainConfig.domain}>`;

    // Create outbox message record
    const outboxMessage = {
      id: uuidv4(),
      agent_id: agentId,
      to,
      from: fromAddress,
      subject,
      body: body || '',
      html: html || null,
      status: 'queued',
      mailgun_id: null,
      attempts: 0,
      max_attempts: MAX_ATTEMPTS,
      error: null,
      sent_at: null,
      delivered_at: null
    };

    const stored = await storage.createOutboxMessage(outboxMessage);

    // Attempt send (async, don't block response)
    this._attemptSend(stored, domainConfig.domain).catch(err => {
      logger.error({ outbox_id: stored.id, error: err.message }, 'Outbox send failed');
    });

    return stored;
  }

  async _attemptSend(outboxMessage, domain) {
    const attempts = this.deliveryAttempts.get(outboxMessage.id) || 0;

    if (attempts >= MAX_ATTEMPTS) {
      await storage.updateOutboxMessage(outboxMessage.id, {
        status: 'failed',
        error: 'Max delivery attempts exceeded'
      });
      this.deliveryAttempts.delete(outboxMessage.id);
      return;
    }

    // Exponential backoff for retries
    if (attempts > 0) {
      const delay = Math.pow(2, attempts - 1) * 1000;
      await new Promise(resolve => setTimeout(resolve, delay));
    }

    try {
      const form = new FormData();
      form.append('from', outboxMessage.from);
      form.append('to', outboxMessage.to);
      form.append('subject', outboxMessage.subject);
      form.append('text', outboxMessage.body);
      if (outboxMessage.html) {
        form.append('html', outboxMessage.html);
      }

      const { ok, json, status } = await this._mailgunRequest(
        `/${encodeURIComponent(domain)}/messages`,
        { method: 'POST', formData: form }
      );

      this.deliveryAttempts.set(outboxMessage.id, attempts + 1);

      if (ok) {
        await storage.updateOutboxMessage(outboxMessage.id, {
          status: 'sent',
          mailgun_id: json?.id || null,
          attempts: attempts + 1,
          sent_at: Date.now(),
          error: null
        });

        this.deliveryAttempts.delete(outboxMessage.id);

        logger.info({
          outbox_id: outboxMessage.id,
          mailgun_id: json?.id,
          to: outboxMessage.to
        }, 'Email sent via Mailgun');

        return;
      }

      // Send failed — schedule retry if under limit
      const error = `Mailgun HTTP ${status}: ${json?.message || 'unknown'}`;
      await storage.updateOutboxMessage(outboxMessage.id, {
        attempts: attempts + 1,
        error
      });

      if (attempts + 1 < MAX_ATTEMPTS) {
        this._scheduleRetry(outboxMessage, domain, Math.pow(2, attempts) * 1000);
      } else {
        await storage.updateOutboxMessage(outboxMessage.id, { status: 'failed' });
        this.deliveryAttempts.delete(outboxMessage.id);
      }

    } catch (err) {
      this.deliveryAttempts.set(outboxMessage.id, attempts + 1);

      await storage.updateOutboxMessage(outboxMessage.id, {
        attempts: attempts + 1,
        error: err.message
      });

      if (attempts + 1 < MAX_ATTEMPTS) {
        this._scheduleRetry(outboxMessage, domain, Math.pow(2, attempts) * 1000);
      } else {
        await storage.updateOutboxMessage(outboxMessage.id, { status: 'failed' });
        this.deliveryAttempts.delete(outboxMessage.id);
      }
    }
  }

  _scheduleRetry(outboxMessage, domain, delayMs) {
    setTimeout(async () => {
      logger.debug({ outbox_id: outboxMessage.id }, 'Retrying outbox send');
      await this._attemptSend(outboxMessage, domain);
    }, delayMs);
  }

  // ============ MAILGUN WEBHOOKS ============

  async handleWebhook(event) {
    if (!event?.event_data) return;

    const mailgunId = event.event_data?.message?.headers?.['message-id'];
    if (!mailgunId) return;

    const eventType = event.event_data?.event;

    logger.info({ event: eventType, mailgun_id: mailgunId }, 'Mailgun webhook received');

    // Find outbox message by mailgun_id via storage scan
    // In production with persistent storage, this would be an indexed query
    const outboxMessage = await this._findOutboxMessageByMailgunId(mailgunId);
    if (!outboxMessage) {
      logger.debug({ mailgun_id: mailgunId }, 'No outbox message found for mailgun_id');
      return;
    }

    const updates = {};

    switch (eventType) {
      case 'delivered':
        updates.status = 'delivered';
        updates.delivered_at = Date.now();
        break;
      case 'failed':
      case 'bounced':
        updates.status = 'failed';
        updates.error = event.event_data?.reason ||
          event.event_data?.['delivery-status']?.description ||
          `Mailgun event: ${eventType}`;
        break;
      default:
        // Other events (opened, clicked, etc.) — log but don't update status
        return;
    }

    await storage.updateOutboxMessage(outboxMessage.id, updates);

    logger.info({
      outbox_id: outboxMessage.id,
      event: eventType,
      new_status: updates.status
    }, 'Outbox message status updated from webhook');
  }

  async _findOutboxMessageByMailgunId(mailgunId) {
    // For memory storage, scan all outbox messages
    // For production, this would use an indexed query
    if (typeof storage.findOutboxMessageByMailgunId === 'function') {
      return storage.findOutboxMessageByMailgunId(mailgunId);
    }

    // Fallback: iterate outboxMessages map if available (memory storage)
    if (storage.outboxMessages) {
      for (const msg of storage.outboxMessages.values()) {
        if (msg.mailgun_id === mailgunId) {
          return msg;
        }
      }
    }

    return null;
  }

  verifyWebhookSignature(timestamp, token, signature) {
    const signingKey = getMailgunWebhookSigningKey();
    if (!signingKey) return false;

    const hmac = crypto.createHmac('sha256', signingKey);
    hmac.update(timestamp + token);
    const expected = hmac.digest('hex');

    return signature === expected;
  }

  // ============ MESSAGE QUERIES ============

  async getMessages(agentId, options = {}) {
    return storage.getOutboxMessages(agentId, options);
  }

  async getMessage(messageId) {
    return storage.getOutboxMessage(messageId);
  }
}

export const outboxService = new OutboxService();
