/**
 * API key issuance and management routes
 * All endpoints require the master API key.
 */

import express from 'express';
import { randomBytes, createHash } from 'node:crypto';
import { v4 as uuidv4 } from 'uuid';
import { storage } from '../storage/index.js';
import { requireMasterKey } from '../middleware/auth.js';

const router = express.Router();

function generateApiKey() {
  return `admp_${randomBytes(32).toString('hex')}`;
}

function hashKey(key) {
  return createHash('sha256').update(key).digest('hex');
}

/**
 * POST /api/keys/issue
 * Issue a scoped API key for a client integration.
 * Body: { client_id, description?, expires_in_days? }
 * Returns the raw key once — client must store it securely.
 */
// Numeric-only client_ids (e.g. "12345") are intentionally permitted.
// client_id is an opaque integration label whose format is caller-controlled.
// Requiring a leading letter would be an arbitrary restriction.
const CLIENT_ID_PATTERN = /^[a-zA-Z0-9_-]+$/;
const CLIENT_ID_MAX_LENGTH = 100;

router.post('/issue', requireMasterKey, async (req, res) => {
  const { client_id, description, expires_in_days, single_use, target_agent_id } = req.body;

  if (!client_id || typeof client_id !== 'string' || client_id.trim() === '') {
    return res.status(400).json({
      error: 'INVALID_CLIENT_ID',
      message: 'client_id is required and must be a non-empty string'
    });
  }

  if (client_id.length > CLIENT_ID_MAX_LENGTH || !CLIENT_ID_PATTERN.test(client_id)) {
    return res.status(400).json({
      error: 'INVALID_CLIENT_ID',
      message: `client_id must be 1-${CLIENT_ID_MAX_LENGTH} characters matching /^[a-zA-Z0-9_-]+$/`
    });
  }

  const rawKey = generateApiKey();
  const keyHash = hashKey(rawKey);
  const keyId = uuidv4();
  const now = Date.now();

  const issuedKey = {
    key_id: keyId,
    key_hash: keyHash,
    client_id,
    description: description || '',
    created_at: now,
    expires_at: expires_in_days ? now + expires_in_days * 86400000 : null,
    revoked: false,
    single_use: single_use === true,
    used_at: null,
    target_agent_id: target_agent_id || null
  };

  await storage.createIssuedKey(issuedKey);

  return res.status(201).json({
    key_id: keyId,
    api_key: rawKey,
    client_id,
    description: issuedKey.description,
    created_at: new Date(now).toISOString(),
    expires_at: issuedKey.expires_at ? new Date(issuedKey.expires_at).toISOString() : null,
    single_use: issuedKey.single_use,
    target_agent_id: issuedKey.target_agent_id,
    warning: 'Store this API key securely — it will not be shown again'
  });
});

/**
 * GET /api/keys
 * List all issued keys (hashes only, never raw keys).
 */
router.get('/', requireMasterKey, async (req, res) => {
  const keys = await storage.listIssuedKeys();
  return res.json(keys.map(k => ({
    key_id: k.key_id,
    client_id: k.client_id,
    description: k.description,
    created_at: new Date(k.created_at).toISOString(),
    expires_at: k.expires_at ? new Date(k.expires_at).toISOString() : null,
    revoked: k.revoked,
    revoked_at: k.revoked_at ? new Date(k.revoked_at).toISOString() : null,
    single_use: k.single_use || false,
    used_at: k.used_at ? new Date(k.used_at).toISOString() : null,
    target_agent_id: k.target_agent_id || null
  })));
});

/**
 * DELETE /api/keys/:keyId
 * Revoke an issued key.
 */
router.delete('/:keyId', requireMasterKey, async (req, res) => {
  const { keyId } = req.params;
  const revoked = await storage.revokeIssuedKey(keyId);

  if (!revoked) {
    return res.status(404).json({
      error: 'KEY_NOT_FOUND',
      message: `Key ${keyId} not found`
    });
  }

  return res.json({ revoked: true, key_id: keyId });
});

export default router;
