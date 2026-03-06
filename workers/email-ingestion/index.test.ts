import { test, expect } from 'bun:test';
import { parseRecipient } from './index';

test('parseRecipient: agentId@domain', () => {
  expect(parseRecipient('alice@agentdispatch.io')).toBe('alice');
});

test('parseRecipient: agentId with dots (dots are preserved, no splitting)', () => {
  expect(parseRecipient('alice.v2@agentdispatch.io')).toBe('alice.v2');
});

test('parseRecipient: agentId with hyphens', () => {
  expect(parseRecipient('my-agent-123@agentdispatch.io')).toBe('my-agent-123');
});

test('parseRecipient: UUID-style agentId', () => {
  expect(parseRecipient('agent-5ad2f6d4-5c81-4475-b91f-f70070a6d27b@agentdispatch.io'))
    .toBe('agent-5ad2f6d4-5c81-4475-b91f-f70070a6d27b');
});

test('parseRecipient: bare local part without @', () => {
  expect(parseRecipient('alice')).toBe('alice');
});

test('parseRecipient: old namespace-prefixed address is now treated as a literal agentId', () => {
  // Previously acme.alice@domain would route to agent 'alice' in tenant 'acme'.
  // Now it looks for an agent literally named 'acme.alice' — which would 404
  // unless that exact agentId was registered.
  expect(parseRecipient('acme.alice@agentdispatch.io')).toBe('acme.alice');
});

test('parseRecipient: empty local part returns empty string (server will 400)', () => {
  // @agentdispatch.io — no local part. Returns '' which the server rejects as 400.
  expect(parseRecipient('@agentdispatch.io')).toBe('');
});
