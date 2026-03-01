/**
 * Shared validation helpers used across CLI command modules.
 * Each function calls process.exit(1) on failure (never returns on error).
 */
import { error } from './output.js';

/**
 * Validates that a message ID contains only safe characters for URL paths.
 * Rejects strings with path-separating characters to prevent path traversal.
 */
export function validateMessageId(id: string): void {
  if (!/^[\w\-]+$/.test(id)) {
    error(
      'Message ID must contain only alphanumeric characters, hyphens, and underscores',
      'INVALID_ARGUMENT'
    );
    process.exit(1);
  }
}

/**
 * Validates that a group ID contains only safe characters for URL paths.
 */
export function validateGroupId(id: string): void {
  if (!/^[\w\-]+$/.test(id)) {
    error(
      'Group ID must contain only alphanumeric characters, hyphens, and underscores',
      'INVALID_ARGUMENT'
    );
    process.exit(1);
  }
}

/**
 * Validates that a round table ID contains only safe characters for URL paths.
 */
export function validateRoundTableId(id: string): void {
  if (!/^[\w\-]+$/.test(id)) {
    error(
      'Round table ID must contain only alphanumeric characters, hyphens, and underscores',
      'INVALID_ARGUMENT'
    );
    process.exit(1);
  }
}

/**
 * Validates that a seed value is a 64-character lowercase or uppercase hex string
 * (representing 32 bytes), matching the server's expected format.
 */
export function validateSeedHex(seed: string): void {
  if (!/^[0-9a-fA-F]{64}$/.test(seed)) {
    error('--seed must be a 64-character hex string (32 bytes)', 'INVALID_ARGUMENT');
    process.exit(1);
  }
}
