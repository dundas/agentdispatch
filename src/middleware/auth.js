/**
 * Authentication middleware
 * Supports:
 * - Agent ID lookup (legacy)
 * - HTTP Signature verification (RFC 9421-style)
 * - DID web federation
 * - Single-use enrollment tokens
 * - Registration approval status gate
 */

import { createHash, timingSafeEqual } from 'node:crypto';
import { storage } from '../storage/index.js';
import nacl from 'tweetnacl';
import { fromBase64, toBase64 } from '../utils/crypto.js';

function hashApiKey(key) {
  return createHash('sha256').update(key).digest('hex');
}

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

  if (agent.registration_status === 'pending') {
    return res.status(403).json({
      error: 'REGISTRATION_PENDING',
      message: 'Agent registration is pending approval'
    });
  }

  if (agent.registration_status === 'rejected') {
    return res.status(403).json({
      error: 'REGISTRATION_REJECTED',
      message: 'Agent registration has been rejected'
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

    // Resolve agent by keyId (supports agent_id, DID seed, or DID web)
    let agent;
    if (params.keyId.startsWith('did:web:')) {
      agent = await resolveDIDWebAgent(params.keyId, req);
    } else if (params.keyId.startsWith('did:seed:')) {
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

    // Approval status gate
    if (agent.registration_status === 'pending') {
      return res.status(403).json({
        error: 'REGISTRATION_PENDING',
        message: 'Agent registration is pending approval'
      });
    }

    if (agent.registration_status === 'rejected') {
      return res.status(403).json({
        error: 'REGISTRATION_REJECTED',
        message: 'Agent registration has been rejected'
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

    // For DID web agents: verify against keys fetched during resolution
    // For regular agents: verify against all active public keys
    const sigBytes = fromBase64(params.signature);
    const message = Buffer.from(signingString, 'utf8');

    const activeKeys = agent._did_web_keys
      ? agent._did_web_keys
      : agent.public_keys
        ? agent.public_keys.filter(k => k.active || (k.deactivate_at && k.deactivate_at > Date.now()))
        : [{ public_key: agent.public_key }];

    let verified = false;
    for (const keyEntry of activeKeys) {
      try {
        const pubKey = fromBase64(keyEntry.public_key);
        if (nacl.sign.detached.verify(message, sigBytes, pubKey)) {
          verified = true;
          break;
        }
      } catch {
        // Skip malformed key entries
      }
    }

    if (!verified) {
      return res.status(403).json({
        error: 'SIGNATURE_INVALID',
        message: 'HTTP signature verification failed'
      });
    }

    // Clean up transient DID web keys before attaching to request
    const { _did_web_keys, ...agentForRequest } = agent;
    req.agent = agentForRequest;
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
 * Accepts MASTER_API_KEY or any valid issued key from storage.
 */
export async function requireApiKey(req, res, next) {
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

  // Check master key first using constant-time comparison to prevent timing attacks
  const masterKey = process.env.MASTER_API_KEY;
  if (masterKey) {
    const masterBuf = Buffer.from(masterKey);
    const inputBuf = Buffer.from(apiKey);
    if (masterBuf.length === inputBuf.length && timingSafeEqual(masterBuf, inputBuf)) {
      req.apiKeyType = 'master';
      return next();
    }
  }

  // Check issued keys by hash
  try {
    const keyHash = hashApiKey(apiKey);
    const issuedKey = await storage.getIssuedKeyByHash(keyHash);

    if (issuedKey && !issuedKey.revoked) {
      if (issuedKey.expires_at && Date.now() > issuedKey.expires_at) {
        return res.status(403).json({
          error: 'API_KEY_EXPIRED',
          message: 'API key has expired'
        });
      }

      // Single-use enrollment token: check if already consumed
      if (issuedKey.single_use && issuedKey.used_at) {
        return res.status(403).json({
          error: 'ENROLLMENT_TOKEN_USED',
          message: 'This enrollment token has already been used'
        });
      }

      // Single-use token scope: validate against requested agent path.
      // A scoped token is only valid for its designated agent's endpoints.
      // Requests to non-agent paths (e.g. /api/stats) are denied — the token
      // is intended for a specific agent, not general API access.
      if (issuedKey.target_agent_id) {
        // req.params not populated yet (middleware runs before route matching)
        // Parse agent ID directly from req.path
        const match = req.path.match(/^\/agents\/([^/]+)/);
        const requestedAgentId = match ? decodeURIComponent(match[1]) : null;
        if (!requestedAgentId || (requestedAgentId !== 'register' && requestedAgentId !== issuedKey.target_agent_id)) {
          return res.status(403).json({
            error: 'ENROLLMENT_TOKEN_SCOPE',
            message: 'This enrollment token is scoped to a different agent'
          });
        }
      }

      // Burn single-use token on first valid use.
      // NOTE: There is an inherent TOCTOU race: two concurrent requests carrying
      // the same token may both pass the used_at check before either write completes.
      // This is acceptable for the intended 1:1 enrollment scenario (token is
      // pre-shared with a single agent). Do not use single-use tokens for
      // high-concurrency access control.
      if (issuedKey.single_use) {
        await storage.updateIssuedKey(issuedKey.key_id, { used_at: Date.now() });
      }

      req.apiKeyType = 'issued';
      req.apiKeyId = issuedKey.key_id;
      req.apiKeyClientId = issuedKey.client_id;
      return next();
    }
  } catch (err) {
    // Storage lookup failure → deny; log for observability
    console.error('issued key lookup failed:', err.message);
  }

  return res.status(403).json({
    error: 'INVALID_API_KEY',
    message: 'Invalid API key'
  });
}

/**
 * Decode a base58btc-encoded multibase string (stripping the 2-byte multicodec prefix).
 * Used for DID document `publicKeyMultibase` values (e.g. Ed25519 keys start with 0xed01).
 *
 * Uses a fixed output length of 34 bytes (2-byte multicodec prefix + 32-byte Ed25519 key)
 * to preserve any leading zero bytes that a plain BigInt→hex conversion would drop.
 */
function base58btcDecode(multibase) {
  // Strip leading 'z' multibase prefix
  const encoded = multibase.startsWith('z') ? multibase.slice(1) : multibase;

  const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  const BASE = BigInt(58);

  let result = BigInt(0);
  for (const char of encoded) {
    const idx = ALPHABET.indexOf(char);
    if (idx < 0) throw new Error(`Invalid base58 character: ${char}`);
    result = result * BASE + BigInt(idx);
  }

  // Ed25519 with multicodec prefix is exactly 34 bytes (2-byte prefix + 32-byte key).
  // Pad to the full expected length so leading zero bytes in the key material are preserved.
  const ED25519_MULTIBASE_BYTES = 34;
  const hex = result.toString(16).padStart(ED25519_MULTIBASE_BYTES * 2, '0');
  const bytes = Buffer.from(hex, 'hex');

  // Strip 2-byte multicodec prefix (Ed25519 = 0xed01)
  return bytes.slice(2);
}

// Short-lived in-process cache for DID document keys (5-minute TTL per DID).
// Prevents a per-request outbound HTTP fetch and removes the DoS amplification
// surface from novel did:web key IDs crafted by an attacker.
const _didKeyCache = new Map();
const _DID_KEY_CACHE_TTL_MS = 5 * 60 * 1000;

/**
 * Resolve a did:web: DID to a shadow agent record.
 * - Fetches the DID document from the well-known URL (cached 5 min)
 * - Extracts Ed25519 verification keys
 * - Returns existing shadow agent or creates a new one per tenant policy
 */
async function resolveDIDWebAgent(did, req) {
  try {
    // Parse DID web URL: did:web:domain.com[:path:segments]
    const withoutPrefix = did.slice('did:web:'.length);
    const parts = withoutPrefix.split(':');
    const domain = decodeURIComponent(parts[0]);
    const pathSegments = parts.slice(1).map(decodeURIComponent);

    // Check in-process key cache before making an outbound HTTP request
    const cachedEntry = _didKeyCache.get(did);
    let didWebKeys = cachedEntry && (Date.now() - cachedEntry.cachedAt < _DID_KEY_CACHE_TTL_MS)
      ? cachedEntry.keys
      : null;

    if (!didWebKeys) {
      // Per the DID:web spec:
      //   did:web:domain.com           → https://domain.com/.well-known/did.json
      //   did:web:domain.com:path:seg  → https://domain.com/path/seg/did.json
      const didUrl = pathSegments.length > 0
        ? `https://${domain}/${pathSegments.join('/')}/did.json`
        : `https://${domain}/.well-known/did.json`;

      // Fetch with 5s timeout (fail-closed on network errors)
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 5000);

      let didDoc;
      try {
        const resp = await fetch(didUrl, { signal: controller.signal });
        if (!resp.ok) return null;
        didDoc = await resp.json();
      } finally {
        clearTimeout(timeout);
      }

      if (!didDoc || didDoc.id !== did) return null;

      // Extract Ed25519 verification methods
      const verificationMethods = (didDoc.verificationMethod || []).filter(
        vm => vm.type === 'Ed25519VerificationKey2020' || vm.type === 'Ed25519VerificationKey2018'
      );

      if (verificationMethods.length === 0) return null;

      // Convert DID doc keys to internal format for signature verification
      didWebKeys = verificationMethods.map(vm => {
        if (vm.publicKeyMultibase) {
          const pubKeyBytes = base58btcDecode(vm.publicKeyMultibase);
          return { public_key: toBase64(pubKeyBytes) };
        }
        if (vm.publicKeyBase64) {
          return { public_key: vm.publicKeyBase64 };
        }
        return null;
      }).filter(Boolean);

      if (didWebKeys.length === 0) return null;

      _didKeyCache.set(did, { keys: didWebKeys, cachedAt: Date.now() });
    }

    // Check for existing shadow agent
    const existing = await storage.getAgentByDid(did);
    if (existing) {
      // Attach fresh keys for this request's signature verification
      return { ...existing, _did_web_keys: didWebKeys };
    }

    // Create shadow agent with tenant policy applied
    // Shadow agents don't have a specific tenant; use global policy
    const policy = process.env.REGISTRATION_POLICY || 'open';
    const registrationStatus = policy === 'approval_required' ? 'pending' : 'approved';

    // Use decoded domain + path segments as agent_id to avoid collisions between
    // multi-path DIDs sharing the same domain (e.g. did:web:host:alice vs did:web:host:bob)
    const agentIdPath = [domain, ...pathSegments].join('/');
    const didUrl = pathSegments.length > 0
      ? `https://${domain}/${pathSegments.join('/')}/did.json`
      : `https://${domain}/.well-known/did.json`;

    const shadowAgent = {
      agent_id: `did-web:${agentIdPath}`,
      agent_type: 'federated',
      did,
      public_key: didWebKeys[0].public_key,
      public_keys: didWebKeys.map((k, i) => ({ version: i + 1, public_key: k.public_key, created_at: Date.now(), active: true })),
      tenant_id: null,
      registration_mode: 'did-web',
      registration_status: registrationStatus,
      key_version: 1,
      verification_tier: 'unverified',
      metadata: { did_document_url: didUrl },
      webhook_url: null,
      webhook_secret: null,
      heartbeat: {
        last_heartbeat: Date.now(),
        status: 'online',
        interval_ms: 60000,
        timeout_ms: 300000
      },
      trusted_agents: [],
      blocked_agents: []
    };

    await storage.createAgent(shadowAgent);

    return { ...shadowAgent, _did_web_keys: didWebKeys };
  } catch {
    // Any error → fail closed
    return null;
  }
}

/**
 * Requires the master API key specifically.
 * Used for admin-only operations like key issuance.
 */
export function requireMasterKey(req, res, next) {
  const apiKey = req.headers['x-api-key'] || req.headers['authorization']?.replace('Bearer ', '');

  if (!apiKey) {
    return res.status(401).json({
      error: 'API_KEY_REQUIRED',
      message: 'Master API key is required'
    });
  }

  const masterKey = process.env.MASTER_API_KEY;
  let masterKeyMatches = false;
  if (masterKey) {
    const masterBuf = Buffer.from(masterKey);
    const inputBuf = Buffer.from(apiKey);
    masterKeyMatches = masterBuf.length === inputBuf.length && timingSafeEqual(masterBuf, inputBuf);
  }

  if (!masterKeyMatches) {
    return res.status(403).json({
      error: 'MASTER_KEY_REQUIRED',
      message: 'This endpoint requires the master API key'
    });
  }

  next();
}
