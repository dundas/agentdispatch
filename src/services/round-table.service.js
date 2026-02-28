/**
 * Round Table Service
 * Ephemeral multi-agent deliberation sessions built on top of the Groups API.
 */

import { v4 as uuid } from 'uuid';
import { storage } from '../storage/index.js';
import { groupService } from './group.service.js';
import { inboxService } from './inbox.service.js';

export class RoundTableService {
  /**
   * Create a new Round Table session.
   * Automatically creates an ADMP group for multicast routing and sends
   * a work_order to each participant inviting them to join.
   */
  async create({ topic, goal, facilitator, participants, timeout_minutes = 30 }) {
    if (!topic || !goal || !facilitator) {
      throw new Error('topic, goal, and facilitator are required');
    }
    if (!Array.isArray(participants) || participants.length === 0) {
      throw new Error('participants must be a non-empty array');
    }
    if (timeout_minutes < 1 || timeout_minutes > 10080) {
      throw new Error('timeout_minutes must be between 1 and 10080 (7 days)');
    }
    if (participants.length > 20) {
      throw new Error('Round Table supports at most 20 participants');
    }

    const id = `rt_${uuid().replace(/-/g, '').slice(0, 12)}`;
    const now = new Date();
    const expires_at = new Date(now.getTime() + timeout_minutes * 60 * 1000).toISOString();

    // Create backing ADMP group (invite-only, facilitator is owner)
    const groupName = `round-table-${id}`;
    const group = await groupService.create({
      name: groupName,
      created_by: facilitator,
      access: { type: 'invite-only' },
      settings: { max_members: participants.length + 1, message_ttl_sec: timeout_minutes * 60 }
    });

    // Add all participants to the group
    for (const participantId of participants) {
      try {
        await groupService.addMember(group.id, facilitator, participantId, 'member');
      } catch (err) {
        // Log but don't fail creation if a participant doesn't exist yet
        console.warn(`[RoundTable] Could not add participant ${participantId}: ${err.message}`);
      }
    }

    const rt = {
      id,
      topic,
      goal,
      facilitator,
      participants,
      group_id: group.id,
      status: 'open',
      thread: [],
      outcome: null,
      artifact_id: null,
      created_at: now.toISOString(),
      expires_at
    };

    await storage.createRoundTable(rt);

    // Notify each participant with a work_order via ADMP inbox
    for (const participantId of participants) {
      try {
        await inboxService.send({
          from: facilitator,
          to: participantId,
          type: 'work_order',
          subject: `Round Table invitation: ${topic}`,
          body: {
            round_table_id: id,
            topic,
            goal,
            facilitator,
            participants,
            expires_at,
            instructions: `You have been invited to a Round Table deliberation session. POST to /api/round-tables/${id}/speak with {"message":"..."} to contribute. The facilitator will resolve with an outcome when consensus is reached.`
          },
          timestamp: now.toISOString()
        }, { verify_signature: false });
      } catch (err) {
        console.warn(`[RoundTable] Could not notify participant ${participantId}: ${err.message}`);
      }
    }

    return rt;
  }

  /**
   * Speak into a Round Table thread.
   * Appends message to the thread and multicasts to all participants via the group.
   */
  async speak(id, { from, message }) {
    const rt = await this._getOpen(id);
    this._requireParticipant(rt, from);

    if (rt.thread.length >= 200) {
      throw new Error('Round Table thread has reached the maximum of 200 entries');
    }

    const entry = {
      id: uuid(),
      from,
      message,
      timestamp: new Date().toISOString()
    };

    const thread = [...rt.thread, entry];
    const updated = await storage.updateRoundTable(id, { thread });

    // Multicast to all participants via the backing group
    try {
      await groupService.postMessage(rt.group_id, {
        from,
        subject: `Round Table: ${rt.topic}`,
        body: { round_table_id: id, thread_entry: entry },
        timestamp: entry.timestamp
      });
    } catch (err) {
      console.warn(`[RoundTable] Group multicast failed for ${id}: ${err.message}`);
    }

    return { thread_entry_id: entry.id, thread_length: updated.thread.length };
  }

  /**
   * Get a Round Table session (any participant or facilitator can read).
   */
  async get(id, requesterId) {
    const rt = await storage.getRoundTable(id);
    if (!rt) throw new Error(`Round table ${id} not found`);
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
      throw new Error('Only the facilitator can resolve a Round Table');
    }
    if (!outcome) {
      throw new Error('outcome is required to resolve');
    }

    const now = new Date().toISOString();
    const updated = await storage.updateRoundTable(id, {
      status: 'resolved',
      outcome,
      decision: decision || 'approved',
      resolved_at: now
    });

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
      console.warn(`[RoundTable] Resolution multicast failed for ${id}: ${err.message}`);
    }

    // Clean up backing group — no longer needed after resolution
    try {
      await groupService.delete(rt.group_id, facilitator);
    } catch (err) {
      console.warn(`[RoundTable] Group cleanup failed for ${rt.group_id}: ${err.message}`);
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
   */
  async expireStale() {
    const tables = await storage.listRoundTables({ status: 'open' });
    const now = Date.now();
    let expired = 0;

    for (const rt of tables) {
      if (rt.expires_at && new Date(rt.expires_at).getTime() < now) {
        await storage.updateRoundTable(rt.id, { status: 'expired' });
        // Clean up backing group
        try {
          await groupService.delete(rt.group_id, rt.facilitator);
        } catch (err) {
          console.warn(`[RoundTable] Group cleanup on expiry failed for ${rt.group_id}: ${err.message}`);
        }
        expired++;
      }
    }

    return expired;
  }

  // ---- internal helpers ----

  async _getOpen(id) {
    const rt = await storage.getRoundTable(id);
    if (!rt) throw new Error(`Round table ${id} not found`);
    if (rt.status === 'resolved') throw new Error('Round table is already resolved');
    if (rt.status === 'expired') throw new Error('Round table has expired');
    return rt;
  }

  _requireParticipant(rt, agentId) {
    if (rt.facilitator !== agentId && !(rt.participants || []).includes(agentId)) {
      throw new Error('Not a participant of this Round Table');
    }
  }
}

export const roundTableService = new RoundTableService();
