/**
 * ADMP Core Types
 * Message envelope definitions and API types for v1.0
 */

export type MessageType = 'task.request' | 'task.result' | 'task.error' | 'event';

export type MessageStatus =
  | 'queued'
  | 'sent'
  | 'delivered'
  | 'leased'
  | 'acked'
  | 'nacked'
  | 'failed'
  | 'dead';

export interface MessageSignature {
  alg: 'ed25519' | 'hmac-sha256';
  kid: string;
  sig: string;
}

export interface MessageEnvelope {
  version: string;
  id: string;
  type: MessageType;
  from: string;
  to: string;
  subject: string;
  correlation_id?: string;
  headers?: Record<string, any>;
  body: Record<string, any>;
  ttl_sec?: number;
  timestamp: string;
  signature?: MessageSignature;
}

export interface MessageRecord extends MessageEnvelope {
  status: MessageStatus;
  lease_until?: string;
  leased_at?: string;
  attempts: number;
  delivered_at?: string;
  acked_at?: string;
  created_at: string;
}

export interface SendMessageRequest {
  version?: string;
  type: MessageType;
  from: string;
  to: string;
  subject: string;
  correlation_id?: string;
  headers?: Record<string, any>;
  body: Record<string, any>;
  ttl_sec?: number;
  idempotency_key?: string;
}

export interface SendMessageResponse {
  message_id: string;
}

export interface PullMessageRequest {
  visibility_timeout?: number;
}

export interface InboxStats {
  ready: number;
  leased: number;
  dead: number;
  oldest_age_sec: number | null;
}

export interface HealthResponse {
  status: 'healthy' | 'unhealthy';
  version: string;
  uptime: number;
  database: 'connected' | 'disconnected';
}
