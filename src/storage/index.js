import { config } from 'dotenv';
import { storage as memoryStorage } from './memory.js';

// Storage abstraction
// -------------------
// This module exposes a single `storage` instance used by services and
// middleware. The underlying backend is selected via STORAGE_BACKEND.
//
// Built-in backends:
//   memory  — in-process Map-based storage (default, good for development)
//
// Custom backends (overlay pattern):
//   Place a compatible adapter at src/storage/<name>.js and set STORAGE_BACKEND=<name>.
//   The adapter must export a `createMechStorage`-style factory or a singleton that
//   implements the same interface as memory.js. See memory.js for the required methods.
//
//   Example: STORAGE_BACKEND=mech loads ./mech.js (not shipped in the public repo;
//   injected at deploy time via the agentdispatch-deploy overlay).

config();

const backend = (process.env.STORAGE_BACKEND || 'memory').toLowerCase();

let _storage;

switch (backend) {
  case 'mech': {
    // mech.js is a private adapter injected via the agentdispatch-deploy overlay.
    // It is not included in the public repository.
    let mechMod;
    try {
      mechMod = await import('./mech.js');
    } catch {
      throw new Error(
        'STORAGE_BACKEND=mech but src/storage/mech.js is not present. ' +
        'Provide the Mech Storage adapter via the agentdispatch-deploy overlay.'
      );
    }
    _storage = mechMod.createMechStorage();
    break;
  }
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
// Allowlist: letters, digits, and the characters allowed by register() plus forward
// slash (for DID:web shadow agent IDs like did-web:host/path/seg). Characters outside
// this set indicate a caller bug — surfacing them here is preferable to silent storage.
// The stricter character-set and reserved-prefix checks live in register() and
// resolveDIDWebAgent() for agents that go through those code paths.
// Legacy agent://agent-<uuid> IDs already at rest in storage are intentionally NOT
// re-validated here — this guard only fires on new writes via createAgent().
const STORAGE_AGENT_ID_RE = /^[a-zA-Z0-9._:/-]+$/;

// Startup assertion: if the storage interface renames createAgent, the Proxy guard
// silently becomes a no-op. Crashing at startup is better than a silent bypass.
if (typeof _storage.createAgent !== 'function') {
  throw new Error('storage: createAgent is missing — update the Proxy guard in storage/index.js');
}

const storage = new Proxy(_storage, {
  get(target, prop) {
    // NOTE: if the storage interface renames createAgent, update this string —
    // a name mismatch silently bypasses the guard with no error or test failure.
    if (prop === 'createAgent') {
      return async (agent) => {
        if (!agent?.agent_id || typeof agent.agent_id !== 'string') {
          throw new Error('createAgent: agent_id is required and must be a string');
        }
        if (agent.agent_id.length > 255) {
          throw new Error('createAgent: agent_id must be 255 characters or fewer');
        }
        if (!STORAGE_AGENT_ID_RE.test(agent.agent_id)) {
          throw new Error('createAgent: agent_id contains characters outside the allowed set [a-zA-Z0-9._:/-]');
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
