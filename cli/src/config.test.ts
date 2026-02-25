import { test, expect, beforeAll, afterAll } from 'bun:test';
import { existsSync, statSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { loadConfig, saveConfig, resolveConfig, requireConfig } from './config.js';

// Redirect all config operations to a temp file so tests never touch ~/.admp/config.json
const TEST_CONFIG = join(tmpdir(), `admp-test-${process.pid}.json`);

beforeAll(() => {
  process.env.ADMP_CONFIG_PATH = TEST_CONFIG;
});

afterAll(() => {
  delete process.env.ADMP_CONFIG_PATH;
  if (existsSync(TEST_CONFIG)) rmSync(TEST_CONFIG);
});

test('loadConfig returns {} when file does not exist', () => {
  const result = loadConfig();
  expect(result).toEqual({});
});

test('saveConfig writes file and sets mode 0600', () => {
  saveConfig({ base_url: 'http://test.local', agent_id: 'test-agent', secret_key: 'sk_test' });

  expect(existsSync(TEST_CONFIG)).toBe(true);

  const stat = statSync(TEST_CONFIG);
  const mode = stat.mode & 0o777;
  expect(mode).toBe(0o600);
});

test('resolveConfig applies env var overrides over file config', () => {
  const saved = {
    ADMP_BASE_URL: process.env.ADMP_BASE_URL,
    ADMP_AGENT_ID: process.env.ADMP_AGENT_ID,
    ADMP_SECRET_KEY: process.env.ADMP_SECRET_KEY,
  };

  process.env.ADMP_BASE_URL = 'http://override.example.com';
  process.env.ADMP_AGENT_ID = 'override-agent';
  process.env.ADMP_SECRET_KEY = 'override-secret';

  const config = resolveConfig();
  expect(config.base_url).toBe('http://override.example.com');
  expect(config.agent_id).toBe('override-agent');
  expect(config.secret_key).toBe('override-secret');

  // Restore
  if (saved.ADMP_BASE_URL === undefined) delete process.env.ADMP_BASE_URL;
  else process.env.ADMP_BASE_URL = saved.ADMP_BASE_URL;
  if (saved.ADMP_AGENT_ID === undefined) delete process.env.ADMP_AGENT_ID;
  else process.env.ADMP_AGENT_ID = saved.ADMP_AGENT_ID;
  if (saved.ADMP_SECRET_KEY === undefined) delete process.env.ADMP_SECRET_KEY;
  else process.env.ADMP_SECRET_KEY = saved.ADMP_SECRET_KEY;
});

test('resolveConfig defaults base_url to production server', () => {
  const saved = process.env.ADMP_BASE_URL;
  delete process.env.ADMP_BASE_URL;

  // Temp config has no base_url
  saveConfig({ agent_id: 'test', secret_key: 'sk' });
  const config = resolveConfig();
  expect(config.base_url).toBe('https://agentdispatch.fly.dev');

  if (saved !== undefined) process.env.ADMP_BASE_URL = saved;
});

test('requireConfig throws a friendly error for missing required field', () => {
  const saved = process.env.ADMP_AGENT_ID;
  delete process.env.ADMP_AGENT_ID;

  // Temp config has no agent_id
  saveConfig({ base_url: 'http://test.local', secret_key: 'sk' });
  expect(() => requireConfig(['agent_id'])).toThrow('agent_id not set');
  expect(() => requireConfig(['agent_id'])).toThrow('ADMP_AGENT_ID');

  if (saved !== undefined) process.env.ADMP_AGENT_ID = saved;
});
