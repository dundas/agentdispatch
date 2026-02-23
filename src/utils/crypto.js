/**
 * Cryptographic utilities for ADMP
 * Handles Ed25519 keypair generation and signature verification
 */

import nacl from 'tweetnacl';
import { createHash, createHmac } from 'crypto';

/**
 * Generate Ed25519 keypair
 * @returns {Object} {publicKey: Uint8Array, secretKey: Uint8Array}
 */
export function generateKeypair() {
  return nacl.sign.keyPair();
}

/**
 * Convert Uint8Array to base64
 * @param {Uint8Array} bytes
 * @returns {string}
 */
export function toBase64(bytes) {
  return Buffer.from(bytes).toString('base64');
}

/**
 * Convert base64 to Uint8Array
 * @param {string} base64
 * @returns {Uint8Array}
 */
export function fromBase64(base64) {
  return new Uint8Array(Buffer.from(base64, 'base64'));
}

/**
 * SHA256 hash of input
 * @param {string|Buffer} input
 * @returns {string} base64 encoded hash
 */
export function sha256(input) {
  return createHash('sha256').update(input).digest('base64');
}

/**
 * SHA-256 hex digest for API key lookups.
 * Shared by auth.js (key validation) and keys.js (key issuance) to ensure
 * the same hashing algorithm is used in both places.
 * @param {string} key
 * @returns {string} hex digest
 */
export function hashApiKey(key) {
  return createHash('sha256').update(key).digest('hex');
}

/**
 * Create canonical signing base string for ADMP message
 * Format: timestamp\nbodyHash\nfrom\nto\ncorrelationId
 *
 * @param {Object} envelope - ADMP message envelope
 * @returns {string}
 */
export function createSigningBase(envelope) {
  const bodyHash = sha256(JSON.stringify(envelope.body || {}));
  const parts = [
    envelope.timestamp,
    bodyHash,
    envelope.from,
    envelope.to,
    envelope.correlation_id || ''
  ];
  return parts.join('\n');
}

/**
 * Sign a message envelope
 * @param {Object} envelope - ADMP message envelope
 * @param {Uint8Array} secretKey - Agent's secret key
 * @returns {Object} signature object
 */
export function signMessage(envelope, secretKey) {
  const base = createSigningBase(envelope);
  const message = Buffer.from(base, 'utf8');
  const signature = nacl.sign.detached(message, secretKey);

  return {
    alg: 'ed25519',
    kid: envelope.from.replace('agent://', ''),
    sig: toBase64(signature)
  };
}

/**
 * Verify message signature
 * @param {Object} envelope - ADMP message envelope
 * @param {Uint8Array} publicKey - Sender's public key
 * @returns {boolean}
 */
export function verifySignature(envelope, publicKey) {
  if (!envelope.signature || !envelope.signature.sig) {
    return false;
  }

  const base = createSigningBase(envelope);
  const message = Buffer.from(base, 'utf8');
  const signature = fromBase64(envelope.signature.sig);

  return nacl.sign.detached.verify(message, signature, publicKey);
}

/**
 * Validate timestamp is within acceptable window (±5 minutes)
 * @param {string} timestamp - ISO 8601 timestamp
 * @returns {boolean}
 */
export function validateTimestamp(timestamp) {
  const now = Date.now();
  const msgTime = new Date(timestamp).getTime();
  const FIVE_MINUTES = 5 * 60 * 1000;

  return Math.abs(now - msgTime) <= FIVE_MINUTES;
}

/**
 * Parse a human-readable TTL string into seconds
 * Supports: "30m" (minutes), "1h" (hours), "7d" (days), "3600" (raw seconds)
 * @param {string|number} ttl - TTL value
 * @returns {number|null} seconds, or null if input is invalid/unparseable
 */
export function parseTTL(ttl) {
  if (typeof ttl === 'number') return ttl > 0 ? ttl : null;
  if (typeof ttl !== 'string') return null;

  const match = ttl.match(/^(\d+)\s*(m|h|d|s)?$/i);
  if (!match) return null;

  const value = parseInt(match[1], 10);
  if (value <= 0) return null;

  const unit = (match[2] || 's').toLowerCase();

  switch (unit) {
    case 'm': return value * 60;
    case 'h': return value * 3600;
    case 'd': return value * 86400;
    case 's': return value;
    default: return value;
  }
}

// ============ IDENTITY DERIVATION ============
// SeedID-compatible primitives using tweetnacl + node:crypto.
// These produce output identical to @seedid/core's hkdf, generateEd25519KeyPair,
// and generateDID. When SeedID fixes Node.js JSON import compatibility,
// these can be replaced with direct @seedid/core imports.

/** HKDF label for Agent Dispatch (matches @seedid/core LABEL_ADMP) */
export const LABEL_ADMP = 'seedid/v1/admp';

/**
 * RFC 5869 HKDF-SHA256 (Extract + Expand)
 * @param {Uint8Array} ikm - Input keying material
 * @param {string} info - Context/label string
 * @param {Object} opts
 * @param {string} opts.salt - Salt string (default: 'seedid/v1')
 * @param {number} opts.length - Output length in bytes (default: 32)
 * @returns {Uint8Array}
 */
export function hkdfSha256(ikm, info, opts = {}) {
  const salt = opts.salt ?? 'seedid/v1';
  const length = opts.length ?? 32;

  // HKDF-Extract: PRK = HMAC-SHA256(salt, IKM)
  const prk = createHmac('sha256', Buffer.from(salt, 'utf8'))
    .update(ikm)
    .digest();

  // HKDF-Expand
  const infoBytes = Buffer.from(info, 'utf8');
  const out = Buffer.alloc(length);
  let t = Buffer.alloc(0);
  let pos = 0;
  let counter = 1;

  while (pos < length) {
    t = createHmac('sha256', prk)
      .update(Buffer.concat([t, infoBytes, Buffer.from([counter])]))
      .digest();
    const take = Math.min(t.length, length - pos);
    t.copy(out, pos, 0, take);
    pos += take;
    counter++;
  }

  return new Uint8Array(out);
}

/**
 * Generate Ed25519 keypair from 32-byte seed (deterministic)
 * Compatible with @seedid/core's generateEd25519KeyPair
 * @param {Uint8Array} seed - 32-byte private key seed
 * @returns {{ publicKey: Uint8Array, privateKey: Uint8Array }}
 */
export function keypairFromSeed(seed) {
  if (seed.length !== 32) {
    throw new Error(`Expected 32-byte seed, got ${seed.length}`);
  }
  const kp = nacl.sign.keyPair.fromSeed(seed);
  return {
    publicKey: kp.publicKey,
    privateKey: kp.secretKey  // Return the 64-byte secretKey needed by nacl.sign.detached()
  };
}

/**
 * Generate a did:seed: DID from a public key
 * Compatible with @seedid/core's generateDID
 * @param {Uint8Array} publicKey
 * @returns {string} did:seed:<hex-fingerprint>
 */
export function generateDID(publicKey) {
  const hash = createHash('sha256').update(publicKey).digest();
  const fingerprint = hash.subarray(0, 16).toString('hex');
  return `did:seed:${fingerprint}`;
}

/**
 * Sign an HTTP request for Signature header authentication
 * @param {string} method - HTTP method
 * @param {string} path - Request path
 * @param {Object} headers - Request headers (must include 'host' and 'date')
 * @param {Uint8Array} privateKey - Agent's 64-byte secret key (nacl format)
 * @param {string} keyId - Agent ID or DID for the keyId field
 * @param {string[]} signedHeaders - Headers to sign (default: request-target, host, date)
 * @returns {string} Signature header value
 */
export function signRequest(method, path, headers, privateKey, keyId, signedHeaders) {
  const hdrs = signedHeaders || ['(request-target)', 'host', 'date'];

  const signingLines = hdrs.map(h => {
    if (h === '(request-target)') {
      return `(request-target): ${method.toLowerCase()} ${path}`;
    }
    const val = headers[h.toLowerCase()];
    if (!val) throw new Error(`Missing header for signing: ${h}`);
    return `${h.toLowerCase()}: ${val}`;
  });
  const signingString = signingLines.join('\n');

  const message = Buffer.from(signingString, 'utf8');
  const signature = nacl.sign.detached(message, privateKey);

  return `keyId="${keyId}",algorithm="ed25519",headers="${hdrs.join(' ')}",signature="${toBase64(signature)}"`;
}
