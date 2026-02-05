/**
 * Group Service
 * Handles group creation, membership, and message fanout
 */

import { v4 as uuid } from 'uuid';
import { storage } from '../storage/index.js';
import { inboxService } from './inbox.service.js';

export class GroupService {
  /**
   * Create a new group
   * @param {Object} params
   * @param {string} params.name - Group name
   * @param {string} params.created_by - Agent ID of creator
   * @param {Object} params.access - Access configuration
   * @param {Object} params.settings - Group settings
   * @returns {Object} Created group
   */
  async create({ name, created_by, access = {}, settings = {} }) {
    const groupId = `group://${name.toLowerCase().replace(/\s+/g, '-')}-${uuid().slice(0, 8)}`;

    const group = {
      id: groupId,
      name,
      created_by,
      access: {
        type: access.type || 'invite-only',
        join_key_hash: access.join_key ? this.hashKey(access.join_key) : null
      },
      settings: {
        history_visible: settings.history_visible ?? true,
        max_members: settings.max_members || 50,
        message_ttl_sec: settings.message_ttl_sec || 604800 // 7 days
      },
      members: [
        {
          agent_id: created_by,
          role: 'owner',
          joined_at: Date.now()
        }
      ]
    };

    return await storage.createGroup(group);
  }

  /**
   * Get group by ID
   * @param {string} groupId
   * @returns {Object|null}
   */
  async get(groupId) {
    return await storage.getGroup(groupId);
  }

  /**
   * Update group settings
   * @param {string} groupId
   * @param {string} agentId - Agent making the update
   * @param {Object} updates
   * @returns {Object} Updated group
   */
  async update(groupId, agentId, updates) {
    await this.requireRole(groupId, agentId, ['admin', 'owner']);

    // Only allow updating certain fields
    const allowed = ['name', 'settings'];
    const filtered = {};
    for (const key of allowed) {
      if (updates[key] !== undefined) {
        filtered[key] = updates[key];
      }
    }

    return await storage.updateGroup(groupId, filtered);
  }

  /**
   * Delete group
   * @param {string} groupId
   * @param {string} agentId - Agent requesting deletion
   */
  async delete(groupId, agentId) {
    await this.requireRole(groupId, agentId, ['owner']);
    return await storage.deleteGroup(groupId);
  }

  /**
   * Add member to group (admin action)
   * @param {string} groupId
   * @param {string} adminId - Admin adding the member
   * @param {string} agentId - Agent to add
   * @param {string} role - Member role
   * @returns {Object} Updated group
   */
  async addMember(groupId, adminId, agentId, role = 'member') {
    await this.requireRole(groupId, adminId, ['admin', 'owner']);

    const group = await this.get(groupId);
    if (!group) {
      throw new Error(`Group ${groupId} not found`);
    }

    // Check max members
    if ((group.members?.length || 0) >= group.settings.max_members) {
      throw new Error(`Group has reached maximum members (${group.settings.max_members})`);
    }

    // Verify agent exists
    const agent = await storage.getAgent(agentId);
    if (!agent) {
      throw new Error(`Agent ${agentId} not found`);
    }

    return await storage.addGroupMember(groupId, {
      agent_id: agentId,
      role
    });
  }

  /**
   * Remove member from group
   * @param {string} groupId
   * @param {string} adminId - Admin removing the member
   * @param {string} agentId - Agent to remove
   * @returns {Object} Updated group
   */
  async removeMember(groupId, adminId, agentId) {
    // Can remove self or need admin
    if (adminId !== agentId) {
      await this.requireRole(groupId, adminId, ['admin', 'owner']);
    }

    const group = await this.get(groupId);
    if (!group) {
      throw new Error(`Group ${groupId} not found`);
    }

    // Can't remove owner
    const member = group.members?.find(m => m.agent_id === agentId);
    if (member?.role === 'owner') {
      throw new Error('Cannot remove group owner');
    }

    return await storage.removeGroupMember(groupId, agentId);
  }

  /**
   * Join group (for open or key-protected groups)
   * @param {string} groupId
   * @param {string} agentId
   * @param {string} key - Join key for key-protected groups
   * @returns {Object} Updated group
   */
  async join(groupId, agentId, key = null) {
    const group = await this.get(groupId);
    if (!group) {
      throw new Error(`Group ${groupId} not found`);
    }

    // Check access type
    if (group.access.type === 'invite-only') {
      throw new Error('This group is invite-only');
    }

    if (group.access.type === 'key-protected') {
      if (!key) {
        throw new Error('Join key required');
      }
      if (this.hashKey(key) !== group.access.join_key_hash) {
        throw new Error('Invalid join key');
      }
    }

    // Check max members
    if ((group.members?.length || 0) >= group.settings.max_members) {
      throw new Error(`Group has reached maximum members (${group.settings.max_members})`);
    }

    // Verify agent exists
    const agent = await storage.getAgent(agentId);
    if (!agent) {
      throw new Error(`Agent ${agentId} not found`);
    }

    return await storage.addGroupMember(groupId, {
      agent_id: agentId,
      role: 'member'
    });
  }

  /**
   * Leave group
   * @param {string} groupId
   * @param {string} agentId
   * @returns {Object} Updated group
   */
  async leave(groupId, agentId) {
    const group = await this.get(groupId);
    if (!group) {
      throw new Error(`Group ${groupId} not found`);
    }

    // Check if agent is the owner - owners cannot leave without transferring ownership
    const member = group.members?.find(m => m.agent_id === agentId);
    if (member?.role === 'owner') {
      throw new Error('Owner cannot leave group. Transfer ownership first or delete the group.');
    }

    return await this.removeMember(groupId, agentId, agentId);
  }

  /**
   * List group members
   * @param {string} groupId
   * @param {string} agentId - Requesting agent (must be member)
   * @returns {Array} Members
   */
  async listMembers(groupId, agentId) {
    await this.requireMembership(groupId, agentId);
    return await storage.getGroupMembers(groupId);
  }

  /**
   * List groups for an agent
   * @param {string} agentId
   * @returns {Array} Groups
   */
  async listForAgent(agentId) {
    return await storage.listGroups({ member: agentId });
  }

  /**
   * Post message to group (fanout to all members)
   * @param {string} groupId
   * @param {Object} envelope - ADMP message envelope
   * @returns {Object} Message info
   */
  async postMessage(groupId, envelope) {
    const group = await this.get(groupId);
    if (!group) {
      throw new Error(`Group ${groupId} not found`);
    }

    // Verify sender is a member
    await this.requireMembership(groupId, envelope.from);

    const members = group.members || [];
    const membersSnapshot = members.map(m => m.agent_id);

    // Create group message envelope with stable group_message_id for history
    const groupMessageId = envelope.id || uuid();
    const groupEnvelope = {
      ...envelope,
      id: groupMessageId,
      group_message_id: groupMessageId, // Preserved for history deduplication
      type: 'group.message',
      group_id: groupId,
      members_snapshot: membersSnapshot,
      timestamp: envelope.timestamp || new Date().toISOString()
    };

    // Fanout to all members (except sender)
    // Each member gets their own message ID to avoid storage collisions
    // but group_message_id stays the same for history correlation
    const deliveries = [];
    for (const member of members) {
      if (member.agent_id === envelope.from) {
        continue; // Don't send to self
      }

      try {
        const memberEnvelope = {
          ...groupEnvelope,
          id: uuid(), // Generate unique ID per recipient for storage
          to: member.agent_id
          // group_message_id is preserved from groupEnvelope
        };

        const message = await inboxService.send(memberEnvelope, {
          verify_signature: false // Already verified membership
        });

        deliveries.push({
          agent_id: member.agent_id,
          message_id: message.id,
          status: 'delivered'
        });
      } catch (error) {
        console.error(`[GroupService] Fanout to ${member.agent_id} failed:`, error.message);
        deliveries.push({
          agent_id: member.agent_id,
          status: 'failed',
          error: error.message
        });
      }
    }

    return {
      message_id: groupEnvelope.id,
      group_id: groupId,
      deliveries,
      delivered: deliveries.filter(d => d.status === 'delivered').length,
      failed: deliveries.filter(d => d.status === 'failed').length
    };
  }

  /**
   * Get group message history
   * @param {string} groupId
   * @param {string} agentId - Requesting agent
   * @param {Object} options
   * @returns {Array} Messages
   */
  async getMessages(groupId, agentId, options = {}) {
    const group = await this.get(groupId);
    if (!group) {
      throw new Error(`Group ${groupId} not found`);
    }

    // Check if history is visible
    if (!group.settings.history_visible) {
      throw new Error('Message history is disabled for this group');
    }

    // Verify membership
    await this.requireMembership(groupId, agentId);

    return await storage.getGroupMessages(groupId, {
      limit: options.limit || 50
    });
  }

  // ============ HELPERS ============

  /**
   * Require agent to be a member of the group
   */
  async requireMembership(groupId, agentId) {
    const isMember = await storage.isGroupMember(groupId, agentId);
    if (!isMember) {
      throw new Error(`Agent ${agentId} is not a member of ${groupId}`);
    }
  }

  /**
   * Require agent to have specific role(s)
   */
  async requireRole(groupId, agentId, roles) {
    const group = await this.get(groupId);
    if (!group) {
      throw new Error(`Group ${groupId} not found`);
    }

    const member = (group.members || []).find(m => m.agent_id === agentId);
    if (!member) {
      throw new Error(`Agent ${agentId} is not a member of ${groupId}`);
    }

    if (!roles.includes(member.role)) {
      throw new Error(`Requires ${roles.join(' or ')} role`);
    }
  }

  /**
   * Hash a join key using SHA-256
   */
  hashKey(key) {
    const crypto = require('crypto');
    return crypto.createHash('sha256').update(key).digest('hex');
  }
}

export const groupService = new GroupService();
