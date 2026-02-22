/**
 * Agent routes
 * /api/agents/*
 */

import express from 'express';
import { agentService } from '../services/agent.service.js';
import { groupService } from '../services/group.service.js';
import { identityService } from '../services/identity.service.js';
import { authenticateHttpSignature, requireApiKey } from '../middleware/auth.js';
import { fromBase64, toBase64, hkdfSha256, LABEL_ADMP, keypairFromSeed } from '../utils/crypto.js';
import { storage } from '../storage/index.js';

const router = express.Router();

/**
 * POST /api/agents/register
 * Register a new agent
 */
router.post('/register', async (req, res) => {
  try {
    const { agent_id, agent_type, metadata, webhook_url, webhook_secret, seed, public_key, tenant_id } = req.body;

    // Convert seed from base64 string to Uint8Array if provided
    let seedBytes;
    if (seed) {
      seedBytes = fromBase64(seed);
    }

    const agent = await agentService.register({
      agent_id,
      agent_type,
      metadata,
      webhook_url,
      webhook_secret,
      seed: seedBytes,
      public_key,
      tenant_id
    });

    const response = {
      agent_id: agent.agent_id,
      agent_type: agent.agent_type,
      public_key: agent.public_key,
      did: agent.did,
      registration_mode: agent.registration_mode,
      key_version: agent.key_version,
      verification_tier: agent.verification_tier,
      tenant_id: agent.tenant_id,
      webhook_url: agent.webhook_url,
      webhook_secret: agent.webhook_secret,
      heartbeat: agent.heartbeat
    };

    // Only include secret_key when available (legacy and seed-based modes)
    if (agent.secret_key) {
      response.secret_key = agent.secret_key;
    }

    res.status(201).json(response);
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
router.post('/:agentId/heartbeat', authenticateHttpSignature, async (req, res) => {
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
router.get('/:agentId', authenticateHttpSignature, async (req, res) => {
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
router.delete('/:agentId', authenticateHttpSignature, async (req, res) => {
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
router.get('/:agentId/trusted', authenticateHttpSignature, async (req, res) => {
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
router.post('/:agentId/trusted', authenticateHttpSignature, async (req, res) => {
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
router.delete('/:agentId/trusted/:trustedAgentId', authenticateHttpSignature, async (req, res) => {
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
router.post('/:agentId/webhook', authenticateHttpSignature, async (req, res) => {
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
router.get('/:agentId/webhook', authenticateHttpSignature, async (req, res) => {
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
router.delete('/:agentId/webhook', authenticateHttpSignature, async (req, res) => {
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

/**
 * GET /api/agents/:agentId/groups
 * List groups the agent is a member of
 */
router.get('/:agentId/groups', authenticateHttpSignature, async (req, res) => {
  try {
    const groups = await groupService.listForAgent(req.params.agentId);

    res.json({
      groups: groups.map(g => ({
        id: g.id,
        name: g.name,
        role: g.members?.find(m => m.agent_id === req.params.agentId)?.role,
        member_count: g.members?.length || 0
      }))
    });
  } catch (error) {
    res.status(400).json({
      error: 'LIST_GROUPS_FAILED',
      message: error.message
    });
  }
});

// ============ KEY ROTATION ============

/**
 * POST /api/agents/:agentId/rotate-key
 * Rotate key for seed-based agent
 */
router.post('/:agentId/rotate-key', authenticateHttpSignature, async (req, res) => {
  try {
    const { seed, tenant_id } = req.body;

    if (!seed || !tenant_id) {
      return res.status(400).json({
        error: 'SEED_AND_TENANT_REQUIRED',
        message: 'seed and tenant_id are required for key rotation'
      });
    }

    const seedBytes = fromBase64(seed);

    // Verify the provided seed derives a key matching the agent's current public key
    const agent = req.agent;
    if (agent.registration_mode !== 'seed') {
      return res.status(400).json({
        error: 'KEY_ROTATION_FAILED',
        message: 'Key rotation is only supported for seed-based agents'
      });
    }

    const currentContext = `${LABEL_ADMP}:${tenant_id}:${req.params.agentId}:ed25519:v${agent.key_version || 1}`;
    const currentDerivedKey = hkdfSha256(seedBytes, currentContext, { length: 32 });
    const currentKeypair = keypairFromSeed(currentDerivedKey);
    const derivedPubKey = toBase64(currentKeypair.publicKey);

    if (derivedPubKey !== agent.public_key) {
      return res.status(403).json({
        error: 'SEED_MISMATCH',
        message: 'Provided seed does not match current agent key'
      });
    }

    const result = await agentService.rotateKey(req.params.agentId, {
      seed: seedBytes,
      tenant_id
    });

    res.json({
      agent_id: result.agent_id,
      public_key: result.public_key,
      did: result.did,
      key_version: result.key_version,
      secret_key: result.secret_key
    });
  } catch (error) {
    res.status(400).json({
      error: 'KEY_ROTATION_FAILED',
      message: error.message
    });
  }
});

// ============ IDENTITY VERIFICATION ============

/**
 * POST /api/agents/:agentId/verify/github
 * Link GitHub handle to agent
 */
router.post('/:agentId/verify/github', authenticateHttpSignature, async (req, res) => {
  try {
    const { github_handle } = req.body;

    const agent = await identityService.linkGithub(req.params.agentId, github_handle);

    res.json({
      agent_id: agent.agent_id,
      verification_tier: agent.verification_tier,
      github_handle: agent.github_handle
    });
  } catch (error) {
    res.status(400).json({
      error: 'GITHUB_LINK_FAILED',
      message: error.message
    });
  }
});

/**
 * POST /api/agents/:agentId/verify/cryptographic
 * Upgrade to cryptographic verification tier
 */
router.post('/:agentId/verify/cryptographic', authenticateHttpSignature, async (req, res) => {
  try {
    const agent = await identityService.verifyCryptographic(req.params.agentId);

    res.json({
      agent_id: agent.agent_id,
      verification_tier: agent.verification_tier,
      did: agent.did
    });
  } catch (error) {
    res.status(400).json({
      error: 'CRYPTOGRAPHIC_VERIFY_FAILED',
      message: error.message
    });
  }
});

/**
 * GET /api/agents/:agentId/identity
 * Get verification status
 */
router.get('/:agentId/identity', authenticateHttpSignature, async (req, res) => {
  try {
    const identity = await identityService.getIdentity(req.params.agentId);
    res.json(identity);
  } catch (error) {
    res.status(400).json({
      error: 'GET_IDENTITY_FAILED',
      message: error.message
    });
  }
});

// ============ TENANT ROUTES ============

/**
 * POST /api/agents/tenants
 * Create a new tenant
 */
router.post('/tenants', requireApiKey, async (req, res) => {
  try {
    const { tenant_id, name, metadata } = req.body;

    if (!tenant_id) {
      return res.status(400).json({
        error: 'TENANT_ID_REQUIRED',
        message: 'tenant_id is required'
      });
    }

    const existing = await storage.getTenant(tenant_id);
    if (existing) {
      return res.status(409).json({
        error: 'TENANT_EXISTS',
        message: `Tenant ${tenant_id} already exists`
      });
    }

    const tenant = await storage.createTenant({
      tenant_id,
      name: name || tenant_id,
      metadata: metadata || {}
    });

    res.status(201).json(tenant);
  } catch (error) {
    res.status(400).json({
      error: 'CREATE_TENANT_FAILED',
      message: error.message
    });
  }
});

/**
 * GET /api/agents/tenants/:tenantId
 * Get tenant details
 */
router.get('/tenants/:tenantId', requireApiKey, async (req, res) => {
  try {
    const tenant = await storage.getTenant(req.params.tenantId);

    if (!tenant) {
      return res.status(404).json({
        error: 'TENANT_NOT_FOUND',
        message: `Tenant ${req.params.tenantId} not found`
      });
    }

    res.json(tenant);
  } catch (error) {
    res.status(400).json({
      error: 'GET_TENANT_FAILED',
      message: error.message
    });
  }
});

/**
 * GET /api/agents/tenants/:tenantId/agents
 * List agents belonging to tenant
 */
router.get('/tenants/:tenantId/agents', requireApiKey, async (req, res) => {
  try {
    const agents = await storage.getAgentsByTenant(req.params.tenantId);

    res.json({ agents });
  } catch (error) {
    res.status(400).json({
      error: 'LIST_TENANT_AGENTS_FAILED',
      message: error.message
    });
  }
});

/**
 * DELETE /api/agents/tenants/:tenantId
 * Delete a tenant
 */
router.delete('/tenants/:tenantId', requireApiKey, async (req, res) => {
  try {
    await storage.deleteTenant(req.params.tenantId);
    res.status(204).send();
  } catch (error) {
    res.status(400).json({
      error: 'DELETE_TENANT_FAILED',
      message: error.message
    });
  }
});

export default router;
