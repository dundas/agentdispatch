/**
 * Email Inbound Webhook Route
 * Receives parsed email payloads from the Cloudflare email-ingestion Worker
 */

import crypto from 'crypto';
import { Router } from 'express';
import { inboxService } from '../services/inbox.service.js';
import { storage } from '../storage/index.js';

const router = Router();

function getInboundSecret() {
  return process.env.INBOUND_EMAIL_SECRET || '';
}

/**
 * POST /api/webhooks/email/inbound
 * Receive a parsed inbound email from the Cloudflare Worker.
 *
 * Expected body:
 *   to_agent      {string}           - Agent ID parsed from email local part
 *   to_namespace  {string|undefined} - Tenant/namespace parsed from email local part
 *   from_email    {string}           - Sender email address
 *   subject       {string}           - Email subject
 *   text          {string|undefined} - Plain-text body
 *   html          {string|undefined} - HTML body
 *   raw_size      {number|undefined} - Raw message size in bytes
 */
router.post('/webhooks/email/inbound', async (req, res) => {
  try {
    // --- Signature verification ---
    const secret = getInboundSecret();
    const incomingSecret = req.headers['x-webhook-secret'];

    if (secret) {
      if (!incomingSecret) {
        return res.status(401).json({
          error: 'UNAUTHORIZED',
          message: 'X-Webhook-Secret header is required'
        });
      }

      let valid = false;
      try {
        valid = crypto.timingSafeEqual(
          Buffer.from(incomingSecret),
          Buffer.from(secret)
        );
      } catch {
        valid = false;
      }

      if (!valid) {
        return res.status(401).json({
          error: 'UNAUTHORIZED',
          message: 'Invalid webhook secret'
        });
      }
    }

    // --- Input validation ---
    const { to_agent, to_namespace, from_email, subject, text, html, raw_size } = req.body;

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
    let agent = await storage.getAgent(to_agent);
    if (to_namespace && agent && agent.tenant_id !== to_namespace) {
      agent = null;
    }

    if (!agent) {
      return res.status(404).json({
        error: 'AGENT_NOT_FOUND',
        message: `Agent ${to_agent} not found`
      });
    }

    // --- Deliver to inbox ---
    // Encode from_email into a format that satisfies ADMP envelope validation
    // (SAFE_CHARS: [a-zA-Z0-9._:-]) by replacing '@' with '.at.'
    const fromId = `email:${from_email.replace('@', '.at.')}`;

    await inboxService.send({
      version: '1.0',
      from: fromId,
      to: agent.agent_id,
      subject: subject || '(no subject)',
      timestamp: new Date().toISOString(),
      type: 'email',
      body: { subject, from_email, text, html },
      metadata: { source: 'email', raw_size }
    }, { verify_signature: false });

    res.status(200).json({ ok: true });
  } catch (error) {
    res.status(500).json({
      error: 'INBOUND_FAILED',
      message: error.message
    });
  }
});

export default router;
