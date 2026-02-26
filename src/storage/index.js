import { config } from 'dotenv';
import { storage as memoryStorage } from './memory.js';
import { createMechStorage } from './mech.js';

// Storage abstraction
// -------------------
// This module exposes a single `storage` instance used by services and
// middleware. The underlying backend is selected via STORAGE_BACKEND.
//
// Built-in backends:
//   memory  — in-process Map-based storage (default, good for development)
//   mech    — persistent Mech Storage backend (requires MECH_APP_ID, MECH_API_KEY)

config();

const backend = (process.env.STORAGE_BACKEND || 'memory').toLowerCase();

let _storage;

switch (backend) {
  case 'mech':
    _storage = createMechStorage();
    break;
  case 'memory':
  default:
    _storage = memoryStorage;
    break;
}

// Defense-in-depth: validate agent_id before any storage backend writes it.
// Callers that bypass register() (e.g. DID:web shadow agents, migrations)
// still go through this guard, ensuring no unsafe ID is ever persisted.
//
// Only createAgent is intercepted: update paths go through register() or
// resolveDIDWebAgent() which have their own character-set and prefix guards,
// and they never change an existing agent_id.
//
// The regex blocks only control characters (newlines, null bytes, DEL) and
// backslashes — the characters that cause signing-string injection or escaping
// issues in storage backends. Slashes are intentionally allowed because
// DID:web shadow agent IDs use them as path separators (did-web:host/path/seg).
// The stricter character-set and reserved-prefix checks live in register() and
// resolveDIDWebAgent() for agents that go through those code paths.
const STORAGE_AGENT_ID_RE = /^[^\x00-\x1f\x7f\\]+$/;
const storage = new Proxy(_storage, {
  get(target, prop) {
    if (prop === 'createAgent') {
      return async (agent) => {
        if (!agent?.agent_id || typeof agent.agent_id !== 'string') {
          throw new Error('createAgent: agent_id is required and must be a string');
        }
        if (agent.agent_id.length > 255) {
          throw new Error('createAgent: agent_id must be 255 characters or fewer');
        }
        if (!STORAGE_AGENT_ID_RE.test(agent.agent_id)) {
          throw new Error('createAgent: agent_id contains unsafe characters (control chars, backslashes)');
        }
        return target.createAgent(agent);
      };
    }
    const value = target[prop];
    return typeof value === 'function' ? value.bind(target) : value;
  }
});

export { storage };
export const storageBackend = backend;
