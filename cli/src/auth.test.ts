import { test, expect } from 'bun:test';
import nacl from 'tweetnacl';
import { buildAuthHeaders, signEnvelope, toBase64, fromBase64, createSigningBase } from './auth.js';

// Generate a deterministic keypair for all tests
const keypair = nacl.sign.keyPair();
const secretKeyB64 = toBase64(keypair.secretKey);
const agentId = 'test-agent.example.com';

// ── 1. buildAuthHeaders returns object with Date and Signature keys ──────────
test('buildAuthHeaders returns object with Date and Signature keys', () => {
  const headers = buildAuthHeaders('GET', '/v1/agents/test/messages', 'example.com', secretKeyB64, agentId);

  expect(typeof headers).toBe('object');
  expect(headers).toHaveProperty('Date');
  expect(headers).toHaveProperty('Signature');
});

// ── 2. Signature value matches the expected format ───────────────────────────
test('Signature value matches keyId=...,algorithm="ed25519",headers="...",signature="..."', () => {
  const headers = buildAuthHeaders('POST', '/v1/agents/test/messages', 'api.example.com', secretKeyB64, agentId);

  const sig = headers['Signature'];
  expect(typeof sig).toBe('string');

  // Must contain all four fields in order
  expect(sig).toMatch(/^keyId="[^"]+",algorithm="ed25519",headers="[^"]+",signature="[^"]+"$/);
  expect(sig).toContain(`keyId="${agentId}"`);
  expect(sig).toContain('algorithm="ed25519"');
  expect(sig).toContain('headers="(request-target) host date"');
});

// ── 3. signEnvelope adds signature.alg, signature.kid, signature.sig ─────────
test('signEnvelope adds signature.alg, signature.kid, and signature.sig to the envelope', () => {
  const envelope = {
    version: '1.0',
    id: 'test-id-123',
    type: 'task.request',
    from: `agent://${agentId}`,
    to: 'agent://target.example.com',
    subject: 'test_subject',
    timestamp: new Date().toISOString(),
    body: { hello: 'world' },
  };

  const signed = signEnvelope(envelope, secretKeyB64, agentId) as typeof envelope & {
    signature: { alg: string; kid: string; sig: string };
  };

  expect(signed).toHaveProperty('signature');
  expect(signed.signature.alg).toBe('ed25519');
  expect(signed.signature.kid).toBe(agentId);
  expect(typeof signed.signature.sig).toBe('string');
  expect(signed.signature.sig.length).toBeGreaterThan(0);
});

// ── 4. Roundtrip: sign then verify with nacl.sign.detached.verify ─────────────
test('signEnvelope roundtrip: verify with nacl.sign.detached.verify returns true', () => {
  const envelope = {
    version: '1.0',
    id: 'roundtrip-test-456',
    type: 'task.request',
    from: `agent://${agentId}`,
    to: 'agent://other.example.com',
    subject: 'roundtrip',
    correlation_id: 'c-999',
    timestamp: new Date().toISOString(),
    body: { data: 'roundtrip payload' },
  };

  const signed = signEnvelope(envelope, secretKeyB64, agentId) as typeof envelope & {
    signature: { alg: string; kid: string; sig: string };
  };

  // Reconstruct the signing base exactly as the implementation does
  const base = createSigningBase(envelope);
  const message = Buffer.from(base, 'utf8');
  const sigBytes = fromBase64(signed.signature.sig);

  const valid = nacl.sign.detached.verify(message, sigBytes, keypair.publicKey);
  expect(valid).toBe(true);
});
