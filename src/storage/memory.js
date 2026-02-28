/**
 * In-memory storage for ADMP
 * Can be easily swapped with database implementation
 */

export class MemoryStorage {
  constructor() {
    this.agents = new Map();        // agent_id -> agent object
    this.messages = new Map();      // message_id -> message object
    this.inboxes = new Map();       // agent_id -> message_id[]
    this.groups = new Map();        // group_id -> group object
    this.domains = new Map();       // agent_id -> domain config
    this.outboxMessages = new Map(); // message_id -> outbox message
    this.outboxes = new Map();      // agent_id -> message_id[]
    this.tenants = new Map();       // tenant_id -> tenant object
    this.issuedKeys = new Map();    // key_id -> key object
    this.issuedKeysByHash = new Map(); // key_hash -> key_id
    this.roundTables = new Map();   // round_table_id -> round table object
  }

  // ============ AGENTS ============

  async createAgent(agent) {
    this.agents.set(agent.agent_id, {
      ...agent,
      created_at: Date.now(),
      updated_at: Date.now()
    });
    this.inboxes.set(agent.agent_id, []);
    return agent;
  }

  async getAgent(agentId) {
    return this.agents.get(agentId) || null;
  }

  async updateAgent(agentId, updates) {
    const agent = this.agents.get(agentId);
    if (!agent) return null;

    const updated = {
      ...agent,
      ...updates,
      updated_at: Date.now()
    };
    this.agents.set(agentId, updated);
    return updated;
  }

  async deleteAgent(agentId) {
    this.agents.delete(agentId);
    this.inboxes.delete(agentId);
    return true;
  }

  async listAgents(filter = {}) {
    let agents = Array.from(this.agents.values());

    if (filter.status) {
      agents = agents.filter(a => a.heartbeat?.status === filter.status);
    }

    if (filter.registration_status) {
      agents = agents.filter(a => a.registration_status === filter.registration_status);
    }

    if (filter.tenant_id) {
      agents = agents.filter(a => a.tenant_id === filter.tenant_id);
    }

    return agents;
  }

  async getAgentByDid(did) {
    for (const agent of this.agents.values()) {
      if (agent.did === did) return agent;
    }
    return null;
  }

  // ============ TENANTS ============

  async createTenant(tenant) {
    const now = Date.now();
    const stored = {
      ...tenant,
      created_at: now,
      updated_at: now
    };
    this.tenants.set(tenant.tenant_id, stored);
    return stored;
  }

  async getTenant(tenantId) {
    return this.tenants.get(tenantId) || null;
  }

  async updateTenant(tenantId, updates) {
    const tenant = this.tenants.get(tenantId);
    if (!tenant) return null;

    const updated = {
      ...tenant,
      ...updates,
      updated_at: Date.now()
    };
    this.tenants.set(tenantId, updated);
    return updated;
  }

  async deleteTenant(tenantId) {
    this.tenants.delete(tenantId);
    return true;
  }

  async listTenants() {
    return Array.from(this.tenants.values());
  }

  async getAgentsByTenant(tenantId) {
    return Array.from(this.agents.values()).filter(a => a.tenant_id === tenantId);
  }

  // ============ MESSAGES ============

  async createMessage(message) {
    const stored = {
      ...message,
      created_at: Date.now(),
      updated_at: Date.now()
    };

    this.messages.set(message.id, stored);

    // Add to recipient's inbox
    const inbox = this.inboxes.get(message.to_agent_id) || [];
    inbox.push(message.id);
    this.inboxes.set(message.to_agent_id, inbox);

    return stored;
  }

  async getMessage(messageId) {
    return this.messages.get(messageId) || null;
  }

  async updateMessage(messageId, updates) {
    const message = this.messages.get(messageId);
    if (!message) return null;

    const updated = {
      ...message,
      ...updates,
      updated_at: Date.now()
    };
    this.messages.set(messageId, updated);
    return updated;
  }

  async deleteMessage(messageId) {
    const message = this.messages.get(messageId);
    if (!message) return false;

    // Remove from inbox
    const inbox = this.inboxes.get(message.to_agent_id) || [];
    const filtered = inbox.filter(id => id !== messageId);
    this.inboxes.set(message.to_agent_id, filtered);

    this.messages.delete(messageId);
    return true;
  }

  async getInbox(agentId, status = null) {
    const messageIds = this.inboxes.get(agentId) || [];
    const messages = messageIds
      .map(id => this.messages.get(id))
      .filter(m => m !== undefined);

    if (status) {
      return messages.filter(m => m.status === status);
    }

    return messages;
  }

  async getInboxStats(agentId) {
    const messages = await this.getInbox(agentId);

    return {
      total: messages.length,
      queued: messages.filter(m => m.status === 'queued').length,
      leased: messages.filter(m => m.status === 'leased').length,
      acked: messages.filter(m => m.status === 'acked').length,
      failed: messages.filter(m => m.status === 'failed').length
    };
  }

  // ============ CLEANUP ============

  async expireLeases() {
    const now = Date.now();
    let expired = 0;

    for (const message of this.messages.values()) {
      if (message.status === 'leased' && message.lease_until && message.lease_until < now) {
        await this.updateMessage(message.id, {
          status: 'queued',
          lease_until: null
        });
        expired++;
      }
    }

    return expired;
  }

  async expireMessages() {
    const now = Date.now();
    let expired = 0;

    for (const message of this.messages.values()) {
      const age = now - message.created_at;
      const ttl = message.ttl_sec * 1000;

      if (age > ttl) {
        await this.updateMessage(message.id, {
          status: 'expired'
        });
        expired++;
      }
    }

    return expired;
  }

  async cleanupExpiredMessages() {
    const messages = Array.from(this.messages.values());
    let deleted = 0;

    for (const message of messages) {
      if (message.status === 'expired' || message.status === 'acked') {
        const age = Date.now() - message.updated_at;
        // Keep for 1 hour after ack/expire
        if (age > 3600000) {
          await this.deleteMessage(message.id);
          deleted++;
        }
      }
    }

    return deleted;
  }

  async purgeExpiredEphemeralMessages() {
    const now = Date.now();
    let purged = 0;

    for (const message of this.messages.values()) {
      // Only purge messages with an expires_at that haven't been purged already
      if (message.expires_at && message.expires_at < now && message.status !== 'purged') {
        // Strip body from envelope
        const purgedEnvelope = { ...message.envelope };
        delete purgedEnvelope.body;

        await this.updateMessage(message.id, {
          status: 'purged',
          envelope: purgedEnvelope,
          purged_at: now,
          purge_reason: 'ttl_expired'
        });
        purged++;
      }
    }

    return purged;
  }

  // ============ STATS ============

  async getStats() {
    const agents = Array.from(this.agents.values());
    const messages = Array.from(this.messages.values());
    const groups = Array.from(this.groups.values());

    return {
      agents: {
        total: agents.length,
        online: agents.filter(a => a.heartbeat?.status === 'online').length,
        offline: agents.filter(a => a.heartbeat?.status === 'offline').length
      },
      messages: {
        total: messages.length,
        queued: messages.filter(m => m.status === 'queued').length,
        leased: messages.filter(m => m.status === 'leased').length,
        acked: messages.filter(m => m.status === 'acked').length,
        failed: messages.filter(m => m.status === 'failed').length,
        expired: messages.filter(m => m.status === 'expired').length,
        purged: messages.filter(m => m.status === 'purged').length
      },
      groups: {
        total: groups.length
      }
    };
  }

  // ============ GROUPS ============

  async createGroup(group) {
    const stored = {
      ...group,
      created_at: Date.now(),
      updated_at: Date.now()
    };
    this.groups.set(group.id, stored);
    return stored;
  }

  async getGroup(groupId) {
    return this.groups.get(groupId) || null;
  }

  async updateGroup(groupId, updates) {
    const group = this.groups.get(groupId);
    if (!group) return null;

    const updated = {
      ...group,
      ...updates,
      updated_at: Date.now()
    };
    this.groups.set(groupId, updated);
    return updated;
  }

  async deleteGroup(groupId) {
    this.groups.delete(groupId);
    return true;
  }

  async listGroups(filter = {}) {
    let groups = Array.from(this.groups.values());

    if (filter.member) {
      groups = groups.filter(g => g.members?.some(m => m.agent_id === filter.member));
    }

    return groups;
  }

  // ============ GROUP MEMBERS ============

  async addGroupMember(groupId, member) {
    const group = this.groups.get(groupId);
    if (!group) {
      throw new Error(`Group ${groupId} not found`);
    }

    const members = group.members || [];

    if (members.some(m => m.agent_id === member.agent_id)) {
      throw new Error(`Agent ${member.agent_id} is already a member`);
    }

    const newMember = {
      ...member,
      joined_at: Date.now()
    };

    members.push(newMember);

    return this.updateGroup(groupId, { members });
  }

  async removeGroupMember(groupId, agentId) {
    const group = this.groups.get(groupId);
    if (!group) {
      throw new Error(`Group ${groupId} not found`);
    }

    const members = (group.members || []).filter(m => m.agent_id !== agentId);

    return this.updateGroup(groupId, { members });
  }

  async getGroupMembers(groupId) {
    const group = this.groups.get(groupId);
    if (!group) {
      throw new Error(`Group ${groupId} not found`);
    }

    return group.members || [];
  }

  async isGroupMember(groupId, agentId) {
    const group = this.groups.get(groupId);
    if (!group) {
      return false;
    }

    return (group.members || []).some(m => m.agent_id === agentId);
  }

  // ============ GROUP MESSAGES ============

  async getGroupMessages(groupId, options = {}) {
    // Group messages are stored in regular messages with group_id in envelope
    let messages = Array.from(this.messages.values()).filter(m =>
      m.group_id === groupId || m.envelope?.group_id === groupId
    );

    // Deduplicate by group_message_id (each group post is fanned out to multiple recipients)
    const seen = new Set();
    messages = messages.filter(m => {
      const groupMsgId = m.envelope?.group_message_id || m.group_message_id || m.id;
      if (seen.has(groupMsgId)) {
        return false;
      }
      seen.add(groupMsgId);
      return true;
    });

    // Sort by timestamp descending (newest first)
    messages.sort((a, b) => b.created_at - a.created_at);

    // Apply limit
    if (options.limit) {
      messages = messages.slice(0, options.limit);
    }

    // Return envelope data for history view
    return messages.map(m => ({
      id: m.envelope?.group_message_id || m.group_message_id || m.id,
      from: m.from_agent_id,
      subject: m.envelope?.subject,
      body: m.envelope?.body,
      timestamp: m.envelope?.timestamp || m.created_at,
      group_id: m.envelope?.group_id || m.group_id
    }));
  }

  // ============ DOMAINS ============

  async setDomainConfig(agentId, config) {
    const stored = {
      ...config,
      agent_id: agentId,
      updated_at: Date.now()
    };
    if (!this.domains.has(agentId)) {
      stored.created_at = Date.now();
    } else {
      stored.created_at = this.domains.get(agentId).created_at;
    }
    this.domains.set(agentId, stored);
    return stored;
  }

  async getDomainConfig(agentId) {
    return this.domains.get(agentId) || null;
  }

  async deleteDomainConfig(agentId) {
    this.domains.delete(agentId);
    return true;
  }

  // ============ ISSUED API KEYS ============

  async createIssuedKey(key) {
    const stored = { ...key, created_at: key.created_at || Date.now() };
    this.issuedKeys.set(key.key_id, stored);
    this.issuedKeysByHash.set(key.key_hash, key.key_id);
    return stored;
  }

  async getIssuedKey(keyId) {
    return this.issuedKeys.get(keyId) || null;
  }

  async getIssuedKeyByHash(keyHash) {
    const keyId = this.issuedKeysByHash.get(keyHash);
    if (!keyId) return null;
    return this.issuedKeys.get(keyId) || null;
  }

  async listIssuedKeys() {
    return Array.from(this.issuedKeys.values());
  }

  async revokeIssuedKey(keyId) {
    const key = this.issuedKeys.get(keyId);
    if (!key) return false;
    const updated = { ...key, revoked: true, revoked_at: Date.now() };
    this.issuedKeys.set(keyId, updated);
    return true;
  }

  async updateIssuedKey(keyId, updates) {
    const key = this.issuedKeys.get(keyId);
    if (!key) return null;
    const updated = { ...key, ...updates };
    this.issuedKeys.set(keyId, updated);
    return updated;
  }

  /**
   * Atomically burn a single-use token: sets used_at only if it is currently null.
   * Returns true if this call burned the token, false if it was already burned.
   * Eliminates TOCTOU race where two concurrent requests both pass the used_at check.
   */
  async burnSingleUseKey(keyId) {
    const key = this.issuedKeys.get(keyId);
    if (!key || key.used_at) return false;
    this.issuedKeys.set(keyId, { ...key, used_at: Date.now() });
    return true;
  }

  // ============ OUTBOX ============

  async createOutboxMessage(message) {
    const stored = {
      ...message,
      created_at: Date.now(),
      updated_at: Date.now()
    };
    this.outboxMessages.set(message.id, stored);

    const outbox = this.outboxes.get(message.agent_id) || [];
    outbox.push(message.id);
    this.outboxes.set(message.agent_id, outbox);

    return stored;
  }

  async getOutboxMessage(messageId) {
    return this.outboxMessages.get(messageId) || null;
  }

  async updateOutboxMessage(messageId, updates) {
    const message = this.outboxMessages.get(messageId);
    if (!message) return null;

    const updated = {
      ...message,
      ...updates,
      updated_at: Date.now()
    };
    this.outboxMessages.set(messageId, updated);
    return updated;
  }

  async findOutboxMessageByMailgunId(mailgunId) {
    for (const msg of this.outboxMessages.values()) {
      if (msg.mailgun_id === mailgunId) {
        return msg;
      }
    }
    return null;
  }

  async getOutboxMessages(agentId, options = {}) {
    const messageIds = this.outboxes.get(agentId) || [];
    let messages = messageIds
      .map(id => this.outboxMessages.get(id))
      .filter(m => m !== undefined);

    if (options.status) {
      messages = messages.filter(m => m.status === options.status);
    }

    // Sort newest first
    messages.sort((a, b) => b.created_at - a.created_at);

    if (options.limit) {
      messages = messages.slice(0, options.limit);
    }

    return messages;
  }

  // ============ ROUND TABLES ============

  async createRoundTable(rt) {
    const stored = { ...rt, created_at: rt.created_at || new Date().toISOString(), updated_at: new Date().toISOString() };
    this.roundTables.set(rt.id, stored);
    return stored;
  }

  async getRoundTable(id) {
    return this.roundTables.get(id) || null;
  }

  async updateRoundTable(id, updates) {
    const rt = this.roundTables.get(id);
    if (!rt) return null;
    const updated = { ...rt, ...updates, updated_at: new Date().toISOString() };
    this.roundTables.set(id, updated);
    return updated;
  }

  async listRoundTables(filter = {}) {
    let tables = Array.from(this.roundTables.values());
    if (filter.status) {
      tables = tables.filter(rt => rt.status === filter.status);
    }
    if (filter.participant) {
      tables = tables.filter(rt =>
        rt.facilitator === filter.participant ||
        (rt.participants || []).includes(filter.participant)
      );
    }
    return tables;
  }
}

// Singleton instance
export const storage = new MemoryStorage();
