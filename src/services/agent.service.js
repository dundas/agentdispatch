/**
 * Agent Service
 * Handles agent registration, heartbeat, and lifecycle
 */

import { v4 as uuid } from 'uuid';
import { generateKeypair, toBase64, fromBase64, hkdfSha256, LABEL_ADMP, keypairFromSeed, generateDID } from '../utils/crypto.js';
import { storage } from '../storage/index.js';

export class AgentService {
  /**
   * Register a new agent
   *
   * Supports three registration modes:
   * - Legacy (default): Random keypair, returns secret_key
   * - Seed-based: Deterministic keypair from HKDF derivation, requires tenant_id
   * - Import: Client provides public_key, no secret_key returned
   *
   * @param {Object} params
   * @param {string} params.agent_id - Optional custom agent ID
   * @param {string} params.agent_type - Type of agent (e.g., 'claude_session')
   * @param {Object} params.metadata - Agent metadata
   * @param {string} params.webhook_url - Optional webhook URL for push delivery
   * @param {string} params.webhook_secret - Optional webhook secret for signing
   * @param {Uint8Array} params.seed - Master key bytes for seed-based registration
   * @param {string} params.public_key - Base64 public key for import mode
   * @param {string} params.tenant_id - Tenant ID (required for seed-based)
   * @returns {Object} Agent with keypair
   */
  async register({ agent_id, agent_type = 'generic', metadata = {}, webhook_url, webhook_secret, seed, public_key, tenant_id }) {
    // Generate agent_id if not provided
    if (!agent_id) {
      agent_id = `agent://agent-${uuid()}`;
    }

    // Check if agent already exists
    const existing = await storage.getAgent(agent_id);
    if (existing) {
      throw new Error(`Agent ${agent_id} already exists`);
    }

    // Determine registration mode and derive keys
    let publicKeyB64;
    let secretKeyB64;
    let registrationMode;
    let derivationContext = null;
    let did;

    if (seed) {
      // Mode 2: Seed-based (deterministic)
      if (!tenant_id) {
        throw new Error('tenant_id is required for seed-based registration');
      }
      registrationMode = 'seed';
      derivationContext = `${LABEL_ADMP}:${tenant_id}:${agent_id}:ed25519:v1`;

      // Derive per-agent key via HKDF
      const derivedKey = hkdfSha256(seed, derivationContext, { length: 32 });
      const keypair = keypairFromSeed(derivedKey);
      publicKeyB64 = toBase64(keypair.publicKey);
      secretKeyB64 = toBase64(keypair.privateKey);
      did = generateDID(keypair.publicKey);
    } else if (public_key) {
      // Mode 3: Import (client-provided public key)
      registrationMode = 'import';
      publicKeyB64 = public_key;
      // No secret key — client retains it
      const pubBytes = fromBase64(public_key);
      did = generateDID(pubBytes);
    } else {
      // Mode 1: Legacy (random keypair)
      registrationMode = 'legacy';
      const keypair = generateKeypair();
      publicKeyB64 = toBase64(keypair.publicKey);
      secretKeyB64 = toBase64(keypair.secretKey);
      did = generateDID(keypair.publicKey);
    }

    // Generate webhook secret if URL provided but no secret
    if (webhook_url && !webhook_secret) {
      webhook_secret = toBase64(generateKeypair().publicKey).substring(0, 32);
    }

    const agent = {
      agent_id,
      agent_type,
      public_key: publicKeyB64,
      did,
      tenant_id: tenant_id || null,
      registration_mode: registrationMode,
      key_version: 1,
      public_keys: [{ version: 1, public_key: publicKeyB64, created_at: Date.now(), active: true }],
      verification_tier: 'unverified',
      derivation_context: derivationContext,
      metadata,
      webhook_url: webhook_url || null,
      webhook_secret: webhook_secret || null,
      heartbeat: {
        last_heartbeat: Date.now(),
        status: 'online',
        interval_ms: parseInt(process.env.HEARTBEAT_INTERVAL_MS) || 60000,
        timeout_ms: parseInt(process.env.HEARTBEAT_TIMEOUT_MS) || 300000
      },
      trusted_agents: [],
      blocked_agents: []
    };

    // Apply registration policy
    const tenant = tenant_id ? await storage.getTenant(tenant_id) : null;
    const policy = tenant?.registration_policy || process.env.REGISTRATION_POLICY || 'open';
    agent.registration_status = policy === 'approval_required' ? 'pending' : 'approved';

    await storage.createAgent(agent);

    const response = {
      ...agent
    };

    // Only return secret_key for legacy and seed-based modes
    if (secretKeyB64) {
      response.secret_key = secretKeyB64;
    }

    return response;
  }

  /**
   * Approve a pending agent
   * @param {string} agentId
   * @returns {Object} Updated agent
   */
  async approve(agentId) {
    const agent = await storage.getAgent(agentId);
    if (!agent) {
      throw new Error(`Agent ${agentId} not found`);
    }
    if (agent.registration_status === 'approved') {
      // Idempotent: already approved, return as-is
      return agent;
    }
    return await storage.updateAgent(agentId, { registration_status: 'approved' });
  }

  /**
   * Reject an agent
   * @param {string} agentId
   * @param {string} reason - Optional rejection reason
   * @returns {Object} Updated agent
   */
  async reject(agentId, reason) {
    const agent = await storage.getAgent(agentId);
    if (!agent) {
      throw new Error(`Agent ${agentId} not found`);
    }
    if (agent.registration_status === 'rejected') {
      throw new Error(`Agent ${agentId} is already rejected`);
    }
    return await storage.updateAgent(agentId, {
      registration_status: 'rejected',
      rejection_reason: reason || null
    });
  }

  /**
   * Update agent heartbeat
   * @param {string} agentId
   * @param {Object} metadata - Optional metadata to update
   * @returns {Object} Updated agent
   */
  async heartbeat(agentId, metadata = {}) {
    const agent = await storage.getAgent(agentId);
    if (!agent) {
      throw new Error(`Agent ${agentId} not found`);
    }

    const updates = {
      heartbeat: {
        ...agent.heartbeat,
        last_heartbeat: Date.now(),
        status: 'online'
      }
    };

    // Update metadata if provided
    if (Object.keys(metadata).length > 0) {
      updates.metadata = {
        ...agent.metadata,
        ...metadata
      };
    }

    return await storage.updateAgent(agentId, updates);
  }

  /**
   * Get agent by ID
   * @param {string} agentId
   * @returns {Object} Agent
   */
  async getAgent(agentId) {
    const agent = await storage.getAgent(agentId);
    if (!agent) {
      throw new Error(`Agent ${agentId} not found`);
    }
    return agent;
  }

  /**
   * Deregister agent
   * @param {string} agentId
   * @returns {boolean}
   */
  async deregister(agentId) {
    const agent = await storage.getAgent(agentId);
    if (!agent) {
      throw new Error(`Agent ${agentId} not found`);
    }

    return await storage.deleteAgent(agentId);
  }

  /**
   * Check if agent is online
   * @param {string} agentId
   * @returns {boolean}
   */
  async isOnline(agentId) {
    const agent = await storage.getAgent(agentId);
    if (!agent) return false;

    const elapsed = Date.now() - agent.heartbeat.last_heartbeat;
    return elapsed < agent.heartbeat.timeout_ms;
  }

  /**
   * Mark offline agents
   * Background job to check heartbeat timeouts
   * @returns {number} Number of agents marked offline
   */
  async markOfflineAgents() {
    const agents = await storage.listAgents({ status: 'online' });
    let marked = 0;

    for (const agent of agents) {
      const elapsed = Date.now() - agent.heartbeat.last_heartbeat;
      if (elapsed > agent.heartbeat.timeout_ms) {
        await storage.updateAgent(agent.agent_id, {
          heartbeat: {
            ...agent.heartbeat,
            status: 'offline'
          }
        });
        marked++;
      }
    }

    return marked;
  }

  /**
   * Add agent to trusted list
   * @param {string} agentId - Target agent
   * @param {string} trustedAgentId - Agent to trust
   * @returns {Object} Updated agent
   */
  async addTrustedAgent(agentId, trustedAgentId) {
    const agent = await storage.getAgent(agentId);
    if (!agent) {
      throw new Error(`Agent ${agentId} not found`);
    }

    if (!agent.trusted_agents.includes(trustedAgentId)) {
      agent.trusted_agents.push(trustedAgentId);
      return await storage.updateAgent(agentId, {
        trusted_agents: agent.trusted_agents
      });
    }

    return agent;
  }

  /**
   * Remove agent from trusted list
   * @param {string} agentId - Target agent
   * @param {string} trustedAgentId - Agent to remove
   * @returns {Object} Updated agent
   */
  async removeTrustedAgent(agentId, trustedAgentId) {
    const agent = await storage.getAgent(agentId);
    if (!agent) {
      throw new Error(`Agent ${agentId} not found`);
    }

    const updated = agent.trusted_agents.filter(id => id !== trustedAgentId);
    return await storage.updateAgent(agentId, {
      trusted_agents: updated
    });
  }

  /**
   * Check if sender is trusted by recipient
   * @param {string} recipientId - Recipient agent ID
   * @param {string} senderId - Sender agent ID
   * @returns {boolean}
   */
  async isTrusted(recipientId, senderId) {
    const agent = await storage.getAgent(recipientId);
    if (!agent) return false;

    return agent.trusted_agents.includes(senderId);
  }

  /**
   * Configure webhook for agent
   * @param {string} agentId - Agent ID
   * @param {string} webhook_url - Webhook URL
   * @param {string} webhook_secret - Optional webhook secret (auto-generated if not provided)
   * @returns {Object} Updated agent with webhook_secret
   */
  async configureWebhook(agentId, webhook_url, webhook_secret) {
    const agent = await storage.getAgent(agentId);
    if (!agent) {
      throw new Error(`Agent ${agentId} not found`);
    }

    // Generate webhook secret if not provided
    if (!webhook_secret && webhook_url) {
      webhook_secret = toBase64(generateKeypair().publicKey).substring(0, 32);
    }

    const updated = await storage.updateAgent(agentId, {
      webhook_url: webhook_url || null,
      webhook_secret: webhook_secret || null
    });

    return {
      agent_id: updated.agent_id,
      webhook_url: updated.webhook_url,
      webhook_secret: updated.webhook_secret  // Return secret so agent can verify
    };
  }

  /**
   * Remove webhook configuration
   * @param {string} agentId - Agent ID
   * @returns {Object} Updated agent
   */
  async removeWebhook(agentId) {
    const agent = await storage.getAgent(agentId);
    if (!agent) {
      throw new Error(`Agent ${agentId} not found`);
    }

    return await storage.updateAgent(agentId, {
      webhook_url: null,
      webhook_secret: null
    });
  }

  /**
   * Get webhook configuration
   * @param {string} agentId - Agent ID
   * @returns {Object} Webhook config
   */
  async getWebhookConfig(agentId) {
    const agent = await storage.getAgent(agentId);
    if (!agent) {
      throw new Error(`Agent ${agentId} not found`);
    }

    return {
      webhook_url: agent.webhook_url,
      webhook_configured: !!agent.webhook_url
    };
  }

  /**
   * Rotate key for seed-based agents
   * @param {string} agentId
   * @param {Object} params
   * @param {Uint8Array} params.seed - Master key bytes
   * @param {string} params.tenant_id - Tenant ID
   * @returns {Object} Updated agent with new key info
   */
  async rotateKey(agentId, { seed, tenant_id }) {
    const agent = await storage.getAgent(agentId);
    if (!agent) {
      throw new Error(`Agent ${agentId} not found`);
    }

    if (agent.registration_mode !== 'seed') {
      throw new Error('Key rotation is only supported for seed-based agents');
    }

    if (!seed || !tenant_id) {
      throw new Error('seed and tenant_id are required for key rotation');
    }

    const newVersion = (agent.key_version || 1) + 1;
    const derivationContext = `${LABEL_ADMP}:${tenant_id}:${agentId}:ed25519:v${newVersion}`;

    // Derive new key
    const derivedKey = hkdfSha256(seed, derivationContext, { length: 32 });
    const keypair = keypairFromSeed(derivedKey);
    const newPublicKeyB64 = toBase64(keypair.publicKey);
    const newDid = generateDID(keypair.publicKey);

    // Keep old keys active during rotation window (24 hours) so in-flight
    // messages signed with the previous key still verify. After the window,
    // auth middleware and inbox verification will stop accepting them.
    const ROTATION_WINDOW_MS = 24 * 60 * 60 * 1000;
    const publicKeys = (agent.public_keys || []).map(k => ({
      ...k,
      active: false,
      deactivate_at: k.active ? Date.now() + ROTATION_WINDOW_MS : k.deactivate_at
    }));
    publicKeys.push({
      version: newVersion,
      public_key: newPublicKeyB64,
      created_at: Date.now(),
      active: true
    });

    const updated = await storage.updateAgent(agentId, {
      public_key: newPublicKeyB64,
      did: newDid,
      key_version: newVersion,
      public_keys: publicKeys,
      derivation_context: derivationContext
    });

    return {
      ...updated,
      secret_key: toBase64(keypair.privateKey)
    };
  }
}

export const agentService = new AgentService();
