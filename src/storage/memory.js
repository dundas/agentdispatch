/**
 * In-memory storage for ADMP
 * Can be easily swapped with database implementation
 */

export class MemoryStorage {
  constructor() {
    this.agents = new Map();        // agent_id -> agent object
    this.messages = new Map();      // message_id -> message object
    this.inboxes = new Map();       // agent_id -> message_id[]
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
    const agents = Array.from(this.agents.values());

    if (filter.status) {
      return agents.filter(a => a.heartbeat?.status === filter.status);
    }

    return agents;
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

  // ============ STATS ============

  async getStats() {
    const agents = Array.from(this.agents.values());
    const messages = Array.from(this.messages.values());

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
        expired: messages.filter(m => m.status === 'expired').length
      }
    };
  }
}

// Singleton instance
export const storage = new MemoryStorage();
