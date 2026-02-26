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
import { fromBase64, toBase64, hashApiKey, validateTimestamp } from '../utils/crypto.js';

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
 * Shared signature verification core used by both verifyHttpSignatureOnly
 * (global gate) and authenticateHttpSignature (route middleware).
 *
 * Returns:
 *   { ok: true, agent }           — signature valid, agent approved
 *   { ok: false, reason, agent? } — verification failed with specific reason
 *
 * Handles: header parsing → agent resolution → approval gate → algorithm
 * validation → signed header requirements → timestamp freshness → signing
 * string construction → key iteration → Ed25519 verify.
 *
 * Callers add their own authorization checks and response handling on top.
 */
async function _verifySignatureCore(req, sigHeader) {
  const params = parseSignatureHeader(sigHeader);
  if (!params.keyId || !params.signature) {
    return { ok: false, reason: 'INVALID_PARAMS' };
  }

  // Algorithm validation: only Ed25519 is supported.
  // Prevents algorithm confusion if another algorithm is ever added.
  if (params.algorithm && params.algorithm !== 'ed25519') {
    return { ok: false, reason: 'UNSUPPORTED_ALGORITHM' };
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

  if (!agent) return { ok: false, reason: 'AGENT_NOT_FOUND', keyId: params.keyId };

  // Approval status gate
  if (agent.registration_status === 'pending') {
    return { ok: false, reason: 'REGISTRATION_PENDING', agent };
  }
  if (agent.registration_status === 'rejected') {
    return { ok: false, reason: 'REGISTRATION_REJECTED', agent };
  }

  // Build canonical signing string
  const headersToSign = params.headers
    ? params.headers.split(' ')
    : ['(request-target)', 'host', 'date'];

  // (request-target) must always be signed to bind the signature to the URL.
  // Without this, a signature over 'date' alone is path-agnostic and can be
  // replayed on any endpoint for that agent within the time window.
  if (!headersToSign.includes('(request-target)')) {
    return { ok: false, reason: 'REQUEST_TARGET_REQUIRED' };
  }

  // Replay protection: 'date' must always be signed to prevent replay attacks.
  if (!headersToSign.includes('date')) {
    return { ok: false, reason: 'DATE_REQUIRED' };
  }

  // Validate Date header freshness (must be within +/- 5 minutes)
  const dateHeader = req.headers['date'];
  if (!dateHeader) {
    return { ok: false, reason: 'DATE_MISSING' };
  }
  if (!validateTimestamp(dateHeader)) {
    return { ok: false, reason: 'REQUEST_EXPIRED' };
  }

  const signingLines = headersToSign.map(h => {
    if (h === '(request-target)') {
      return `(request-target): ${req.method.toLowerCase()} ${req.originalUrl}`;
    }
    const val = req.headers[h.toLowerCase()];
    if (!val) throw new Error(`Missing header: ${h}`);
    return `${h.toLowerCase()}: ${val}`;
  });
  const signingString = signingLines.join('\n');

  // Verify against active public keys
  const sigBytes = fromBase64(params.signature);
  const message = Buffer.from(signingString, 'utf8');

  const activeKeys = agent._did_web_keys
    ? agent._did_web_keys
    : agent.public_keys
      ? agent.public_keys.filter(k => k.active || (k.deactivate_at && k.deactivate_at > Date.now()))
      : [{ public_key: agent.public_key }];

  for (const keyEntry of activeKeys) {
    try {
      const pubKey = fromBase64(keyEntry.public_key);
      if (nacl.sign.detached.verify(message, sigBytes, pubKey)) {
        const { _did_web_keys, ...agentForRequest } = agent;
        return { ok: true, agent: agentForRequest };
      }
    } catch {
      // Skip malformed key entries
    }
  }

  return { ok: false, reason: 'SIGNATURE_INVALID' };
}

/**
 * Verify an HTTP Signature header without sending a response.
 * Returns { verified: true, agent } if the signature is valid,
 * or { verified: false, reason? } if missing/invalid.
 * Used by the global API key gate to bypass requireApiKey for signed requests.
 */
export async function verifyHttpSignatureOnly(req) {
  const sigHeader = req.headers['signature'];
  if (!sigHeader) return { verified: false };

  try {
    const result = await _verifySignatureCore(req, sigHeader);

    if (!result.ok) {
      return { verified: false, reason: result.reason };
    }

    // Authorization check: signing agent must match target agent in URL,
    // EXCEPT for cross-agent message sending (POST /agents/:id/messages).
    // Without this, Agent A could sign with their own valid key and
    // access Agent B's private resources (inbox pull, ack) via the bypass.
    // Message sending is explicitly allowed cross-agent — that's the protocol's purpose.
    const agentPathMatch = req.path.match(/^\/agents\/([^/]+)/);
    if (agentPathMatch) {
      const targetAgentId = decodeURIComponent(agentPathMatch[1]);
      const isMessageSend = req.method === 'POST' && /^\/agents\/[^/]+\/messages\/?$/.test(req.path);
      if (targetAgentId !== 'register' && !isMessageSend && result.agent.agent_id !== targetAgentId) {
        return { verified: false };
      }
    }

    return { verified: true, agent: result.agent };
  } catch {
    return { verified: false };
  }
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
  // Short-circuit: if the global API gate already verified the signature and
  // set req.agent, skip the duplicate crypto + storage work.
  if (req.agent && req.authMethod === 'http-signature') {
    return next();
  }

  const sigHeader = req.headers['signature'];

  // No Signature header → fall back to legacy auth
  if (!sigHeader) {
    return authenticateAgent(req, res, next);
  }

  try {
    const result = await _verifySignatureCore(req, sigHeader);

    if (!result.ok) {
      // Map core reasons to HTTP responses
      const reasonMap = {
        INVALID_PARAMS: [400, 'INVALID_SIGNATURE_HEADER', 'Signature header must include keyId and signature'],
        UNSUPPORTED_ALGORITHM: [400, 'UNSUPPORTED_ALGORITHM', 'Only ed25519 signatures are supported'],
        AGENT_NOT_FOUND: [404, 'AGENT_NOT_FOUND', `Agent for keyId ${result.keyId || 'unknown'} not found`],
        REGISTRATION_PENDING: [403, 'REGISTRATION_PENDING', 'Agent registration is pending approval'],
        REGISTRATION_REJECTED: [403, 'REGISTRATION_REJECTED', 'Agent registration has been rejected'],
        REQUEST_TARGET_REQUIRED: [400, 'INSUFFICIENT_SIGNED_HEADERS', 'Signed headers must include (request-target)'],
        DATE_REQUIRED: [400, 'DATE_HEADER_REQUIRED', 'The "date" header must be included in the signed headers list'],
        DATE_MISSING: [400, 'DATE_HEADER_REQUIRED', 'Date header is required for HTTP signature authentication'],
        REQUEST_EXPIRED: [403, 'REQUEST_EXPIRED', 'Date header is outside the acceptable time window (+-5 minutes)'],
        SIGNATURE_INVALID: [403, 'SIGNATURE_INVALID', 'HTTP signature verification failed'],
      };
      const [status, error, message] = reasonMap[result.reason] || [400, 'SIGNATURE_VERIFICATION_FAILED', 'Signature verification failed'];
      return res.status(status).json({ error, message });
    }

    // Authorization check: signing agent must match target agent in URL.
    // Without this, Agent A could sign with their own valid key and
    // perform actions on Agent B's resources.
    const targetAgentId = req.params.agentId || req.params.agent_id;
    if (targetAgentId && result.agent.agent_id !== targetAgentId) {
      return res.status(403).json({
        error: 'FORBIDDEN',
        message: 'Signature keyId does not match target agent'
      });
    }

    req.agent = result.agent;
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
  try {
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
          // Return the same error as unknown keys to avoid leaking key existence.
          // An attacker probing keys shouldn't be able to distinguish 'expired but
          // valid' from 'never existed'.
          return res.status(401).json({
            error: 'INVALID_API_KEY',
            message: 'Invalid API key'
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
          // Note: POST /agents/register is already exempted in server.js before
          // requireApiKey runs, so no 'register' carve-out is needed here.
          if (!requestedAgentId || requestedAgentId !== issuedKey.target_agent_id) {
            return res.status(403).json({
              error: 'ENROLLMENT_TOKEN_SCOPE',
              message: 'This enrollment token is scoped to a different agent'
            });
          }
        }

        // Burn single-use token atomically: burnSingleUseKey sets used_at only if
        // it is currently null, returning false if another request already burned it.
        // This closes the TOCTOU race where two concurrent requests both pass the
        // used_at check above before either write completes.
        if (issuedKey.single_use) {
          const burned = await storage.burnSingleUseKey(issuedKey.key_id);
          if (!burned) {
            return res.status(403).json({
              error: 'ENROLLMENT_TOKEN_USED',
              message: 'This enrollment token has already been used'
            });
          }
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

    // 401 for all bad-credential scenarios — do not use 403 here, which would
    // leak that the key format was recognized but didn't match any record.
    return res.status(401).json({
      error: 'INVALID_API_KEY',
      message: 'Invalid API key'
    });
  } catch (err) {
    // Guard against unhandled exceptions (e.g. hashApiKey or Buffer.from throwing).
    // Express 4 does not forward async rejections to the error handler, so an
    // uncaught throw here would hang the request.
    console.error('requireApiKey unexpected error:', err.message);
    return res.status(500).json({
      error: 'INTERNAL_ERROR',
      message: 'Internal server error'
    });
  }
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
  // Reject anything that isn't exactly 34 bytes — shorter keys would be silently
  // zero-padded, which could produce an all-zero public key that an attacker
  // could craft signatures against.
  const ED25519_MULTIBASE_BYTES = 34;
  if (result.length !== ED25519_MULTIBASE_BYTES) {
    throw new Error(`Invalid key length: expected ${ED25519_MULTIBASE_BYTES} bytes, got ${result.length}`);
  }

  // Verify the 2-byte multicodec prefix is Ed25519 (0xed 0x01) before stripping.
  // Other key types use different prefixes and must not be silently decoded as Ed25519.
  if (result[0] !== 0xed || result[1] !== 0x01) {
    throw new Error(`Unsupported key type: expected Ed25519 multicodec prefix 0xed01, got 0x${result[0].toString(16).padStart(2, '0')}${result[1].toString(16).padStart(2, '0')}`);
  }

  return result.slice(2);
}

// Short-lived in-process cache for DID document keys (5-minute TTL per DID).
// Prevents a per-request outbound HTTP fetch and removes the DoS amplification
// surface from novel did:web key IDs crafted by an attacker.
// Size is bounded to prevent memory exhaustion from novel DID values.
const _didKeyCache = new Map();
const _DID_KEY_CACHE_TTL_MS = 5 * 60 * 1000;
const _DID_KEY_CACHE_MAX = 1000;

// Allowlist for DID:web domain names (excludes colons — colons are not valid in hostnames).
// Module-level so it is compiled once, not on every DID auth attempt.
const SAFE_DID_DOMAIN = /^[a-zA-Z0-9._-]+$/;
// Allowlist for DID:web path segments (colons are valid per W3C DID Core spec).
const SAFE_DID_SEGMENT = /^[a-zA-Z0-9._:-]+$/;

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
  // Allowlist mode: if DID_WEB_ALLOWED_DOMAINS is set (comma-separated),
  // ONLY those domains are permitted for DID:web resolution.
  const allowedDomains = process.env.DID_WEB_ALLOWED_DOMAINS;
  if (allowedDomains) {
    const allowed = allowedDomains.split(',').map(d => d.trim()).filter(Boolean);
    return !allowed.includes(domain);
  }

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
    // Guard against out-of-range octets (e.g. 999.0.0.1) which would bypass
    // all private-range checks and be treated as a valid public IP.
    if (o.some(x => x > 255)) return true;
    if (
      o[0] === 127 ||                                            // 127.0.0.0/8 loopback
      o[0] === 10 ||                                             // 10.0.0.0/8 RFC 1918
      (o[0] === 172 && o[1] >= 16 && o[1] <= 31) ||             // 172.16.0.0/12 RFC 1918
      (o[0] === 192 && o[1] === 168) ||                          // 192.168.0.0/16 RFC 1918
      (o[0] === 169 && o[1] === 254) ||                          // 169.254.0.0/16 link-local
      (o[0] === 100 && o[1] >= 64 && o[1] <= 127) ||            // 100.64.0.0/10 CGNAT/shared (cloud metadata)
      (o[0] === 100 && o[1] === 100 && o[2] === 100 && o[3] === 200) || // 100.100.100.200 Alibaba Cloud metadata
      (o[0] === 192 && o[1] === 0 && o[2] === 0) ||             // 192.0.0.0/24 IETF Protocol Assignments
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

    // Defense-in-depth: validate domain and path segments contain only safe
    // characters before using them in agent_id construction or HTTP requests.
    // A crafted keyId like "did:web:evil.com\nX-Injected: header" could
    // otherwise inject into signing strings or storage keys.
    if (!SAFE_DID_DOMAIN.test(domain) || domain === '..') return null;
    // Also block '..' explicitly: SAFE_DID_SEGMENT allows dots, so '..' passes the
    // character check — but it would produce a path-traversal URL like
    // https://domain.com/../did.json which may escape the intended path prefix.
    if (pathSegments.some(seg => !SAFE_DID_SEGMENT.test(seg) || seg === '..')) return null;

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

      const DID_DOC_MAX_BYTES = 65536; // 64 KB

      let didDoc;
      try {
        // Use redirect: 'manual' to prevent SSRF via redirect — an attacker
        // controlling a public domain could redirect /.well-known/did.json
        // to an internal address, bypassing isBlockedDIDWebHost.
        const resp = await fetch(didUrl, { signal: controller.signal, redirect: 'manual' });

        // Handle redirects: validate the redirect target against the SSRF blocklist
        if (resp.status >= 300 && resp.status < 400) {
          const location = resp.headers.get('location');
          if (!location) return null;
          try {
            const redirectUrl = new URL(location, didUrl);
            if (isBlockedDIDWebHost(redirectUrl.hostname)) return null;
            // Follow one validated redirect
            const redirectResp = await fetch(redirectUrl.href, { signal: controller.signal, redirect: 'error' });
            if (!redirectResp.ok) return null;
            const contentLength = parseInt(redirectResp.headers.get('content-length'), 10);
            if (contentLength > DID_DOC_MAX_BYTES) return null;
            const bodyText = await redirectResp.text();
            if (Buffer.byteLength(bodyText, 'utf8') > DID_DOC_MAX_BYTES) return null;
            didDoc = JSON.parse(bodyText);
          } catch {
            return null;
          }
        } else {
          if (!resp.ok) return null;

          // Check Content-Length header if present (fast reject for oversized docs)
          const contentLength = parseInt(resp.headers.get('content-length'), 10);
          if (contentLength > DID_DOC_MAX_BYTES) return null;

          // Read body with byte cap as fallback (Content-Length can be spoofed)
          const bodyText = await resp.text();
          if (Buffer.byteLength(bodyText, 'utf8') > DID_DOC_MAX_BYTES) return null;

          didDoc = JSON.parse(bodyText);
        }
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
    const existing = await storage.getAgentByDid(did);
    if (existing) {
      // Attach fresh keys for this request's signature verification
      return { ...existing, _did_web_keys: didWebKeys };
    }

    // Create shadow agent with federated trust policy.
    // DID:web agents come from external domains — a different trust origin than
    // locally-registered agents. Auto-approve only if:
    //   1. REGISTRATION_POLICY is 'open' (not 'approval_required'), AND
    //   2. DID_WEB_ALLOWED_DOMAINS is set and the domain is in the allowlist.
    // Otherwise default to 'pending' to prevent arbitrary internet domains from
    // gaining immediate access.
    const policy = process.env.REGISTRATION_POLICY || 'open';
    let registrationStatus = 'pending';
    if (policy === 'open') {
      const allowedDomains = process.env.DID_WEB_ALLOWED_DOMAINS;
      if (allowedDomains) {
        const allowed = allowedDomains.split(',').map(d => d.trim().toLowerCase());
        if (allowed.includes(domain.toLowerCase())) {
          registrationStatus = 'approved';
        }
      }
      // If no allowlist set, DID:web agents default to pending even under open policy
    }

    // Use decoded domain + path segments as agent_id to avoid collisions between
    // multi-path DIDs sharing the same domain (e.g. did:web:host:alice vs did:web:host:bob)
    const agentIdPath = [domain, ...pathSegments].join('/');

    // Namespace collision guard: if a non-federated agent already occupies
    // this agent_id, fail closed rather than silently overwriting it.
    const collisionCheck = await storage.getAgent(`did-web:${agentIdPath}`);
    if (collisionCheck && collisionCheck.agent_type !== 'federated') {
      return null;
    }

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

    try {
      await storage.createAgent(shadowAgent);
    } catch {
      // Race condition: another request created the agent between our
      // getAgentByDid check and createAgent call. Retry the lookup once
      // (optimistic upsert pattern) rather than surfacing a 500.
      const raceWinner = await storage.getAgentByDid(did);
      if (raceWinner) return { ...raceWinner, _did_web_keys: didWebKeys };
      return null;
    }

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
    // 401 for all bad-credential cases — consistent with requireApiKey.
    // 403 would leak that the key was recognised as a key but didn't match.
    return res.status(401).json({
      error: 'MASTER_KEY_REQUIRED',
      message: 'This endpoint requires the master API key'
    });
  }

  next();
}
