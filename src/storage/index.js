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
