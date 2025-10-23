/**
 * Inbox Operations
 * Core SEND, PULL, ACK operations for ADMP message handling
 */

import { v4 as uuidv4 } from 'uuid';
import { getPool } from './db.js';
import {
  MessageEnvelope,
  MessageRecord,
  SendMessageRequest,
  InboxStats,
} from './types.js';
import pino from 'pino';

const logger = pino({ name: 'inbox' });

/**
 * SEND - Enqueue a message to an agent's inbox
 */
export async function sendMessage(
  request: SendMessageRequest
): Promise<string> {
  const pool = getPool();
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const messageId = uuidv4();
    const timestamp = new Date().toISOString();
    const toAgentId = request.to.replace('agent://', '');
    const fromAgent = request.from.replace('agent://', '');

    // Check for duplicate by idempotency key
    if (request.idempotency_key) {
      const dupeCheck = await client.query(
        `SELECT id FROM message
         WHERE to_agent_id = $1 AND idempotency_key = $2
         LIMIT 1`,
        [toAgentId, request.idempotency_key]
      );

      if (dupeCheck.rowCount && dupeCheck.rowCount > 0) {
        await client.query('COMMIT');
        logger.info(
          { messageId: dupeCheck.rows[0].id, idempotencyKey: request.idempotency_key },
          'Duplicate message detected, returning existing ID'
        );
        return dupeCheck.rows[0].id;
      }
    }

    // Insert message
    const result = await client.query(
      `INSERT INTO message (
        id, version, type, from_agent, to_agent_id, subject,
        correlation_id, headers, body, ttl_sec, timestamp,
        channel, status, idempotency_key, delivered_at, attempts
      ) VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, NOW(), 0
      ) RETURNING id`,
      [
        messageId,
        request.version || '1.0',
        request.type,
        fromAgent,
        toAgentId,
        request.subject,
        request.correlation_id || null,
        JSON.stringify(request.headers || {}),
        JSON.stringify(request.body),
        request.ttl_sec || 86400,
        timestamp,
        'http',
        'delivered',
        request.idempotency_key || null,
      ]
    );

    await client.query('COMMIT');

    logger.info(
      {
        messageId,
        from: fromAgent,
        to: toAgentId,
        subject: request.subject,
        type: request.type,
      },
      'Message sent'
    );

    return result.rows[0].id;
  } catch (err) {
    await client.query('ROLLBACK');
    logger.error({ err, request }, 'Failed to send message');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * PULL - Retrieve and lease a message from an agent's inbox
 */
export async function pullMessage(
  agentId: string,
  visibilityTimeout: number = 30
): Promise<MessageRecord | null> {
  const pool = getPool();
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const leaseUntil = new Date(Date.now() + visibilityTimeout * 1000).toISOString();

    // Find and lease oldest delivered message
    const result = await client.query(
      `UPDATE message
       SET status = 'leased',
           leased_at = NOW(),
           lease_until = $1
       WHERE id = (
         SELECT id FROM message
         WHERE to_agent_id = $2 AND status = 'delivered'
         ORDER BY created_at ASC
         FOR UPDATE SKIP LOCKED
         LIMIT 1
       )
       RETURNING
         id, version, type, from_agent as "from",
         'agent://' || to_agent_id as "to",
         subject, correlation_id, headers, body,
         ttl_sec, timestamp, status, lease_until,
         leased_at, attempts, delivered_at, acked_at, created_at`,
      [leaseUntil, agentId]
    );

    await client.query('COMMIT');

    if (result.rowCount === 0) {
      return null;
    }

    const message = result.rows[0];

    // Parse JSON fields
    message.headers = JSON.parse(message.headers || '{}');
    message.body = JSON.parse(message.body || '{}');
    message.from = `agent://${message.from}`;

    logger.info(
      {
        messageId: message.id,
        agentId,
        leaseUntil,
      },
      'Message pulled and leased'
    );

    return message;
  } catch (err) {
    await client.query('ROLLBACK');
    logger.error({ err, agentId }, 'Failed to pull message');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * ACK - Acknowledge successful message processing
 */
export async function ackMessage(
  messageId: string,
  agentId: string
): Promise<void> {
  const pool = getPool();

  const result = await pool.query(
    `UPDATE message
     SET status = 'acked',
         acked_at = NOW()
     WHERE id = $1
       AND to_agent_id = $2
       AND status = 'leased'`,
    [messageId, agentId]
  );

  if (result.rowCount === 0) {
    const msg = `Message ${messageId} not found or not leased by ${agentId}`;
    logger.warn({ messageId, agentId }, msg);
    throw new Error(msg);
  }

  logger.info({ messageId, agentId }, 'Message acknowledged');
}

/**
 * Get inbox statistics for an agent
 */
export async function getInboxStats(agentId: string): Promise<InboxStats> {
  const pool = getPool();

  const result = await pool.query(
    `SELECT
       COUNT(*) FILTER (WHERE status = 'delivered') as ready,
       COUNT(*) FILTER (WHERE status = 'leased') as leased,
       COUNT(*) FILTER (WHERE status = 'dead') as dead,
       EXTRACT(EPOCH FROM (NOW() - MIN(created_at))) FILTER (WHERE status IN ('delivered', 'leased')) as oldest_age_sec
     FROM message
     WHERE to_agent_id = $1`,
    [agentId]
  );

  const stats = result.rows[0];

  return {
    ready: parseInt(stats.ready) || 0,
    leased: parseInt(stats.leased) || 0,
    dead: parseInt(stats.dead) || 0,
    oldest_age_sec: stats.oldest_age_sec ? Math.floor(parseFloat(stats.oldest_age_sec)) : null,
  };
}

/**
 * Reclaim expired leases
 */
export async function reclaimExpiredLeases(): Promise<number> {
  const pool = getPool();

  const result = await pool.query(
    `UPDATE message
     SET status = 'delivered',
         leased_at = NULL,
         lease_until = NULL,
         attempts = attempts + 1
     WHERE status = 'leased'
       AND lease_until < NOW()
       AND attempts < 3`
  );

  // Mark as dead if max attempts exceeded
  await pool.query(
    `UPDATE message
     SET status = 'dead',
         last_error = 'Max lease attempts exceeded'
     WHERE status = 'leased'
       AND lease_until < NOW()
       AND attempts >= 3`
  );

  const reclaimedCount = result.rowCount || 0;

  if (reclaimedCount > 0) {
    logger.info({ reclaimedCount }, 'Reclaimed expired leases');
  }

  return reclaimedCount;
}
