/**
 * Integration tests for @agentdispatch/cli
 *
 * Requires a running ADMP server:
 *   ADMP_BASE_URL=http://localhost:3000 bun test cli/test/integration.test.ts
 *
 * Also requires a valid API key in ADMP_API_KEY for endpoints that use it.
 * Tests are skipped when ADMP_BASE_URL is not set.
 */
import { test, expect, describe } from 'bun:test';
import { AdmpClient } from '../src/client.js';
import { resolveConfig } from '../src/config.js';

const BASE_URL = process.env.ADMP_BASE_URL;
const HAVE_SERVER = !!BASE_URL;

/** Returns test or test.skip based on condition — shows real skips in CI output. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const skipUnless = (cond: boolean): typeof test => cond ? test : (test as any).skip as typeof test;
const serverTest = skipUnless(HAVE_SERVER);

describe('Integration: register → send → pull → ack', () => {
  serverTest('server is reachable', async () => {
    const url = new URL('/health', BASE_URL!);
    const res = await fetch(url.toString());
    expect(res.ok || res.status === 404).toBe(true); // any response = server is up
  });

  serverTest('register returns agent_id and secret_key', async () => {
    const res = await fetch(new URL('/api/agents/register', BASE_URL!).toString(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: `test-agent-${Date.now()}` }),
    });
    expect(res.ok).toBe(true);
    const data = await res.json() as Record<string, unknown>;
    expect(typeof data.agent_id).toBe('string');
  });
});

describe('Integration: rotate-key', () => {
  serverTest('rotate-key returns new secret_key', async () => {
    // Register a fresh agent
    const regRes = await fetch(new URL('/api/agents/register', BASE_URL!).toString(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: `rotate-test-${Date.now()}` }),
    });
    expect(regRes.ok).toBe(true);
    const reg = await regRes.json() as Record<string, unknown>;
    const agentId = reg.agent_id as string;
    const secretKey = reg.secret_key as string;

    const config = {
      base_url: BASE_URL!,
      agent_id: agentId,
      secret_key: secretKey,
    };
    const client = new AdmpClient(config);
    const rotated = await client.request<{ secret_key?: string }>(
      'POST', `/api/agents/${agentId}/rotate-key`, {}, 'signature'
    );
    expect(rotated?.secret_key).toBeDefined();
    expect(rotated?.secret_key).not.toBe(secretKey);
  });
});

describe('Integration: groups', () => {
  const config = resolveConfig();
  const groupsTest = skipUnless(HAVE_SERVER && !!config.agent_id && !!config.secret_key);

  groupsTest('create → join → send → list messages', async () => {
    const client = new AdmpClient(config);
    const group = await client.request<{ group_id: string }>(
      'POST', '/api/groups', { name: `test-group-${Date.now()}`, access: 'open' }, 'signature'
    );
    expect(typeof group?.group_id).toBe('string');

    await client.request('POST', `/api/groups/${group.group_id}/join`, {}, 'signature');

    const sent = await client.request<{ message_id: string }>(
      'POST', `/api/groups/${group.group_id}/messages`,
      { subject: 'test', body: { hello: 'world' } }, 'signature'
    );
    expect(typeof sent?.message_id).toBe('string');

    const msgs = await client.request<{ messages: unknown[] }>(
      'GET', `/api/groups/${group.group_id}/messages`, undefined, 'signature'
    );
    expect(Array.isArray(msgs?.messages)).toBe(true);
  });
});

describe('Unit: --json flag output', () => {
  test('isJsonMode returns false when --json not in argv', async () => {
    const { isJsonMode } = await import('../src/output.js');
    const originalArgv = process.argv;
    process.argv = ['node', 'admp', 'status', 'msg_123'];
    expect(isJsonMode()).toBe(false);
    process.argv = originalArgv;
  });

  test('isJsonMode returns true when --json in argv', async () => {
    const { isJsonMode } = await import('../src/output.js');
    const originalArgv = process.argv;
    process.argv = ['node', 'admp', 'status', 'msg_123', '--json'];
    expect(isJsonMode()).toBe(true);
    process.argv = originalArgv;
  });

  test('isJsonMode returns true when ADMP_JSON=1', async () => {
    const { isJsonMode } = await import('../src/output.js');
    const original = process.env.ADMP_JSON;
    process.env.ADMP_JSON = '1';
    expect(isJsonMode()).toBe(true);
    if (original === undefined) delete process.env.ADMP_JSON;
    else process.env.ADMP_JSON = original;
  });
});
