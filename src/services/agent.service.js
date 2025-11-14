/**
 * Agent Service
 * Handles agent registration, heartbeat, and lifecycle
 */

import { v4 as uuid } from 'uuid';
import { generateKeypair, toBase64 } from '../utils/crypto.js';
import { storage } from '../storage/memory.js';

export class AgentService {
  /**
   * Register a new agent
   * @param {Object} params
   * @param {string} params.agent_id - Optional custom agent ID
   * @param {string} params.agent_type - Type of agent (e.g., 'claude_session')
   * @param {Object} params.metadata - Agent metadata
   * @param {string} params.webhook_url - Optional webhook URL for push delivery
   * @param {string} params.webhook_secret - Optional webhook secret for signing
   * @returns {Object} Agent with keypair
   */
  async register({ agent_id, agent_type = 'generic', metadata = {}, webhook_url, webhook_secret }) {
    // Generate agent_id if not provided
    if (!agent_id) {
      agent_id = `agent://agent-${uuid()}`;
    }

    // Check if agent already exists
    const existing = await storage.getAgent(agent_id);
    if (existing) {
      throw new Error(`Agent ${agent_id} already exists`);
    }

    // Generate Ed25519 keypair
    const keypair = generateKeypair();

    // Generate webhook secret if URL provided but no secret
    if (webhook_url && !webhook_secret) {
      webhook_secret = toBase64(generateKeypair().publicKey).substring(0, 32);
    }

    const agent = {
      agent_id,
      agent_type,
      public_key: toBase64(keypair.publicKey),
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

    await storage.createAgent(agent);

    return {
      ...agent,
      secret_key: toBase64(keypair.secretKey)  // Only returned on registration
    };
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
}

export const agentService = new AgentService();
