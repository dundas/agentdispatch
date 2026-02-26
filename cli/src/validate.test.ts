import { test, expect, beforeEach, afterEach } from 'bun:test';
import { validateMessageId, validateGroupId, validateSeedHex } from './validate.js';

// All validators call process.exit(1) on failure, so we intercept it.
let exitCalled: number | null;
const originalExit = process.exit;

beforeEach(() => {
  exitCalled = null;
  process.exit = ((code?: number) => { exitCalled = code ?? 0; }) as never;
});

afterEach(() => {
  process.exit = originalExit;
});

// --- validateMessageId ---

test('validateMessageId: accepts alphanumeric with hyphens and underscores', () => {
  validateMessageId('msg_abc-123');
  expect(exitCalled).toBeNull();
});

test('validateMessageId: rejects path traversal', () => {
  validateMessageId('../etc/passwd');
  expect(exitCalled).toBe(1);
});

test('validateMessageId: rejects slashes', () => {
  validateMessageId('msg/123');
  expect(exitCalled).toBe(1);
});

test('validateMessageId: rejects spaces', () => {
  validateMessageId('msg 123');
  expect(exitCalled).toBe(1);
});

// --- validateGroupId ---

test('validateGroupId: accepts valid group ID', () => {
  validateGroupId('grp_abc123');
  expect(exitCalled).toBeNull();
});

test('validateGroupId: rejects slashes', () => {
  validateGroupId('grp/abc');
  expect(exitCalled).toBe(1);
});

test('validateGroupId: rejects dots', () => {
  validateGroupId('grp.abc');
  expect(exitCalled).toBe(1);
});

// --- validateSeedHex ---

test('validateSeedHex: accepts valid 64-char hex', () => {
  validateSeedHex('a'.repeat(64));
  expect(exitCalled).toBeNull();
});

test('validateSeedHex: accepts uppercase hex', () => {
  validateSeedHex('ABCDEF0123456789'.repeat(4));
  expect(exitCalled).toBeNull();
});

test('validateSeedHex: rejects short string', () => {
  validateSeedHex('abcd');
  expect(exitCalled).toBe(1);
});

test('validateSeedHex: rejects non-hex characters', () => {
  validateSeedHex('g'.repeat(64));
  expect(exitCalled).toBe(1);
});

test('validateSeedHex: rejects 65-char string', () => {
  validateSeedHex('a'.repeat(65));
  expect(exitCalled).toBe(1);
});
