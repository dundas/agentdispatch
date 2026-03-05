import { test, expect } from 'bun:test';
import { parseRecipient } from './index';

test('parseRecipient: namespace.agentId@domain', () => {
  const result = parseRecipient('acme.alice@agentdispatch.io', 'agentdispatch.io');
  expect(result.namespace).toBe('acme');
  expect(result.agentId).toBe('alice');
});

test('parseRecipient: namespace.agentId.with.dots@domain (preserves dots in agentId)', () => {
  const result = parseRecipient('acme.alice.v2@agentdispatch.io', 'agentdispatch.io');
  expect(result.namespace).toBe('acme');
  expect(result.agentId).toBe('alice.v2');
});

test('parseRecipient: agentId@domain (no namespace)', () => {
  const result = parseRecipient('alice@agentdispatch.io', 'agentdispatch.io');
  expect(result.namespace).toBeNull();
  expect(result.agentId).toBe('alice');
});

test('parseRecipient: address without @ (bare local part)', () => {
  const result = parseRecipient('acme.bob', 'agentdispatch.io');
  expect(result.namespace).toBe('acme');
  expect(result.agentId).toBe('bob');
});

test('parseRecipient: single-segment local part without @', () => {
  const result = parseRecipient('alice', 'agentdispatch.io');
  expect(result.namespace).toBeNull();
  expect(result.agentId).toBe('alice');
});
