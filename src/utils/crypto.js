/**
 * Cryptographic utilities for ADMP
 * Handles Ed25519 keypair generation and signature verification
 */

import nacl from 'tweetnacl';
import { createHash } from 'crypto';

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
