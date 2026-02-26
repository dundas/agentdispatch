/**
 * Unit tests for AdmpClient error handling.
 * Uses a minimal mock fetch to avoid network calls.
 */
import { test, expect, mock, beforeEach, afterEach } from 'bun:test';
import { AdmpClient, AdmpError } from './client.js';

const BASE = 'https://test.example.com';

function makeFetchMock(status: number, body: unknown, contentType = 'application/json') {
  return mock(() =>
    Promise.resolve(new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': contentType },
    }))
  );
}

let originalFetch: typeof globalThis.fetch;

beforeEach(() => {
  originalFetch = globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

test('AdmpError carries code and status', () => {
  const err = new AdmpError('something broke', 'AGENT_NOT_FOUND', 404);
  expect(err.message).toBe('something broke');
  expect(err.code).toBe('AGENT_NOT_FOUND');
  expect(err.status).toBe(404);
  expect(err.name).toBe('AdmpError');
});

test('request throws AdmpError on non-2xx response', async () => {
  globalThis.fetch = makeFetchMock(404, { error: 'agent not found', code: 'AGENT_NOT_FOUND' }) as unknown as typeof fetch;

  const client = new AdmpClient({ base_url: BASE });
  await expect(
    client.request('GET', '/api/agents/missing', undefined, 'none')
  ).rejects.toMatchObject({ code: 'AGENT_NOT_FOUND', status: 404 });
});

test('request returns undefined for 204 No Content', async () => {
  globalThis.fetch = mock(() =>
    Promise.resolve(new Response(null, { status: 204 }))
  ) as unknown as typeof fetch;

  const client = new AdmpClient({ base_url: BASE });
  const result = await client.request('DELETE', '/api/agents/foo', undefined, 'none');
  expect(result).toBeUndefined();
});

test('request throws AdmpError with UNKNOWN_ERROR when code is missing', async () => {
  globalThis.fetch = makeFetchMock(500, { message: 'Internal Server Error' }) as unknown as typeof fetch;

  const client = new AdmpClient({ base_url: BASE });
  await expect(
    client.request('GET', '/api/agents/foo', undefined, 'none')
  ).rejects.toMatchObject({ code: 'UNKNOWN_ERROR', status: 500 });
});

test('request throws AdmpError with INVALID_API_KEY when api_key is missing', async () => {
  const client = new AdmpClient({ base_url: BASE });
  await expect(
    client.request('GET', '/api/agents/foo', undefined, 'api-key')
  ).rejects.toMatchObject({ code: 'INVALID_API_KEY', status: 401 });
});
