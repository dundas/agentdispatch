/**
 * Outbox Service
 * Handles outbound email delivery via Resend
 */

import crypto from 'crypto';
import { v4 as uuidv4 } from 'uuid';
import pino from 'pino';
import { storage } from '../storage/index.js';

const logger = pino();

const MAX_ATTEMPTS = 3;

// Read env vars dynamically so they can be overridden in tests
function getResendApiKey() {
  return process.env.RESEND_API_KEY || '';
}

function getResendWebhookSecret() {
  return process.env.RESEND_WEBHOOK_SECRET || '';
}

export class OutboxService {
  constructor() {
    this.deliveryAttempts = new Map(); // outboxMessageId -> attempts
  }

  // ============ RESEND HTTP HELPERS ============

  async _resendRequest(path, { method = 'GET', body } = {}) {
    const url = `https://api.resend.com${path}`;
    const headers = {
      'Authorization': `Bearer ${getResendApiKey()}`,
      'Content-Type': 'application/json'
    };

    const init = { method, headers };

    if (body !== undefined) {
      init.body = JSON.stringify(body);
    }

    const res = await fetch(url, init);
    const text = await res.text();

    let json = null;
    try { json = JSON.parse(text); } catch { /* not json */ }

    return { status: res.status, ok: res.ok, json };
  }

  // ============ DOMAIN MANAGEMENT ============

  async addDomain(agentId, domain) {
    if (!getResendApiKey()) {
      throw new Error('RESEND_API_KEY is not configured');
    }

    const agent = await storage.getAgent(agentId);
    if (!agent) throw new Error(`Agent ${agentId} not found`);

    // Check if agent already has a domain
    const existing = await storage.getDomainConfig(agentId);
    if (existing) {
      throw new Error(`Agent ${agentId} already has domain ${existing.domain} configured. Remove it first.`);
    }

    // Add domain to Resend
    const { ok, json, status } = await this._resendRequest('/domains', {
      method: 'POST',
      body: { name: domain }
    });

    if (!ok && status !== 409) {
      // 409 = domain already exists in Resend (may be shared across agents)
      throw new Error(`Failed to add domain to Resend: ${json?.message || `HTTP ${status}`}`);
    }

    // Fetch DNS records from Resend
    const resendDomainId = json?.id;
    const dnsRecords = resendDomainId
      ? await this._getDomainDnsRecords(resendDomainId)
      : [];

    // Store domain config
    const config = {
      domain,
      resend_domain_id: resendDomainId || null,
      status: 'pending',
      dns_records: dnsRecords,
      provider_state: json?.status || 'not_started'
    };

    const stored = await storage.setDomainConfig(agentId, config);

    logger.info({ agent_id: agentId, domain }, 'Domain configured for outbox');

    return stored;
  }

  async _getDomainDnsRecords(resendDomainId) {
    const { ok, json } = await this._resendRequest(`/domains/${encodeURIComponent(resendDomainId)}`);

    if (!ok) return [];

    const records = [];

    if (Array.isArray(json?.records)) {
      for (const r of json.records) {
        records.push({
          type: r.type,
          name: r.name,
          value: r.value,
          valid: r.status === 'verified'
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

    if (!getResendApiKey()) {
      throw new Error('RESEND_API_KEY is not configured');
    }

    const resendDomainId = config.resend_domain_id;
    if (!resendDomainId) {
      throw new Error('Domain has no resend_domain_id — cannot verify');
    }

    // Ask Resend to verify DNS records
    const { ok, json } = await this._resendRequest(
      `/domains/${encodeURIComponent(resendDomainId)}/verify`,
      { method: 'POST' }
    );

    if (!ok) {
      throw new Error(`Resend verification request failed: ${json?.message || 'unknown error'}`);
    }

    // Refresh DNS record status
    const dnsRecords = await this._getDomainDnsRecords(resendDomainId);

    const providerState = json?.status || config.provider_state;
    const verified = providerState === 'verified';

    const updated = await storage.setDomainConfig(agentId, {
      ...config,
      status: verified ? 'verified' : 'pending',
      provider_state: providerState,
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

    // Note: We do NOT delete from Resend — domain may be shared or reused.
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

    if (!getResendApiKey()) {
      throw new Error('RESEND_API_KEY is not configured');
    }

    // Construct from address
    const fromLocal = agentId.replace(/[^a-zA-Z0-9._-]/g, '_');
    // Sanitize display name: strip characters that could corrupt RFC 5322 From header
    const rawName = from_name || agentId;
    const displayName = rawName.replace(/[<>\r\n"\\]/g, '').trim() || fromLocal;
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
      provider_message_id: null,
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
      const emailBody = {
        from: outboxMessage.from,
        to: [outboxMessage.to],
        subject: outboxMessage.subject,
        text: outboxMessage.body
      };

      if (outboxMessage.html) {
        emailBody.html = outboxMessage.html;
      }

      const { ok, json, status } = await this._resendRequest('/emails', {
        method: 'POST',
        body: emailBody
      });

      this.deliveryAttempts.set(outboxMessage.id, attempts + 1);

      if (ok) {
        await storage.updateOutboxMessage(outboxMessage.id, {
          status: 'sent',
          provider_message_id: json?.id || null,
          attempts: attempts + 1,
          sent_at: Date.now(),
          error: null
        });

        this.deliveryAttempts.delete(outboxMessage.id);

        logger.info({
          outbox_id: outboxMessage.id,
          provider_message_id: json?.id,
          to: outboxMessage.to
        }, 'Email sent via Resend');

        return;
      }

      // Send failed — schedule retry if under limit
      const error = `Resend HTTP ${status}: ${json?.message || 'unknown'}`;
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

  // ============ RESEND WEBHOOKS ============

  async handleWebhook(event) {
    const eventType = event?.type;
    if (!eventType) return;

    const providerId = event.data?.email_id;
    if (!providerId) return;

    logger.info({ event: eventType, provider_message_id: providerId }, 'Resend webhook received');

    // Find outbox message by provider_message_id via storage scan
    // In production with persistent storage, this would be an indexed query
    const outboxMessage = await this._findOutboxMessageByProviderId(providerId);
    if (!outboxMessage) {
      logger.debug({ provider_message_id: providerId }, 'No outbox message found for provider_message_id');
      return;
    }

    const updates = {};

    switch (eventType) {
      case 'email.delivered':
        updates.status = 'delivered';
        updates.delivered_at = Date.now();
        break;
      case 'email.bounced':
      case 'email.complained':
        updates.status = 'failed';
        updates.error = `Resend event: ${eventType}`;
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

  async _findOutboxMessageByProviderId(providerId) {
    if (typeof storage.findOutboxMessageByProviderId === 'function') {
      return storage.findOutboxMessageByProviderId(providerId);
    }

    logger.warn('Storage backend does not implement findOutboxMessageByProviderId — webhook status updates will be lost');
    return null;
  }

  verifyWebhookSignature(svixId, svixTimestamp, svixSignature, rawBody) {
    const secret = getResendWebhookSecret();
    if (!secret) return false;

    // Timestamp freshness: reject webhooks older than 5 minutes to prevent replay attacks
    const tsSeconds = Number(svixTimestamp);
    if (!Number.isFinite(tsSeconds)) return false;
    if (Math.abs(Date.now() / 1000 - tsSeconds) > 300) return false;

    const signingString = `${svixId}.${svixTimestamp}.${rawBody}`;

    const hmac = crypto.createHmac('sha256', secret);
    hmac.update(signingString);
    const computed = hmac.digest('base64');

    // svix-signature format: "v1,{base64sig}" — strip the "v1," prefix
    const incoming = svixSignature.startsWith('v1,')
      ? svixSignature.slice(3)
      : svixSignature;

    try {
      return crypto.timingSafeEqual(
        Buffer.from(incoming),
        Buffer.from(computed)
      );
    } catch {
      return false;
    }
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
