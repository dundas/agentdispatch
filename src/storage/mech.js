/**
 * Mech Storage backend for ADMP
 * Implements the same interface as MemoryStorage using Mech's NoSQL APIs.
 */

export class MechStorage {
  constructor({ baseUrl, appId, apiKey }) {
    this.baseUrl = (baseUrl || 'https://storage.mechdna.net').replace(/\/+$/, '');
    this.appId = appId;
    this.apiKey = apiKey;
  }

  ensureConfigured() {
    if (!this.appId || !this.apiKey) {
      throw new Error('Mech Storage is not configured. Set MECH_APP_ID and MECH_API_KEY environment variables.');
    }
  }

  get appBaseUrl() {
    return `${this.baseUrl}/api/apps/${this.appId}`;
  }

  async request(path, { method = 'GET', body, allow404 = false } = {}) {
    this.ensureConfigured();

    const url = `${this.appBaseUrl}${path}`;
    const headers = {
      'X-API-Key': this.apiKey
    };

    const init = { method, headers };

    if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(body);
    }

    const res = await fetch(url, init);
    const status = res.status;
    const text = await res.text();

    let json = null;
    if (text) {
      try {
        json = JSON.parse(text);
      } catch {
        json = null;
      }
    }

    if (status === 404 && allow404) {
      return { status, json };
    }

    if (!res.ok) {
      const message = json?.error?.message || `Mech request failed with status ${status}`;
      const error = new Error(message);
      error.status = status;
      error.code = json?.error?.code;
      throw error;
    }

    return { status, json };
  }

  extractDocument(wrapper) {
    if (!wrapper) return null;
    if (wrapper.document) return wrapper.document;
    if (wrapper.data && wrapper.data.document) return wrapper.data.document;
    return wrapper;
  }

  extractDocuments(listJson) {
    const docs = Array.isArray(listJson?.data) ? listJson.data : [];
    return docs.map(doc => (doc.document ? doc.document : doc));
  }

  // ============ AGENTS ============

  async createAgent(agent) {
    const now = Date.now();
    const stored = {
      ...agent,
      created_at: now,
      updated_at: now
    };

    await this.request('/nosql/documents', {
      method: 'POST',
      body: {
        collection_name: 'admp_agents',
        document_key: stored.agent_id,
        data: stored
      }
    });

    return stored;
  }

  async getAgent(agentId) {
    const { status, json } = await this.request(
      `/nosql/documents/key/${encodeURIComponent(agentId)}?collection_name=admp_agents`,
      { allow404: true }
    );

    if (status === 404) {
      return null;
    }

    const agentDoc = json?.data;
    const agent = this.extractDocument(agentDoc);
    return agent || null;
  }

  async updateAgent(agentId, updates) {
    const now = Date.now();
    const patch = {
      ...updates,
      updated_at: now
    };

    await this.request(`/nosql/documents/admp_agents/${encodeURIComponent(agentId)}`, {
      method: 'PUT',
      body: {
        data: patch
      }
    });

    return this.getAgent(agentId);
  }

  async deleteAgent(agentId) {
    const { status } = await this.request(
      `/nosql/documents/admp_agents/${encodeURIComponent(agentId)}`,
      { method: 'DELETE', allow404: true }
    );

    return status === 200 || status === 204;
  }

  async listAgents(filter = {}) {
    const { json } = await this.request('/nosql/documents?collection_name=admp_agents&limit=1000');
    let agents = this.extractDocuments(json);

    if (filter.status) {
      agents = agents.filter(a => a.heartbeat?.status === filter.status);
    }

    return agents;
  }

  // ============ MESSAGES / INBOX ============

  async createMessage(message) {
    const now = Date.now();
    const stored = {
      ...message,
      created_at: now,
      updated_at: now
    };

    await this.request('/nosql/documents', {
      method: 'POST',
      body: {
        collection_name: 'admp_messages',
        document_key: stored.id,
        data: stored
      }
    });

    return stored;
  }

  async getMessage(messageId) {
    const { status, json } = await this.request(
      `/nosql/documents/key/${encodeURIComponent(messageId)}?collection_name=admp_messages`,
      { allow404: true }
    );

    if (status === 404) {
      return null;
    }

    const msgDoc = json?.data;
    const message = this.extractDocument(msgDoc);
    return message || null;
  }

  async updateMessage(messageId, updates) {
    const now = Date.now();
    const patch = {
      ...updates,
      updated_at: now
    };

    await this.request(`/nosql/documents/admp_messages/${encodeURIComponent(messageId)}`, {
      method: 'PUT',
      body: {
        data: patch
      }
    });

    return this.getMessage(messageId);
  }

  async deleteMessage(messageId) {
    const { status } = await this.request(
      `/nosql/documents/admp_messages/${encodeURIComponent(messageId)}`,
      { method: 'DELETE', allow404: true }
    );

    return status === 200 || status === 204;
  }

  async getInbox(agentId, status = null) {
    const { json } = await this.request('/nosql/documents?collection_name=admp_messages&limit=1000');
    let messages = this.extractDocuments(json).filter(m => m.to_agent_id === agentId);

    if (status) {
      messages = messages.filter(m => m.status === status);
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

  // ============ CLEANUP / STATS ============

  async expireLeases() {
    const now = Date.now();
    const { json } = await this.request('/nosql/documents?collection_name=admp_messages&limit=1000');
    const messages = this.extractDocuments(json);

    let expired = 0;

    for (const message of messages) {
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
    const { json } = await this.request('/nosql/documents?collection_name=admp_messages&limit=1000');
    const messages = this.extractDocuments(json);

    let expired = 0;

    for (const message of messages) {
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
    const { json } = await this.request('/nosql/documents?collection_name=admp_messages&limit=1000');
    const messages = this.extractDocuments(json);

    let deleted = 0;

    for (const message of messages) {
      if (message.status === 'expired' || message.status === 'acked') {
        const age = Date.now() - message.updated_at;
        if (age > 3600000) {
          const removed = await this.deleteMessage(message.id);
          if (removed) {
            deleted++;
          }
        }
      }
    }

    return deleted;
  }

  async getStats() {
    const { json: agentsJson } = await this.request('/nosql/documents?collection_name=admp_agents&limit=1000');
    const { json: messagesJson } = await this.request('/nosql/documents?collection_name=admp_messages&limit=1000');

    const agents = this.extractDocuments(agentsJson);
    const messages = this.extractDocuments(messagesJson);

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

export function createMechStorage() {
  return new MechStorage({
    baseUrl: process.env.MECH_BASE_URL,
    appId: process.env.MECH_APP_ID,
    apiKey: process.env.MECH_API_KEY
  });
}
