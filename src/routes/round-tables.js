/**
 * Round Table routes
 * /api/round-tables/*
 */

import express from 'express';
import { roundTableService } from '../services/round-table.service.js';
import { authenticateAgent } from '../middleware/auth.js';

const router = express.Router();

function getErrorStatusCode(error) {
  const msg = error.message || '';
  if (msg.includes('not found')) return 404;
  if (msg.includes('Not a participant') || msg.includes('Only the facilitator')) return 403;
  if (msg.includes('already resolved') || msg.includes('has expired') || msg.includes('maximum of 200')) return 409;
  return 400;
}

/**
 * POST /api/round-tables
 * Create a new Round Table session
 */
router.post('/', authenticateAgent, async (req, res) => {
  try {
    const { topic, goal, participants, timeout_minutes } = req.body;

    if (!topic || typeof topic !== 'string' || topic.trim().length === 0) {
      return res.status(400).json({ error: 'INVALID_TOPIC', message: 'topic is required' });
    }
    if (!goal || typeof goal !== 'string' || goal.trim().length === 0) {
      return res.status(400).json({ error: 'INVALID_GOAL', message: 'goal is required' });
    }
    if (!Array.isArray(participants) || participants.length === 0) {
      return res.status(400).json({ error: 'INVALID_PARTICIPANTS', message: 'participants must be a non-empty array' });
    }

    const rt = await roundTableService.create({
      topic: topic.trim(),
      goal: goal.trim(),
      facilitator: req.agent.agent_id,
      participants,
      timeout_minutes: timeout_minutes || 30
    });

    res.status(201).json(rt);
  } catch (error) {
    res.status(getErrorStatusCode(error)).json({ error: 'CREATE_ROUND_TABLE_FAILED', message: error.message });
  }
});

/**
 * GET /api/round-tables
 * List Round Tables, optionally filtered by status and/or participant
 */
router.get('/', authenticateAgent, async (req, res) => {
  try {
    const { status, participant } = req.query;
    const tables = await roundTableService.list({
      status: status || undefined,
      participant: participant || req.agent.agent_id
    });
    res.json({ round_tables: tables, count: tables.length });
  } catch (error) {
    res.status(500).json({ error: 'LIST_ROUND_TABLES_FAILED', message: error.message });
  }
});

/**
 * GET /api/round-tables/:id
 * Get a Round Table session (facilitator or participant only)
 */
router.get('/:id', authenticateAgent, async (req, res) => {
  try {
    const rt = await roundTableService.get(req.params.id, req.agent.agent_id);
    res.json(rt);
  } catch (error) {
    res.status(getErrorStatusCode(error)).json({ error: 'GET_ROUND_TABLE_FAILED', message: error.message });
  }
});

/**
 * POST /api/round-tables/:id/speak
 * Contribute a message to the thread (participants only)
 */
router.post('/:id/speak', authenticateAgent, async (req, res) => {
  try {
    const { message } = req.body;

    if (!message || typeof message !== 'string' || message.trim().length === 0) {
      return res.status(400).json({ error: 'INVALID_MESSAGE', message: 'message is required' });
    }
    if (message.length > 10000) {
      return res.status(400).json({ error: 'MESSAGE_TOO_LONG', message: 'message must be 10000 characters or less' });
    }

    const result = await roundTableService.speak(req.params.id, {
      from: req.agent.agent_id,
      message: message.trim()
    });

    res.status(201).json(result);
  } catch (error) {
    res.status(getErrorStatusCode(error)).json({ error: 'SPEAK_FAILED', message: error.message });
  }
});

/**
 * POST /api/round-tables/:id/resolve
 * Resolve a Round Table (facilitator only)
 */
router.post('/:id/resolve', authenticateAgent, async (req, res) => {
  try {
    const { outcome, decision } = req.body;

    if (!outcome || typeof outcome !== 'string' || outcome.trim().length === 0) {
      return res.status(400).json({ error: 'INVALID_OUTCOME', message: 'outcome is required' });
    }

    const rt = await roundTableService.resolve(req.params.id, {
      facilitator: req.agent.agent_id,
      outcome: outcome.trim(),
      decision
    });

    res.json(rt);
  } catch (error) {
    res.status(getErrorStatusCode(error)).json({ error: 'RESOLVE_FAILED', message: error.message });
  }
});

export default router;
