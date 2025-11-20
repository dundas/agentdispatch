/**
 * Authentication middleware
 */

import { storage } from '../storage/index.js';

/**
 * Verify agent exists
 */
export async function authenticateAgent(req, res, next) {
  const agentId = req.params.agentId || req.params.agent_id;

  if (!agentId) {
    return res.status(400).json({
      error: 'AGENT_ID_REQUIRED',
      message: 'Agent ID is required'
    });
  }

  const agent = await storage.getAgent(agentId);

  if (!agent) {
    return res.status(404).json({
      error: 'AGENT_NOT_FOUND',
      message: `Agent ${agentId} not found`
    });
  }

  req.agent = agent;
  next();
}

/**
 * Optional API key authentication
 */
export function requireApiKey(req, res, next) {
  const apiKeyRequired = process.env.API_KEY_REQUIRED === 'true';

  if (!apiKeyRequired) {
    return next();
  }

  const apiKey = req.headers['x-api-key'] || req.headers['authorization']?.replace('Bearer ', '');

  if (!apiKey) {
    return res.status(401).json({
      error: 'API_KEY_REQUIRED',
      message: 'API key is required'
    });
  }

  const masterKey = process.env.MASTER_API_KEY;

  if (apiKey !== masterKey) {
    return res.status(403).json({
      error: 'INVALID_API_KEY',
      message: 'Invalid API key'
    });
  }

  next();
}
