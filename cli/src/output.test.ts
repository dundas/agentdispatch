import { test, expect } from 'bun:test';
import { maskSecret, isJsonMode } from './output.js';

// isJsonMode tests — test through ADMP_JSON env var since argv mutations
// are not reliable across cached module imports.
test('isJsonMode returns false when ADMP_JSON not set', () => {
  const original = process.env.ADMP_JSON;
  delete process.env.ADMP_JSON;
  // Also ensure --json not in argv for isolation
  const originalArgv = process.argv;
  process.argv = ['node', 'admp', 'status'];
  expect(isJsonMode()).toBe(false);
  process.argv = originalArgv;
  if (original !== undefined) process.env.ADMP_JSON = original;
});

test('isJsonMode returns true when ADMP_JSON=1', () => {
  const original = process.env.ADMP_JSON;
  process.env.ADMP_JSON = '1';
  expect(isJsonMode()).toBe(true);
  if (original === undefined) delete process.env.ADMP_JSON;
  else process.env.ADMP_JSON = original;
});

test('isJsonMode returns false when ADMP_JSON=0', () => {
  const original = process.env.ADMP_JSON;
  process.env.ADMP_JSON = '0';
  expect(isJsonMode()).toBe(false);
  if (original === undefined) delete process.env.ADMP_JSON;
  else process.env.ADMP_JSON = original;
});

test('maskSecret returns (not set) for undefined', () => {
  expect(maskSecret(undefined)).toBe('(not set)');
});

test('maskSecret returns (not set) for empty string', () => {
  expect(maskSecret('')).toBe('(not set)');
});

test('maskSecret returns *** for short values (<=8 chars)', () => {
  expect(maskSecret('abc')).toBe('***');
  expect(maskSecret('12345678')).toBe('***');
});

test('maskSecret truncates and appends ... for long values (>8 chars)', () => {
  const result = maskSecret('supersecretkey123');
  expect(result).toBe('supersec...');
  expect(result.startsWith('supersec')).toBe(true);
  expect(result.endsWith('...')).toBe(true);
});

test('maskSecret shows first 8 chars only for long values', () => {
  const key = 'abcdefghijklmnop';
  expect(maskSecret(key)).toBe('abcdefgh...');
});
