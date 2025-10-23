/**
 * ADMP Client SDK Types
 */

export type MessageType = 'task.request' | 'task.result' | 'task.error' | 'event';

export interface Message {
  id: string;
  version: string;
  type: MessageType;
  from: string;
  to: string;
  subject: string;
  correlation_id?: string;
  headers?: Record<string, any>;
  body: Record<string, any>;
  timestamp: string;
  status?: string;
  lease_until?: string;
  attempts?: number;
}

export interface SendOptions {
  to: string;
  type: MessageType;
  subject: string;
  body: Record<string, any>;
  from?: string;
  correlation_id?: string;
  headers?: Record<string, any>;
  ttl_sec?: number;
  idempotency_key?: string;
}

export interface PullOptions {
  leaseDuration?: number;
}

export interface InboxStats {
  ready: number;
  leased: number;
  dead: number;
  oldest_age_sec: number | null;
}

export interface ClientConfig {
  agentId: string;
  relayUrl: string;
  apiKey: string;
  timeout?: number;
}

export class ADMPError extends Error {
  constructor(
    message: string,
    public code: string,
    public statusCode?: number
  ) {
    super(message);
    this.name = 'ADMPError';
  }
}
