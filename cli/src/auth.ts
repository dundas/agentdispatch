/**
 * HTTP Signature auth utilities for the ADMP CLI.
 *
 * Standalone port of the relevant functions from src/utils/crypto.js.
 * Do NOT import from the server src — this module must remain self-contained.
 *
 * All Ed25519 operations use tweetnacl.
 * `secretKey` parameters accepted by buildAuthHeaders and signEnvelope are
 * base64-encoded strings (as stored in the config file). They are decoded to
 * Uint8Array via fromBase64() before being passed to nacl.
 */

import nacl from 'tweetnacl';
import { createHash } from 'node:crypto';

// ── Base64 helpers ────────────────────────────────────────────────────────────

/** Convert Uint8Array to base64 string */
export function toBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64');
}

/** Convert base64 string to Uint8Array */
export function fromBase64(base64: string): Uint8Array {
  return new Uint8Array(Buffer.from(base64, 'base64'));
}

// ── SHA-256 ───────────────────────────────────────────────────────────────────

/** SHA-256 hash of input, returned as base64 */
export function sha256(input: string | Buffer): string {
  return createHash('sha256').update(input).digest('base64');
}

// ── Envelope signing primitives ───────────────────────────────────────────────

export interface AdmpEnvelope {
  timestamp: string;
  body?: unknown;
  from: string;
  to: string;
  correlation_id?: string;
  [key: string]: unknown;
}

/**
 * Create the canonical signing base string for an ADMP message.
 * Format: timestamp\nbodyHash\nfrom\nto\ncorrelationId
 */
export function createSigningBase(envelope: AdmpEnvelope): string {
  const bodyHash = sha256(JSON.stringify(envelope.body ?? {}));
  const parts = [
    envelope.timestamp,
    bodyHash,
    envelope.from,
    envelope.to,
    envelope.correlation_id ?? '',
  ];
  return parts.join('\n');
}

export interface EnvelopeSignature {
  alg: 'ed25519';
  kid: string;
  sig: string;
}

/**
 * Sign an ADMP message envelope.
 * @param envelope - The message envelope (not yet containing a signature field)
 * @param secretKey - 64-byte nacl secret key as a Uint8Array
 * @returns Signature object { alg, kid, sig }
 */
function signMessage(envelope: AdmpEnvelope, secretKey: Uint8Array): EnvelopeSignature {
  const base = createSigningBase(envelope);
  const message = Buffer.from(base, 'utf8');
  const signature = nacl.sign.detached(message, secretKey);
  const kid = envelope.from.replace('agent://', '');
  if (!kid) {
    throw new Error('signMessage: envelope.from must not be bare "agent://" — no agent ID');
  }
  return {
    alg: 'ed25519',
    kid,
    sig: toBase64(signature),
  };
}

// ── HTTP Signature header ─────────────────────────────────────────────────────

/**
 * Build the Signature header value for HTTP Signature auth.
 * Covers (request-target), host, and date by default.
 *
 * @param method - HTTP method (e.g. "GET", "POST")
 * @param path - Request path (e.g. "/v1/agents/foo/messages")
 * @param headers - Map of lowercase header names to values (must include 'host' and 'date')
 * @param privateKey - 64-byte nacl secret key as Uint8Array
 * @param keyId - Agent ID used as keyId in the Signature header
 * @param signedHeaders - Ordered list of header names to sign (default: request-target, host, date)
 * @returns Signature header value string
 */
function signRequest(
  method: string,
  path: string,
  headers: Record<string, string>,
  privateKey: Uint8Array,
  keyId: string,
  signedHeaders?: string[],
): string {
  const hdrs = signedHeaders ?? ['(request-target)', 'host', 'date'];

  const signingLines = hdrs.map((h) => {
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

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Build the auth headers (`Date` and `Signature`) ready to merge into a fetch call.
 *
 * @param method - HTTP method
 * @param path - Request path
 * @param host - Target host (no scheme, no port)
 * @param secretKey - Base64-encoded 64-byte nacl secret key (from config file)
 * @param agentId - Agent ID used as keyId in the Signature header
 * @returns Object with `Date` and `Signature` header values
 */
export function buildAuthHeaders(
  method: string,
  path: string,
  host: string,
  secretKey: string,
  agentId: string,
): Record<string, string> {
  const privateKey = fromBase64(secretKey);
  const date = new Date().toUTCString();

  const sigHeader = signRequest(
    method,
    path,
    { host, date },
    privateKey,
    agentId,
  );

  return {
    Date: date,
    Signature: sigHeader,
  };
}

/**
 * Add an Ed25519 signature field to an ADMP message envelope.
 *
 * @param envelope - The envelope object (must include timestamp, from, to, body)
 * @param secretKey - Base64-encoded 64-byte nacl secret key (from config file)
 * @returns A new envelope object with `signature` set; kid is derived from envelope.from
 */
export function signEnvelope(
  envelope: object,
  secretKey: string,
): object {
  const env = envelope as AdmpEnvelope;
  if (!env.from) {
    throw new Error('signEnvelope: envelope.from is required to derive the signing key ID');
  }
  const privateKey = fromBase64(secretKey);
  const signature = signMessage(env, privateKey);
  return { ...env, signature };
}
