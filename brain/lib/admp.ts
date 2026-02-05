/**
 * AgentDispatch (ADMP) Integration for Brains
 *
 * Handles agent registration, channel subscriptions, and messaging.
 */

import nacl from 'tweetnacl';
import { encodeBase64, decodeUTF8, decodeBase64 } from 'tweetnacl-util';

interface ADMPConfig {
  hubUrl: string;
  agentId: string;
  agentType: string;
  webhookUrl?: string;
  /** Pre-existing secret key (base64) for resumed sessions */
  secretKey?: string;
  /** Pre-existing public key (base64) for resumed sessions */
  publicKey?: string;
}

interface InboxMessage {
  id: string;
  from: string;
  to: string;
  subject: string;
  body: any;
  timestamp: string;
  type: string;
  lease_id?: string;
  lease_expires_at?: string;
}

interface PullOptions {
  /** Number of messages to pull (default: 1) */
  limit?: number;
  /** Visibility timeout in seconds (default: 30) */
  visibility_timeout?: number;
}

interface NackOptions {
  /** Delay before message is visible again (seconds) */
  delay?: number;
  /** Whether to send to dead-letter queue instead of requeue */
  dead_letter?: boolean;
}

interface InboxStats {
  pending: number;
  in_flight: number;
  dead_letter: number;
  total_received: number;
  total_processed: number;
}

interface ADMPMessage {
  version: string;
  id: string;
  type: string;
  from: string;
  to: string;
  subject: string;
  body: any;
  timestamp: string;
  ttl_sec?: number;
  correlation_id?: string;
  signature?: {
    alg: string;
    kid: string;
    sig: string;
  };
}

export class ADMPClient {
  private config: ADMPConfig;
  private secretKey?: Uint8Array;
  private publicKey?: Uint8Array;

  constructor(config: ADMPConfig) {
    this.config = config;
  }

  /**
   * Register agent in AgentDispatch
   */
  async register(): Promise<{ agent_id: string; secret_key: string }> {
    const response = await fetch(`${this.config.hubUrl}/api/agents/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        agent_type: this.config.agentType,
        metadata: {
          name: this.config.agentId,
          registered_at: new Date().toISOString()
        },
        webhook_url: this.config.webhookUrl
      })
    });

    if (!response.ok) {
      throw new Error(`Registration failed: ${await response.text()}`);
    }

    const data = await response.json();

    // Store keys
    this.secretKey = decodeBase64(data.secret_key);
    this.publicKey = decodeBase64(data.public_key);

    console.log(`✅ Registered as ${data.agent_id}`);

    return data;
  }

  /**
   * Send heartbeat to keep agent alive
   */
  async heartbeat(metadata?: any): Promise<void> {
    await fetch(`${this.config.hubUrl}/api/agents/${this.config.agentId}/heartbeat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ metadata })
    });
  }

  /**
   * Subscribe to channel
   */
  async subscribeToChannel(channelId: string): Promise<void> {
    await fetch(`${this.config.hubUrl}/api/channels/${channelId}/subscribe`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        agent_id: this.config.agentId
      })
    });

    console.log(`✅ Subscribed to ${channelId}`);
  }

  /**
   * Send message to another agent
   */
  async sendMessage(params: {
    to: string;
    subject: string;
    body: any;
    type?: string;
  }): Promise<void> {
    const message: ADMPMessage = {
      version: '1.0',
      id: crypto.randomUUID(),
      type: params.type || 'notification',
      from: this.config.agentId,
      to: params.to,
      subject: params.subject,
      body: params.body,
      timestamp: new Date().toISOString(),
      ttl_sec: 86400, // 24 hours
    };

    // Sign message if we have keys
    if (this.secretKey) {
      message.signature = this.signMessage(message);
    }

    await fetch(`${this.config.hubUrl}/api/agents/${params.to}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(message)
    });
  }

  /**
   * Post to channel (broadcasts to all subscribers)
   */
  async postToChannel(params: {
    channel: string;
    subject: string;
    body: any;
  }): Promise<void> {
    await this.sendMessage({
      to: params.channel,
      subject: params.subject,
      body: params.body,
      type: 'channel.broadcast'
    });
  }

  /**
   * Sign message with Ed25519
   */
  private signMessage(message: ADMPMessage): any {
    if (!this.secretKey) {
      throw new Error('No secret key available for signing');
    }

    // Create signing base
    const bodyHash = encodeBase64(
      nacl.hash(decodeUTF8(JSON.stringify(message.body)))
    );

    const base = `${message.timestamp}\n${bodyHash}\n${message.from}\n${message.to}\n${message.correlation_id || ''}`;

    // Sign
    const signature = nacl.sign.detached(
      decodeUTF8(base),
      this.secretKey
    );

    return {
      alg: 'ed25519',
      kid: this.config.agentId,
      sig: encodeBase64(signature)
    };
  }

  // ============ GROUPS ============

  /**
   * Create a new group
   */
  async createGroup(params: {
    name: string;
    access?: { type: 'open' | 'invite-only' | 'key-protected'; join_key?: string };
    settings?: { history_visible?: boolean; max_members?: number };
  }): Promise<Group> {
    const response = await fetch(`${this.config.hubUrl}/api/groups`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Agent-ID': this.config.agentId
      },
      body: JSON.stringify(params)
    });

    if (!response.ok) {
      throw new Error(`Create group failed: ${await response.text()}`);
    }

    const group = await response.json();
    console.log(`✅ Created group: ${group.id}`);
    return group;
  }

  /**
   * Get group info
   */
  async getGroup(groupId: string): Promise<Group> {
    const response = await fetch(`${this.config.hubUrl}/api/groups/${encodeURIComponent(groupId)}`, {
      headers: { 'X-Agent-ID': this.config.agentId }
    });

    if (!response.ok) {
      throw new Error(`Get group failed: ${await response.text()}`);
    }

    return response.json();
  }

  /**
   * List groups this agent is a member of
   */
  async listGroups(): Promise<{ groups: GroupSummary[] }> {
    const response = await fetch(
      `${this.config.hubUrl}/api/agents/${encodeURIComponent(this.config.agentId)}/groups`,
      { headers: { 'X-Agent-ID': this.config.agentId } }
    );

    if (!response.ok) {
      throw new Error(`List groups failed: ${await response.text()}`);
    }

    return response.json();
  }

  /**
   * Add member to group (requires admin role)
   */
  async addGroupMember(groupId: string, agentId: string, role: string = 'member'): Promise<Group> {
    const response = await fetch(
      `${this.config.hubUrl}/api/groups/${encodeURIComponent(groupId)}/members`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Agent-ID': this.config.agentId
        },
        body: JSON.stringify({ agent_id: agentId, role })
      }
    );

    if (!response.ok) {
      throw new Error(`Add member failed: ${await response.text()}`);
    }

    return response.json();
  }

  /**
   * Remove member from group
   */
  async removeGroupMember(groupId: string, agentId: string): Promise<Group> {
    const response = await fetch(
      `${this.config.hubUrl}/api/groups/${encodeURIComponent(groupId)}/members/${encodeURIComponent(agentId)}`,
      {
        method: 'DELETE',
        headers: { 'X-Agent-ID': this.config.agentId }
      }
    );

    if (!response.ok) {
      throw new Error(`Remove member failed: ${await response.text()}`);
    }

    return response.json();
  }

  /**
   * Join a group (for open or key-protected groups)
   */
  async joinGroup(groupId: string, key?: string): Promise<Group> {
    const response = await fetch(
      `${this.config.hubUrl}/api/groups/${encodeURIComponent(groupId)}/join`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Agent-ID': this.config.agentId
        },
        body: JSON.stringify({ key })
      }
    );

    if (!response.ok) {
      throw new Error(`Join group failed: ${await response.text()}`);
    }

    console.log(`✅ Joined group: ${groupId}`);
    return response.json();
  }

  /**
   * Leave a group
   */
  async leaveGroup(groupId: string): Promise<void> {
    const response = await fetch(
      `${this.config.hubUrl}/api/groups/${encodeURIComponent(groupId)}/leave`,
      {
        method: 'POST',
        headers: { 'X-Agent-ID': this.config.agentId }
      }
    );

    if (!response.ok) {
      throw new Error(`Leave group failed: ${await response.text()}`);
    }

    console.log(`✅ Left group: ${groupId}`);
  }

  /**
   * Post message to group
   */
  async postToGroup(params: {
    groupId: string;
    subject: string;
    body: any;
    correlationId?: string;
    replyTo?: string;
  }): Promise<GroupMessageResult> {
    const response = await fetch(
      `${this.config.hubUrl}/api/groups/${encodeURIComponent(params.groupId)}/messages`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Agent-ID': this.config.agentId
        },
        body: JSON.stringify({
          subject: params.subject,
          body: params.body,
          correlation_id: params.correlationId,
          reply_to: params.replyTo
        })
      }
    );

    if (!response.ok) {
      throw new Error(`Post to group failed: ${await response.text()}`);
    }

    return response.json();
  }

  /**
   * Get group message history
   */
  async getGroupHistory(groupId: string, limit: number = 50): Promise<{ messages: GroupMessage[]; count: number; has_more: boolean }> {
    const response = await fetch(
      `${this.config.hubUrl}/api/groups/${encodeURIComponent(groupId)}/messages?limit=${limit}`,
      { headers: { 'X-Agent-ID': this.config.agentId } }
    );

    if (!response.ok) {
      throw new Error(`Get group history failed: ${await response.text()}`);
    }

    return response.json();
  }

  // ============ INBOX ============

  /**
   * Pull messages from inbox
   */
  async pullMessages(options: PullOptions = {}): Promise<InboxMessage | null> {
    const response = await fetch(
      `${this.config.hubUrl}/api/agents/${encodeURIComponent(this.config.agentId)}/inbox/pull`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          visibility_timeout: options.visibility_timeout || 60
        })
      }
    );

    if (response.status === 204) {
      return null; // Inbox empty
    }

    if (!response.ok) {
      throw new Error(`Pull messages failed: ${await response.text()}`);
    }

    return response.json();
  }

  /**
   * Acknowledge a message (mark as processed)
   */
  async ackMessage(messageId: string, result?: any): Promise<void> {
    const response = await fetch(
      `${this.config.hubUrl}/api/agents/${encodeURIComponent(this.config.agentId)}/messages/${encodeURIComponent(messageId)}/ack`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ result })
      }
    );

    if (!response.ok) {
      throw new Error(`Ack message failed: ${await response.text()}`);
    }
  }

  /**
   * Negative acknowledge (requeue or extend lease)
   */
  async nackMessage(messageId: string, options: NackOptions = {}): Promise<void> {
    const response = await fetch(
      `${this.config.hubUrl}/api/agents/${encodeURIComponent(this.config.agentId)}/messages/${encodeURIComponent(messageId)}/nack`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(options)
      }
    );

    if (!response.ok) {
      throw new Error(`Nack message failed: ${await response.text()}`);
    }
  }

  /**
   * Get inbox statistics
   */
  async getInboxStats(): Promise<InboxStats> {
    const response = await fetch(
      `${this.config.hubUrl}/api/agents/${encodeURIComponent(this.config.agentId)}/inbox/stats`
    );

    if (!response.ok) {
      throw new Error(`Get inbox stats failed: ${await response.text()}`);
    }

    return response.json();
  }
}

// ============ TYPES ============

interface Group {
  id: string;
  name: string;
  created_by: string;
  access: { type: string; join_key_hash?: string };
  settings: { history_visible: boolean; max_members: number; message_ttl_sec: number };
  members: { agent_id: string; role: string; joined_at: number }[];
  created_at: number;
  updated_at: number;
}

interface GroupSummary {
  id: string;
  name: string;
  role: string;
  member_count: number;
}

interface GroupMessage {
  id: string;
  from: string;
  subject: string;
  body: any;
  timestamp: string;
  group_id: string;
}

interface GroupMessageResult {
  message_id: string;
  group_id: string;
  deliveries: { agent_id: string; message_id: string; status: string }[];
  delivered: number;
  failed: number;
}

/**
 * Create ADMP client from config
 */
export function createADMPClient(config: ADMPConfig): ADMPClient {
  return new ADMPClient(config);
}
