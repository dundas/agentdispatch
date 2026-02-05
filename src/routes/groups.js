/**
 * Group routes
 * /api/groups/*
 */

import express from 'express';
import { groupService } from '../services/group.service.js';
import { authenticateAgent } from '../middleware/auth.js';

const router = express.Router();

/**
 * POST /api/groups
 * Create a new group
 */
router.post('/', authenticateAgent, async (req, res) => {
  try {
    const { name, access, settings } = req.body;

    if (!name) {
      return res.status(400).json({
        error: 'NAME_REQUIRED',
        message: 'Group name is required'
      });
    }

    const group = await groupService.create({
      name,
      created_by: req.agent.agent_id,
      access,
      settings
    });

    res.status(201).json(group);
  } catch (error) {
    res.status(400).json({
      error: 'CREATE_GROUP_FAILED',
      message: error.message
    });
  }
});

/**
 * GET /api/groups/:groupId
 * Get group info
 */
router.get('/:groupId', authenticateAgent, async (req, res) => {
  try {
    const group = await groupService.get(req.params.groupId);

    if (!group) {
      return res.status(404).json({
        error: 'GROUP_NOT_FOUND',
        message: 'Group not found'
      });
    }

    // Check if requester is a member
    const isMember = group.members?.some(m => m.agent_id === req.agent.agent_id);

    // Non-members see limited info
    if (!isMember) {
      return res.json({
        id: group.id,
        name: group.name,
        access_type: group.access.type,
        member_count: group.members?.length || 0
      });
    }

    res.json(group);
  } catch (error) {
    res.status(400).json({
      error: 'GET_GROUP_FAILED',
      message: error.message
    });
  }
});

/**
 * PUT /api/groups/:groupId
 * Update group settings
 */
router.put('/:groupId', authenticateAgent, async (req, res) => {
  try {
    const { name, settings } = req.body;

    const group = await groupService.update(
      req.params.groupId,
      req.agent.agent_id,
      { name, settings }
    );

    res.json(group);
  } catch (error) {
    res.status(400).json({
      error: 'UPDATE_GROUP_FAILED',
      message: error.message
    });
  }
});

/**
 * DELETE /api/groups/:groupId
 * Delete group
 */
router.delete('/:groupId', authenticateAgent, async (req, res) => {
  try {
    await groupService.delete(req.params.groupId, req.agent.agent_id);
    res.status(204).send();
  } catch (error) {
    res.status(400).json({
      error: 'DELETE_GROUP_FAILED',
      message: error.message
    });
  }
});

/**
 * GET /api/groups/:groupId/members
 * List group members
 */
router.get('/:groupId/members', authenticateAgent, async (req, res) => {
  try {
    const members = await groupService.listMembers(
      req.params.groupId,
      req.agent.agent_id
    );

    res.json({ members });
  } catch (error) {
    res.status(400).json({
      error: 'LIST_MEMBERS_FAILED',
      message: error.message
    });
  }
});

/**
 * POST /api/groups/:groupId/members
 * Add member (admin action)
 */
router.post('/:groupId/members', authenticateAgent, async (req, res) => {
  try {
    const { agent_id, role } = req.body;

    if (!agent_id) {
      return res.status(400).json({
        error: 'AGENT_ID_REQUIRED',
        message: 'agent_id is required'
      });
    }

    const group = await groupService.addMember(
      req.params.groupId,
      req.agent.agent_id,
      agent_id,
      role
    );

    res.json(group);
  } catch (error) {
    res.status(400).json({
      error: 'ADD_MEMBER_FAILED',
      message: error.message
    });
  }
});

/**
 * DELETE /api/groups/:groupId/members/:agentId
 * Remove member
 */
router.delete('/:groupId/members/:agentId', authenticateAgent, async (req, res) => {
  try {
    const group = await groupService.removeMember(
      req.params.groupId,
      req.agent.agent_id,
      req.params.agentId
    );

    res.json(group);
  } catch (error) {
    res.status(400).json({
      error: 'REMOVE_MEMBER_FAILED',
      message: error.message
    });
  }
});

/**
 * POST /api/groups/:groupId/join
 * Join group (for open/key-protected groups)
 */
router.post('/:groupId/join', authenticateAgent, async (req, res) => {
  try {
    const { key } = req.body;

    const group = await groupService.join(
      req.params.groupId,
      req.agent.agent_id,
      key
    );

    res.json(group);
  } catch (error) {
    res.status(400).json({
      error: 'JOIN_FAILED',
      message: error.message
    });
  }
});

/**
 * POST /api/groups/:groupId/leave
 * Leave group
 */
router.post('/:groupId/leave', authenticateAgent, async (req, res) => {
  try {
    const group = await groupService.leave(
      req.params.groupId,
      req.agent.agent_id
    );

    res.json({ message: 'Left group', group_id: req.params.groupId });
  } catch (error) {
    res.status(400).json({
      error: 'LEAVE_FAILED',
      message: error.message
    });
  }
});

/**
 * POST /api/groups/:groupId/messages
 * Post message to group
 */
router.post('/:groupId/messages', authenticateAgent, async (req, res) => {
  try {
    const { subject, body, correlation_id, reply_to } = req.body;

    if (!subject || !body) {
      return res.status(400).json({
        error: 'INVALID_MESSAGE',
        message: 'subject and body are required'
      });
    }

    const envelope = {
      version: '1.0',
      from: req.agent.agent_id,
      subject,
      body,
      correlation_id,
      reply_to,
      timestamp: new Date().toISOString()
    };

    const result = await groupService.postMessage(req.params.groupId, envelope);

    res.status(201).json(result);
  } catch (error) {
    res.status(400).json({
      error: 'POST_MESSAGE_FAILED',
      message: error.message
    });
  }
});

/**
 * GET /api/groups/:groupId/messages
 * Get group message history
 */
router.get('/:groupId/messages', authenticateAgent, async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 50;

    const messages = await groupService.getMessages(
      req.params.groupId,
      req.agent.agent_id,
      { limit }
    );

    res.json({
      messages,
      count: messages.length,
      has_more: messages.length === limit
    });
  } catch (error) {
    res.status(400).json({
      error: 'GET_MESSAGES_FAILED',
      message: error.message
    });
  }
});

export default router;
