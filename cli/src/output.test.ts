import { test, expect } from 'bun:test';
import { maskSecret } from './output.js';

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
