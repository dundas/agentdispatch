/**
 * Authentication middleware
 * Supports:
 * - Agent ID lookup (legacy)
 * - HTTP Signature verification (RFC 9421-style)
 */

import { storage } from '../storage/index.js';
import nacl from 'tweetnacl';
import { fromBase64, toBase64 } from '../utils/crypto.js';

/**
 * Verify agent exists (legacy auth)
 */
export async function authenticateAgent(req, res, next) {
  // Check URL params first, then headers for routes without :agentId param
  const agentId = req.params.agentId || req.params.agent_id || req.headers['x-agent-id'];

  if (!agentId) {
    return res.status(400).json({
      error: 'AGENT_ID_REQUIRED',
      message: 'Agent ID is required (provide in URL or X-Agent-ID header)'
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
 * HTTP Signature authentication middleware
 * If Signature header present: verify Ed25519 signature
 * If absent: falls back to authenticateAgent (backward compatible)
 *
 * Note on fallback: When no Signature header is present, the weaker legacy
 * auth path (agent-lookup by URL param or X-Agent-ID header) is used. This
 * is intentional for backward compatibility. To mandate HTTP Signatures,
 * set the REQUIRE_HTTP_SIGNATURES=true env var (future enhancement).
 *
 * Signature header format:
 *   Signature: keyId="<agent_id or DID>",algorithm="ed25519",
 *              headers="(request-target) host date",signature="<base64>"
 */
export async function authenticateHttpSignature(req, res, next) {
  const sigHeader = req.headers['signature'];

  // No Signature header → fall back to legacy auth
  if (!sigHeader) {
    return authenticateAgent(req, res, next);
  }

  try {
    // Parse Signature header
    const params = parseSignatureHeader(sigHeader);

    if (!params.keyId || !params.signature) {
      return res.status(400).json({
        error: 'INVALID_SIGNATURE_HEADER',
        message: 'Signature header must include keyId and signature'
      });
    }

    // Resolve agent by keyId (supports agent_id or DID)
    let agent;
    if (params.keyId.startsWith('did:seed:')) {
      agent = await storage.getAgentByDid(params.keyId);
    } else {
      agent = await storage.getAgent(params.keyId);
    }

    if (!agent) {
      return res.status(404).json({
        error: 'AGENT_NOT_FOUND',
        message: `Agent for keyId ${params.keyId} not found`
      });
    }

    // Authorization check: signing agent must match target agent in URL.
    // Without this, Agent A could sign with their own valid key and
    // perform actions on Agent B's resources.
    const targetAgentId = req.params.agentId || req.params.agent_id;
    if (targetAgentId && agent.agent_id !== targetAgentId) {
      return res.status(403).json({
        error: 'FORBIDDEN',
        message: 'Signature keyId does not match target agent'
      });
    }

    // Build canonical signing string
    const headersToSign = params.headers
      ? params.headers.split(' ')
      : ['(request-target)', 'host', 'date'];

    const signingLines = headersToSign.map(h => {
      if (h === '(request-target)') {
        return `(request-target): ${req.method.toLowerCase()} ${req.originalUrl}`;
      }
      const val = req.headers[h.toLowerCase()];
      if (!val) throw new Error(`Missing header: ${h}`);
      return `${h.toLowerCase()}: ${val}`;
    });
    const signingString = signingLines.join('\n');

    // Verify signature against all active public keys (supports rotation window)
    const sigBytes = fromBase64(params.signature);
    const message = Buffer.from(signingString, 'utf8');

    const activeKeys = agent.public_keys
      ? agent.public_keys.filter(k => k.active || (k.deactivate_at && k.deactivate_at > Date.now()))
      : [{ public_key: agent.public_key }];

    let verified = false;
    for (const keyEntry of activeKeys) {
      const pubKey = fromBase64(keyEntry.public_key);
      if (nacl.sign.detached.verify(message, sigBytes, pubKey)) {
        verified = true;
        break;
      }
    }

    if (!verified) {
      return res.status(403).json({
        error: 'SIGNATURE_INVALID',
        message: 'HTTP signature verification failed'
      });
    }

    req.agent = agent;
    req.authMethod = 'http-signature';
    next();
  } catch (error) {
    return res.status(400).json({
      error: 'SIGNATURE_VERIFICATION_FAILED',
      message: error.message
    });
  }
}

/**
 * Parse HTTP Signature header into components
 * @param {string} header - Signature header value
 * @returns {{ keyId, algorithm, headers, signature }}
 */
function parseSignatureHeader(header) {
  const params = {};
  // Match key="value" pairs
  const regex = /(\w+)="([^"]*)"/g;
  let match;
  while ((match = regex.exec(header)) !== null) {
    params[match[1]] = match[2];
  }
  return params;
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
