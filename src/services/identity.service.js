/**
 * Identity Verification Service
 * Manages verification tiers for agent identity
 *
 * Tiers:
 *   - unverified: default on registration
 *   - github: agent linked a GitHub handle (claim, no OAuth verification in Phase 1)
 *   - cryptographic: seed-based agent with DID (strongest tier)
 */

import { storage } from '../storage/index.js';

export class IdentityService {
  /**
   * Link GitHub handle to agent (sets tier to 'github')
   * @param {string} agentId
   * @param {string} githubHandle
   * @returns {Object} Updated agent
   */
  async linkGithub(agentId, githubHandle) {
    const agent = await storage.getAgent(agentId);
    if (!agent) {
      throw new Error(`Agent ${agentId} not found`);
    }

    if (!githubHandle) {
      throw new Error('github_handle is required');
    }

    return await storage.updateAgent(agentId, {
      verification_tier: 'github',
      github_handle: githubHandle
    });
  }

  /**
   * Upgrade to cryptographic verification tier
   * Requires seed-based registration + DID
   * @param {string} agentId
   * @returns {Object} Updated agent
   */
  async verifyCryptographic(agentId) {
    const agent = await storage.getAgent(agentId);
    if (!agent) {
      throw new Error(`Agent ${agentId} not found`);
    }

    if (agent.registration_mode !== 'seed') {
      throw new Error('Cryptographic verification requires seed-based registration');
    }

    if (!agent.did) {
      throw new Error('Agent must have a DID for cryptographic verification');
    }

    return await storage.updateAgent(agentId, {
      verification_tier: 'cryptographic'
    });
  }

  /**
   * Get identity verification status
   * @param {string} agentId
   * @returns {Object} Identity info
   */
  async getIdentity(agentId) {
    const agent = await storage.getAgent(agentId);
    if (!agent) {
      throw new Error(`Agent ${agentId} not found`);
    }

    return {
      agent_id: agent.agent_id,
      did: agent.did || null,
      registration_mode: agent.registration_mode || 'legacy',
      verification_tier: agent.verification_tier || 'unverified',
      key_version: agent.key_version || 1,
      github_handle: agent.github_handle || null,
      public_key: agent.public_key
    };
  }
}

export const identityService = new IdentityService();
