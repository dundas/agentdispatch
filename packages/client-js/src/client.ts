/**
 * ADMP Client SDK
 * JavaScript/TypeScript client for Agent Dispatch Messaging Protocol
 */

import {
  ClientConfig,
  SendOptions,
  PullOptions,
  Message,
  InboxStats,
  ADMPError,
} from './types.js';

export class ADMPClient {
  private agentId: string;
  private relayUrl: string;
  private apiKey: string;
  private timeout: number;

  constructor(config: ClientConfig) {
    this.agentId = config.agentId;
    this.relayUrl = config.relayUrl.replace(/\/$/, ''); // Remove trailing slash
    this.apiKey = config.apiKey;
    this.timeout = config.timeout || 30000;
  }

  /**
   * Send a message to another agent's inbox
   */
  async send(options: SendOptions): Promise<string> {
    const url = `${this.relayUrl}/v1/agents/${options.to.replace('agent://', '')}/messages`;

    const body = {
      type: options.type,
      from: options.from || `agent://${this.agentId}`,
      subject: options.subject,
      body: options.body,
      correlation_id: options.correlation_id,
      headers: options.headers,
      ttl_sec: options.ttl_sec,
      idempotency_key: options.idempotency_key,
    };

    const response = await this.request('POST', url, body);

    if (!response.message_id) {
      throw new ADMPError('Invalid response: missing message_id', 'invalid_response');
    }

    return response.message_id;
  }

  /**
   * Pull a message from this agent's inbox
   */
  async pull(options?: PullOptions): Promise<Message | null> {
    const leaseDuration = options?.leaseDuration || 30;
    const url = `${this.relayUrl}/v1/agents/${this.agentId}/inbox/pull?visibility_timeout=${leaseDuration}`;

    try {
      const message = await this.request('POST', url);
      return message as Message;
    } catch (err: any) {
      // 204 No Content means inbox is empty
      if (err.statusCode === 204) {
        return null;
      }
      throw err;
    }
  }

  /**
   * Acknowledge a message as successfully processed
   */
  async ack(messageId: string): Promise<void> {
    const url = `${this.relayUrl}/v1/agents/${this.agentId}/messages/${messageId}/ack`;
    await this.request('POST', url);
  }

  /**
   * Get inbox statistics
   */
  async inboxStats(): Promise<InboxStats> {
    const url = `${this.relayUrl}/v1/agents/${this.agentId}/inbox/stats`;
    const stats = await this.request('GET', url);
    return stats as InboxStats;
  }

  /**
   * Wait for a correlated reply to a sent message
   * Polls the inbox for a message with matching correlation_id
   */
  async waitForReply(
    messageId: string,
    options: { timeout?: number; pollInterval?: number } = {}
  ): Promise<Message> {
    const timeout = options.timeout || 5000;
    const pollInterval = options.pollInterval || 500;
    const startTime = Date.now();

    while (Date.now() - startTime < timeout) {
      const message = await this.pull({ leaseDuration: 30 });

      if (message && message.correlation_id === messageId) {
        return message;
      }

      // If we got a message but it doesn't match, we should handle it
      // For MVP, we'll just re-queue it by not acking
      // In production, this would need proper handling

      await new Promise((resolve) => setTimeout(resolve, pollInterval));
    }

    throw new ADMPError(
      `No reply received within ${timeout}ms`,
      'timeout',
      408
    );
  }

  /**
   * Internal method to make HTTP requests
   */
  private async request(
    method: string,
    url: string,
    body?: any
  ): Promise<any> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeout);

    try {
      const headers: Record<string, string> = {
        'Authorization': `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      };

      const options: RequestInit = {
        method,
        headers,
        signal: controller.signal,
      };

      if (body) {
        options.body = JSON.stringify(body);
      }

      const response = await fetch(url, options);

      // Handle 204 No Content
      if (response.status === 204) {
        throw new ADMPError('No content', 'no_content', 204);
      }

      const data = await response.json();

      if (!response.ok) {
        throw new ADMPError(
          data.message || 'Request failed',
          data.error || 'request_failed',
          response.status
        );
      }

      return data;
    } catch (err: any) {
      if (err.name === 'AbortError') {
        throw new ADMPError(
          `Request timeout after ${this.timeout}ms`,
          'timeout',
          408
        );
      }

      if (err instanceof ADMPError) {
        throw err;
      }

      throw new ADMPError(
        err.message || 'Unknown error',
        'network_error'
      );
    } finally {
      clearTimeout(timeoutId);
    }
  }
}
