/**
 * Authentication middleware
 * Supports:
 * - Agent ID lookup (legacy)
 * - HTTP Signature verification (RFC 9421-style)
 * - DID web federation
 * - Single-use enrollment tokens
 * - Registration approval status gate
 */

import { timingSafeEqual } from 'node:crypto';
import { storage } from '../storage/index.js';
import nacl from 'tweetnacl';
import { fromBase64, toBase64, hashApiKey } from '../utils/crypto.js';

/**
 * Rejects the response if the agent's registration is not approved.
 * Returns true if rejected (caller should return early), false if the agent is approved.
 * Extracted to avoid duplicating the same two-condition check across multiple middlewares.
 */
function rejectIfNotApproved(agent, res) {
  if (agent.registration_status === 'pending') {
    res.status(403).json({
      error: 'REGISTRATION_PENDING',
      message: 'Agent registration is pending approval'
    });
    return true;
  }
  if (agent.registration_status === 'rejected') {
    res.status(403).json({
      error: 'REGISTRATION_REJECTED',
      message: 'Agent registration has been rejected'
    });
    return true;
  }
  return false;
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

  if (rejectIfNotApproved(agent, res)) return;

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
    if (rejectIfNotApproved(agent, res)) return;

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

// Lookup table for base58 alphabet — avoids BigInt arithmetic in the hot auth path.
// Built once at module load; indexed by char code (0-127).
const _BASE58_MAP = new Uint8Array(128).fill(0xff);
for (let i = 0; i < 58; i++) {
  _BASE58_MAP['123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'.charCodeAt(i)] = i;
}

/**
 * Decode a base58btc-encoded multibase string (stripping the 2-byte multicodec prefix).
 * Used for DID document `publicKeyMultibase` values (e.g. Ed25519 keys start with 0xed01).
 *
 * Uses a lookup-table algorithm (not BigInt) to avoid allocating large integers
 * on every incoming authentication request.
 */
function base58btcDecode(multibase) {
  const encoded = multibase.startsWith('z') ? multibase.slice(1) : multibase;

  // Decode base58 into a little-endian byte array using the lookup table
  const digits = [0];
  for (let i = 0; i < encoded.length; i++) {
    const code = encoded.charCodeAt(i);
    if (code >= 128 || _BASE58_MAP[code] === 0xff) {
      throw new Error(`Invalid base58 character: ${encoded[i]}`);
    }
    let carry = _BASE58_MAP[code];
    for (let j = 0; j < digits.length; j++) {
      carry += digits[j] * 58;
      digits[j] = carry & 0xff;
      carry >>= 8;
    }
    while (carry > 0) {
      digits.push(carry & 0xff);
      carry >>= 8;
    }
  }

  // Count leading '1' characters → leading zero bytes
  let leadingZeros = 0;
  for (let i = 0; i < encoded.length && encoded[i] === '1'; i++) leadingZeros++;

  // Assemble big-endian byte array (digits is little-endian → reverse)
  const result = new Uint8Array(leadingZeros + digits.length);
  for (let i = 0; i < digits.length; i++) {
    result[leadingZeros + i] = digits[digits.length - 1 - i];
  }

  // Ed25519 with multicodec prefix is exactly 34 bytes.
  const ED25519_MULTIBASE_BYTES = 34;
  if (result.length > ED25519_MULTIBASE_BYTES) {
    throw new Error(`Invalid key length: expected ${ED25519_MULTIBASE_BYTES} bytes, got ${result.length}`);
  }
  const padded = result.length < ED25519_MULTIBASE_BYTES
    ? new Uint8Array([...new Uint8Array(ED25519_MULTIBASE_BYTES - result.length), ...result])
    : result;

  // Verify the 2-byte multicodec prefix is Ed25519 (0xed 0x01) before stripping.
  // Other key types use different prefixes and must not be silently decoded as Ed25519.
  if (padded[0] !== 0xed || padded[1] !== 0x01) {
    throw new Error(`Unsupported key type: expected Ed25519 multicodec prefix 0xed01, got 0x${padded[0].toString(16).padStart(2, '0')}${padded[1].toString(16).padStart(2, '0')}`);
  }

  return padded.slice(2);
}

// Short-lived in-process cache for DID document keys (5-minute TTL per DID).
// Prevents a per-request outbound HTTP fetch and removes the DoS amplification
// surface from novel did:web key IDs crafted by an attacker.
// Size is bounded to prevent memory exhaustion from novel DID values.
const _didKeyCache = new Map();
const _DID_KEY_CACHE_TTL_MS = 5 * 60 * 1000;
const _DID_KEY_CACHE_MAX = 1000;

/**
 * Returns true if the hostname should be blocked from DID web resolution
 * to prevent SSRF attacks targeting internal/private infrastructure.
 * Blocks loopback, RFC 1918, link-local (AWS metadata), and raw IPv6 addresses.
 *
 * NOTE: DNS rebinding is NOT mitigated here. This blocklist validates the hostname
 * string before the fetch but cannot prevent the DNS resolver from returning a
 * different (internal) IP at connection time. The 5-minute DID key cache reduces
 * the attack window but does not close it. Full SSRF protection requires a
 * post-connect IP check or an explicit allow-list configured at the network layer.
 */
function isBlockedDIDWebHost(domain) {
  // Strip IPv6 brackets (e.g. [::1] → ::1)
  const host = domain.startsWith('[') ? domain.slice(1, -1) : domain;

  // Loopback and localhost
  if (host === 'localhost' || host.endsWith('.local') || host === '::1' || host === '0.0.0.0') {
    return true;
  }

  // Block any raw IPv6 address (::1, fc00::/7, fe80::/10, etc.)
  if (host.includes(':')) {
    return true;
  }

  // Check IPv4 private ranges
  const ipv4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ipv4) {
    const o = ipv4.slice(1).map(Number);
    if (
      o[0] === 127 ||                                            // 127.0.0.0/8 loopback
      o[0] === 10 ||                                             // 10.0.0.0/8 RFC 1918
      (o[0] === 172 && o[1] >= 16 && o[1] <= 31) ||             // 172.16.0.0/12 RFC 1918
      (o[0] === 192 && o[1] === 168) ||                          // 192.168.0.0/16 RFC 1918
      (o[0] === 169 && o[1] === 254) ||                          // 169.254.0.0/16 link-local
      o[0] === 0                                                 // 0.0.0.0/8
    ) {
      return true;
    }
  }

  return false;
}

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

    // Block SSRF: reject DIDs targeting private/internal infrastructure
    if (isBlockedDIDWebHost(domain)) {
      return null;
    }

    // Compute DID document URL once (per W3C DID:web spec):
    //   did:web:domain.com           → https://domain.com/.well-known/did.json
    //   did:web:domain.com:path:seg  → https://domain.com/path/seg/did.json
    const didUrl = pathSegments.length > 0
      ? `https://${domain}/${pathSegments.join('/')}/did.json`
      : `https://${domain}/.well-known/did.json`;

    // Check in-process key cache before making an outbound HTTP request
    const cachedEntry = _didKeyCache.get(did);
    let didWebKeys = cachedEntry && (Date.now() - cachedEntry.cachedAt < _DID_KEY_CACHE_TTL_MS)
      ? cachedEntry.keys
      : null;

    if (!didWebKeys) {
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

      // Evict the oldest cached entry (Map preserves insertion order) to bound memory use.
      // Evicting one-at-a-time limits the blast radius compared to a full clear().
      if (_didKeyCache.size >= _DID_KEY_CACHE_MAX) {
        _didKeyCache.delete(_didKeyCache.keys().next().value);
      }
      _didKeyCache.set(did, { keys: didWebKeys, cachedAt: Date.now() });
    }

    // Check for existing shadow agent.
    // NOTE: There is a narrow race between the getAgentByDid check and createAgent
    // for the first request from a given DID. The memory backend overwrites silently;
    // the Mech backend may return an error on duplicate writes. The race window is
    // small and for federated agents it is acceptable — the second write is idempotent.
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
