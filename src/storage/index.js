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
// Custom backends:
//   Set STORAGE_BACKEND=custom and provide your own implementation by
//   adding a case below. See src/storage/memory.js for the required interface.

config();

const backend = (process.env.STORAGE_BACKEND || 'memory').toLowerCase();

let storage;

switch (backend) {
  case 'memory':
  default:
    storage = memoryStorage;
    break;
}

export { storage };
export const storageBackend = backend;
