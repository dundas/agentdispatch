/**
 * Inbox routes
 * /api/agents/:agentId/inbox/*
 * /api/messages/*
 */

import express from 'express';
import { inboxService } from '../services/inbox.service.js';
import { authenticateAgent } from '../middleware/auth.js';

const router = express.Router();

/**
 * POST /api/agents/:agentId/messages
 * Send message to agent's inbox
 */
router.post('/:agentId/messages', async (req, res) => {
  try {
    const envelope = req.body;

    // Ensure to field matches URL
    if (!envelope.to) {
      envelope.to = req.params.agentId;
    }

    const message = await inboxService.send(envelope);

    res.status(201).json({
      message_id: message.id,
      status: message.status
    });
  } catch (error) {
    if (error.message.includes('not found')) {
      return res.status(404).json({
        error: 'RECIPIENT_NOT_FOUND',
        message: error.message
      });
    }

    if (error.message.includes('signature')) {
      return res.status(403).json({
        error: 'INVALID_SIGNATURE',
        message: error.message
      });
    }

    if (error.message.includes('timestamp')) {
      return res.status(400).json({
        error: 'INVALID_TIMESTAMP',
        message: error.message
      });
    }

    res.status(400).json({
      error: 'SEND_FAILED',
      message: error.message
    });
  }
});

/**
 * POST /api/agents/:agentId/inbox/pull
 * Pull message from inbox (with lease)
 */
router.post('/:agentId/inbox/pull', authenticateAgent, async (req, res) => {
  try {
    const { visibility_timeout } = req.body;

    const message = await inboxService.pull(req.params.agentId, {
      visibility_timeout
    });

    if (!message) {
      return res.status(204).send();
    }

    res.json({
      message_id: message.id,
      envelope: message.envelope,
      lease_until: message.lease_until,
      attempts: message.attempts
    });
  } catch (error) {
    res.status(400).json({
      error: 'PULL_FAILED',
      message: error.message
    });
  }
});

/**
 * POST /api/agents/:agentId/messages/:messageId/ack
 * Acknowledge message
 */
router.post('/:agentId/messages/:messageId/ack', authenticateAgent, async (req, res) => {
  try {
    const { result } = req.body;

    await inboxService.ack(req.params.agentId, req.params.messageId, result);

    res.json({ ok: true });
  } catch (error) {
    if (error.message.includes('not found')) {
      return res.status(404).json({
        error: 'MESSAGE_NOT_FOUND',
        message: error.message
      });
    }

    res.status(400).json({
      error: 'ACK_FAILED',
      message: error.message
    });
  }
});

/**
 * POST /api/agents/:agentId/messages/:messageId/nack
 * Negative acknowledge (requeue or extend lease)
 */
router.post('/:agentId/messages/:messageId/nack', authenticateAgent, async (req, res) => {
  try {
    const { extend_sec, requeue } = req.body;

    const message = await inboxService.nack(req.params.agentId, req.params.messageId, {
      extend_sec,
      requeue
    });

    res.json({
      ok: true,
      status: message.status,
      lease_until: message.lease_until
    });
  } catch (error) {
    if (error.message.includes('not found')) {
      return res.status(404).json({
        error: 'MESSAGE_NOT_FOUND',
        message: error.message
      });
    }

    res.status(400).json({
      error: 'NACK_FAILED',
      message: error.message
    });
  }
});

/**
 * POST /api/agents/:agentId/messages/:messageId/reply
 * Reply to a message
 */
router.post('/:agentId/messages/:messageId/reply', authenticateAgent, async (req, res) => {
  try {
    const envelope = req.body;

    const message = await inboxService.reply(
      req.params.agentId,
      req.params.messageId,
      envelope
    );

    res.json({
      message_id: message.id,
      status: message.status
    });
  } catch (error) {
    if (error.message.includes('not found')) {
      return res.status(404).json({
        error: 'MESSAGE_NOT_FOUND',
        message: error.message
      });
    }

    res.status(400).json({
      error: 'REPLY_FAILED',
      message: error.message
    });
  }
});

/**
 * GET /api/messages/:messageId/status
 * Get message delivery status
 */
router.get('/messages/:messageId/status', async (req, res) => {
  try {
    const status = await inboxService.getStatus(req.params.messageId);

    res.json(status);
  } catch (error) {
    res.status(404).json({
      error: 'MESSAGE_NOT_FOUND',
      message: error.message
    });
  }
});

/**
 * GET /api/agents/:agentId/inbox/stats
 * Get inbox statistics
 */
router.get('/:agentId/inbox/stats', authenticateAgent, async (req, res) => {
  try {
    const stats = await inboxService.getStats(req.params.agentId);

    res.json(stats);
  } catch (error) {
    res.status(400).json({
      error: 'STATS_FAILED',
      message: error.message
    });
  }
});

/**
 * POST /api/agents/:agentId/inbox/reclaim
 * Reclaim expired leases
 */
router.post('/:agentId/inbox/reclaim', authenticateAgent, async (req, res) => {
  try {
    const reclaimed = await inboxService.reclaimExpiredLeases();

    res.json({
      reclaimed
    });
  } catch (error) {
    res.status(400).json({
      error: 'RECLAIM_FAILED',
      message: error.message
    });
  }
});

export default router;
