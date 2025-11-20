import { config } from 'dotenv';
import { storage as memoryStorage } from './memory.js';
import { createMechStorage } from './mech.js';

// Storage abstraction
// -------------------
// This module exposes a single `storage` instance used by services and
// middleware. The underlying backend is selected via STORAGE_BACKEND
// (currently supports: `memory`). This design allows plugging in
// external backends (e.g. Mech Storage via https://storage.mechdna.net)
// without changing call sites.

config();

const backend = (process.env.STORAGE_BACKEND || 'memory').toLowerCase();

let storage;

switch (backend) {
  case 'mech':
    storage = createMechStorage();
    break;
  case 'memory':
  default:
    storage = memoryStorage;
    break;
}

export { storage };
export const storageBackend = backend;
