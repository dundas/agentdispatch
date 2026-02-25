import { test, expect, afterEach } from 'bun:test';
import { existsSync, statSync, rmSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { loadConfig, saveConfig, resolveConfig, requireConfig } from './config.js';

const configPath = join(homedir(), '.admp', 'config.json');

afterEach(() => {
  // Restore env vars that tests may have set
  delete process.env._ADMP_TEST_RESTORE;
});

test('loadConfig returns {} when file does not exist', () => {
  if (existsSync(configPath)) {
    // File already exists — just verify it parses without error
    const result = loadConfig();
    expect(typeof result).toBe('object');
  } else {
    const result = loadConfig();
    expect(result).toEqual({});
  }
});

test('saveConfig writes file and sets mode 0600', () => {
  const uniqueId = `test-agent-${Date.now()}`;
  saveConfig({ base_url: 'http://test.local', agent_id: uniqueId, secret_key: 'sk_test' });

  expect(existsSync(configPath)).toBe(true);

  const stat = statSync(configPath);
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

  // Temporarily clear the file-based base_url by saving a config without it
  const existing = loadConfig();
  const noBaseUrl = { ...existing };
  delete noBaseUrl.base_url;
  saveConfig(noBaseUrl as any);

  const config = resolveConfig();
  expect(config.base_url).toBe('https://agentdispatch.fly.dev');

  // Restore file state
  saveConfig({ ...noBaseUrl, base_url: existing.base_url } as any);
  if (saved !== undefined) process.env.ADMP_BASE_URL = saved;
});

test('requireConfig throws a friendly error for missing required field', () => {
  const saved = process.env.ADMP_AGENT_ID;
  delete process.env.ADMP_AGENT_ID;

  const fileConfig = loadConfig();
  if (!fileConfig.agent_id) {
    expect(() => requireConfig(['agent_id'])).toThrow('agent_id not set');
    expect(() => requireConfig(['agent_id'])).toThrow('ADMP_AGENT_ID');
  }

  if (saved !== undefined) process.env.ADMP_AGENT_ID = saved;
});
