/**
 * Email Inbound Webhook Route
 * Receives parsed email payloads from the Cloudflare email-ingestion Worker
 */

import crypto from 'crypto';
import { Router } from 'express';
import pino from 'pino';
import { inboxService } from '../services/inbox.service.js';
import { storage } from '../storage/index.js';

const logger = pino();

// In-process counters for the inbound email health endpoint.
// These reset on process restart — suitable for operational visibility,
// not for billing/audit. Persistent metrics belong in the storage layer.
export const inboundStats = {
  last_inbound_at: null,       // ISO timestamp of last successfully accepted inbound
  last_error_at: null,         // ISO timestamp of last 5xx internal error (catch block only)
  total_accepted: 0,           // accepted since last restart
  total_rejected: 0,           // 404 (unknown agent) since last restart
  total_errors: 0,             // 5xx errors since last restart
};

const router = Router();

function getInboundSecret() {
  return process.env.INBOUND_EMAIL_SECRET || '';
}

function verifyInboundSecret(req) {
  const secret = getInboundSecret();
  if (!secret) return { ok: false, status: 500, body: {
    error: 'SERVER_MISCONFIGURATION',
    message: 'INBOUND_EMAIL_SECRET is not configured'
  } };

  const incomingSecret = req.headers['x-webhook-secret'];
  if (!incomingSecret) return { ok: false, status: 401, body: {
    error: 'UNAUTHORIZED',
    message: 'X-Webhook-Secret header is required'
  } };

  let valid = false;
  try {
    valid = crypto.timingSafeEqual(
      Buffer.from(incomingSecret),
      Buffer.from(secret)
    );
  } catch {
    valid = false;
  }

  if (!valid) return { ok: false, status: 401, body: {
    error: 'UNAUTHORIZED',
    message: 'Invalid webhook secret'
  } };

  return { ok: true };
}

function normalizeEmail(value) {
  return String(value || '').trim().toLowerCase();
}

function isTrustedEmailSender(agent, fromEmail) {
  const configured = agent?.metadata?.email_trusted_senders;
  if (!Array.isArray(configured) || configured.length === 0) {
    return false;
  }

  const from = normalizeEmail(fromEmail);
  return configured
    .filter(v => typeof v === 'string')
    .map(normalizeEmail)
    .includes(from);
}

/**
 * POST /api/webhooks/email/inbound
 * Receive a parsed inbound email from the Cloudflare Worker.
 *
 * Expected body:
 *   to_agent      {string}           - Agent ID parsed from email local part (= full local part)
 *   from_email    {string}           - Sender email address
 *   subject       {string}           - Email subject
 *   text          {string|undefined} - Plain-text body
 *   html          {string|undefined} - HTML body
 *   raw_size      {number|undefined} - Raw message size in bytes
 */
router.post('/webhooks/email/inbound', async (req, res) => {
  try {
    // --- Signature verification ---
    const auth = verifyInboundSecret(req);
    if (!auth.ok) {
      return res.status(auth.status).json(auth.body);
    }

    // --- Input validation ---
    const { to_agent, from_email, subject, text, html, raw_size } = req.body;

    if (!to_agent) {
      return res.status(400).json({
        error: 'TO_AGENT_REQUIRED',
        message: 'to_agent field is required'
      });
    }

    if (!from_email) {
      return res.status(400).json({
        error: 'FROM_EMAIL_REQUIRED',
        message: 'from_email field is required'
      });
    }

    // --- Agent resolution ---
    const agent = await storage.getAgent(to_agent);

    if (!agent) {
      inboundStats.total_rejected++;
      return res.status(404).json({
        error: 'AGENT_NOT_FOUND',
        message: `Agent ${to_agent} not found`
      });
    }

    // --- Deliver to inbox ---
    // Encode from_email into a format that satisfies ADMP envelope validation
    // (SAFE_CHARS: [a-zA-Z0-9._:-]) by replacing '@' with '.at.'
    const fromId = `email:${from_email.replace('@', '.at.')}`;

    const trustedSender = isTrustedEmailSender(agent, from_email);
    const now = Date.now();
    const created = await inboxService.send({
      version: '1.0',
      from: fromId,
      to: agent.agent_id,
      subject: subject || '(no subject)',
      timestamp: new Date().toISOString(),
      type: 'email',
      body: { subject, from_email, text, html },
      metadata: { source: 'email', raw_size }
    }, {
      verify_signature: false,
      bypass_trust_check: true,
      initial_status: trustedSender ? 'queued' : 'review_pending',
      // External ingress defaults to hold-for-review before becoming pullable.
      retain_until_acked: true,
      system_metadata: {
        ingress_channel: 'email',
        ingress_trust: trustedSender ? 'trusted' : 'untrusted',
        review_status: trustedSender ? 'approved' : 'pending',
        review_source: trustedSender ? 'trusted_sender_allowlist' : null,
        reviewed_at: trustedSender ? now : null,
        ingested_at: now
      }
    });

    inboundStats.last_inbound_at = new Date().toISOString();
    inboundStats.total_accepted++;

    res.status(200).json({
      ok: true,
      message_id: created.id,
      review_status: created.review_status,
      trusted_sender: trustedSender
    });
  } catch (error) {
    inboundStats.last_error_at = new Date().toISOString();
    inboundStats.total_errors++;
    logger.error({ error: error.message }, 'Email inbound webhook failed');
    res.status(500).json({
      error: 'INBOUND_FAILED',
      message: 'Internal server error'
    });
  }
});

/**
 * POST /api/webhooks/email/inbound/:messageId/review
 * Internal policy/review hook to release or reject quarantined email.
 * Body: { decision: 'approve' | 'reject', reason?: string, model_verdict?: object|string }
 */
router.post('/webhooks/email/inbound/:messageId/review', async (req, res) => {
  try {
    const auth = verifyInboundSecret(req);
    if (!auth.ok) {
      return res.status(auth.status).json(auth.body);
    }

    const { decision, reason, model_verdict } = req.body || {};
    if (decision !== 'approve' && decision !== 'reject') {
      return res.status(400).json({
        error: 'INVALID_DECISION',
        message: 'decision must be "approve" or "reject"'
      });
    }

    const message = await storage.getMessage(req.params.messageId);
    if (!message) {
      return res.status(404).json({
        error: 'MESSAGE_NOT_FOUND',
        message: `Message ${req.params.messageId} not found`
      });
    }

    if (message.ingress_channel !== 'email') {
      return res.status(400).json({
        error: 'NOT_EMAIL_INGRESS',
        message: 'Message is not an inbound email message'
      });
    }

    if (message.status !== 'review_pending' || message.review_status !== 'pending') {
      return res.status(409).json({
        error: 'INVALID_REVIEW_STATE',
        message: `Message is not pending review (status=${message.status}, review_status=${message.review_status})`
      });
    }

    const now = Date.now();
    const updates = decision === 'approve'
      ? { status: 'queued', review_status: 'approved', reviewed_at: now, review_reason: null }
      : { status: 'failed', review_status: 'rejected', reviewed_at: now, review_reason: reason || 'Rejected by policy review' };
    updates.review_source = 'manual_review';
    if (model_verdict !== undefined) {
      updates.model_verdict = model_verdict;
    }

    const updated = await storage.updateMessage(req.params.messageId, updates);

    return res.status(200).json({
      ok: true,
      message_id: updated.id,
      decision,
      status: updated.status,
      review_status: updated.review_status
    });
  } catch (error) {
    logger.error({ error: error.message }, 'Email review webhook failed');
    return res.status(500).json({
      error: 'REVIEW_FAILED',
      message: 'Internal server error'
    });
  }
});

/**
 * GET /api/health/inbound
 * Liveness check for the email inbound path.
 * Returns 200 with stats while the process is up.
 * Returns 503 if no email has been accepted within INBOUND_STALE_THRESHOLD_MS
 * (default 2 hours) — useful for uptime monitors that want a non-200 on staleness.
 */
router.get('/health/inbound', (req, res) => {
  const defaultThresholdMs = 2 * 60 * 60 * 1000;
  const parsedThresholdMs = Number.parseInt(process.env.INBOUND_STALE_THRESHOLD_MS ?? '', 10);
  const thresholdMs = Number.isFinite(parsedThresholdMs) && parsedThresholdMs > 0
    ? parsedThresholdMs
    : defaultThresholdMs;
  const now = Date.now();
  const lastAt = inboundStats.last_inbound_at ? new Date(inboundStats.last_inbound_at).getTime() : null;
  const ageMs = lastAt ? now - lastAt : null;
  const stale = ageMs === null || ageMs > thresholdMs;

  const body = {
    status: stale ? 'stale' : 'ok',
    last_inbound_at: inboundStats.last_inbound_at,
    age_seconds: ageMs !== null ? Math.floor(ageMs / 1000) : null,
    stale_threshold_seconds: Math.floor(thresholdMs / 1000),
    since_restart: {
      accepted: inboundStats.total_accepted,
      rejected: inboundStats.total_rejected,
      errors: inboundStats.total_errors,
    },
    last_error_at: inboundStats.last_error_at,
  };

  res.status(stale ? 503 : 200).json(body);
});

export default router;
