/**
 * Outbox Routes
 * Domain configuration and outbound email via Mailgun
 */

import { Router } from 'express';
import { authenticateAgent } from '../middleware/auth.js';
import { outboxService } from '../services/outbox.service.js';

const router = Router();

// ============ DOMAIN MANAGEMENT ============

/**
 * POST /api/agents/:agentId/outbox/domain
 * Configure a custom domain for outbound email
 */
router.post('/:agentId/outbox/domain', authenticateAgent, async (req, res) => {
  try {
    const { domain } = req.body;

    if (!domain) {
      return res.status(400).json({
        error: 'DOMAIN_REQUIRED',
        message: 'domain field is required'
      });
    }

    const config = await outboxService.addDomain(req.agent.agent_id, domain);

    res.status(201).json(config);
  } catch (error) {
    const status = error.message.includes('already has domain') ? 409 : 400;
    res.status(status).json({
      error: 'DOMAIN_CONFIG_FAILED',
      message: error.message
    });
  }
});

/**
 * GET /api/agents/:agentId/outbox/domain
 * Get domain configuration and status
 */
router.get('/:agentId/outbox/domain', authenticateAgent, async (req, res) => {
  try {
    const config = await outboxService.getDomain(req.agent.agent_id);

    if (!config) {
      return res.status(404).json({
        error: 'NO_DOMAIN',
        message: `No domain configured for agent ${req.agent.agent_id}`
      });
    }

    res.json(config);
  } catch (error) {
    res.status(500).json({
      error: 'DOMAIN_FETCH_FAILED',
      message: error.message
    });
  }
});

/**
 * POST /api/agents/:agentId/outbox/domain/verify
 * Trigger DNS verification check
 */
router.post('/:agentId/outbox/domain/verify', authenticateAgent, async (req, res) => {
  try {
    const config = await outboxService.verifyDomain(req.agent.agent_id);

    res.json(config);
  } catch (error) {
    const status = error.message.includes('No domain configured') ? 404 : 400;
    res.status(status).json({
      error: 'DOMAIN_VERIFY_FAILED',
      message: error.message
    });
  }
});

/**
 * DELETE /api/agents/:agentId/outbox/domain
 * Remove domain configuration
 */
router.delete('/:agentId/outbox/domain', authenticateAgent, async (req, res) => {
  try {
    await outboxService.removeDomain(req.agent.agent_id);

    res.status(204).end();
  } catch (error) {
    const status = error.message.includes('No domain configured') ? 404 : 400;
    res.status(status).json({
      error: 'DOMAIN_DELETE_FAILED',
      message: error.message
    });
  }
});

// ============ SENDING ============

/**
 * POST /api/agents/:agentId/outbox/send
 * Send an email via Mailgun
 */
router.post('/:agentId/outbox/send', authenticateAgent, async (req, res) => {
  try {
    const { to, subject, body, html, from_name } = req.body;

    if (!to) {
      return res.status(400).json({
        error: 'TO_REQUIRED',
        message: 'to field is required'
      });
    }

    if (!subject) {
      return res.status(400).json({
        error: 'SUBJECT_REQUIRED',
        message: 'subject field is required'
      });
    }

    if (!body && !html) {
      return res.status(400).json({
        error: 'BODY_REQUIRED',
        message: 'body or html field is required'
      });
    }

    const message = await outboxService.send(req.agent.agent_id, {
      to, subject, body, html, from_name
    });

    res.status(202).json(message);
  } catch (error) {
    const status = error.message.includes('not verified') ? 403
      : error.message.includes('no outbox domain') ? 404
      : 400;
    res.status(status).json({
      error: 'SEND_FAILED',
      message: error.message
    });
  }
});

// ============ MESSAGE QUERIES ============

/**
 * GET /api/agents/:agentId/outbox/messages
 * List sent messages
 */
router.get('/:agentId/outbox/messages', authenticateAgent, async (req, res) => {
  try {
    const options = {};
    if (req.query.status) options.status = req.query.status;
    if (req.query.limit) options.limit = parseInt(req.query.limit, 10);

    const messages = await outboxService.getMessages(req.agent.agent_id, options);

    res.json({ messages, count: messages.length });
  } catch (error) {
    res.status(500).json({
      error: 'OUTBOX_FETCH_FAILED',
      message: error.message
    });
  }
});

/**
 * GET /api/agents/:agentId/outbox/messages/:messageId
 * Get specific outbox message status
 */
router.get('/:agentId/outbox/messages/:messageId', authenticateAgent, async (req, res) => {
  try {
    const message = await outboxService.getMessage(req.params.messageId);

    if (!message) {
      return res.status(404).json({
        error: 'OUTBOX_MESSAGE_NOT_FOUND',
        message: `Outbox message ${req.params.messageId} not found`
      });
    }

    if (message.agent_id !== req.agent.agent_id) {
      return res.status(403).json({
        error: 'FORBIDDEN',
        message: 'Message belongs to a different agent'
      });
    }

    res.json(message);
  } catch (error) {
    res.status(500).json({
      error: 'OUTBOX_FETCH_FAILED',
      message: error.message
    });
  }
});

// ============ MAILGUN WEBHOOK ============

/**
 * POST /api/webhooks/mailgun
 * Receive delivery status updates from Mailgun
 */
router.post('/webhooks/mailgun', async (req, res) => {
  try {
    const { signature, event_data } = req.body;

    // Verify webhook signature if signing key is configured
    if (process.env.MAILGUN_WEBHOOK_SIGNING_KEY) {
      // Signing key is set — signature is mandatory
      if (!signature) {
        return res.status(400).json({
          error: 'SIGNATURE_REQUIRED',
          message: 'Webhook signature is required when signing key is configured'
        });
      }

      const valid = outboxService.verifyWebhookSignature(
        signature.timestamp,
        signature.token,
        signature.signature
      );

      if (!valid) {
        return res.status(403).json({
          error: 'INVALID_SIGNATURE',
          message: 'Invalid Mailgun webhook signature'
        });
      }
    }

    await outboxService.handleWebhook({ event_data });

    res.status(200).json({ status: 'ok' });
  } catch (error) {
    res.status(500).json({
      error: 'WEBHOOK_FAILED',
      message: error.message
    });
  }
});

export default router;
