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

    if (filter.registration_status) {
      agents = agents.filter(a => a.registration_status === filter.registration_status);
    }

    if (filter.tenant_id) {
      agents = agents.filter(a => a.tenant_id === filter.tenant_id);
    }

    return agents;
  }

  async getAgentByDid(did) {
    const { json } = await this.request('/nosql/documents?collection_name=admp_agents&limit=1000');
    const agents = this.extractDocuments(json);
    return agents.find(a => a.did === did) || null;
  }

  // ============ TENANTS ============

  async createTenant(tenant) {
    const now = Date.now();
    const stored = {
      ...tenant,
      created_at: now,
      updated_at: now
    };

    await this.request('/nosql/documents', {
      method: 'POST',
      body: {
        collection_name: 'admp_tenants',
        document_key: stored.tenant_id,
        data: stored
      }
    });

    return stored;
  }

  async getTenant(tenantId) {
    const { status, json } = await this.request(
      `/nosql/documents/key/${encodeURIComponent(tenantId)}?collection_name=admp_tenants`,
      { allow404: true }
    );

    if (status === 404) return null;

    const doc = json?.data;
    return this.extractDocument(doc) || null;
  }

  async updateTenant(tenantId, updates) {
    const now = Date.now();
    const patch = {
      ...updates,
      updated_at: now
    };

    await this.request(`/nosql/documents/admp_tenants/${encodeURIComponent(tenantId)}`, {
      method: 'PUT',
      body: { data: patch }
    });

    return this.getTenant(tenantId);
  }

  async deleteTenant(tenantId) {
    const { status } = await this.request(
      `/nosql/documents/admp_tenants/${encodeURIComponent(tenantId)}`,
      { method: 'DELETE', allow404: true }
    );
    return status === 200 || status === 204;
  }

  async listTenants() {
    const { json } = await this.request('/nosql/documents?collection_name=admp_tenants&limit=1000');
    return this.extractDocuments(json);
  }

  async getAgentsByTenant(tenantId) {
    const { json } = await this.request('/nosql/documents?collection_name=admp_agents&limit=1000');
    const agents = this.extractDocuments(json);
    return agents.filter(a => a.tenant_id === tenantId);
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

  // TODO: The limit=1000 cap applies to all message list operations (purge, expire,
  // cleanup). Messages beyond the 1000th won't be processed in a single sweep.
  // For high-volume deployments, implement pagination or storage-side filtering.
  async purgeExpiredEphemeralMessages() {
    const now = Date.now();
    const { json } = await this.request('/nosql/documents?collection_name=admp_messages&limit=1000');
    const messages = this.extractDocuments(json);

    let purged = 0;

    for (const message of messages) {
      if (message.expires_at && message.expires_at < now && message.status !== 'purged') {
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

  async getStats() {
    const { json: agentsJson } = await this.request('/nosql/documents?collection_name=admp_agents&limit=1000');
    const { json: messagesJson } = await this.request('/nosql/documents?collection_name=admp_messages&limit=1000');
    const { json: groupsJson } = await this.request('/nosql/documents?collection_name=admp_groups&limit=1000');

    const agents = this.extractDocuments(agentsJson);
    const messages = this.extractDocuments(messagesJson);
    const groups = this.extractDocuments(groupsJson);

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
    const now = Date.now();
    const stored = {
      ...group,
      created_at: now,
      updated_at: now
    };

    await this.request('/nosql/documents', {
      method: 'POST',
      body: {
        collection_name: 'admp_groups',
        document_key: stored.id,
        data: stored
      }
    });

    return stored;
  }

  async getGroup(groupId) {
    const { status, json } = await this.request(
      `/nosql/documents/key/${encodeURIComponent(groupId)}?collection_name=admp_groups`,
      { allow404: true }
    );

    if (status === 404) {
      return null;
    }

    const groupDoc = json?.data;
    const group = this.extractDocument(groupDoc);
    return group || null;
  }

  async updateGroup(groupId, updates) {
    const now = Date.now();
    const patch = {
      ...updates,
      updated_at: now
    };

    await this.request(`/nosql/documents/admp_groups/${encodeURIComponent(groupId)}`, {
      method: 'PUT',
      body: {
        data: patch
      }
    });

    return this.getGroup(groupId);
  }

  async deleteGroup(groupId) {
    const { status } = await this.request(
      `/nosql/documents/admp_groups/${encodeURIComponent(groupId)}`,
      { method: 'DELETE', allow404: true }
    );

    return status === 200 || status === 204;
  }

  async listGroups(filter = {}) {
    const { json } = await this.request('/nosql/documents?collection_name=admp_groups&limit=1000');
    let groups = this.extractDocuments(json);

    if (filter.member) {
      groups = groups.filter(g => g.members?.some(m => m.agent_id === filter.member));
    }

    return groups;
  }

  // ============ GROUP MEMBERS ============

  async addGroupMember(groupId, member) {
    const group = await this.getGroup(groupId);
    if (!group) {
      throw new Error(`Group ${groupId} not found`);
    }

    const members = group.members || [];

    // Check if already a member
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
    const group = await this.getGroup(groupId);
    if (!group) {
      throw new Error(`Group ${groupId} not found`);
    }

    const members = (group.members || []).filter(m => m.agent_id !== agentId);

    return this.updateGroup(groupId, { members });
  }

  async getGroupMembers(groupId) {
    const group = await this.getGroup(groupId);
    if (!group) {
      throw new Error(`Group ${groupId} not found`);
    }

    return group.members || [];
  }

  async isGroupMember(groupId, agentId) {
    const group = await this.getGroup(groupId);
    if (!group) {
      return false;
    }

    return (group.members || []).some(m => m.agent_id === agentId);
  }

  // ============ GROUP MESSAGES ============

  async getGroupMessages(groupId, options = {}) {
    const { json } = await this.request('/nosql/documents?collection_name=admp_messages&limit=1000');
    // group_id is stored in the envelope, not at top level
    let messages = this.extractDocuments(json).filter(m =>
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
    const now = Date.now();
    const existing = await this.getDomainConfig(agentId);

    const stored = {
      ...config,
      agent_id: agentId,
      created_at: existing?.created_at || now,
      updated_at: now
    };

    if (existing) {
      await this.request(`/nosql/documents/admp_domains/${encodeURIComponent(agentId)}`, {
        method: 'PUT',
        body: { data: stored }
      });
    } else {
      await this.request('/nosql/documents', {
        method: 'POST',
        body: {
          collection_name: 'admp_domains',
          document_key: agentId,
          data: stored
        }
      });
    }

    return stored;
  }

  async getDomainConfig(agentId) {
    const { status, json } = await this.request(
      `/nosql/documents/key/${encodeURIComponent(agentId)}?collection_name=admp_domains`,
      { allow404: true }
    );

    if (status === 404) return null;

    const doc = json?.data;
    return this.extractDocument(doc) || null;
  }

  async deleteDomainConfig(agentId) {
    const { status } = await this.request(
      `/nosql/documents/admp_domains/${encodeURIComponent(agentId)}`,
      { method: 'DELETE', allow404: true }
    );
    return status === 200 || status === 204;
  }

  // ============ ISSUED API KEYS ============

  async createIssuedKey(key) {
    const stored = { ...key, created_at: key.created_at || Date.now() };
    await this.request('/nosql/documents', {
      method: 'POST',
      body: {
        collection_name: 'admp_api_keys',
        document_key: stored.key_id,
        data: stored
      }
    });
    // Write a hash-indexed pointer document for O(1) getIssuedKeyByHash lookups.
    // The pointer only stores the key_id; revocation/expiry is checked on the primary record.
    await this.request('/nosql/documents', {
      method: 'POST',
      body: {
        collection_name: 'admp_api_key_hashes',
        document_key: stored.key_hash,
        data: { key_id: stored.key_id }
      }
    });
    return stored;
  }

  async getIssuedKey(keyId) {
    const { status, json } = await this.request(
      `/nosql/documents/key/${encodeURIComponent(keyId)}?collection_name=admp_api_keys`,
      { allow404: true }
    );
    if (status === 404) return null;
    return this.extractDocument(json?.data) || null;
  }

  async getIssuedKeyByHash(keyHash) {
    // O(1) lookup via hash-index collection (written in createIssuedKey).
    // Falls back to full scan if the index doesn't exist (e.g. keys created before this change).
    const { status: idxStatus, json: idxJson } = await this.request(
      `/nosql/documents/key/${encodeURIComponent(keyHash)}?collection_name=admp_api_key_hashes`,
      { allow404: true }
    );
    if (idxStatus !== 404) {
      const pointer = this.extractDocument(idxJson?.data);
      if (pointer?.key_id) {
        return this.getIssuedKey(pointer.key_id);
      }
    }
    // Fallback: linear scan (catches pre-index keys; remove once all keys are re-issued)
    // If this warning fires, re-issue API keys so the hash index gets populated.
    console.warn('[mech] admp_api_key_hashes index miss — falling back to linear scan. Re-issue API keys to rebuild the index.');
    const { json } = await this.request('/nosql/documents?collection_name=admp_api_keys&limit=1000');
    const keys = this.extractDocuments(json);
    return keys.find(k => k.key_hash === keyHash) || null;
  }

  async listIssuedKeys() {
    const { json } = await this.request('/nosql/documents?collection_name=admp_api_keys&limit=1000');
    return this.extractDocuments(json);
  }

  async revokeIssuedKey(keyId) {
    const key = await this.getIssuedKey(keyId);
    if (!key) return false;
    // Mech API uses different URL forms per operation:
    //   GET  → /nosql/documents/key/:key?collection_name=...  (query-param format)
    //   PUT  → /nosql/documents/:collection/:key              (path-segment format)
    // this.request() throws on non-2xx, so reaching `return true` implies success.
    await this.request(`/nosql/documents/admp_api_keys/${encodeURIComponent(keyId)}`, {
      method: 'PUT',
      body: { data: { ...key, revoked: true, revoked_at: Date.now() } }
    });
    return true;
  }

  async updateIssuedKey(keyId, updates) {
    const key = await this.getIssuedKey(keyId);
    if (!key) return null;
    const updated = { ...key, ...updates };
    // See revokeIssuedKey for note on Mech URL format difference between GET and PUT.
    await this.request(`/nosql/documents/admp_api_keys/${encodeURIComponent(keyId)}`, {
      method: 'PUT',
      body: { data: updated }
    });
    return updated;
  }

  /**
   * Atomically burn a single-use token: sets used_at only if it is currently null.
   * Returns true if this call burned the token, false if it was already burned.
   *
   * NOTE: Mech backend does not support conditional writes natively, so this uses
   * read-then-conditional-write. The race window is narrower than the old
   * unconditional write (we reject if used_at is already set after re-read),
   * but is not fully atomic. For true atomicity, migrate to a backend that
   * supports conditional updates (e.g. PostgreSQL WHERE used_at IS NULL).
   */
  async burnSingleUseKey(keyId) {
    const key = await this.getIssuedKey(keyId);
    if (!key || key.used_at) return false;
    const updated = { ...key, used_at: Date.now() };
    await this.request(`/nosql/documents/admp_api_keys/${encodeURIComponent(keyId)}`, {
      method: 'PUT',
      body: { data: updated }
    });
    return true;
  }

  // ============ OUTBOX ============

  async createOutboxMessage(message) {
    const now = Date.now();
    const stored = {
      ...message,
      created_at: now,
      updated_at: now
    };

    await this.request('/nosql/documents', {
      method: 'POST',
      body: {
        collection_name: 'admp_outbox',
        document_key: stored.id,
        data: stored
      }
    });

    return stored;
  }

  async getOutboxMessage(messageId) {
    const { status, json } = await this.request(
      `/nosql/documents/key/${encodeURIComponent(messageId)}?collection_name=admp_outbox`,
      { allow404: true }
    );

    if (status === 404) return null;

    const doc = json?.data;
    return this.extractDocument(doc) || null;
  }

  async updateOutboxMessage(messageId, updates) {
    // Fetch-then-merge to avoid losing fields on PUT (Mech replaces the document)
    const existing = await this.getOutboxMessage(messageId);
    if (!existing) return null;

    const merged = {
      ...existing,
      ...updates,
      updated_at: Date.now()
    };

    await this.request(`/nosql/documents/admp_outbox/${encodeURIComponent(messageId)}`, {
      method: 'PUT',
      body: { data: merged }
    });

    return merged;
  }

  async findOutboxMessageByMailgunId(mailgunId) {
    const { json } = await this.request('/nosql/documents?collection_name=admp_outbox&limit=1000');
    const messages = this.extractDocuments(json);

    for (const msg of messages) {
      if (msg.mailgun_id === mailgunId) {
        return msg;
      }
    }

    return null;
  }

  async getOutboxMessages(agentId, options = {}) {
    const { json } = await this.request('/nosql/documents?collection_name=admp_outbox&limit=1000');
    let messages = this.extractDocuments(json).filter(m => m.agent_id === agentId);

    if (options.status) {
      messages = messages.filter(m => m.status === options.status);
    }

    messages.sort((a, b) => b.created_at - a.created_at);

    if (options.limit) {
      messages = messages.slice(0, options.limit);
    }

    return messages;
  }
}

export function createMechStorage() {
  return new MechStorage({
    baseUrl: process.env.MECH_BASE_URL,
    appId: process.env.MECH_APP_ID,
    apiKey: process.env.MECH_API_KEY
  });
}
