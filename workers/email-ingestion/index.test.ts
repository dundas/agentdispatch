import { test, expect } from 'bun:test';
import { parseRecipient } from './index';

test('parseRecipient: agentId@domain', () => {
  expect(parseRecipient('alice@agentdispatch.io', 'agentdispatch.io')).toBe('alice');
});

test('parseRecipient: agentId with dots@domain (dots are preserved, no splitting)', () => {
  expect(parseRecipient('alice.v2@agentdispatch.io', 'agentdispatch.io')).toBe('alice.v2');
});

test('parseRecipient: agentId with hyphens', () => {
  expect(parseRecipient('my-agent-123@agentdispatch.io', 'agentdispatch.io')).toBe('my-agent-123');
});

test('parseRecipient: bare local part without @', () => {
  expect(parseRecipient('alice', 'agentdispatch.io')).toBe('alice');
});

test('parseRecipient: UUID-style agentId', () => {
  expect(parseRecipient('agent-5ad2f6d4-5c81-4475-b91f-f70070a6d27b@agentdispatch.io', 'agentdispatch.io'))
    .toBe('agent-5ad2f6d4-5c81-4475-b91f-f70070a6d27b');
});
