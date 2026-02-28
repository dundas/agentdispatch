/**
 * Round Table Service
 * Ephemeral multi-agent deliberation sessions built on top of the Groups API.
 */

import { v4 as uuid } from 'uuid';
import pino from 'pino';
import { storage } from '../storage/index.js';
import { groupService } from './group.service.js';
import { inboxService } from './inbox.service.js';

const logger = pino({ level: process.env.NODE_ENV === 'production' ? 'info' : 'debug' });

function makeError(message, statusCode) {
  const err = new Error(message);
  err.statusCode = statusCode;
  return err;
}

export class RoundTableService {
  /**
   * Create a new Round Table session.
   * Automatically creates an ADMP group for multicast routing and sends
   * a work_order to each participant inviting them to join.
   * Only participants successfully enrolled in the backing group are stored,
   * preventing a split-brain between rt.participants and group membership.
   * Returns `excluded_participants` so callers know who was dropped.
   */
  async create({ topic, goal, facilitator, participants, timeout_minutes = 30 }) {
    if (!topic || !goal || !facilitator) {
      throw makeError('topic, goal, and facilitator are required', 400);
    }
    if (!Array.isArray(participants) || participants.length === 0) {
      throw makeError('participants must be a non-empty array', 400);
    }
    if (!Number.isInteger(timeout_minutes) || timeout_minutes < 1 || timeout_minutes > 10080) {
      throw makeError('timeout_minutes must be an integer between 1 and 10080 (7 days)', 400);
    }
    const uniqueParticipants = [...new Set(participants)];
    if (uniqueParticipants.length > 20) {
      throw makeError('Round Table supports at most 20 participants', 400);
    }

    const id = `rt_${uuid().replace(/-/g, '').slice(0, 12)}`;
    const now = new Date();
    const expires_at = new Date(now.getTime() + timeout_minutes * 60 * 1000).toISOString();

    // Create backing ADMP group (invite-only, facilitator is owner).
    // max_members is initially the upper bound; adjusted after enrollment below.
    const groupName = `round-table-${id}`;
    const group = await groupService.create({
      name: groupName,
      created_by: facilitator,
      access: { type: 'invite-only' },
      settings: { max_members: uniqueParticipants.length + 1, message_ttl_sec: timeout_minutes * 60 }
    });

    // Add participants to the group — only those successfully enrolled are stored.
    // A participant that doesn't exist yet cannot be enrolled and is excluded rather
    // than silently included in rt.participants (split-brain prevention).
    const enrolledParticipants = [];
    const excludedParticipants = [];
    for (const participantId of uniqueParticipants) {
      try {
        await groupService.addMember(group.id, facilitator, participantId, 'member');
        enrolledParticipants.push(participantId);
      } catch (err) {
        logger.warn({ participantId, err: err.message }, '[RoundTable] Could not enroll participant — excluded from session');
        excludedParticipants.push(participantId);
      }
    }

    if (enrolledParticipants.length === 0) {
      try { await groupService.delete(group.id, facilitator); } catch (_) {}
      throw makeError('No participants could be enrolled; round table not created', 400);
    }

    // Align max_members to actual enrolled count + facilitator
    if (enrolledParticipants.length < uniqueParticipants.length) {
      try {
        await groupService.update(group.id, facilitator, {
          settings: { max_members: enrolledParticipants.length + 1, message_ttl_sec: timeout_minutes * 60 }
        });
      } catch (err) {
        logger.warn({ groupId: group.id, err: err.message }, '[RoundTable] Could not update group max_members after partial enrollment');
      }
    }

    const rt = {
      id,
      topic,
      goal,
      facilitator,
      participants: enrolledParticipants,
      group_id: group.id,
      status: 'open',
      thread: [],
      outcome: null,
      created_at: now.toISOString(),
      expires_at
    };

    await storage.createRoundTable(rt);

    // Notify each enrolled participant with a work_order via ADMP inbox
    for (const participantId of enrolledParticipants) {
      try {
        await inboxService.send({
          version: '1.0',
          id: uuid(),
          from: facilitator,
          to: participantId,
          type: 'work_order',
          subject: `Round Table invitation: ${topic}`,
          body: {
            round_table_id: id,
            topic,
            goal,
            facilitator,
            participants: enrolledParticipants,
            expires_at,
            instructions: `You have been invited to a Round Table deliberation session. POST to /api/round-tables/${id}/speak with {"message":"..."} to contribute. The facilitator will resolve with an outcome when consensus is reached.`
          },
          timestamp: now.toISOString()
        }, { verify_signature: false });
      } catch (err) {
        logger.warn({ participantId, err: err.message }, '[RoundTable] Could not notify participant');
      }
    }

    // Include excluded participants in the response so callers know who was dropped
    return { ...rt, excluded_participants: excludedParticipants };
  }

  /**
   * Speak into a Round Table thread.
   * Appends message to the thread and multicasts to all participants via the group.
   */
  async speak(id, { from, message }) {
    const rt = await this._getOpen(id);
    this._requireParticipant(rt, from);

    if (rt.thread.length >= 200) {
      throw makeError('Round Table thread has reached the maximum of 200 entries', 409);
    }

    const entry = {
      id: uuid(),
      from,
      message,
      timestamp: new Date().toISOString()
    };

    const thread = [...rt.thread, entry];
    const updated = await storage.updateRoundTable(id, { thread });
    if (!updated) throw makeError(`Round table ${id} not found`, 404);

    // Multicast to all participants via the backing group
    try {
      await groupService.postMessage(rt.group_id, {
        from,
        subject: `Round Table: ${rt.topic}`,
        body: { round_table_id: id, thread_entry: entry },
        timestamp: entry.timestamp
      });
    } catch (err) {
      logger.warn({ id, err: err.message }, '[RoundTable] Group multicast failed');
    }

    return { thread_entry_id: entry.id, thread_length: updated.thread.length };
  }

  /**
   * Get a Round Table session (any participant or facilitator can read).
   */
  async get(id, requesterId) {
    const rt = await storage.getRoundTable(id);
    if (!rt) throw makeError(`Round table ${id} not found`, 404);
    this._requireParticipant(rt, requesterId);
    return rt;
  }

  /**
   * Resolve a Round Table session. Only the facilitator can call this.
   * Multicasts the resolution to all participants and closes the session.
   */
  async resolve(id, { facilitator, outcome, decision }) {
    const rt = await this._getOpen(id);

    if (rt.facilitator !== facilitator) {
      throw makeError('Only the facilitator can resolve a Round Table', 403);
    }
    if (!outcome) {
      throw makeError('outcome is required to resolve', 400);
    }

    const now = new Date().toISOString();
    const updated = await storage.updateRoundTable(id, {
      status: 'resolved',
      outcome,
      decision: decision || 'approved',
      resolved_at: now
    });
    if (!updated) throw makeError(`Round table ${id} not found`, 404);

    // Multicast resolution to all participants
    try {
      await groupService.postMessage(rt.group_id, {
        from: facilitator,
        subject: `Round Table resolved: ${rt.topic}`,
        body: {
          round_table_id: id,
          outcome,
          decision: decision || 'approved',
          resolved_at: now
        },
        timestamp: now
      });
    } catch (err) {
      logger.warn({ id, err: err.message }, '[RoundTable] Resolution multicast failed');
    }

    // Clean up backing group — no longer needed after resolution
    try {
      await groupService.delete(rt.group_id, facilitator);
    } catch (err) {
      logger.warn({ groupId: rt.group_id, err: err.message }, '[RoundTable] Group cleanup failed');
    }

    return updated;
  }

  /**
   * List Round Tables, optionally filtered by status and/or participant.
   */
  async list(filter = {}) {
    return await storage.listRoundTables(filter);
  }

  /**
   * Mark expired Round Tables (called by cleanup loop).
   * Notifies facilitator and all participants of expiry, cleans up backing groups.
   * Each record is processed independently — a failure on one does not abort the rest.
   */
  async expireStale() {
    const tables = await storage.listRoundTables({ status: 'open' });
    const now = Date.now();
    let expired = 0;

    for (const rt of tables) {
      if (!rt.expires_at || new Date(rt.expires_at).getTime() >= now) continue;

      try {
        await storage.updateRoundTable(rt.id, { status: 'expired' });

        // Notify facilitator and all participants of expiry.
        // Use rt.expires_at as the canonical close timestamp.
        const toNotify = [rt.facilitator, ...rt.participants];
        for (const recipientId of toNotify) {
          try {
            await inboxService.send({
              version: '1.0',
              id: uuid(),
              from: rt.facilitator,
              to: recipientId,
              type: 'notification',
              subject: `Round Table expired: ${rt.topic}`,
              body: { round_table_id: rt.id, topic: rt.topic, reason: 'timeout', expires_at: rt.expires_at },
              timestamp: rt.expires_at
            }, { verify_signature: false });
          } catch (err) {
            logger.warn({ recipientId, err: err.message }, '[RoundTable] Could not notify recipient of expiry');
          }
        }

        // Clean up backing group
        try {
          await groupService.delete(rt.group_id, rt.facilitator);
        } catch (err) {
          logger.warn({ groupId: rt.group_id, err: err.message }, '[RoundTable] Group cleanup on expiry failed');
        }

        expired++;
      } catch (err) {
        logger.warn({ id: rt.id, err: err.message }, '[RoundTable] Failed to expire record — will retry next cycle');
      }
    }

    return expired;
  }

  /**
   * Purge resolved/expired Round Tables older than olderThanMs (default: 7 days).
   * Called by the cleanup loop to prevent unbounded storage growth.
   */
  async purgeStale(olderThanMs = 7 * 24 * 60 * 60 * 1000) {
    return storage.purgeStaleRoundTables(olderThanMs);
  }

  // ---- internal helpers ----

  async _getOpen(id) {
    const rt = await storage.getRoundTable(id);
    if (!rt) throw makeError(`Round table ${id} not found`, 404);
    if (rt.status === 'resolved') throw makeError('Round table is already resolved', 409);
    if (rt.status === 'expired') throw makeError('Round table has expired', 409);
    return rt;
  }

  _requireParticipant(rt, agentId) {
    if (rt.facilitator !== agentId && !(rt.participants || []).includes(agentId)) {
      throw makeError('Not a participant of this Round Table', 403);
    }
  }
}

export const roundTableService = new RoundTableService();
