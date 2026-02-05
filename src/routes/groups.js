/**
 * Group routes
 * /api/groups/*
 */

import express from 'express';
import { groupService } from '../services/group.service.js';
import { authenticateAgent } from '../middleware/auth.js';

const router = express.Router();

/**
 * Map error messages to appropriate HTTP status codes
 */
function getErrorStatusCode(error) {
  const message = error.message || '';

  // 404 Not Found
  if (message.includes('not found')) {
    return 404;
  }

  // 403 Forbidden - permission/role issues
  if (message.includes('not a member') ||
      message.includes('Requires ') ||
      message.includes('invite-only') ||
      message.includes('Invalid join key') ||
      message.includes('Cannot remove group owner')) {
    return 403;
  }

  // 409 Conflict - already exists
  if (message.includes('already a member') ||
      message.includes('maximum members')) {
    return 409;
  }

  // Default to 400 Bad Request
  return 400;
}

/**
 * POST /api/groups
 * Create a new group
 */
router.post('/', authenticateAgent, async (req, res) => {
  try {
    const { name, access, settings } = req.body;

    // Validate name
    if (!name || typeof name !== 'string' || name.trim().length === 0) {
      return res.status(400).json({
        error: 'INVALID_NAME',
        message: 'Group name must be a non-empty string'
      });
    }

    if (name.length > 100) {
      return res.status(400).json({
        error: 'NAME_TOO_LONG',
        message: 'Group name must be 100 characters or less'
      });
    }

    // Validate name doesn't contain problematic characters
    if (!/^[\w\s\-\.]+$/.test(name)) {
      return res.status(400).json({
        error: 'INVALID_NAME_CHARS',
        message: 'Group name can only contain letters, numbers, spaces, hyphens, underscores, and periods'
      });
    }

    const group = await groupService.create({
      name: name.trim(),
      created_by: req.agent.agent_id,
      access,
      settings
    });

    res.status(201).json(group);
  } catch (error) {
    const status = getErrorStatusCode(error);
    res.status(status).json({
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
    const status = getErrorStatusCode(error);
    res.status(status).json({
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
    const status = getErrorStatusCode(error);
    res.status(status).json({
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
    const status = getErrorStatusCode(error);
    res.status(status).json({
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
    const status = getErrorStatusCode(error);
    res.status(status).json({
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
    const status = getErrorStatusCode(error);
    res.status(status).json({
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
    const status = getErrorStatusCode(error);
    res.status(status).json({
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
    const status = getErrorStatusCode(error);
    res.status(status).json({
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
    const status = getErrorStatusCode(error);
    res.status(status).json({
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

    // Input size limits
    if (typeof subject !== 'string' || subject.length > 200) {
      return res.status(400).json({
        error: 'INVALID_SUBJECT',
        message: 'subject must be a string of 200 characters or less'
      });
    }

    // Body size limit (1MB for JSON)
    const bodyStr = typeof body === 'string' ? body : JSON.stringify(body);
    if (bodyStr.length > 1048576) {
      return res.status(400).json({
        error: 'BODY_TOO_LARGE',
        message: 'message body must be less than 1MB'
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
    const status = getErrorStatusCode(error);
    res.status(status).json({
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
    const status = getErrorStatusCode(error);
    res.status(status).json({
      error: 'GET_MESSAGES_FAILED',
      message: error.message
    });
  }
});

export default router;
