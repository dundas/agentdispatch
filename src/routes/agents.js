/**
 * Agent routes
 * /api/agents/*
 */

import express from 'express';
import { agentService } from '../services/agent.service.js';
import { authenticateAgent } from '../middleware/auth.js';

const router = express.Router();

/**
 * POST /api/agents/register
 * Register a new agent
 */
router.post('/register', async (req, res) => {
  try {
    const { agent_id, agent_type, metadata, webhook_url, webhook_secret } = req.body;

    const agent = await agentService.register({
      agent_id,
      agent_type,
      metadata,
      webhook_url,
      webhook_secret
    });

    res.status(201).json({
      agent_id: agent.agent_id,
      agent_type: agent.agent_type,
      public_key: agent.public_key,
      secret_key: agent.secret_key,  // Only returned on registration
      webhook_url: agent.webhook_url,
      webhook_secret: agent.webhook_secret,  // Only returned on registration
      heartbeat: agent.heartbeat
    });
  } catch (error) {
    res.status(400).json({
      error: 'REGISTRATION_FAILED',
      message: error.message
    });
  }
});

/**
 * POST /api/agents/:agentId/heartbeat
 * Update agent heartbeat
 */
router.post('/:agentId/heartbeat', authenticateAgent, async (req, res) => {
  try {
    const { metadata } = req.body;

    const agent = await agentService.heartbeat(req.params.agentId, metadata);

    res.json({
      ok: true,
      last_heartbeat: agent.heartbeat.last_heartbeat,
      timeout_at: agent.heartbeat.last_heartbeat + agent.heartbeat.timeout_ms,
      status: agent.heartbeat.status
    });
  } catch (error) {
    res.status(400).json({
      error: 'HEARTBEAT_FAILED',
      message: error.message
    });
  }
});

/**
 * GET /api/agents/:agentId
 * Get agent details
 */
router.get('/:agentId', authenticateAgent, async (req, res) => {
  try {
    const agent = req.agent;

    // Don't expose secret key
    const { secret_key, ...publicAgent } = agent;

    res.json(publicAgent);
  } catch (error) {
    res.status(404).json({
      error: 'AGENT_NOT_FOUND',
      message: error.message
    });
  }
});

/**
 * DELETE /api/agents/:agentId
 * Deregister agent
 */
router.delete('/:agentId', authenticateAgent, async (req, res) => {
  try {
    await agentService.deregister(req.params.agentId);

    res.status(204).send();
  } catch (error) {
    res.status(400).json({
      error: 'DEREGISTER_FAILED',
      message: error.message
    });
  }
});

/**
 * GET /api/agents/:agentId/trusted
 * List trusted agents
 */
router.get('/:agentId/trusted', authenticateAgent, async (req, res) => {
  try {
    res.json({
      trusted_agents: req.agent.trusted_agents || []
    });
  } catch (error) {
    res.status(400).json({
      error: 'FAILED',
      message: error.message
    });
  }
});

/**
 * POST /api/agents/:agentId/trusted
 * Add agent to trusted list
 */
router.post('/:agentId/trusted', authenticateAgent, async (req, res) => {
  try {
    const { agent_id } = req.body;

    if (!agent_id) {
      return res.status(400).json({
        error: 'AGENT_ID_REQUIRED',
        message: 'agent_id is required'
      });
    }

    const agent = await agentService.addTrustedAgent(req.params.agentId, agent_id);

    res.json({
      trusted_agents: agent.trusted_agents
    });
  } catch (error) {
    res.status(400).json({
      error: 'ADD_TRUSTED_FAILED',
      message: error.message
    });
  }
});

/**
 * DELETE /api/agents/:agentId/trusted/:trustedAgentId
 * Remove agent from trusted list
 */
router.delete('/:agentId/trusted/:trustedAgentId', authenticateAgent, async (req, res) => {
  try {
    const agent = await agentService.removeTrustedAgent(
      req.params.agentId,
      req.params.trustedAgentId
    );

    res.json({
      trusted_agents: agent.trusted_agents
    });
  } catch (error) {
    res.status(400).json({
      error: 'REMOVE_TRUSTED_FAILED',
      message: error.message
    });
  }
});

/**
 * POST /api/agents/:agentId/webhook
 * Configure webhook for agent
 */
router.post('/:agentId/webhook', authenticateAgent, async (req, res) => {
  try {
    const { webhook_url, webhook_secret } = req.body;

    if (!webhook_url) {
      return res.status(400).json({
        error: 'WEBHOOK_URL_REQUIRED',
        message: 'webhook_url is required'
      });
    }

    const config = await agentService.configureWebhook(
      req.params.agentId,
      webhook_url,
      webhook_secret
    );

    res.json(config);
  } catch (error) {
    res.status(400).json({
      error: 'WEBHOOK_CONFIG_FAILED',
      message: error.message
    });
  }
});

/**
 * GET /api/agents/:agentId/webhook
 * Get webhook configuration
 */
router.get('/:agentId/webhook', authenticateAgent, async (req, res) => {
  try {
    const config = await agentService.getWebhookConfig(req.params.agentId);

    res.json(config);
  } catch (error) {
    res.status(400).json({
      error: 'GET_WEBHOOK_FAILED',
      message: error.message
    });
  }
});

/**
 * DELETE /api/agents/:agentId/webhook
 * Remove webhook configuration
 */
router.delete('/:agentId/webhook', authenticateAgent, async (req, res) => {
  try {
    await agentService.removeWebhook(req.params.agentId);

    res.json({
      message: 'Webhook removed',
      webhook_configured: false
    });
  } catch (error) {
    res.status(400).json({
      error: 'REMOVE_WEBHOOK_FAILED',
      message: error.message
    });
  }
});

export default router;
