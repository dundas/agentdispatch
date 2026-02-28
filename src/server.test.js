import test from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import http from 'node:http';
import crypto from 'node:crypto';
import nacl from 'tweetnacl';

import app from './server.js';
import { fromBase64, toBase64, signMessage, signRequest, hkdfSha256, LABEL_ADMP, keypairFromSeed, generateDID, hashApiKey } from './utils/crypto.js';
import { requireApiKey } from './middleware/auth.js';
import { webhookService } from './services/webhook.service.js';
import { outboxService } from './services/outbox.service.js';
import { storage } from './storage/index.js';
import { roundTableService } from './services/round-table.service.js';
import { groupService } from './services/group.service.js';

let createMechStorage = null;
try {
  ({ createMechStorage } = await import('./storage/mech.js'));
} catch {
  // Optional in open-source branch: mech backend may be intentionally absent.
}

async function registerAgent(name, metadata = {}) {
  const uniqueSuffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const res = await request(app)
    .post('/api/agents/register')
    .send({
      agent_id: `${name}-${uniqueSuffix}`,
      agent_type: 'test',
      metadata
    });

  assert.equal(res.status, 201);
  return res.body;
}

async function sendSignedMessage(sender, recipientId, options = {}) {
  const envelope = {
    version: '1.0',
    id: `msg-${Date.now()}`,
    type: options.type || 'task.request',
    from: sender.agent_id,
    to: recipientId,
    subject: options.subject || 'test-message',
    body: options.body || { ping: 'pong' },
    timestamp: options.timestamp || new Date().toISOString(),
    ttl_sec: 3600
  };

  const secretKey = fromBase64(sender.secret_key);
  envelope.signature = signMessage(envelope, secretKey);

  if (options.mutateSignature) {
    envelope.signature.sig = 'invalid-signature';
  }

  // Build send body — envelope fields plus optional ephemeral/ttl
  const sendBody = { ...envelope };
  if (options.ephemeral !== undefined) {
    sendBody.ephemeral = options.ephemeral;
  }
  if (options.ttl !== undefined) {
    sendBody.ttl = options.ttl;
  }

  const res = await request(app)
    .post(`/api/agents/${encodeURIComponent(recipientId)}/messages`)
    .send(sendBody);

  return res;
}

function withAgentHeader(req, agentId) {
  return req.set('X-Agent-ID', agentId);
}

const MECH_CONFIGURED =
  !!createMechStorage &&
  process.env.STORAGE_BACKEND === 'mech' &&
  !!process.env.MECH_APP_ID &&
  !!process.env.MECH_API_KEY;

const ORIGINAL_API_KEY_REQUIRED = process.env.API_KEY_REQUIRED;
const ORIGINAL_MASTER_API_KEY = process.env.MASTER_API_KEY;

test('GET /health returns healthy status', async () => {
  const res = await request(app).get('/health');

  assert.equal(res.status, 200);
  assert.equal(res.body.status, 'healthy');
  assert.ok(typeof res.body.timestamp === 'string');
  assert.ok(typeof res.body.version === 'string');
});

test('GET /api/stats returns stats object', async () => {
  const res = await request(app).get('/api/stats');

  assert.equal(res.status, 200);
  assert.ok(res.body.agents);
  assert.ok(res.body.messages);
});

test('agent_id validation rejects dangerous characters', async () => {
  const bad = [
    'has space',
    'newline\ninjection',
    'path/traversal',
    'null\x00byte',
    '<script>xss</script>',
    'agent://legacy-scheme',   // slashes + reserved prefix
    'agent:bare',              // reserved prefix (no slashes)
    'did:seed:spoofed',        // reserved DID prefix
    'did:web:example.com',     // reserved DID prefix
    'DID:spoofed',             // reserved prefix — case-insensitive check
    'AGENT:foo',               // reserved prefix — case-insensitive check
    'a'.repeat(256),
    '   ',                     // whitespace-only (truthy but fails charset regex)
  ];

  for (const id of bad) {
    const res = await request(app)
      .post('/api/agents/register')
      .send({ agent_id: id, agent_type: 'test' });
    assert.equal(res.status, 400, `Expected 400 for agent_id: ${JSON.stringify(id)}`);
  }

  // Valid IDs should still work — use unique suffix to avoid conflicts across test runs
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const valid = ['simple', 'with-hyphens', 'dots.allowed', 'colons:ok', 'ALL_CAPS'].map(id => `${id}-${suffix}`);
  // Use a timestamp-based prefix for the boundary ID so it is unique across test runs.
  // Pad to exactly 255 chars. assert.equal pins the length so any format change fails fast.
  const tsStr = Date.now().toString(); // 13 chars in 2026 — assert catches length change
  const boundaryId = tsStr + 'a'.repeat(255 - tsStr.length);
  assert.equal(boundaryId.length, 255, 'boundary test ID must be exactly 255 chars');
  valid.push(boundaryId);
  for (const id of valid) {
    const res = await request(app)
      .post('/api/agents/register')
      .send({ agent_id: id, agent_type: 'test' });
    assert.equal(res.status, 201, `Expected 201 for agent_id: ${JSON.stringify(id)}`);
  }
});

test('storage proxy: createAgent directly rejects unsafe agent_ids', async () => {
  // Verify the storage Proxy backstop fires independently of register() —
  // catches callers (DID:web shadow agents, migrations) that bypass registration.
  const dummyKey = toBase64(nacl.sign.keyPair().publicKey);
  const base = { agent_type: 'test', public_key: dummyKey, registration_status: 'approved' };

  const badIds = [
    'evil\nX-Injected: header',   // newline injection
    'null\x00byte',               // null byte
    'back\\slash',                // backslash (signing-string escape)
    '\x01control',                // control char (SOH)
    'a'.repeat(256),              // exceeds 255-char limit
    '',                           // empty string
  ];

  for (const agent_id of badIds) {
    await assert.rejects(
      () => storage.createAgent({ ...base, agent_id }),
      (err) => {
        assert.ok(err.message.startsWith('createAgent:'),
          `Expected 'createAgent:' error for ${JSON.stringify(agent_id)}, got: ${err.message}`);
        return true;
      },
      `storage.createAgent should reject agent_id: ${JSON.stringify(agent_id)}`
    );
  }

  // Slashes are allowed — DID:web shadow agent IDs use them as path separators
  const shadowId = `did-web-proxy-test-${Date.now()}.example.com/users/alice`;
  const shadowAgent = await storage.createAgent({ ...base, agent_id: shadowId });
  assert.equal(shadowAgent.agent_id, shadowId, 'storage proxy should allow slashes for DID:web IDs');
});

test('envelope from/to validation rejects injection attempts', async () => {
  const sender = await registerAgent('env-sender');
  const recipient = await registerAgent('env-recipient');

  // Malicious from fields that should be rejected
  const badFromIds = [
    'evil\nX-Injected: header',
    'agent://bad\ninjected',
    'did:seed:\ninjected',
    'has spaces',
    '../traversal',
  ];

  for (const badId of badFromIds) {
    const envelope = {
      version: '1.0',
      id: `msg-${Date.now()}`,
      type: 'task.request',
      from: badId,
      to: recipient.agent_id,
      subject: 'injection-test',
      body: { test: true },
      timestamp: new Date().toISOString(),
    };
    const res = await request(app)
      .post(`/api/agents/${encodeURIComponent(recipient.agent_id)}/messages`)
      .send(envelope);
    assert.equal(res.status, 400, `Expected 400 for from: ${JSON.stringify(badId)}`);
  }

  // Malicious to fields — same validation applies
  const badToIds = [
    'evil\nX-Injected: header',
    'agent://bad\ninjected',
    '../traversal',
    'a'.repeat(256),
  ];

  for (const badId of badToIds) {
    const envelope = {
      version: '1.0',
      id: `msg-${Date.now()}`,
      type: 'task.request',
      from: sender.agent_id,
      to: badId,
      subject: 'injection-test',
      body: { test: true },
      timestamp: new Date().toISOString(),
    };
    const res = await request(app)
      .post(`/api/agents/${encodeURIComponent(recipient.agent_id)}/messages`)
      .send(envelope);
    assert.equal(res.status, 400, `Expected 400 for to: ${JSON.stringify(badId)}`);
  }

  // Legacy agent:// URI in from field should still pass (backward-compat)
  const legacyEnvelope = {
    version: '1.0',
    id: `msg-${Date.now()}`,
    type: 'task.request',
    from: 'agent://legacy-sender',
    to: recipient.agent_id,
    subject: 'legacy-compat',
    body: { test: true },
    timestamp: new Date().toISOString(),
  };
  const legacyRes = await request(app)
    .post(`/api/agents/${encodeURIComponent(recipient.agent_id)}/messages`)
    .send(legacyEnvelope);
  // 201: envelope accepted, sender not in storage so signature verification is skipped.
  // 404 is NOT expected because the recipient exists.
  // 400 would indicate the validation wrongly rejected a valid agent:// URI.
  assert.equal(legacyRes.status, 201, 'Legacy agent:// envelope from should pass validation and be accepted');

  // DID:web canonical form in from should pass envelope validation (colons pass SAFE_CHARS)
  const didWebEnvelope = {
    version: '1.0',
    id: `msg-${Date.now()}`,
    type: 'task.request',
    from: 'did:web:example.com:users:alice',
    to: recipient.agent_id,
    subject: 'did-web-compat',
    body: { test: true },
    timestamp: new Date().toISOString(),
  };
  const didWebRes = await request(app)
    .post(`/api/agents/${encodeURIComponent(recipient.agent_id)}/messages`)
    .send(didWebEnvelope);
  // 201: accepted. Sender not in storage so signature check skipped (from is untrusted).
  // 400 would mean did:web canonical form was wrongly rejected by isValidAgentId().
  assert.equal(didWebRes.status, 201, 'DID:web canonical from (did:web:domain:path) should pass envelope validation');
});

test('agent registration, heartbeat, and get agent', async () => {
  const agent = await registerAgent('test-agent', { role: 'tester' });

  const heartbeatRes = await request(app)
    .post(`/api/agents/${encodeURIComponent(agent.agent_id)}/heartbeat`)
    .send({
      metadata: { last_activity: Date.now() }
    });

  assert.equal(heartbeatRes.status, 200);
  assert.equal(heartbeatRes.body.ok, true);
  assert.equal(heartbeatRes.body.status, 'online');

  const getRes = await request(app)
    .get(`/api/agents/${encodeURIComponent(agent.agent_id)}`);

  assert.equal(getRes.status, 200);
  assert.equal(getRes.body.agent_id, agent.agent_id);
  assert.equal(getRes.body.agent_type, agent.agent_type);
  assert.ok(getRes.body.public_key);
  assert.ok(!getRes.body.secret_key);
});

test('send → pull → ack → status flow', async () => {
  const sender = await registerAgent('sender');
  const recipient = await registerAgent('recipient');

  const sendRes = await sendSignedMessage(sender, recipient.agent_id, {
    subject: 'flow-test',
    body: { hello: 'world' }
  });

  assert.equal(sendRes.status, 201);
  assert.ok(sendRes.body.message_id);

  const pullRes = await request(app)
    .post(`/api/agents/${encodeURIComponent(recipient.agent_id)}/inbox/pull`)
    .send({ visibility_timeout: 60 });

  assert.equal(pullRes.status, 200);
  assert.ok(pullRes.body.message_id);
  assert.ok(pullRes.body.envelope);

  const messageId = pullRes.body.message_id;

  const ackRes = await request(app)
    .post(`/api/agents/${encodeURIComponent(recipient.agent_id)}/messages/${messageId}/ack`)
    .send({
      result: { status: 'success', note: 'ack from test' }
    });

  assert.equal(ackRes.status, 200);
  assert.equal(ackRes.body.ok, true);

  const statusRes = await request(app)
    .get(`/api/messages/${messageId}/status`);

  assert.equal(statusRes.status, 200);
  assert.equal(statusRes.body.id, messageId);
  assert.equal(statusRes.body.status, 'acked');
});

test('nack requeues message back to inbox', async () => {
  const sender = await registerAgent('sender-nack-requeue');
  const recipient = await registerAgent('recipient-nack-requeue');

  const sendRes = await sendSignedMessage(sender, recipient.agent_id, {
    subject: 'nack-requeue',
    body: { test: 'nack-requeue' }
  });

  assert.equal(sendRes.status, 201);
  assert.ok(sendRes.body.message_id);

  const firstPull = await request(app)
    .post(`/api/agents/${encodeURIComponent(recipient.agent_id)}/inbox/pull`)
    .send({ visibility_timeout: 60 });

  assert.equal(firstPull.status, 200);
  const messageId = firstPull.body.message_id;
  assert.ok(messageId);

  const nackRes = await request(app)
    .post(`/api/agents/${encodeURIComponent(recipient.agent_id)}/messages/${messageId}/nack`)
    .send({ requeue: true });

  assert.equal(nackRes.status, 200);
  assert.equal(nackRes.body.ok, true);
  assert.equal(nackRes.body.status, 'queued');
  assert.equal(nackRes.body.lease_until, null);

  const secondPull = await request(app)
    .post(`/api/agents/${encodeURIComponent(recipient.agent_id)}/inbox/pull`)
    .send({ visibility_timeout: 60 });

  assert.equal(secondPull.status, 200);
  assert.equal(secondPull.body.message_id, messageId);
  assert.ok(secondPull.body.envelope);
});

test('nack can extend lease without requeue', async () => {
  const sender = await registerAgent('sender-nack-extend');
  const recipient = await registerAgent('recipient-nack-extend');

  const sendRes = await sendSignedMessage(sender, recipient.agent_id, {
    subject: 'nack-extend',
    body: { test: 'nack-extend' }
  });

  assert.equal(sendRes.status, 201);

  const pullRes = await request(app)
    .post(`/api/agents/${encodeURIComponent(recipient.agent_id)}/inbox/pull`)
    .send({ visibility_timeout: 60 });

  assert.equal(pullRes.status, 200);
  const messageId = pullRes.body.message_id;
  const originalLeaseUntil = pullRes.body.lease_until;
  assert.ok(messageId);
  assert.ok(typeof originalLeaseUntil === 'number');

  const nackRes = await request(app)
    .post(`/api/agents/${encodeURIComponent(recipient.agent_id)}/messages/${messageId}/nack`)
    .send({ extend_sec: 30 });

  assert.equal(nackRes.status, 200);
  assert.equal(nackRes.body.ok, true);
  assert.equal(nackRes.body.status, 'leased');
  assert.ok(typeof nackRes.body.lease_until === 'number');
  assert.ok(nackRes.body.lease_until > originalLeaseUntil);
});

test('reclaiming expired leases requeues messages', async () => {
  const sender = await registerAgent('sender-reclaim-leases');
  const recipient = await registerAgent('recipient-reclaim-leases');

  const sendRes = await sendSignedMessage(sender, recipient.agent_id, {
    subject: 'reclaim-leases',
    body: { test: 'reclaim-leases' }
  });

  assert.equal(sendRes.status, 201);

  const pullRes = await request(app)
    .post(`/api/agents/${encodeURIComponent(recipient.agent_id)}/inbox/pull`)
    .send({ visibility_timeout: 1 });

  assert.equal(pullRes.status, 200);
  const messageId = pullRes.body.message_id;
  assert.ok(messageId);

  // Wait for lease to expire
  await new Promise(resolve => setTimeout(resolve, 1500));

  const reclaimRes = await request(app)
    .post(`/api/agents/${encodeURIComponent(recipient.agent_id)}/inbox/reclaim`)
    .send({});

  assert.equal(reclaimRes.status, 200);
  assert.ok(typeof reclaimRes.body.reclaimed === 'number');
  assert.ok(reclaimRes.body.reclaimed >= 1);

  const secondPull = await request(app)
    .post(`/api/agents/${encodeURIComponent(recipient.agent_id)}/inbox/pull`)
    .send({ visibility_timeout: 60 });

  assert.equal(secondPull.status, 200);
  assert.equal(secondPull.body.message_id, messageId);
  assert.ok(secondPull.body.envelope);
});

test('rejects messages with invalid signature', async () => {
  const sender = await registerAgent('sender-invalid-sig');
  const recipient = await registerAgent('recipient-invalid-sig');

  const res = await sendSignedMessage(sender, recipient.agent_id, {
    subject: 'invalid-sig',
    body: { test: true },
    mutateSignature: true
  });

  assert.equal(res.status, 403);
  assert.equal(res.body.error, 'INVALID_SIGNATURE');
});

test('returns 404 for unknown recipient agent', async () => {
  const sender = await registerAgent('sender-unknown-recipient');
  const nonExistentRecipient = 'non-existent-recipient';

  const res = await sendSignedMessage(sender, nonExistentRecipient, {
    subject: 'unknown-recipient',
    body: { test: true }
  });

  assert.equal(res.status, 404);
  assert.equal(res.body.error, 'RECIPIENT_NOT_FOUND');
});

test('rejects messages with timestamp too far in the past', async () => {
  const sender = await registerAgent('sender-old-timestamp');
  const recipient = await registerAgent('recipient-old-timestamp');

  const pastTimestamp = new Date(Date.now() - (10 * 60 * 1000)).toISOString();

  const res = await sendSignedMessage(sender, recipient.agent_id, {
    subject: 'old-timestamp',
    body: { test: true },
    timestamp: pastTimestamp
  });

  assert.equal(res.status, 400);
  assert.equal(res.body.error, 'INVALID_TIMESTAMP');
});

test('rejects messages with timestamp too far in the future', async () => {
  const sender = await registerAgent('sender-future-timestamp');
  const recipient = await registerAgent('recipient-future-timestamp');

  const futureTimestamp = new Date(Date.now() + (10 * 60 * 1000)).toISOString();

  const res = await sendSignedMessage(sender, recipient.agent_id, {
    subject: 'future-timestamp',
    body: { test: true },
    timestamp: futureTimestamp
  });

  assert.equal(res.status, 400);
  assert.equal(res.body.error, 'INVALID_TIMESTAMP');
});

test('can manage trusted agents via API', async () => {
  const recipient = await registerAgent('trusted-recipient');
  const sender = await registerAgent('trusted-sender');

  const initialRes = await request(app)
    .get(`/api/agents/${encodeURIComponent(recipient.agent_id)}/trusted`);

  assert.equal(initialRes.status, 200);
  assert.deepEqual(initialRes.body.trusted_agents, []);

  const addRes = await request(app)
    .post(`/api/agents/${encodeURIComponent(recipient.agent_id)}/trusted`)
    .send({ agent_id: sender.agent_id });

  assert.equal(addRes.status, 200);
  assert.ok(Array.isArray(addRes.body.trusted_agents));
  assert.ok(addRes.body.trusted_agents.includes(sender.agent_id));
});

test('trust list restricts message senders', async () => {
  const recipient = await registerAgent('trusted-recipient-enforced');
  const trustedSender = await registerAgent('trusted-sender-enforced');
  const untrustedSender = await registerAgent('untrusted-sender-enforced');

  const addRes = await request(app)
    .post(`/api/agents/${encodeURIComponent(recipient.agent_id)}/trusted`)
    .send({ agent_id: trustedSender.agent_id });

  assert.equal(addRes.status, 200);
  assert.ok(addRes.body.trusted_agents.includes(trustedSender.agent_id));

  const allowedRes = await sendSignedMessage(trustedSender, recipient.agent_id, {
    subject: 'allowed-trusted',
    body: { test: 'trusted-ok' }
  });

  assert.equal(allowedRes.status, 201);
  assert.ok(allowedRes.body.message_id);

  const blockedRes = await sendSignedMessage(untrustedSender, recipient.agent_id, {
    subject: 'blocked-untrusted',
    body: { test: 'untrusted-blocked' }
  });

  assert.equal(blockedRes.status, 400);
  assert.equal(blockedRes.body.error, 'SEND_FAILED');
  assert.ok(blockedRes.body.message.includes('not trusted'));
});

test('trust list rejects unregistered sender claiming a trusted ID', async () => {
  const recipient = await registerAgent('trusted-recipient-missing-sender');
  const ghostTrustedId = `ghost-trusted-${Date.now()}`;

  const addRes = await request(app)
    .post(`/api/agents/${encodeURIComponent(recipient.agent_id)}/trusted`)
    .send({ agent_id: ghostTrustedId });

  assert.equal(addRes.status, 200);
  assert.ok(addRes.body.trusted_agents.includes(ghostTrustedId));

  const forgedEnvelope = {
    version: '1.0',
    id: `msg-${Date.now()}`,
    type: 'task.request',
    from: ghostTrustedId,
    to: recipient.agent_id,
    subject: 'forged-trusted-sender',
    body: { test: 'impersonation-attempt' },
    timestamp: new Date().toISOString(),
    ttl_sec: 3600
  };

  const forgedRes = await request(app)
    .post(`/api/agents/${encodeURIComponent(recipient.agent_id)}/messages`)
    .send(forgedEnvelope);

  assert.equal(forgedRes.status, 403);
  assert.equal(forgedRes.body.error, 'INVALID_SIGNATURE');
  assert.ok(
    forgedRes.body.message.includes('signature required') ||
    forgedRes.body.message.includes('not registered')
  );
});

test('mech storage persists agents', { skip: !MECH_CONFIGURED }, async () => {
  const agent = await registerAgent('mech-persist-agent', { role: 'mech-test' });

  const mech = createMechStorage();
  const stored = await mech.getAgent(agent.agent_id);

  assert.ok(stored);
  assert.equal(stored.agent_id, agent.agent_id);
  assert.equal(stored.agent_type, agent.agent_type);
  assert.equal(stored.metadata.role, 'mech-test');
});

test('mech storage persists messages', { skip: !MECH_CONFIGURED }, async () => {
  const sender = await registerAgent('mech-persist-sender');
  const recipient = await registerAgent('mech-persist-recipient');

  const sendRes = await sendSignedMessage(sender, recipient.agent_id, {
    subject: 'mech-persist-message',
    body: { test: 'mech-message' }
  });

  assert.equal(sendRes.status, 201);
  const messageId = sendRes.body.message_id;
  assert.ok(messageId);

  const mech = createMechStorage();
  const stored = await mech.getMessage(messageId);

  assert.ok(stored);
  assert.equal(stored.id, messageId);
  assert.equal(stored.to_agent_id, recipient.agent_id);
  assert.equal(stored.from_agent_id, sender.agent_id);
  assert.equal(stored.envelope.subject, 'mech-persist-message');
});

test('requireApiKey rejects missing API key when enabled', () => {
  process.env.API_KEY_REQUIRED = 'true';
  process.env.MASTER_API_KEY = 'test-master-key';

  const req = { headers: {} };
  let statusCode;
  let body;
  const res = {
    status(code) {
      statusCode = code;
      return this;
    },
    json(payload) {
      body = payload;
      return this;
    }
  };

  let nextCalled = false;
  const next = () => {
    nextCalled = true;
  };

  requireApiKey(req, res, next);

  assert.equal(nextCalled, false);
  assert.equal(statusCode, 401);
  assert.equal(body.error, 'API_KEY_REQUIRED');

  process.env.API_KEY_REQUIRED = ORIGINAL_API_KEY_REQUIRED;
  process.env.MASTER_API_KEY = ORIGINAL_MASTER_API_KEY;
});

test('requireApiKey rejects invalid API key', async () => {
  process.env.API_KEY_REQUIRED = 'true';
  process.env.MASTER_API_KEY = 'test-master-key';

  const req = { headers: { 'x-api-key': 'wrong-key' } };
  let statusCode;
  let body;
  const res = {
    status(code) {
      statusCode = code;
      return this;
    },
    json(payload) {
      body = payload;
      return this;
    }
  };

  let nextCalled = false;
  const next = () => {
    nextCalled = true;
  };

  // requireApiKey is async: it checks issued keys in storage when master key does not match
  await requireApiKey(req, res, next);

  assert.equal(nextCalled, false);
  assert.equal(statusCode, 401);
  assert.equal(body.error, 'INVALID_API_KEY');

  process.env.API_KEY_REQUIRED = ORIGINAL_API_KEY_REQUIRED;
  process.env.MASTER_API_KEY = ORIGINAL_MASTER_API_KEY;
});

test('requireApiKey allows valid API key', () => {
  process.env.API_KEY_REQUIRED = 'true';
  process.env.MASTER_API_KEY = 'test-master-key';

  const req = { headers: { 'x-api-key': 'test-master-key' } };
  let statusCode;
  let body;
  const res = {
    status(code) {
      statusCode = code;
      return this;
    },
    json(payload) {
      body = payload;
      return this;
    }
  };

  let nextCalled = false;
  const next = () => {
    nextCalled = true;
  };

  requireApiKey(req, res, next);

  assert.equal(nextCalled, true);
  assert.equal(statusCode, undefined);
  assert.equal(body, undefined);

  process.env.API_KEY_REQUIRED = ORIGINAL_API_KEY_REQUIRED;
  process.env.MASTER_API_KEY = ORIGINAL_MASTER_API_KEY;
});

test('webhook happy path delivers and verifies signature', async () => {
  let receivedPayload;

  const server = http.createServer((req, res) => {
    if (req.method === 'POST' && req.url === '/webhook-test-ok') {
      let body = '';
      req.on('data', chunk => {
        body += chunk;
      });
      req.on('end', () => {
        const payload = JSON.parse(body);
        const signature = payload.signature;
        const unsignedPayload = { ...payload };
        delete unsignedPayload.signature;

        const valid = webhookService.verifyWebhookSignature(
          unsignedPayload,
          signature,
          'test-webhook-secret'
        );

        receivedPayload = payload;

        res.statusCode = valid ? 200 : 401;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ ok: valid }));
      });
    } else {
      res.statusCode = 404;
      res.end();
    }
  });

  await new Promise(resolve => server.listen(0, resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;

  const agent = {
    agent_id: 'webhook-happy',
    webhook_url: `http://127.0.0.1:${port}/webhook-test-ok`,
    webhook_secret: 'test-webhook-secret'
  };

  const message = {
    id: `msg-${Date.now()}`,
    envelope: {
      id: `msg-${Date.now()}`,
      type: 'task.request',
      from: agent.agent_id,
      to: agent.agent_id,
      subject: 'webhook-test',
      body: { hello: 'webhook' },
      timestamp: new Date().toISOString()
    }
  };

  const result = await webhookService.deliverWithRetry(agent, message);

  assert.equal(result.success, true);
  assert.equal(result.status, 200);
  assert.equal(result.attempts, 1);
  assert.ok(receivedPayload);
  assert.equal(receivedPayload.message_id, message.id);
  assert.equal(receivedPayload.envelope.subject, 'webhook-test');

  await new Promise(resolve => server.close(resolve));
});

test('webhook failure reports will_retry and pending retries', async () => {
  let attemptCount = 0;

  const server = http.createServer((req, res) => {
    if (req.method === 'POST' && req.url === '/webhook-test-fail') {
      attemptCount += 1;
      res.statusCode = 500;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ error: 'FAIL' }));
    } else {
      res.statusCode = 404;
      res.end();
    }
  });

  await new Promise(resolve => server.listen(0, resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;

  const agent = {
    agent_id: 'webhook-fail',
    webhook_url: `http://127.0.0.1:${port}/webhook-test-fail`,
    webhook_secret: null
  };

  const message = {
    id: `msg-fail-${Date.now()}`,
    envelope: {
      id: `msg-fail-${Date.now()}`,
      type: 'task.request',
      from: agent.agent_id,
      to: agent.agent_id,
      subject: 'webhook-fail',
      body: { hello: 'webhook-fail' },
      timestamp: new Date().toISOString()
    }
  };

  webhookService.clearAttempts(message.id);

  const result = await webhookService.deliverWithRetry(agent, message);

  assert.equal(result.success, false);
  assert.equal(result.status, 500);
  assert.equal(result.attempts, 1);
  assert.equal(result.will_retry, true);
  assert.equal(attemptCount, 1);

  const stats = webhookService.getStats();
  assert.ok(stats.pending_retries >= 1);
  assert.ok(stats.messages.some(m => m.message_id === message.id));

  webhookService.clearAttempts(message.id);
  await new Promise(resolve => server.close(resolve));
});

test('groups: open group join → post fanout → history dedupe', async () => {
  const owner = await registerAgent('group-owner');
  const member = await registerAgent('group-member');

  const groupName = `Test Group ${Date.now()}`;
  const createRes = await withAgentHeader(request(app).post('/api/groups'), owner.agent_id).send({
    name: groupName,
    access: { type: 'open' },
    settings: { history_visible: true, max_members: 10 }
  });

  assert.equal(createRes.status, 201);
  assert.ok(createRes.body.id);
  const groupId = createRes.body.id;

  const joinRes = await withAgentHeader(
    request(app).post(`/api/groups/${encodeURIComponent(groupId)}/join`),
    member.agent_id
  ).send({});

  assert.equal(joinRes.status, 200);
  assert.ok(joinRes.body.members.some(m => m.agent_id === member.agent_id));

  const postRes = await withAgentHeader(
    request(app).post(`/api/groups/${encodeURIComponent(groupId)}/messages`),
    member.agent_id
  ).send({
    subject: 'hello-group',
    body: { hello: 'world' },
    correlation_id: 'thread-1'
  });

  assert.equal(postRes.status, 201);
  assert.equal(postRes.body.group_id, groupId);
  assert.ok(postRes.body.message_id);
  assert.equal(postRes.body.delivered, 1);

  const stableGroupMessageId = postRes.body.message_id;

  // Owner should receive the message in their personal inbox
  const pullRes = await request(app)
    .post(`/api/agents/${encodeURIComponent(owner.agent_id)}/inbox/pull`)
    .send({ visibility_timeout: 60 });

  assert.equal(pullRes.status, 200);
  assert.ok(pullRes.body.envelope);
  assert.equal(pullRes.body.envelope.type, 'group.message');
  assert.equal(pullRes.body.envelope.group_id, groupId);
  assert.equal(pullRes.body.envelope.group_message_id, stableGroupMessageId);

  // History should dedupe fanout deliveries
  const historyRes = await withAgentHeader(
    request(app).get(`/api/groups/${encodeURIComponent(groupId)}/messages?limit=50`),
    owner.agent_id
  );

  assert.equal(historyRes.status, 200);
  assert.equal(historyRes.body.count, 1);
  assert.ok(Array.isArray(historyRes.body.messages));
  assert.equal(historyRes.body.messages[0].id, stableGroupMessageId);
  assert.equal(historyRes.body.messages[0].group_id, groupId);
});

test('groups: key-protected join rejects wrong key and accepts correct key', async () => {
  const owner = await registerAgent('kp-owner');
  const joiner = await registerAgent('kp-joiner');

  const createRes = await withAgentHeader(request(app).post('/api/groups'), owner.agent_id).send({
    name: `Key Protected ${Date.now()}`,
    access: { type: 'key-protected', join_key: 'super-secret' }
  });

  assert.equal(createRes.status, 201);
  const groupId = createRes.body.id;

  const wrongKeyRes = await withAgentHeader(
    request(app).post(`/api/groups/${encodeURIComponent(groupId)}/join`),
    joiner.agent_id
  ).send({ key: 'wrong' });

  assert.equal(wrongKeyRes.status, 403);

  const correctKeyRes = await withAgentHeader(
    request(app).post(`/api/groups/${encodeURIComponent(groupId)}/join`),
    joiner.agent_id
  ).send({ key: 'super-secret' });

  assert.equal(correctKeyRes.status, 200);
  assert.ok(correctKeyRes.body.members.some(m => m.agent_id === joiner.agent_id));
});

test('groups: invite-only groups reject join requests', async () => {
  const owner = await registerAgent('io-owner');
  const joiner = await registerAgent('io-joiner');

  const createRes = await withAgentHeader(request(app).post('/api/groups'), owner.agent_id).send({
    name: `Invite Only ${Date.now()}`,
    access: { type: 'invite-only' }
  });

  assert.equal(createRes.status, 201);
  const groupId = createRes.body.id;

  const joinRes = await withAgentHeader(
    request(app).post(`/api/groups/${encodeURIComponent(groupId)}/join`),
    joiner.agent_id
  ).send({});

  assert.equal(joinRes.status, 403);
});

// ============ EPHEMERAL MESSAGES ============

test('ephemeral message: body purged on ack, metadata preserved', async () => {
  const sender = await registerAgent('eph-sender');
  const recipient = await registerAgent('eph-recipient');

  const sendRes = await sendSignedMessage(sender, recipient.agent_id, {
    subject: 'credentials',
    body: { api_key: 'secret-key-12345' },
    ephemeral: true
  });

  assert.equal(sendRes.status, 201);
  const messageId = sendRes.body.message_id;

  // Pull the message
  const pullRes = await request(app)
    .post(`/api/agents/${encodeURIComponent(recipient.agent_id)}/inbox/pull`)
    .send({ visibility_timeout: 60 });

  assert.equal(pullRes.status, 200);
  assert.equal(pullRes.body.message_id, messageId);
  assert.deepEqual(pullRes.body.envelope.body, { api_key: 'secret-key-12345' });

  // Ack the message
  const ackRes = await request(app)
    .post(`/api/agents/${encodeURIComponent(recipient.agent_id)}/messages/${messageId}/ack`)
    .send({ result: { status: 'processed' } });

  assert.equal(ackRes.status, 200);

  // Status should return 410 Gone with metadata but no body
  const statusRes = await request(app)
    .get(`/api/messages/${messageId}/status`);

  assert.equal(statusRes.status, 410);
  assert.equal(statusRes.body.error, 'MESSAGE_EXPIRED');
  assert.equal(statusRes.body.status, 'purged');
  assert.equal(statusRes.body.purge_reason, 'acked');
  assert.equal(statusRes.body.from, sender.agent_id);
  assert.equal(statusRes.body.subject, 'credentials');
  assert.equal(statusRes.body.body, null);
});

test('ephemeral message with TTL: auto-purged after expiry', async () => {
  const sender = await registerAgent('eph-ttl-sender');
  const recipient = await registerAgent('eph-ttl-recipient');

  const sendRes = await sendSignedMessage(sender, recipient.agent_id, {
    subject: 'temp-data',
    body: { token: 'expires-soon' },
    ephemeral: true,
    ttl: '1s'
  });

  assert.equal(sendRes.status, 201);
  const messageId = sendRes.body.message_id;

  // Wait for TTL to expire
  await new Promise(resolve => setTimeout(resolve, 1500));

  // Trigger the purge sweep (simulating the background job)
  const { inboxService } = await import('./services/inbox.service.js');
  const purged = await inboxService.purgeExpiredEphemeralMessages();
  assert.ok(purged >= 1);

  // Status should return 410 Gone
  const statusRes = await request(app)
    .get(`/api/messages/${messageId}/status`);

  assert.equal(statusRes.status, 410);
  assert.equal(statusRes.body.error, 'MESSAGE_EXPIRED');
  assert.equal(statusRes.body.purge_reason, 'ttl_expired');
  assert.equal(statusRes.body.body, null);
});

test('ttl-only (without ephemeral) auto-purges after expiry', async () => {
  const sender = await registerAgent('ttl-only-sender');
  const recipient = await registerAgent('ttl-only-recipient');

  const sendRes = await sendSignedMessage(sender, recipient.agent_id, {
    subject: 'temp-notice',
    body: { info: 'short-lived' },
    ttl: '1s'
  });

  assert.equal(sendRes.status, 201);
  const messageId = sendRes.body.message_id;

  // Wait for TTL to expire
  await new Promise(resolve => setTimeout(resolve, 1500));

  // Trigger purge sweep
  const { inboxService } = await import('./services/inbox.service.js');
  const purged = await inboxService.purgeExpiredEphemeralMessages();
  assert.ok(purged >= 1);

  // Status should return 410
  const statusRes = await request(app)
    .get(`/api/messages/${messageId}/status`);

  assert.equal(statusRes.status, 410);
  assert.equal(statusRes.body.purge_reason, 'ttl_expired');
  assert.equal(statusRes.body.body, null);
});

test('expired ephemeral message cannot be pulled', async () => {
  const sender = await registerAgent('eph-expired-sender');
  const recipient = await registerAgent('eph-expired-recipient');

  const sendRes = await sendSignedMessage(sender, recipient.agent_id, {
    subject: 'secret-creds',
    body: { key: 'should-not-be-readable' },
    ephemeral: true,
    ttl: '1s'
  });

  assert.equal(sendRes.status, 201);

  // Wait for TTL to expire
  await new Promise(resolve => setTimeout(resolve, 1500));

  // Try to pull — should get 204 (empty), not the expired message
  const pullRes = await request(app)
    .post(`/api/agents/${encodeURIComponent(recipient.agent_id)}/inbox/pull`)
    .send({ visibility_timeout: 60 });

  assert.equal(pullRes.status, 204);
});

test('rejects invalid TTL string', async () => {
  const sender = await registerAgent('bad-ttl-sender');
  const recipient = await registerAgent('bad-ttl-recipient');

  const sendRes = await sendSignedMessage(sender, recipient.agent_id, {
    subject: 'bad-ttl',
    body: { test: true },
    ttl: 'invalid'
  });

  assert.equal(sendRes.status, 400);
  assert.equal(sendRes.body.error, 'SEND_FAILED');
  assert.ok(sendRes.body.message.includes('Invalid TTL'));
});

test('non-ephemeral messages behave as before (backward compat)', async () => {
  const sender = await registerAgent('non-eph-sender');
  const recipient = await registerAgent('non-eph-recipient');

  const sendRes = await sendSignedMessage(sender, recipient.agent_id, {
    subject: 'normal-message',
    body: { data: 'persistent' }
  });

  assert.equal(sendRes.status, 201);
  const messageId = sendRes.body.message_id;

  // Pull and ack
  const pullRes = await request(app)
    .post(`/api/agents/${encodeURIComponent(recipient.agent_id)}/inbox/pull`)
    .send({ visibility_timeout: 60 });

  assert.equal(pullRes.status, 200);

  const ackRes = await request(app)
    .post(`/api/agents/${encodeURIComponent(recipient.agent_id)}/messages/${messageId}/ack`)
    .send({ result: { status: 'done' } });

  assert.equal(ackRes.status, 200);

  // Status should still return normally (not 410)
  const statusRes = await request(app)
    .get(`/api/messages/${messageId}/status`);

  assert.equal(statusRes.status, 200);
  assert.equal(statusRes.body.status, 'acked');
});

test('groups: owner can add member; non-member cannot add members', async () => {
  const owner = await registerAgent('add-owner');
  const nonMember = await registerAgent('add-nonmember');
  const newMember = await registerAgent('add-member');

  const createRes = await withAgentHeader(request(app).post('/api/groups'), owner.agent_id).send({
    name: `Add Members ${Date.now()}`,
    access: { type: 'invite-only' }
  });

  assert.equal(createRes.status, 201);
  const groupId = createRes.body.id;

  const forbiddenAddRes = await withAgentHeader(
    request(app).post(`/api/groups/${encodeURIComponent(groupId)}/members`),
    nonMember.agent_id
  ).send({ agent_id: newMember.agent_id, role: 'member' });

  assert.equal(forbiddenAddRes.status, 403);

  const addRes = await withAgentHeader(
    request(app).post(`/api/groups/${encodeURIComponent(groupId)}/members`),
    owner.agent_id
  ).send({ agent_id: newMember.agent_id, role: 'member' });

  assert.equal(addRes.status, 200);
  assert.ok(addRes.body.members.some(m => m.agent_id === newMember.agent_id));

  const listRes = await withAgentHeader(
    request(app).get(`/api/groups/${encodeURIComponent(groupId)}/members`),
    newMember.agent_id
  );

  assert.equal(listRes.status, 200);
  assert.ok(Array.isArray(listRes.body.members));
  assert.ok(listRes.body.members.some(m => m.agent_id === owner.agent_id));
  assert.ok(listRes.body.members.some(m => m.agent_id === newMember.agent_id));
});

// ============ OUTBOX & DOMAIN TESTS ============

test('outbox domain: GET returns 404 when no domain configured', async () => {
  const agent = await registerAgent('outbox-nodomain');

  const res = await request(app)
    .get(`/api/agents/${encodeURIComponent(agent.agent_id)}/outbox/domain`);

  assert.equal(res.status, 404);
  assert.equal(res.body.error, 'NO_DOMAIN');
});

test('outbox domain: POST requires domain field', async () => {
  const agent = await registerAgent('outbox-missing-domain');

  const res = await request(app)
    .post(`/api/agents/${encodeURIComponent(agent.agent_id)}/outbox/domain`)
    .send({});

  assert.equal(res.status, 400);
  assert.equal(res.body.error, 'DOMAIN_REQUIRED');
});

test('outbox domain: POST fails without MAILGUN_API_KEY', async () => {
  const agent = await registerAgent('outbox-nokey');

  // MAILGUN_API_KEY is not set in test env, so this should fail
  const res = await request(app)
    .post(`/api/agents/${encodeURIComponent(agent.agent_id)}/outbox/domain`)
    .send({ domain: 'test.example.com' });

  assert.equal(res.status, 400);
  assert.ok(res.body.message.includes('MAILGUN_API_KEY'));
});

test('outbox domain: DELETE returns 404 when no domain configured', async () => {
  const agent = await registerAgent('outbox-del-nodomain');

  const res = await request(app)
    .delete(`/api/agents/${encodeURIComponent(agent.agent_id)}/outbox/domain`);

  assert.equal(res.status, 404);
});

test('outbox domain: verify returns 404 when no domain configured', async () => {
  const agent = await registerAgent('outbox-verify-nodomain');

  const res = await request(app)
    .post(`/api/agents/${encodeURIComponent(agent.agent_id)}/outbox/domain/verify`)
    .send({});

  assert.equal(res.status, 404);
});

test('outbox send: requires to field', async () => {
  const agent = await registerAgent('outbox-send-noto');

  const res = await request(app)
    .post(`/api/agents/${encodeURIComponent(agent.agent_id)}/outbox/send`)
    .send({ subject: 'test', body: 'hello' });

  assert.equal(res.status, 400);
  assert.equal(res.body.error, 'TO_REQUIRED');
});

test('outbox send: requires subject field', async () => {
  const agent = await registerAgent('outbox-send-nosubj');

  const res = await request(app)
    .post(`/api/agents/${encodeURIComponent(agent.agent_id)}/outbox/send`)
    .send({ to: 'user@example.com', body: 'hello' });

  assert.equal(res.status, 400);
  assert.equal(res.body.error, 'SUBJECT_REQUIRED');
});

test('outbox send: requires body or html field', async () => {
  const agent = await registerAgent('outbox-send-nobody');

  const res = await request(app)
    .post(`/api/agents/${encodeURIComponent(agent.agent_id)}/outbox/send`)
    .send({ to: 'user@example.com', subject: 'test' });

  assert.equal(res.status, 400);
  assert.equal(res.body.error, 'BODY_REQUIRED');
});

test('outbox send: fails when no domain configured', async () => {
  const agent = await registerAgent('outbox-send-nodomain');

  const res = await request(app)
    .post(`/api/agents/${encodeURIComponent(agent.agent_id)}/outbox/send`)
    .send({ to: 'user@example.com', subject: 'test', body: 'hello' });

  assert.equal(res.status, 404);
  assert.ok(res.body.message.includes('no outbox domain configured'));
});

test('outbox send: fails when domain not verified', async () => {
  const agent = await registerAgent('outbox-send-unverified');

  // Manually set a domain config with pending status (bypassing Mailgun)
  await storage.setDomainConfig(agent.agent_id, {
    domain: 'unverified.example.com',
    status: 'pending',
    dns_records: [],
    mailgun_state: 'unverified'
  });

  const res = await request(app)
    .post(`/api/agents/${encodeURIComponent(agent.agent_id)}/outbox/send`)
    .send({ to: 'user@example.com', subject: 'test', body: 'hello' });

  assert.equal(res.status, 403);
  assert.ok(res.body.message.includes('not verified'));
});

test('outbox messages: returns empty list for agent with no outbox messages', async () => {
  const agent = await registerAgent('outbox-empty');

  const res = await request(app)
    .get(`/api/agents/${encodeURIComponent(agent.agent_id)}/outbox/messages`);

  assert.equal(res.status, 200);
  assert.deepEqual(res.body.messages, []);
  assert.equal(res.body.count, 0);
});

test('outbox messages: returns 404 for non-existent message', async () => {
  const agent = await registerAgent('outbox-msg-404');

  const res = await request(app)
    .get(`/api/agents/${encodeURIComponent(agent.agent_id)}/outbox/messages/nonexistent`);

  assert.equal(res.status, 404);
  assert.equal(res.body.error, 'OUTBOX_MESSAGE_NOT_FOUND');
});

test('outbox messages: prevents accessing another agent\'s message', async () => {
  const agent1 = await registerAgent('outbox-owner');
  const agent2 = await registerAgent('outbox-intruder');

  // Create outbox message for agent1
  await storage.createOutboxMessage({
    id: 'outbox-cross-agent-test',
    agent_id: agent1.agent_id,
    to: 'someone@example.com',
    from: 'test@example.com',
    subject: 'private',
    body: 'secret',
    status: 'sent'
  });

  // agent2 tries to access it
  const res = await request(app)
    .get(`/api/agents/${encodeURIComponent(agent2.agent_id)}/outbox/messages/outbox-cross-agent-test`);

  assert.equal(res.status, 403);
  assert.equal(res.body.error, 'FORBIDDEN');
});

test('outbox storage: domain config CRUD via storage layer', async () => {
  const agentId = 'storage-domain-test';

  // Set
  const config = await storage.setDomainConfig(agentId, {
    domain: 'storage.example.com',
    status: 'pending'
  });
  assert.equal(config.domain, 'storage.example.com');
  assert.equal(config.agent_id, agentId);

  // Get
  const fetched = await storage.getDomainConfig(agentId);
  assert.equal(fetched.domain, 'storage.example.com');

  // Update
  const updated = await storage.setDomainConfig(agentId, {
    domain: 'storage.example.com',
    status: 'verified'
  });
  assert.equal(updated.status, 'verified');
  assert.equal(updated.created_at, config.created_at); // preserves created_at

  // Delete
  await storage.deleteDomainConfig(agentId);
  const deleted = await storage.getDomainConfig(agentId);
  assert.equal(deleted, null);
});

test('outbox storage: outbox message CRUD via storage layer', async () => {
  const agentId = 'storage-outbox-test';

  // Create
  const msg = await storage.createOutboxMessage({
    id: 'outbox-crud-test',
    agent_id: agentId,
    to: 'test@example.com',
    from: 'agent@example.com',
    subject: 'CRUD test',
    body: 'hello',
    status: 'queued'
  });
  assert.equal(msg.id, 'outbox-crud-test');
  assert.ok(msg.created_at);

  // Get
  const fetched = await storage.getOutboxMessage('outbox-crud-test');
  assert.equal(fetched.subject, 'CRUD test');

  // Update
  const updated = await storage.updateOutboxMessage('outbox-crud-test', {
    status: 'sent',
    mailgun_id: '<test@mailgun>'
  });
  assert.equal(updated.status, 'sent');
  assert.equal(updated.mailgun_id, '<test@mailgun>');

  // List
  const messages = await storage.getOutboxMessages(agentId);
  assert.ok(messages.length >= 1);
  assert.ok(messages.some(m => m.id === 'outbox-crud-test'));

  // List with status filter
  const sent = await storage.getOutboxMessages(agentId, { status: 'sent' });
  assert.ok(sent.some(m => m.id === 'outbox-crud-test'));

  const queued = await storage.getOutboxMessages(agentId, { status: 'queued' });
  assert.ok(!queued.some(m => m.id === 'outbox-crud-test'));
});

test('outbox webhook: mailgun webhook endpoint accepts events', async () => {
  const res = await request(app)
    .post('/api/webhooks/mailgun')
    .send({
      event_data: {
        event: 'delivered',
        message: { headers: { 'message-id': '<test@mailgun>' } }
      }
    });

  assert.equal(res.status, 200);
  assert.equal(res.body.status, 'ok');
});

test('outbox webhook signature verification', () => {
  // Test the signature verification method directly
  const timestamp = '1234567890';
  const token = 'test-token';

  // Without signing key set, should return false
  const result = outboxService.verifyWebhookSignature(timestamp, token, 'fake-sig');
  assert.equal(result, false);
});

test('outbox send: happy path with verified domain creates outbox message', async () => {
  const agent = await registerAgent('outbox-send-happy');

  // Set up a verified domain config directly in storage (bypassing Mailgun API)
  await storage.setDomainConfig(agent.agent_id, {
    domain: 'verified.example.com',
    status: 'verified',
    dns_records: [],
    mailgun_state: 'active'
  });

  // Set MAILGUN_API_KEY so the service doesn't reject the send
  const origKey = process.env.MAILGUN_API_KEY;
  process.env.MAILGUN_API_KEY = 'test-key-for-send';

  // Stub the outbox service _mailgunRequest to simulate Mailgun success
  const originalRequest = outboxService._mailgunRequest.bind(outboxService);
  outboxService._mailgunRequest = async (path, opts) => {
    if (path.includes('/messages') && opts?.method === 'POST') {
      return { status: 200, ok: true, json: { id: '<mock-mailgun-id@mailgun>', message: 'Queued' }, text: '' };
    }
    return originalRequest(path, opts);
  };

  try {
    const res = await request(app)
      .post(`/api/agents/${encodeURIComponent(agent.agent_id)}/outbox/send`)
      .send({
        to: 'user@example.com',
        subject: 'Hello from agent',
        body: 'This is a test email',
        html: '<p>This is a test email</p>'
      });

    assert.equal(res.status, 202);
    assert.ok(res.body.id);
    assert.equal(res.body.status, 'queued');
    assert.equal(res.body.to, 'user@example.com');
    assert.equal(res.body.subject, 'Hello from agent');
    assert.ok(res.body.from.includes('verified.example.com'));
    assert.equal(res.body.agent_id, agent.agent_id);
    assert.equal(res.body.max_attempts, 3);
    assert.ok(res.body.created_at);

    // Wait briefly for async send to complete
    await new Promise(resolve => setTimeout(resolve, 200));

    // Verify outbox message is stored and updated to 'sent'
    const storedMsg = await storage.getOutboxMessage(res.body.id);
    assert.ok(storedMsg);
    assert.equal(storedMsg.status, 'sent');
    assert.equal(storedMsg.mailgun_id, '<mock-mailgun-id@mailgun>');
    assert.ok(storedMsg.sent_at);

    // Verify it appears in the agent's outbox message list
    const listRes = await request(app)
      .get(`/api/agents/${encodeURIComponent(agent.agent_id)}/outbox/messages`);

    assert.equal(listRes.status, 200);
    assert.ok(listRes.body.messages.some(m => m.id === res.body.id));

    // Verify individual message fetch works
    const getRes = await request(app)
      .get(`/api/agents/${encodeURIComponent(agent.agent_id)}/outbox/messages/${res.body.id}`);

    assert.equal(getRes.status, 200);
    assert.equal(getRes.body.id, res.body.id);
    assert.equal(getRes.body.status, 'sent');
  } finally {
    // Restore original method and env var
    outboxService._mailgunRequest = originalRequest;
    if (origKey === undefined) delete process.env.MAILGUN_API_KEY;
    else process.env.MAILGUN_API_KEY = origKey;
  }
});

test('outbox send: constructs from address as agentId@domain', async () => {
  const agent = await registerAgent('outbox-from-addr');

  await storage.setDomainConfig(agent.agent_id, {
    domain: 'mail.example.com',
    status: 'verified',
    dns_records: [],
    mailgun_state: 'active'
  });

  const origKey = process.env.MAILGUN_API_KEY;
  process.env.MAILGUN_API_KEY = 'test-key-for-from';

  // Stub the Mailgun send to succeed
  const originalRequest = outboxService._mailgunRequest.bind(outboxService);
  outboxService._mailgunRequest = async (path, opts) => {
    if (path.includes('/messages') && opts?.method === 'POST') {
      return { status: 200, ok: true, json: { id: '<from-test@mailgun>' }, text: '' };
    }
    return originalRequest(path, opts);
  };

  try {
    const res = await request(app)
      .post(`/api/agents/${encodeURIComponent(agent.agent_id)}/outbox/send`)
      .send({
        to: 'dest@example.com',
        subject: 'From test',
        body: 'Testing from address'
      });

    assert.equal(res.status, 202);
    // From should contain the domain
    assert.ok(res.body.from.includes('@mail.example.com'));
    // From should contain agent_id-derived local part
    assert.ok(res.body.from.includes(agent.agent_id));
  } finally {
    outboxService._mailgunRequest = originalRequest;
    if (origKey === undefined) delete process.env.MAILGUN_API_KEY;
    else process.env.MAILGUN_API_KEY = origKey;
  }
});

test('outbox send: from_name is sanitized to prevent header injection', async () => {
  const agent = await registerAgent('outbox-from-sanitize');

  await storage.setDomainConfig(agent.agent_id, {
    domain: 'sanitize.example.com',
    status: 'verified',
    dns_records: [],
    mailgun_state: 'active'
  });

  const origKey = process.env.MAILGUN_API_KEY;
  process.env.MAILGUN_API_KEY = 'test-key-for-sanitize';

  const originalRequest = outboxService._mailgunRequest.bind(outboxService);
  outboxService._mailgunRequest = async (path, opts) => {
    if (path.includes('/messages') && opts?.method === 'POST') {
      return { status: 200, ok: true, json: { id: '<sanitize-test@mailgun>' }, text: '' };
    }
    return originalRequest(path, opts);
  };

  try {
    const res = await request(app)
      .post(`/api/agents/${encodeURIComponent(agent.agent_id)}/outbox/send`)
      .send({
        to: 'dest@example.com',
        subject: 'Sanitize test',
        body: 'Testing from_name sanitization',
        from_name: 'Evil<script>\r\nBcc: victim@evil.com'
      });

    assert.equal(res.status, 202);
    // Dangerous characters should be stripped from the from field
    assert.ok(!res.body.from.includes('<script>'), 'Should strip angle brackets');
    assert.ok(!res.body.from.includes('\r'), 'Should strip carriage return');
    assert.ok(!res.body.from.includes('\n'), 'Should strip newline');
    assert.ok(res.body.from.includes('sanitize.example.com'));
  } finally {
    outboxService._mailgunRequest = originalRequest;
    if (origKey === undefined) delete process.env.MAILGUN_API_KEY;
    else process.env.MAILGUN_API_KEY = origKey;
  }
});

test('outbox send: rejects invalid email address in to field', async () => {
  const agent = await registerAgent('outbox-bad-email');

  const res = await request(app)
    .post(`/api/agents/${encodeURIComponent(agent.agent_id)}/outbox/send`)
    .send({ to: 'not-an-email', subject: 'test', body: 'hello' });

  assert.equal(res.status, 400);
  assert.equal(res.body.error, 'INVALID_EMAIL');
});

test('outbox send: Mailgun API failure triggers retry and eventually fails', async () => {
  const agent = await registerAgent('outbox-retry');

  await storage.setDomainConfig(agent.agent_id, {
    domain: 'retry.example.com',
    status: 'verified',
    dns_records: [],
    mailgun_state: 'active'
  });

  const origKey = process.env.MAILGUN_API_KEY;
  process.env.MAILGUN_API_KEY = 'test-key-for-retry';

  // Stub Mailgun to always fail
  const originalRequest = outboxService._mailgunRequest.bind(outboxService);
  let callCount = 0;
  outboxService._mailgunRequest = async (path, opts) => {
    if (path.includes('/messages') && opts?.method === 'POST') {
      callCount++;
      return { status: 500, ok: false, json: { message: 'Server Error' }, text: 'Server Error' };
    }
    return originalRequest(path, opts);
  };

  try {
    const res = await request(app)
      .post(`/api/agents/${encodeURIComponent(agent.agent_id)}/outbox/send`)
      .send({
        to: 'user@example.com',
        subject: 'Retry test',
        body: 'Should fail after retries'
      });

    assert.equal(res.status, 202);
    assert.equal(res.body.status, 'queued');

    // Wait for the first attempt to complete (including initial retry scheduling)
    await new Promise(resolve => setTimeout(resolve, 500));

    // First attempt should have happened
    assert.ok(callCount >= 1, `Expected at least 1 Mailgun call, got ${callCount}`);

    // Check the outbox message has attempt count > 0
    const msg = await storage.getOutboxMessage(res.body.id);
    assert.ok(msg);
    assert.ok(msg.attempts >= 1);
    assert.ok(msg.error);
  } finally {
    outboxService._mailgunRequest = originalRequest;
    if (origKey === undefined) delete process.env.MAILGUN_API_KEY;
    else process.env.MAILGUN_API_KEY = origKey;
  }
});

test('outbox webhook: delivered event updates outbox message status', async () => {
  // Create a sent outbox message with a known mailgun_id
  const mailgunId = '<webhook-delivered-test@mailgun>';
  await storage.createOutboxMessage({
    id: 'webhook-deliver-test',
    agent_id: 'webhook-agent',
    to: 'someone@example.com',
    from: 'agent@example.com',
    subject: 'Webhook test',
    body: 'hello',
    status: 'sent',
    mailgun_id: mailgunId,
    attempts: 1,
    max_attempts: 3,
    error: null,
    sent_at: Date.now()
  });

  // Send delivered webhook
  const res = await request(app)
    .post('/api/webhooks/mailgun')
    .send({
      event_data: {
        event: 'delivered',
        message: { headers: { 'message-id': mailgunId } }
      }
    });

  assert.equal(res.status, 200);
  assert.equal(res.body.status, 'ok');

  // Check that the outbox message was updated
  const msg = await storage.getOutboxMessage('webhook-deliver-test');
  assert.equal(msg.status, 'delivered');
  assert.ok(msg.delivered_at);
});

test('outbox webhook: failed event updates outbox message status', async () => {
  const mailgunId = '<webhook-failed-test@mailgun>';
  await storage.createOutboxMessage({
    id: 'webhook-fail-test',
    agent_id: 'webhook-fail-agent',
    to: 'bounce@example.com',
    from: 'agent@example.com',
    subject: 'Will fail',
    body: 'bounce test',
    status: 'sent',
    mailgun_id: mailgunId,
    attempts: 1,
    max_attempts: 3,
    error: null,
    sent_at: Date.now()
  });

  const res = await request(app)
    .post('/api/webhooks/mailgun')
    .send({
      event_data: {
        event: 'failed',
        message: { headers: { 'message-id': mailgunId } },
        reason: 'Mailbox not found'
      }
    });

  assert.equal(res.status, 200);

  const msg = await storage.getOutboxMessage('webhook-fail-test');
  assert.equal(msg.status, 'failed');
  assert.ok(msg.error.includes('Mailbox not found'));
});

test('outbox messages: list supports limit query param', async () => {
  const agent = await registerAgent('outbox-limit');

  // Create 3 outbox messages
  for (let i = 0; i < 3; i++) {
    await storage.createOutboxMessage({
      id: `limit-test-${i}-${Date.now()}`,
      agent_id: agent.agent_id,
      to: `user${i}@example.com`,
      from: 'agent@example.com',
      subject: `Limit test ${i}`,
      body: 'hello',
      status: 'sent'
    });
  }

  // List with limit=2
  const res = await request(app)
    .get(`/api/agents/${encodeURIComponent(agent.agent_id)}/outbox/messages?limit=2`);

  assert.equal(res.status, 200);
  assert.equal(res.body.messages.length, 2);
  assert.equal(res.body.count, 2);
});

test('outbox messages: list supports status query param', async () => {
  const agent = await registerAgent('outbox-status-filter');

  await storage.createOutboxMessage({
    id: `status-sent-${Date.now()}`,
    agent_id: agent.agent_id,
    to: 'user@example.com',
    from: 'agent@example.com',
    subject: 'Sent msg',
    body: 'hello',
    status: 'sent'
  });

  await storage.createOutboxMessage({
    id: `status-failed-${Date.now()}`,
    agent_id: agent.agent_id,
    to: 'user@example.com',
    from: 'agent@example.com',
    subject: 'Failed msg',
    body: 'hello',
    status: 'failed'
  });

  // Filter by status=sent
  const sentRes = await request(app)
    .get(`/api/agents/${encodeURIComponent(agent.agent_id)}/outbox/messages?status=sent`);

  assert.equal(sentRes.status, 200);
  assert.ok(sentRes.body.messages.every(m => m.status === 'sent'));
  assert.ok(sentRes.body.messages.length >= 1);

  // Filter by status=failed
  const failedRes = await request(app)
    .get(`/api/agents/${encodeURIComponent(agent.agent_id)}/outbox/messages?status=failed`);

  assert.equal(failedRes.status, 200);
  assert.ok(failedRes.body.messages.every(m => m.status === 'failed'));
  assert.ok(failedRes.body.messages.length >= 1);
});

test('outbox domain: DELETE removes config and subsequent GET returns 404', async () => {
  const agent = await registerAgent('outbox-del-flow');

  // Set up domain config directly
  await storage.setDomainConfig(agent.agent_id, {
    domain: 'delete-test.example.com',
    status: 'pending',
    dns_records: [],
    mailgun_state: 'unverified'
  });

  // Verify domain exists
  const getRes = await request(app)
    .get(`/api/agents/${encodeURIComponent(agent.agent_id)}/outbox/domain`);
  assert.equal(getRes.status, 200);
  assert.equal(getRes.body.domain, 'delete-test.example.com');

  // Delete domain
  const delRes = await request(app)
    .delete(`/api/agents/${encodeURIComponent(agent.agent_id)}/outbox/domain`);
  assert.equal(delRes.status, 204);

  // Verify it's gone
  const afterRes = await request(app)
    .get(`/api/agents/${encodeURIComponent(agent.agent_id)}/outbox/domain`);
  assert.equal(afterRes.status, 404);
});

test('outbox send: Mailgun send uses correct API path (no /domains/ prefix)', async () => {
  const agent = await registerAgent('outbox-path-check');

  await storage.setDomainConfig(agent.agent_id, {
    domain: 'path-test.example.com',
    status: 'verified',
    dns_records: [],
    mailgun_state: 'active'
  });

  const origKey = process.env.MAILGUN_API_KEY;
  process.env.MAILGUN_API_KEY = 'test-key-for-path';

  // Capture the URL path used in the Mailgun request
  let capturedPath = null;
  const originalRequest = outboxService._mailgunRequest.bind(outboxService);
  outboxService._mailgunRequest = async (path, opts) => {
    if (opts?.method === 'POST' && path.includes('/messages')) {
      capturedPath = path;
      return { status: 200, ok: true, json: { id: '<path-test@mailgun>' }, text: '' };
    }
    return originalRequest(path, opts);
  };

  try {
    const res = await request(app)
      .post(`/api/agents/${encodeURIComponent(agent.agent_id)}/outbox/send`)
      .send({
        to: 'dest@example.com',
        subject: 'Path test',
        body: 'Testing URL path'
      });

    assert.equal(res.status, 202);

    // Wait for async send
    await new Promise(resolve => setTimeout(resolve, 200));

    // The path should be /{domain}/messages, NOT /domains/{domain}/messages
    assert.ok(capturedPath, 'Mailgun request path should have been captured');
    assert.ok(capturedPath.startsWith('/path-test.example.com/messages'),
      `Expected path to start with /path-test.example.com/messages, got: ${capturedPath}`);
    assert.ok(!capturedPath.includes('/domains/'),
      `Path should NOT include /domains/ prefix, got: ${capturedPath}`);
  } finally {
    outboxService._mailgunRequest = originalRequest;
    if (origKey === undefined) delete process.env.MAILGUN_API_KEY;
    else process.env.MAILGUN_API_KEY = origKey;
  }
});

// ============ ISSUE 1: findOutboxMessageByMailgunId on storage backends ============

test('storage: findOutboxMessageByMailgunId finds message by mailgun_id', async () => {
  const mailgunId = '<find-by-mailgun-id-test@mailgun>';
  const msgId = `find-mailgun-${Date.now()}`;

  await storage.createOutboxMessage({
    id: msgId,
    agent_id: 'find-test',
    to: 'user@example.com',
    from: 'agent@example.com',
    subject: 'Find test',
    body: 'hello',
    status: 'sent',
    mailgun_id: mailgunId
  });

  // The storage backend should have findOutboxMessageByMailgunId as a method
  assert.equal(typeof storage.findOutboxMessageByMailgunId, 'function',
    'storage must implement findOutboxMessageByMailgunId');

  const found = await storage.findOutboxMessageByMailgunId(mailgunId);
  assert.ok(found, 'Should find outbox message by mailgun_id');
  assert.equal(found.id, msgId);
  assert.equal(found.mailgun_id, mailgunId);
});

test('storage: findOutboxMessageByMailgunId returns null for unknown mailgun_id', async () => {
  assert.equal(typeof storage.findOutboxMessageByMailgunId, 'function',
    'storage must implement findOutboxMessageByMailgunId');

  const result = await storage.findOutboxMessageByMailgunId('<nonexistent@mailgun>');
  assert.equal(result, null);
});

test('outbox webhook: handleWebhook uses findOutboxMessageByMailgunId to locate message', async () => {
  const mailgunId = '<webhook-find-method-test@mailgun>';
  const msgId = `webhook-find-${Date.now()}`;

  await storage.createOutboxMessage({
    id: msgId,
    agent_id: 'webhook-find-agent',
    to: 'someone@example.com',
    from: 'agent@example.com',
    subject: 'Webhook find test',
    body: 'hello',
    status: 'sent',
    mailgun_id: mailgunId,
    attempts: 1,
    max_attempts: 3,
    error: null,
    sent_at: Date.now()
  });

  // Send delivered webhook
  const res = await request(app)
    .post('/api/webhooks/mailgun')
    .send({
      event_data: {
        event: 'delivered',
        message: { headers: { 'message-id': mailgunId } }
      }
    });

  assert.equal(res.status, 200);

  // The message should have been found and updated
  const msg = await storage.getOutboxMessage(msgId);
  assert.equal(msg.status, 'delivered');
  assert.ok(msg.delivered_at);
});

// ============ ISSUE 2: Webhook signature bypass ============

test('outbox webhook: rejects request when signing key is set but signature is missing', async () => {
  const origKey = process.env.MAILGUN_WEBHOOK_SIGNING_KEY;
  process.env.MAILGUN_WEBHOOK_SIGNING_KEY = 'test-signing-key';

  try {
    // Send webhook WITHOUT signature field - should be rejected
    const res = await request(app)
      .post('/api/webhooks/mailgun')
      .send({
        event_data: {
          event: 'delivered',
          message: { headers: { 'message-id': '<bypass-test@mailgun>' } }
        }
        // Note: no signature field at all
      });

    assert.equal(res.status, 400, 'Should reject with 400 when signing key is set but signature is missing');
    assert.equal(res.body.error, 'SIGNATURE_REQUIRED');
  } finally {
    if (origKey === undefined) delete process.env.MAILGUN_WEBHOOK_SIGNING_KEY;
    else process.env.MAILGUN_WEBHOOK_SIGNING_KEY = origKey;
  }
});

test('outbox webhook: rejects request when signing key is set and signature is invalid', async () => {
  const origKey = process.env.MAILGUN_WEBHOOK_SIGNING_KEY;
  process.env.MAILGUN_WEBHOOK_SIGNING_KEY = 'test-signing-key';

  try {
    const res = await request(app)
      .post('/api/webhooks/mailgun')
      .send({
        signature: {
          timestamp: '1234567890',
          token: 'test-token',
          signature: 'invalid-signature'
        },
        event_data: {
          event: 'delivered',
          message: { headers: { 'message-id': '<sig-invalid-test@mailgun>' } }
        }
      });

    assert.equal(res.status, 403, 'Should reject with 403 for invalid signature');
    assert.equal(res.body.error, 'INVALID_SIGNATURE');
  } finally {
    if (origKey === undefined) delete process.env.MAILGUN_WEBHOOK_SIGNING_KEY;
    else process.env.MAILGUN_WEBHOOK_SIGNING_KEY = origKey;
  }
});

test('outbox webhook: allows requests when signing key is NOT set (dev mode)', async () => {
  const origKey = process.env.MAILGUN_WEBHOOK_SIGNING_KEY;
  delete process.env.MAILGUN_WEBHOOK_SIGNING_KEY;

  try {
    const res = await request(app)
      .post('/api/webhooks/mailgun')
      .send({
        event_data: {
          event: 'delivered',
          message: { headers: { 'message-id': '<devmode-test@mailgun>' } }
        }
      });

    assert.equal(res.status, 200, 'Should allow requests when no signing key is configured');
    assert.equal(res.body.status, 'ok');
  } finally {
    if (origKey === undefined) delete process.env.MAILGUN_WEBHOOK_SIGNING_KEY;
    else process.env.MAILGUN_WEBHOOK_SIGNING_KEY = origKey;
  }
});

// ============ SEEDID REGISTRATION TESTS ============

test('legacy registration returns secret_key, public_key, and DID (backward compat)', async () => {
  const agent = await registerAgent('legacy-compat');

  assert.ok(agent.secret_key, 'Legacy registration should return secret_key');
  assert.ok(agent.public_key, 'Legacy registration should return public_key');
  assert.ok(agent.did, 'Legacy registration should return DID');
  assert.ok(agent.did.startsWith('did:seed:'), 'DID should start with did:seed:');
  assert.equal(agent.registration_mode, 'legacy');
  assert.equal(agent.verification_tier, 'unverified');
  assert.equal(agent.key_version, 1);
});

test('seed-based registration: same seed+tenant+agent = same keypair (deterministic)', async () => {
  const seed = crypto.randomBytes(32);
  const seedB64 = toBase64(seed);
  const tenantId = `tenant-determ-${Date.now()}`;
  const agentId = `seed-determ-${Date.now()}`;

  // Create tenant first
  await storage.createTenant({ tenant_id: tenantId, name: tenantId, metadata: {} });

  const res1 = await request(app)
    .post('/api/agents/register')
    .send({
      agent_id: agentId,
      agent_type: 'test',
      seed: seedB64,
      tenant_id: tenantId
    });

  assert.equal(res1.status, 201);
  assert.equal(res1.body.registration_mode, 'seed');
  assert.ok(res1.body.secret_key, 'Seed-based should return secret_key');
  assert.ok(res1.body.did);

  // Re-derive locally to confirm determinism
  const context = `${LABEL_ADMP}:${tenantId}:${agentId}:ed25519:v1`;
  const derivedKey = hkdfSha256(seed, context, { length: 32 });
  const kp = keypairFromSeed(derivedKey);

  assert.equal(res1.body.public_key, toBase64(kp.publicKey),
    'Server-derived public key should match local derivation');
});

test('seed-based registration: different tenant = different keypair (isolation)', async () => {
  const seed = crypto.randomBytes(32);
  const seedB64 = toBase64(seed);
  const agentSuffix = `iso-${Date.now()}`;

  const tenantA = `tenant-a-${Date.now()}`;
  const tenantB = `tenant-b-${Date.now()}`;

  await storage.createTenant({ tenant_id: tenantA, name: tenantA, metadata: {} });
  await storage.createTenant({ tenant_id: tenantB, name: tenantB, metadata: {} });

  const resA = await request(app)
    .post('/api/agents/register')
    .send({
      agent_id: `agent-a-${agentSuffix}`,
      agent_type: 'test',
      seed: seedB64,
      tenant_id: tenantA
    });

  const resB = await request(app)
    .post('/api/agents/register')
    .send({
      agent_id: `agent-b-${agentSuffix}`,
      agent_type: 'test',
      seed: seedB64,
      tenant_id: tenantB
    });

  assert.equal(resA.status, 201);
  assert.equal(resB.status, 201);
  assert.notEqual(resA.body.public_key, resB.body.public_key,
    'Different tenants should yield different keys from same seed');
  assert.notEqual(resA.body.did, resB.body.did,
    'Different tenants should yield different DIDs');
});

test('seed-based registration requires tenant_id', async () => {
  const seed = crypto.randomBytes(32);
  const seedB64 = toBase64(seed);

  const res = await request(app)
    .post('/api/agents/register')
    .send({
      agent_id: `no-tenant-${Date.now()}`,
      agent_type: 'test',
      seed: seedB64
    });

  assert.equal(res.status, 400);
  assert.ok(res.body.message.includes('tenant_id'));
});

test('import mode: stores provided key, no secret_key in response, DID generated', async () => {
  const kp = nacl.sign.keyPair();
  const pubKeyB64 = toBase64(kp.publicKey);

  const res = await request(app)
    .post('/api/agents/register')
    .send({
      agent_id: `import-${Date.now()}`,
      agent_type: 'test',
      public_key: pubKeyB64
    });

  assert.equal(res.status, 201);
  assert.equal(res.body.registration_mode, 'import');
  assert.equal(res.body.public_key, pubKeyB64);
  assert.ok(!res.body.secret_key, 'Import mode should NOT return secret_key');
  assert.ok(res.body.did, 'Import mode should generate DID');
  assert.ok(res.body.did.startsWith('did:seed:'));
});

// ============ TENANT TESTS ============

test('tenant CRUD: create, get, list agents, delete', async () => {
  const origRequired = process.env.API_KEY_REQUIRED;
  const origKey = process.env.MASTER_API_KEY;
  process.env.API_KEY_REQUIRED = 'true';
  process.env.MASTER_API_KEY = 'test-tenant-key';

  try {
    const tenantId = `tenant-crud-${Date.now()}`;

    // Create
    const createRes = await request(app)
      .post('/api/agents/tenants')
      .set('x-api-key', 'test-tenant-key')
      .send({ tenant_id: tenantId, name: 'Test Tenant', metadata: { plan: 'pro' } });

    assert.equal(createRes.status, 201);
    assert.equal(createRes.body.tenant_id, tenantId);
    assert.equal(createRes.body.name, 'Test Tenant');

    // Get
    const getRes = await request(app)
      .get(`/api/agents/tenants/${tenantId}`)
      .set('x-api-key', 'test-tenant-key');

    assert.equal(getRes.status, 200);
    assert.equal(getRes.body.tenant_id, tenantId);

    // Register agent under tenant
    const seed = crypto.randomBytes(32);
    const agentRes = await request(app)
      .post('/api/agents/register')
      .send({
        agent_id: `tenant-agent-${Date.now()}`,
        agent_type: 'test',
        seed: toBase64(seed),
        tenant_id: tenantId
      });

    assert.equal(agentRes.status, 201);

    // List agents by tenant
    const listRes = await request(app)
      .get(`/api/agents/tenants/${tenantId}/agents`)
      .set('x-api-key', 'test-tenant-key');

    assert.equal(listRes.status, 200);
    assert.ok(listRes.body.agents.length >= 1);
    assert.ok(listRes.body.agents.some(a => a.agent_id === agentRes.body.agent_id));

    // Delete
    const delRes = await request(app)
      .delete(`/api/agents/tenants/${tenantId}`)
      .set('x-api-key', 'test-tenant-key');

    assert.equal(delRes.status, 204);
  } finally {
    if (origRequired === undefined) delete process.env.API_KEY_REQUIRED;
    else process.env.API_KEY_REQUIRED = origRequired;
    if (origKey === undefined) delete process.env.MASTER_API_KEY;
    else process.env.MASTER_API_KEY = origKey;
  }
});

test('duplicate tenant returns 409', async () => {
  const origRequired = process.env.API_KEY_REQUIRED;
  const origKey = process.env.MASTER_API_KEY;
  process.env.API_KEY_REQUIRED = 'true';
  process.env.MASTER_API_KEY = 'test-dup-key';

  try {
    const tenantId = `tenant-dup-${Date.now()}`;

    const first = await request(app)
      .post('/api/agents/tenants')
      .set('x-api-key', 'test-dup-key')
      .send({ tenant_id: tenantId, name: 'Dup Tenant' });

    assert.equal(first.status, 201);

    const second = await request(app)
      .post('/api/agents/tenants')
      .set('x-api-key', 'test-dup-key')
      .send({ tenant_id: tenantId, name: 'Dup Tenant Again' });

    assert.equal(second.status, 409);
    assert.equal(second.body.error, 'TENANT_EXISTS');
  } finally {
    if (origRequired === undefined) delete process.env.API_KEY_REQUIRED;
    else process.env.API_KEY_REQUIRED = origRequired;
    if (origKey === undefined) delete process.env.MASTER_API_KEY;
    else process.env.MASTER_API_KEY = origKey;
  }
});

test('tenant routes require API key when API_KEY_REQUIRED is true', async () => {
  const origRequired = process.env.API_KEY_REQUIRED;
  const origKey = process.env.MASTER_API_KEY;
  process.env.API_KEY_REQUIRED = 'true';
  process.env.MASTER_API_KEY = 'test-req-key';

  try {
    // POST without API key
    const createRes = await request(app)
      .post('/api/agents/tenants')
      .send({ tenant_id: 'should-fail' });

    assert.equal(createRes.status, 401);
    assert.equal(createRes.body.error, 'API_KEY_REQUIRED');

    // GET without API key
    const getRes = await request(app)
      .get('/api/agents/tenants/whatever');

    assert.equal(getRes.status, 401);

    // DELETE without API key
    const delRes = await request(app)
      .delete('/api/agents/tenants/whatever');

    assert.equal(delRes.status, 401);
  } finally {
    if (origRequired === undefined) delete process.env.API_KEY_REQUIRED;
    else process.env.API_KEY_REQUIRED = origRequired;
    if (origKey === undefined) delete process.env.MASTER_API_KEY;
    else process.env.MASTER_API_KEY = origKey;
  }
});

// ============ DID MESSAGING TESTS ============

test('send message to agent by DID URI works', async () => {
  const sender = await registerAgent('did-msg-sender');
  const recipient = await registerAgent('did-msg-recipient');

  // Get recipient's DID
  const recipientAgent = await storage.getAgent(recipient.agent_id);
  assert.ok(recipientAgent.did, 'Recipient should have a DID');

  const res = await sendSignedMessage(sender, recipientAgent.did, {
    subject: 'did-delivery',
    body: { hello: 'via-did' }
  });

  assert.equal(res.status, 201);
  assert.ok(res.body.message_id);
});

test('send from DID URI resolves sender correctly', async () => {
  const sender = await registerAgent('did-from-sender');
  const recipient = await registerAgent('did-from-recipient');

  const senderAgent = await storage.getAgent(sender.agent_id);
  assert.ok(senderAgent.did);

  // Build envelope with DID as from
  const envelope = {
    version: '1.0',
    id: `msg-did-from-${Date.now()}`,
    type: 'task.request',
    from: senderAgent.did,
    to: recipient.agent_id,
    subject: 'from-did',
    body: { test: 'did-from' },
    timestamp: new Date().toISOString(),
    ttl_sec: 3600
  };

  const secretKey = fromBase64(sender.secret_key);
  envelope.signature = signMessage(envelope, secretKey);

  const res = await request(app)
    .post(`/api/agents/${encodeURIComponent(recipient.agent_id)}/messages`)
    .send(envelope);

  assert.equal(res.status, 201);
  assert.ok(res.body.message_id);
});

// ============ HTTP SIGNATURE TESTS ============

test('valid HTTP signature passes auth', async () => {
  const agent = await registerAgent('httpsig-valid');
  const secretKey = fromBase64(agent.secret_key);
  const agentId = agent.agent_id;
  const path = `/api/agents/${encodeURIComponent(agentId)}`;

  const headers = {
    host: '127.0.0.1',
    date: new Date().toUTCString()
  };

  const sigHeader = signRequest('GET', path, headers, secretKey, agentId);

  const res = await request(app)
    .get(path)
    .set('host', headers.host)
    .set('date', headers.date)
    .set('signature', sigHeader);

  assert.equal(res.status, 200);
  assert.equal(res.body.agent_id, agentId);
});

test('invalid HTTP signature returns 401 (rejected at global gate)', async () => {
  const agent = await registerAgent('httpsig-invalid');
  const agentId = agent.agent_id;
  const path = `/api/agents/${encodeURIComponent(agentId)}`;

  // Create a bogus signature with a different key
  const bogusKeyPair = nacl.sign.keyPair();
  const headers = {
    host: '127.0.0.1',
    date: new Date().toUTCString()
  };

  const sigHeader = signRequest('GET', path, headers, bogusKeyPair.secretKey, agentId);

  const res = await request(app)
    .get(path)
    .set('host', headers.host)
    .set('date', headers.date)
    .set('signature', sigHeader);

  // After Fix 1: invalid signature is rejected at the global API key gate (401)
  // instead of being forwarded to authenticateHttpSignature (403)
  assert.equal(res.status, 401);
  assert.equal(res.body.error, 'SIGNATURE_INVALID');
});

test('no Signature header falls back to legacy auth (backward compat)', async () => {
  const agent = await registerAgent('httpsig-fallback');
  const agentId = agent.agent_id;

  // No Signature header, no X-Agent-ID — relies on URL param
  const res = await request(app)
    .get(`/api/agents/${encodeURIComponent(agentId)}`);

  assert.equal(res.status, 200);
  assert.equal(res.body.agent_id, agentId);
});

test('HTTP signature keyId can be DID', async () => {
  const agent = await registerAgent('httpsig-did');
  const secretKey = fromBase64(agent.secret_key);
  const agentId = agent.agent_id;

  const agentRecord = await storage.getAgent(agentId);
  const did = agentRecord.did;
  assert.ok(did, 'Agent should have a DID');

  const path = `/api/agents/${encodeURIComponent(agentId)}`;
  const headers = {
    host: '127.0.0.1',
    date: new Date().toUTCString()
  };

  // Sign using DID as keyId
  const sigHeader = signRequest('GET', path, headers, secretKey, did);

  const res = await request(app)
    .get(path)
    .set('host', headers.host)
    .set('date', headers.date)
    .set('signature', sigHeader);

  assert.equal(res.status, 200);
  assert.equal(res.body.agent_id, agentId);
});

// ============ DISCOVERY TESTS ============

test('/.well-known/agent-keys.json lists registered agents with DIDs', async () => {
  const agent = await registerAgent('discovery-agent');

  const res = await request(app)
    .get('/.well-known/agent-keys.json');

  assert.equal(res.status, 200);
  assert.ok(Array.isArray(res.body.keys));
  assert.ok(res.body.keys.length >= 1);

  const found = res.body.keys.find(k => k.kid === agent.agent_id);
  assert.ok(found, 'Registered agent should appear in key directory');
  assert.ok(found.did, 'Agent should have DID in directory');
  assert.equal(found.kty, 'OKP');
  assert.equal(found.crv, 'Ed25519');
  assert.ok(found.x, 'Should have public key');
  assert.ok(found.verification_tier);
});

test('/api/agents/:id/did.json returns valid DID document with service endpoint', async () => {
  const agent = await registerAgent('discovery-did-doc');

  const res = await request(app)
    .get(`/api/agents/${encodeURIComponent(agent.agent_id)}/did.json`);

  assert.equal(res.status, 200);

  const doc = res.body;
  assert.ok(doc['@context']);
  assert.ok(doc.id.startsWith('did:seed:'));
  assert.ok(Array.isArray(doc.verificationMethod));
  assert.equal(doc.verificationMethod.length, 1);
  assert.equal(doc.verificationMethod[0].type, 'Ed25519VerificationKey2020');
  assert.ok(doc.verificationMethod[0].publicKeyMultibase, 'Should use publicKeyMultibase');
  assert.ok(doc.verificationMethod[0].publicKeyMultibase.startsWith('z'), 'Multibase should start with z');
  assert.ok(!doc.verificationMethod[0].publicKeyBase64, 'Should NOT use publicKeyBase64');

  // Check service endpoint
  assert.ok(Array.isArray(doc.service));
  const admpService = doc.service.find(s => s.type === 'ADMPInbox');
  assert.ok(admpService, 'Should have ADMPInbox service');
  assert.ok(admpService.serviceEndpoint.includes(agent.agent_id));

  // Check authentication
  assert.ok(Array.isArray(doc.authentication));
  assert.ok(doc.authentication.length >= 1);
});

test('DID document returns 404 for unknown agent', async () => {
  const res = await request(app)
    .get('/api/agents/agent%3A%2F%2Fnon-existent-agent/did.json');

  assert.equal(res.status, 404);
  assert.equal(res.body.error, 'AGENT_NOT_FOUND');
});

// ============ KEY ROTATION TESTS ============

test('key rotation increments version and generates new keypair', async () => {
  const seed = crypto.randomBytes(32);
  const seedB64 = toBase64(seed);
  const tenantId = `tenant-rotate-${Date.now()}`;
  const agentId = `rotate-${Date.now()}`;

  await storage.createTenant({ tenant_id: tenantId, name: tenantId, metadata: {} });

  const regRes = await request(app)
    .post('/api/agents/register')
    .send({
      agent_id: agentId,
      agent_type: 'test',
      seed: seedB64,
      tenant_id: tenantId
    });

  assert.equal(regRes.status, 201);
  const originalPubKey = regRes.body.public_key;
  assert.equal(regRes.body.key_version, 1);

  // Rotate
  const rotateRes = await request(app)
    .post(`/api/agents/${encodeURIComponent(agentId)}/rotate-key`)
    .send({ seed: seedB64, tenant_id: tenantId });

  assert.equal(rotateRes.status, 200);
  assert.equal(rotateRes.body.key_version, 2);
  assert.notEqual(rotateRes.body.public_key, originalPubKey, 'New key should differ');
  assert.ok(rotateRes.body.did, 'New DID should be generated');
  assert.ok(rotateRes.body.secret_key, 'Should return new secret_key');
});

test('messages signed with old key still verify during rotation window', async () => {
  const seed = crypto.randomBytes(32);
  const seedB64 = toBase64(seed);
  const tenantId = `tenant-rotwin-${Date.now()}`;
  const senderAgentId = `rotwin-sender-${Date.now()}`;
  const recipientAgentId = `rotwin-recv-${Date.now()}`;

  await storage.createTenant({ tenant_id: tenantId, name: tenantId, metadata: {} });

  // Register sender with seed
  const senderRes = await request(app)
    .post('/api/agents/register')
    .send({
      agent_id: senderAgentId,
      agent_type: 'test',
      seed: seedB64,
      tenant_id: tenantId
    });

  assert.equal(senderRes.status, 201);
  const oldSecretKey = senderRes.body.secret_key;

  // Register recipient
  const recipientRes = await request(app)
    .post('/api/agents/register')
    .send({
      agent_id: recipientAgentId,
      agent_type: 'test'
    });

  assert.equal(recipientRes.status, 201);

  // Rotate sender's key — old key stays in rotation window (deactivate_at set)
  const rotateRes = await request(app)
    .post(`/api/agents/${encodeURIComponent(senderAgentId)}/rotate-key`)
    .send({ seed: seedB64, tenant_id: tenantId });

  assert.equal(rotateRes.status, 200);

  // Verify old key has deactivate_at set (rotation window)
  const senderAgent = await storage.getAgent(senderAgentId);
  const oldKey = senderAgent.public_keys.find(k => k.version === 1);
  assert.ok(oldKey.deactivate_at, 'Old key should have deactivate_at for rotation window');
  assert.ok(oldKey.deactivate_at > Date.now(), 'Old key deactivate_at should be in the future');

  // Send message signed with OLD key
  const envelope = {
    version: '1.0',
    id: `msg-rotwin-${Date.now()}`,
    type: 'task.request',
    from: senderAgentId,
    to: recipientAgentId,
    subject: 'rotation-window',
    body: { test: 'old-key' },
    timestamp: new Date().toISOString(),
    ttl_sec: 3600
  };

  const oldSecret = fromBase64(oldSecretKey);
  envelope.signature = signMessage(envelope, oldSecret);

  const sendRes = await request(app)
    .post(`/api/agents/${encodeURIComponent(recipientAgentId)}/messages`)
    .send(envelope);

  assert.equal(sendRes.status, 201, 'Message with old key should be accepted during rotation window');
});

test('key rotation fails for non-seed agents', async () => {
  const agent = await registerAgent('rotate-nonseed');

  const seed = crypto.randomBytes(32);
  const seedB64 = toBase64(seed);

  const res = await request(app)
    .post(`/api/agents/${encodeURIComponent(agent.agent_id)}/rotate-key`)
    .send({ seed: seedB64, tenant_id: 'some-tenant' });

  assert.equal(res.status, 400);
  assert.ok(res.body.message.includes('seed-based') || res.body.error === 'KEY_ROTATION_FAILED');
});

test('key rotation requires valid seed matching current key', async () => {
  const seed = crypto.randomBytes(32);
  const seedB64 = toBase64(seed);
  const tenantId = `tenant-seedmatch-${Date.now()}`;
  const agentId = `seedmatch-${Date.now()}`;

  await storage.createTenant({ tenant_id: tenantId, name: tenantId, metadata: {} });

  const regRes = await request(app)
    .post('/api/agents/register')
    .send({
      agent_id: agentId,
      agent_type: 'test',
      seed: seedB64,
      tenant_id: tenantId
    });

  assert.equal(regRes.status, 201);

  // Try rotation with a DIFFERENT seed
  const wrongSeed = crypto.randomBytes(32);
  const wrongSeedB64 = toBase64(wrongSeed);

  const rotateRes = await request(app)
    .post(`/api/agents/${encodeURIComponent(agentId)}/rotate-key`)
    .send({ seed: wrongSeedB64, tenant_id: tenantId });

  assert.equal(rotateRes.status, 403);
  assert.equal(rotateRes.body.error, 'SEED_MISMATCH');
});

// ============ IDENTITY VERIFICATION TESTS ============

test('default verification tier is unverified', async () => {
  const agent = await registerAgent('identity-default');

  const res = await request(app)
    .get(`/api/agents/${encodeURIComponent(agent.agent_id)}/identity`);

  assert.equal(res.status, 200);
  assert.equal(res.body.verification_tier, 'unverified');
  assert.equal(res.body.agent_id, agent.agent_id);
});

test('GitHub linking sets tier to github', async () => {
  const agent = await registerAgent('identity-github');

  const res = await request(app)
    .post(`/api/agents/${encodeURIComponent(agent.agent_id)}/verify/github`)
    .send({ github_handle: 'octocat' });

  assert.equal(res.status, 200);
  assert.equal(res.body.verification_tier, 'github');
  assert.equal(res.body.github_handle, 'octocat');

  // Verify persisted via identity endpoint
  const identityRes = await request(app)
    .get(`/api/agents/${encodeURIComponent(agent.agent_id)}/identity`);

  assert.equal(identityRes.status, 200);
  assert.equal(identityRes.body.verification_tier, 'github');
  assert.equal(identityRes.body.github_handle, 'octocat');
});

test('cryptographic verification requires seed-based + DID', async () => {
  // Legacy agent should fail
  const legacyAgent = await registerAgent('identity-crypto-legacy');

  const legacyRes = await request(app)
    .post(`/api/agents/${encodeURIComponent(legacyAgent.agent_id)}/verify/cryptographic`)
    .send({});

  assert.equal(legacyRes.status, 400);
  assert.ok(legacyRes.body.message.includes('seed-based'));

  // Seed-based agent should succeed
  const seed = crypto.randomBytes(32);
  const tenantId = `tenant-crypto-${Date.now()}`;
  await storage.createTenant({ tenant_id: tenantId, name: tenantId, metadata: {} });

  const seedAgent = await request(app)
    .post('/api/agents/register')
    .send({
      agent_id: `crypto-verify-${Date.now()}`,
      agent_type: 'test',
      seed: toBase64(seed),
      tenant_id: tenantId
    });

  assert.equal(seedAgent.status, 201);

  const cryptoRes = await request(app)
    .post(`/api/agents/${encodeURIComponent(seedAgent.body.agent_id)}/verify/cryptographic`)
    .send({});

  assert.equal(cryptoRes.status, 200);
  assert.equal(cryptoRes.body.verification_tier, 'cryptographic');
  assert.ok(cryptoRes.body.did);
});

test('GET identity returns current status', async () => {
  const agent = await registerAgent('identity-status');

  const res = await request(app)
    .get(`/api/agents/${encodeURIComponent(agent.agent_id)}/identity`);

  assert.equal(res.status, 200);
  assert.equal(res.body.agent_id, agent.agent_id);
  assert.ok(res.body.did);
  assert.equal(res.body.registration_mode, 'legacy');
  assert.equal(res.body.verification_tier, 'unverified');
  assert.equal(res.body.key_version, 1);
  assert.ok(res.body.public_key);
});

// ============ NEGATIVE PATH TESTS ============

test('cryptographic verification fails for import-mode agents', async () => {
  const keypair = nacl.sign.keyPair();
  const pubKeyB64 = toBase64(keypair.publicKey);

  const regRes = await request(app)
    .post('/api/agents/register')
    .send({
      agent_id: `import-nocrypto-${Date.now()}`,
      agent_type: 'test',
      public_key: pubKeyB64
    });

  assert.equal(regRes.status, 201);
  assert.equal(regRes.body.registration_mode, 'import');

  const verifyRes = await request(app)
    .post(`/api/agents/${encodeURIComponent(regRes.body.agent_id)}/verify/cryptographic`)
    .send({});

  assert.equal(verifyRes.status, 400);
  assert.ok(verifyRes.body.message.includes('seed-based'));
});

test('DID document returns 404 for unknown agent', async () => {
  const res = await request(app)
    .get('/api/agents/agent%3A%2F%2Fnonexistent-did-agent/did.json');

  assert.equal(res.status, 404);
  assert.equal(res.body.error, 'AGENT_NOT_FOUND');
});

test('message with tampered signature is rejected', async () => {
  const sender = await registerAgent('tamper-sender');
  const recipient = await registerAgent('tamper-recv');

  const res = await sendSignedMessage(sender, recipient.agent_id, {
    mutateSignature: true
  });

  // Tampered signature returns 403 (invalid signature)
  assert.ok([400, 403].includes(res.status), `Expected 400 or 403, got ${res.status}`);
  assert.ok(res.body.message.toLowerCase().includes('signature'));
});

test('DID fingerprint is 32 hex chars (16 bytes)', async () => {
  const agent = await registerAgent('did-length');

  // DID format: did:seed:<32-hex-chars>
  assert.ok(agent.did.startsWith('did:seed:'));
  const fingerprint = agent.did.replace('did:seed:', '');
  assert.equal(fingerprint.length, 32, 'DID fingerprint should be 32 hex chars (16 bytes)');
});

// ============ API KEY MANAGEMENT SECURITY TESTS ============

import { requireMasterKey } from './middleware/auth.js';

test('requireApiKey master key: exact match required (case-sensitive, prefix rejected)', async () => {
  const masterKey = `test-master-timing-${Date.now()}`;
  const savedMaster = process.env.MASTER_API_KEY;
  const savedRequired = process.env.API_KEY_REQUIRED;
  process.env.MASTER_API_KEY = masterKey;
  process.env.API_KEY_REQUIRED = 'true';

  try {
    // Exact match must be accepted
    const ok = await request(app).get('/api/stats').set('x-api-key', masterKey);
    assert.equal(ok.status, 200, 'exact master key must be accepted');

    // Wrong case must be rejected (constant-time comparison is case-sensitive)
    const wrongCase = await request(app).get('/api/stats').set('x-api-key', masterKey.toUpperCase());
    assert.equal(wrongCase.status, 401, 'wrong-case key must be rejected');

    // Key prefix must be rejected (different length → different key)
    const prefix = await request(app).get('/api/stats').set('x-api-key', masterKey.slice(0, -1));
    assert.equal(prefix.status, 401, 'prefix of master key must be rejected');
  } finally {
    process.env.API_KEY_REQUIRED = savedRequired;
    process.env.MASTER_API_KEY = savedMaster;
  }
});

test('POST /api/keys/issue requires master key - rejects missing key', async () => {
  const res = await request(app)
    .post('/api/keys/issue')
    .send({ client_id: 'test-client' });

  assert.equal(res.status, 401);
  assert.equal(res.body.error, 'API_KEY_REQUIRED');
});

test('POST /api/keys/issue requires master key - rejects issued key (not master)', async () => {
  const masterKey = 'test-master-reject-issued';
  const savedMaster = process.env.MASTER_API_KEY;
  process.env.MASTER_API_KEY = masterKey;

  const issueRes = await request(app)
    .post('/api/keys/issue')
    .set('x-api-key', masterKey)
    .send({ client_id: 'client-for-reject-test' });

  assert.equal(issueRes.status, 201);
  const issuedApiKey = issueRes.body.api_key;

  // Attempt to issue ANOTHER key using the issued key — must be rejected
  const rejectRes = await request(app)
    .post('/api/keys/issue')
    .set('x-api-key', issuedApiKey)
    .send({ client_id: 'should-fail' });

  assert.equal(rejectRes.status, 401);
  assert.equal(rejectRes.body.error, 'MASTER_KEY_REQUIRED');

  process.env.MASTER_API_KEY = savedMaster;
});

test('POST /api/keys/issue issues key, raw returned once, hash stored', async () => {
  const masterKey = 'test-master-key-issue';
  const savedMaster = process.env.MASTER_API_KEY;
  process.env.MASTER_API_KEY = masterKey;

  const res = await request(app)
    .post('/api/keys/issue')
    .set('x-api-key', masterKey)
    .send({ client_id: 'integration-client', description: 'test key', expires_in_days: 30 });

  assert.equal(res.status, 201);
  assert.ok(res.body.api_key.startsWith('admp_'), 'raw key must start with admp_');
  assert.ok(res.body.warning, 'warning message must be present');
  assert.equal(res.body.client_id, 'integration-client');
  assert.ok(res.body.expires_at, 'expires_at must be set');
  assert.notEqual(res.body.key_id, res.body.api_key);

  process.env.MASTER_API_KEY = savedMaster;
});

test('GET /api/keys does not expose raw keys or hashes', async () => {
  const masterKey = 'test-master-key-list';
  const savedMaster = process.env.MASTER_API_KEY;
  process.env.MASTER_API_KEY = masterKey;

  await request(app)
    .post('/api/keys/issue')
    .set('x-api-key', masterKey)
    .send({ client_id: 'list-test-client' });

  const res = await request(app)
    .get('/api/keys')
    .set('x-api-key', masterKey);

  assert.equal(res.status, 200);
  assert.ok(Array.isArray(res.body));

  for (const key of res.body) {
    assert.ok(!('api_key' in key), 'raw key must not appear in list');
    assert.ok(!('key_hash' in key), 'key hash must not appear in list');
  }

  process.env.MASTER_API_KEY = savedMaster;
});

// Unit tests for requireApiKey middleware: issued key acceptance, revocation, expiry.
// These bypass the HTTP server because API_KEY_REQUIRED=false at server startup means
// the middleware is not mounted on the app. We test the middleware function directly.

function makeMiddlewareHarness(apiKeyHeader) {
  const req = { headers: { 'x-api-key': apiKeyHeader } };
  let statusCode;
  let body;
  const res = {
    status(code) { statusCode = code; return this; },
    json(payload) { body = payload; return this; }
  };
  let nextCalled = false;
  const next = () => { nextCalled = true; };
  return { req, res, next, getStatus: () => statusCode, getBody: () => body, wasNextCalled: () => nextCalled };
}

test('requireApiKey accepts a valid issued key (unit test)', async () => {
  const masterKey = 'test-master-issued-accept-unit';
  const savedMaster = process.env.MASTER_API_KEY;
  const savedRequired = process.env.API_KEY_REQUIRED;
  process.env.MASTER_API_KEY = masterKey;
  process.env.API_KEY_REQUIRED = 'true';

  // Issue a key via HTTP (uses the actual storage)
  const issueRes = await request(app)
    .post('/api/keys/issue')
    .set('x-api-key', masterKey)
    .send({ client_id: 'issued-key-unit-test' });

  assert.equal(issueRes.status, 201);
  const issuedApiKey = issueRes.body.api_key;

  // Call requireApiKey middleware directly
  const harness = makeMiddlewareHarness(issuedApiKey);
  await requireApiKey(harness.req, harness.res, harness.next);

  assert.equal(harness.wasNextCalled(), true, 'next() must be called for valid issued key');
  assert.equal(harness.getStatus(), undefined, 'no error status for valid issued key');

  process.env.MASTER_API_KEY = savedMaster;
  process.env.API_KEY_REQUIRED = savedRequired;
});

test('revoked issued key is rejected by requireApiKey (unit test)', async () => {
  const masterKey = 'test-master-revoke-unit';
  const savedMaster = process.env.MASTER_API_KEY;
  const savedRequired = process.env.API_KEY_REQUIRED;
  process.env.MASTER_API_KEY = masterKey;
  process.env.API_KEY_REQUIRED = 'true';

  // Issue a key via HTTP
  const issueRes = await request(app)
    .post('/api/keys/issue')
    .set('x-api-key', masterKey)
    .send({ client_id: 'revoke-unit-client' });

  assert.equal(issueRes.status, 201);
  const { api_key: issuedKey, key_id: keyId } = issueRes.body;

  // Confirm it is accepted before revocation
  const harnessOk = makeMiddlewareHarness(issuedKey);
  await requireApiKey(harnessOk.req, harnessOk.res, harnessOk.next);
  assert.equal(harnessOk.wasNextCalled(), true);

  // Revoke via HTTP
  const revokeRes = await request(app)
    .delete(`/api/keys/${keyId}`)
    .set('x-api-key', masterKey);
  assert.equal(revokeRes.status, 200);
  assert.equal(revokeRes.body.revoked, true);

  // Confirm it is rejected after revocation (401 — same as unknown key to avoid leaking existence)
  const harnessRevoked = makeMiddlewareHarness(issuedKey);
  await requireApiKey(harnessRevoked.req, harnessRevoked.res, harnessRevoked.next);
  assert.equal(harnessRevoked.wasNextCalled(), false);
  assert.equal(harnessRevoked.getStatus(), 401);
  assert.equal(harnessRevoked.getBody().error, 'INVALID_API_KEY');

  process.env.MASTER_API_KEY = savedMaster;
  process.env.API_KEY_REQUIRED = savedRequired;
});

test('expired issued key is rejected with INVALID_API_KEY (unit test)', async () => {
  // NOTE: expires_in_days: 0 would be falsy in keys.js and set expires_at=null.
  // Instead we directly insert a key record with a past expires_at into storage.
  const { randomBytes } = crypto;
  const savedRequired = process.env.API_KEY_REQUIRED;
  process.env.API_KEY_REQUIRED = 'true';

  const rawKey = `admp_${randomBytes(32).toString('hex')}`;
  // Use hashApiKey (not raw crypto) so this test stays correct if the hash
  // algorithm ever changes (e.g. prefix or HMAC).
  const keyHash = hashApiKey(rawKey);
  const keyId = `test-expired-key-${Date.now()}`;

  await storage.createIssuedKey({
    key_id: keyId,
    key_hash: keyHash,
    client_id: 'expire-test-direct',
    description: '',
    created_at: Date.now() - 10000,
    expires_at: Date.now() - 1,  // already expired
    revoked: false
  });

  const harness = makeMiddlewareHarness(rawKey);
  await requireApiKey(harness.req, harness.res, harness.next);

  assert.equal(harness.wasNextCalled(), false);
  assert.equal(harness.getStatus(), 401);
  assert.equal(harness.getBody().error, 'INVALID_API_KEY');

  process.env.API_KEY_REQUIRED = savedRequired;
});

test('DELETE /api/keys/:keyId returns 404 for unknown key', async () => {
  const masterKey = 'test-master-del-404';
  const savedMaster = process.env.MASTER_API_KEY;
  process.env.MASTER_API_KEY = masterKey;

  const res = await request(app)
    .delete('/api/keys/nonexistent-key-id')
    .set('x-api-key', masterKey);

  assert.equal(res.status, 404);
  assert.equal(res.body.error, 'KEY_NOT_FOUND');

  process.env.MASTER_API_KEY = savedMaster;
});

// ===== MAJOR: double-middleware chain unit test =====
// The global requireApiKey middleware is only mounted when API_KEY_REQUIRED=true at server
// startup, so the full HTTP chain cannot be exercised via supertest in the test suite.
// Instead we call both middleware functions directly in sequence to verify:
//   1. requireApiKey calls next() for a valid issued key (accepts it)
//   2. requireMasterKey then rejects the same key with 401 MASTER_KEY_REQUIRED
test('requireApiKey passes issued key through; requireMasterKey then rejects with MASTER_KEY_REQUIRED (unit chain test)', async () => {
  const masterKey = 'test-master-chain-unit';
  const savedMaster = process.env.MASTER_API_KEY;
  const savedRequired = process.env.API_KEY_REQUIRED;
  process.env.MASTER_API_KEY = masterKey;

  // Issue a key while master key is configured (API_KEY_REQUIRED is false so no global gating)
  const issueRes = await request(app)
    .post('/api/keys/issue')
    .set('x-api-key', masterKey)
    .send({ client_id: 'chain-unit-client' });

  assert.equal(issueRes.status, 201);
  const issuedKey = issueRes.body.api_key;

  // Set API_KEY_REQUIRED=true so requireApiKey enforces key checks
  process.env.API_KEY_REQUIRED = 'true';

  // Step 1: call requireApiKey directly — must accept the issued key and call next()
  const req = { headers: { 'x-api-key': issuedKey } };
  let step1Status;
  const res1 = {
    status(code) { step1Status = code; return this; },
    json() { return this; }
  };
  let nextCalledByRequireApiKey = false;
  await requireApiKey(req, res1, () => { nextCalledByRequireApiKey = true; });

  assert.equal(nextCalledByRequireApiKey, true, 'requireApiKey must call next() for a valid issued key');
  assert.equal(step1Status, undefined, 'requireApiKey must not set an error status for a valid issued key');

  // Step 2: call requireMasterKey on the same req — must reject with 401 MASTER_KEY_REQUIRED
  // (because the issued key is not the master key)
  let step2Status;
  let step2Body;
  const res2 = {
    status(code) { step2Status = code; return this; },
    json(payload) { step2Body = payload; return this; }
  };
  requireMasterKey(req, res2, () => {
    assert.fail('requireMasterKey must NOT call next() for an issued key');
  });

  assert.equal(step2Status, 401, 'requireMasterKey must return 401 for an issued key');
  assert.equal(step2Body.error, 'MASTER_KEY_REQUIRED', 'error code must be MASTER_KEY_REQUIRED');

  process.env.MASTER_API_KEY = savedMaster;
  process.env.API_KEY_REQUIRED = savedRequired;
});

// ===== MAJOR: missing MASTER_API_KEY with API_KEY_REQUIRED=true =====
// When MASTER_API_KEY is not configured, requireApiKey must still accept
// valid issued keys via the hash lookup path.
test('issued key authenticates when MASTER_API_KEY is not set but API_KEY_REQUIRED=true', async () => {
  const masterKey = 'test-master-no-master-env';
  const savedMaster = process.env.MASTER_API_KEY;
  const savedRequired = process.env.API_KEY_REQUIRED;
  process.env.MASTER_API_KEY = masterKey;

  // Issue a key while master key is configured
  const issueRes = await request(app)
    .post('/api/keys/issue')
    .set('x-api-key', masterKey)
    .send({ client_id: 'no-master-env-client' });

  assert.equal(issueRes.status, 201);
  const issuedKey = issueRes.body.api_key;

  // Now unset MASTER_API_KEY and set API_KEY_REQUIRED=true
  delete process.env.MASTER_API_KEY;
  process.env.API_KEY_REQUIRED = 'true';

  // The issued key must be accepted by requireApiKey via issued-key hash path
  const harness = makeMiddlewareHarness(issuedKey);
  await requireApiKey(harness.req, harness.res, harness.next);

  assert.equal(harness.wasNextCalled(), true, 'issued key must authenticate even when MASTER_API_KEY is unset');
  assert.equal(harness.getStatus(), undefined, 'no error status expected');

  process.env.MASTER_API_KEY = savedMaster;
  process.env.API_KEY_REQUIRED = savedRequired;
});

// ===== MINOR: client_id format validation =====
test('POST /api/keys/issue rejects invalid client_id format', async () => {
  const masterKey = 'test-master-client-id-validation';
  const savedMaster = process.env.MASTER_API_KEY;
  process.env.MASTER_API_KEY = masterKey;

  // Empty string
  const emptyRes = await request(app)
    .post('/api/keys/issue')
    .set('x-api-key', masterKey)
    .send({ client_id: '' });
  assert.equal(emptyRes.status, 400, 'empty client_id must be rejected');
  assert.equal(emptyRes.body.error, 'INVALID_CLIENT_ID');

  // client_id with invalid characters (spaces)
  const invalidCharsRes = await request(app)
    .post('/api/keys/issue')
    .set('x-api-key', masterKey)
    .send({ client_id: 'invalid client id' });
  assert.equal(invalidCharsRes.status, 400, 'client_id with spaces must be rejected');
  assert.equal(invalidCharsRes.body.error, 'INVALID_CLIENT_ID');

  // client_id exceeding 100 chars
  const longId = 'a'.repeat(101);
  const longRes = await request(app)
    .post('/api/keys/issue')
    .set('x-api-key', masterKey)
    .send({ client_id: longId });
  assert.equal(longRes.status, 400, 'client_id over 100 chars must be rejected');
  assert.equal(longRes.body.error, 'INVALID_CLIENT_ID');

  // Valid client_id with hyphens and underscores must pass validation
  const validRes = await request(app)
    .post('/api/keys/issue')
    .set('x-api-key', masterKey)
    .send({ client_id: 'valid-client_123' });
  assert.equal(validRes.status, 201, 'valid client_id must be accepted');

  process.env.MASTER_API_KEY = savedMaster;
});


// ===== MINOR: numeric-only client_id is intentionally permitted =====
// The CLIENT_ID_PATTERN (/^[a-zA-Z0-9_-]+$/) accepts numeric-only strings.
// This is by design: client_id is an opaque integration label with no
// requirement for a leading letter. Callers may use numeric tenant IDs.
test('POST /api/keys/issue accepts numeric-only client_id (intentional design)', async () => {
  const masterKey = 'test-master-numeric-client-id';
  const savedMaster = process.env.MASTER_API_KEY;
  process.env.MASTER_API_KEY = masterKey;

  const res = await request(app)
    .post('/api/keys/issue')
    .set('x-api-key', masterKey)
    .send({ client_id: '12345' });

  assert.equal(res.status, 201, 'numeric-only client_id must be accepted (201 Created)');
  assert.equal(res.body.client_id, '12345', 'returned client_id must match submitted value');

  process.env.MASTER_API_KEY = savedMaster;
});

// ============ AGENT TRUST MODEL TESTS ============

test('trust model: registration is exempt from API key when API_KEY_REQUIRED=true', async () => {
  const savedRequired = process.env.API_KEY_REQUIRED;
  const savedMaster = process.env.MASTER_API_KEY;
  process.env.API_KEY_REQUIRED = 'true';
  process.env.MASTER_API_KEY = 'test-master-exempt';

  try {
    const suffix = `${Date.now()}-exempt`;
    const res = await request(app)
      .post('/api/agents/register')
      .send({ agent_id: `exempt-test-${suffix}`, agent_type: 'test' });
    // No X-API-Key header — should succeed
    assert.equal(res.status, 201, 'register must succeed without API key even when API_KEY_REQUIRED=true');
    assert.ok(res.body.agent_id);
  } finally {
    process.env.API_KEY_REQUIRED = savedRequired;
    process.env.MASTER_API_KEY = savedMaster;
  }
});

test('trust model: other endpoints require API key when API_KEY_REQUIRED=true', async () => {
  const savedRequired = process.env.API_KEY_REQUIRED;
  const savedMaster = process.env.MASTER_API_KEY;
  process.env.API_KEY_REQUIRED = 'true';
  process.env.MASTER_API_KEY = 'test-master-gate';

  try {
    const res = await request(app)
      .get('/api/stats');
    // No X-API-Key header — should be blocked
    assert.equal(res.status, 401, '/api/stats must require API key when API_KEY_REQUIRED=true');
  } finally {
    process.env.API_KEY_REQUIRED = savedRequired;
    process.env.MASTER_API_KEY = savedMaster;
  }
});

test('trust model: single-use enrollment token burns on first use', async () => {
  const masterKey = `test-master-singleuse-${Date.now()}`;
  const savedMaster = process.env.MASTER_API_KEY;
  const savedRequired = process.env.API_KEY_REQUIRED;
  process.env.MASTER_API_KEY = masterKey;
  process.env.API_KEY_REQUIRED = 'true';

  try {
    // Issue a single-use token
    const issueRes = await request(app)
      .post('/api/keys/issue')
      .set('x-api-key', masterKey)
      .send({ client_id: 'enrollment-client', single_use: true });
    assert.equal(issueRes.status, 201);
    assert.equal(issueRes.body.single_use, true);
    const token = issueRes.body.api_key;

    // First use — register an agent (exempted route — single-use doesn't matter here)
    // Use token on a non-registration API endpoint
    const statsRes1 = await request(app)
      .get('/api/stats')
      .set('x-api-key', token);
    assert.equal(statsRes1.status, 200, 'first use should succeed');

    // Second use — should be rejected
    const statsRes2 = await request(app)
      .get('/api/stats')
      .set('x-api-key', token);
    assert.equal(statsRes2.status, 403, 'second use should be rejected');
    assert.equal(statsRes2.body.error, 'ENROLLMENT_TOKEN_USED');
  } finally {
    process.env.MASTER_API_KEY = savedMaster;
    process.env.API_KEY_REQUIRED = savedRequired;
  }
});

test('trust model: single-use token scope enforcement', async () => {
  const masterKey = `test-master-scope-${Date.now()}`;
  const savedMaster = process.env.MASTER_API_KEY;
  const savedRequired = process.env.API_KEY_REQUIRED;
  process.env.MASTER_API_KEY = masterKey;
  process.env.API_KEY_REQUIRED = 'true';

  try {
    const suffix = `${Date.now()}-scope`;
    // Register two agents without auth key (exempt)
    const regA = await request(app)
      .post('/api/agents/register')
      .send({ agent_id: `scope-a-${suffix}`, agent_type: 'test' });
    assert.equal(regA.status, 201);

    const regB = await request(app)
      .post('/api/agents/register')
      .send({ agent_id: `scope-b-${suffix}`, agent_type: 'test' });
    assert.equal(regB.status, 201);

    const agentA = regA.body.agent_id;
    const agentB = regB.body.agent_id;

    // Issue a token scoped to agentA
    const issueRes = await request(app)
      .post('/api/keys/issue')
      .set('x-api-key', masterKey)
      .send({ client_id: 'scope-client', single_use: false, target_agent_id: agentA });
    assert.equal(issueRes.status, 201);
    const token = issueRes.body.api_key;

    // Access agentA endpoint — should succeed
    const resA = await request(app)
      .get(`/api/agents/${encodeURIComponent(agentA)}`)
      .set('x-api-key', token)
      .set('x-agent-id', agentA);
    assert.equal(resA.status, 200, 'scoped token must work for target agent');

    // Access agentB endpoint — should be rejected
    const resB = await request(app)
      .get(`/api/agents/${encodeURIComponent(agentB)}`)
      .set('x-api-key', token)
      .set('x-agent-id', agentB);
    assert.equal(resB.status, 403, 'scoped token must be rejected for other agents');
    assert.equal(resB.body.error, 'ENROLLMENT_TOKEN_SCOPE');
  } finally {
    process.env.MASTER_API_KEY = savedMaster;
    process.env.API_KEY_REQUIRED = savedRequired;
  }
});

test('trust model: open tenant policy → agent approved immediately', async () => {
  const tenantId = `tenant-open-${Date.now()}`;
  await storage.createTenant({ tenant_id: tenantId, name: tenantId, registration_policy: 'open', metadata: {} });

  const suffix = `${Date.now()}`;
  const res = await request(app)
    .post('/api/agents/register')
    .send({ agent_id: `open-policy-${suffix}`, agent_type: 'test', tenant_id: tenantId });

  assert.equal(res.status, 201);
  assert.equal(res.body.registration_status, 'approved', 'open policy should approve immediately');
});

test('trust model: approval_required tenant policy → agent starts pending', async () => {
  const tenantId = `tenant-approval-${Date.now()}`;
  await storage.createTenant({ tenant_id: tenantId, name: tenantId, registration_policy: 'approval_required', metadata: {} });

  const suffix = `${Date.now()}`;
  const res = await request(app)
    .post('/api/agents/register')
    .send({ agent_id: `pending-${suffix}`, agent_type: 'test', tenant_id: tenantId });

  assert.equal(res.status, 201);
  assert.equal(res.body.registration_status, 'pending', 'approval_required policy should set status to pending');
});

test('trust model: pending agent is blocked from API access', async () => {
  const tenantId = `tenant-block-${Date.now()}`;
  await storage.createTenant({ tenant_id: tenantId, name: tenantId, registration_policy: 'approval_required', metadata: {} });

  const suffix = `${Date.now()}`;
  const regRes = await request(app)
    .post('/api/agents/register')
    .send({ agent_id: `blocked-${suffix}`, agent_type: 'test', tenant_id: tenantId });
  assert.equal(regRes.status, 201);
  assert.equal(regRes.body.registration_status, 'pending');

  const agentId = regRes.body.agent_id;

  // Try heartbeat — should be blocked
  const hbRes = await request(app)
    .post(`/api/agents/${encodeURIComponent(agentId)}/heartbeat`)
    .set('x-agent-id', agentId)
    .send({});
  assert.equal(hbRes.status, 403);
  assert.equal(hbRes.body.error, 'REGISTRATION_PENDING');
});

test('trust model: approve pending agent → becomes accessible', async () => {
  const masterKey = `test-master-approve-${Date.now()}`;
  const savedMaster = process.env.MASTER_API_KEY;
  process.env.MASTER_API_KEY = masterKey;

  const tenantId = `tenant-approve-${Date.now()}`;
  await storage.createTenant({ tenant_id: tenantId, name: tenantId, registration_policy: 'approval_required', metadata: {} });

  try {
    const suffix = `${Date.now()}`;
    const regRes = await request(app)
      .post('/api/agents/register')
      .send({ agent_id: `to-approve-${suffix}`, agent_type: 'test', tenant_id: tenantId });
    assert.equal(regRes.status, 201);
    const agentId = regRes.body.agent_id;

    // Approve it
    const approveRes = await request(app)
      .post(`/api/agents/${encodeURIComponent(agentId)}/approve`)
      .set('x-api-key', masterKey);
    assert.equal(approveRes.status, 200);
    assert.equal(approveRes.body.registration_status, 'approved');

    // Now heartbeat should work
    const hbRes = await request(app)
      .post(`/api/agents/${encodeURIComponent(agentId)}/heartbeat`)
      .set('x-agent-id', agentId)
      .send({});
    assert.equal(hbRes.status, 200, 'approved agent should be accessible');
  } finally {
    process.env.MASTER_API_KEY = savedMaster;
  }
});

test('trust model: reject agent → returns REGISTRATION_REJECTED error', async () => {
  const masterKey = `test-master-reject-${Date.now()}`;
  const savedMaster = process.env.MASTER_API_KEY;
  process.env.MASTER_API_KEY = masterKey;

  const tenantId = `tenant-reject-${Date.now()}`;
  await storage.createTenant({ tenant_id: tenantId, name: tenantId, registration_policy: 'approval_required', metadata: {} });

  try {
    const suffix = `${Date.now()}`;
    const regRes = await request(app)
      .post('/api/agents/register')
      .send({ agent_id: `to-reject-${suffix}`, agent_type: 'test', tenant_id: tenantId });
    assert.equal(regRes.status, 201);
    const agentId = regRes.body.agent_id;

    // Reject it
    const rejectRes = await request(app)
      .post(`/api/agents/${encodeURIComponent(agentId)}/reject`)
      .set('x-api-key', masterKey)
      .send({ reason: 'Spam agent' });
    assert.equal(rejectRes.status, 200);
    assert.equal(rejectRes.body.registration_status, 'rejected');
    assert.equal(rejectRes.body.rejection_reason, 'Spam agent');

    // Heartbeat should return REGISTRATION_REJECTED
    const hbRes = await request(app)
      .post(`/api/agents/${encodeURIComponent(agentId)}/heartbeat`)
      .set('x-agent-id', agentId)
      .send({});
    assert.equal(hbRes.status, 403);
    assert.equal(hbRes.body.error, 'REGISTRATION_REJECTED');
  } finally {
    process.env.MASTER_API_KEY = savedMaster;
  }
});

test('trust model: pending list endpoint returns correct subset', async () => {
  const masterKey = `test-master-pending-list-${Date.now()}`;
  const savedMaster = process.env.MASTER_API_KEY;
  process.env.MASTER_API_KEY = masterKey;

  const tenantId = `tenant-list-${Date.now()}`;
  await storage.createTenant({ tenant_id: tenantId, name: tenantId, registration_policy: 'approval_required', metadata: {} });

  try {
    const suffix = Date.now();
    // Register two pending agents in the tenant
    const reg1 = await request(app)
      .post('/api/agents/register')
      .send({ agent_id: `list-pending-1-${suffix}`, agent_type: 'test', tenant_id: tenantId });
    assert.equal(reg1.status, 201);

    const reg2 = await request(app)
      .post('/api/agents/register')
      .send({ agent_id: `list-pending-2-${suffix}`, agent_type: 'test', tenant_id: tenantId });
    assert.equal(reg2.status, 201);

    // Register one approved (different tenant — no policy)
    const reg3 = await request(app)
      .post('/api/agents/register')
      .send({ agent_id: `list-approved-${suffix}`, agent_type: 'test' });
    assert.equal(reg3.status, 201);

    // Fetch pending list
    const listRes = await request(app)
      .get(`/api/agents/tenants/${tenantId}/pending`)
      .set('x-api-key', masterKey);
    assert.equal(listRes.status, 200);
    const ids = listRes.body.agents.map(a => a.agent_id);
    assert.ok(ids.includes(reg1.body.agent_id), 'pending agent 1 must be in list');
    assert.ok(ids.includes(reg2.body.agent_id), 'pending agent 2 must be in list');
    assert.ok(!ids.includes(reg3.body.agent_id), 'approved agent must NOT be in pending list');
    // Ensure no secret keys are exposed
    for (const a of listRes.body.agents) {
      assert.equal(a.secret_key, undefined, 'secret_key must not be in pending list response');
    }
  } finally {
    process.env.MASTER_API_KEY = savedMaster;
  }
});

test('trust model: existing agents without registration_status are treated as approved', async () => {
  // Simulate a legacy agent (no registration_status field)
  const agentId = `legacy-no-status-${Date.now()}`;
  await storage.createAgent({
    agent_id: agentId,
    agent_type: 'test',
    public_key: 'fake-key',
    heartbeat: { last_heartbeat: Date.now(), status: 'online', interval_ms: 60000, timeout_ms: 300000 },
    trusted_agents: [],
    blocked_agents: []
    // No registration_status field
  });

  const hbRes = await request(app)
    .post(`/api/agents/${encodeURIComponent(agentId)}/heartbeat`)
    .set('x-agent-id', agentId)
    .send({});
  // Should NOT be blocked — absence of registration_status means approved
  assert.notEqual(hbRes.status, 403, 'legacy agent without registration_status must not be blocked');
});

test('trust model: DID web — shadow agent created from DID document', async () => {
  const domain = `did-web-${Date.now()}.example.com`;
  const did = `did:web:${domain}`;
  const shadowAgentId = `did-web:${domain}`;
  const keypair = nacl.sign.keyPair();
  const pubKeyB64 = toBase64(keypair.publicKey);

  // Build a minimal DID document using publicKeyBase64 format
  const didDoc = {
    '@context': ['https://www.w3.org/ns/did/v1'],
    id: did,
    verificationMethod: [{
      id: `${did}#key-1`,
      type: 'Ed25519VerificationKey2020',
      controller: did,
      publicKeyBase64: pubKeyB64
    }]
  };

  const originalFetch = globalThis.fetch;
  const didDocUrl = `https://${domain}/.well-known/did.json`;
  globalThis.fetch = async (url, init) => {
    if (url === didDocUrl) {
      const body = JSON.stringify(didDoc);
      return { ok: true, json: async () => didDoc, text: async () => body, headers: new Map([['content-length', String(Buffer.byteLength(body))]]) };
    }
    return originalFetch ? originalFetch(url, init) : Promise.reject(new Error('no fetch'));
  };

  // DID:web auto-approval requires the domain to be in the allowlist
  const savedAllowedDomains = process.env.DID_WEB_ALLOWED_DOMAINS;
  process.env.DID_WEB_ALLOWED_DOMAINS = domain;

  try {
    // Use heartbeat endpoint which runs authenticateHttpSignature middleware
    const targetPath = `/api/agents/${encodeURIComponent(shadowAgentId)}/heartbeat`;
    const dateStr = new Date().toUTCString();
    const headers = { host: '127.0.0.1', date: dateStr };
    const signatureHeader = signRequest('POST', targetPath, headers, keypair.secretKey, did);

    const res = await request(app)
      .post(targetPath)
      .set('Host', headers.host)
      .set('Signature', signatureHeader)
      .set('Date', dateStr)
      .send({});

    // Auth should succeed; status 200 or 400 from heartbeat handler, not 401/403
    assert.notEqual(res.status, 401, 'DID web auth should not return 401');
    assert.notEqual(res.status, 403, `DID web auth should not return 403 (got: ${JSON.stringify(res.body)})`);

    // Verify shadow agent was persisted
    const shadowAgent = await storage.getAgentByDid(did);
    assert.ok(shadowAgent, 'shadow agent must be created for did:web');
    assert.equal(shadowAgent.registration_mode, 'did-web');
    assert.equal(shadowAgent.registration_status, 'approved', 'allowed domain should be auto-approved');
  } finally {
    globalThis.fetch = originalFetch;
    if (savedAllowedDomains !== undefined) process.env.DID_WEB_ALLOWED_DOMAINS = savedAllowedDomains;
    else delete process.env.DID_WEB_ALLOWED_DOMAINS;
  }
});

test('trust model: DID web — deduplication: same DID resolves to existing shadow agent', async () => {
  const domain = `did-web-dedup-${Date.now()}.example.com`;
  const did = `did:web:${domain}`;
  const shadowAgentId = `did-web:${domain}`;
  const keypair = nacl.sign.keyPair();
  const pubKeyB64 = toBase64(keypair.publicKey);

  const didDoc = {
    '@context': ['https://www.w3.org/ns/did/v1'],
    id: did,
    verificationMethod: [{
      id: `${did}#key-1`,
      type: 'Ed25519VerificationKey2020',
      controller: did,
      publicKeyBase64: pubKeyB64
    }]
  };

  const originalFetch = globalThis.fetch;
  const didDocUrlDedup = `https://${domain}/.well-known/did.json`;
  globalThis.fetch = async (url, init) => {
    if (url === didDocUrlDedup) {
      const body = JSON.stringify(didDoc);
      return { ok: true, json: async () => didDoc, text: async () => body, headers: new Map([['content-length', String(Buffer.byteLength(body))]]) };
    }
    return originalFetch ? originalFetch(url, init) : Promise.reject(new Error('no fetch'));
  };

  try {
    const targetPath = `/api/agents/${encodeURIComponent(shadowAgentId)}/heartbeat`;
    const dateStr = new Date().toUTCString();
    const headers = { host: '127.0.0.1', date: dateStr };
    const sigHeader = signRequest('POST', targetPath, headers, keypair.secretKey, did);

    // First request: creates shadow agent
    await request(app).post(targetPath).set('Host', headers.host).set('Signature', sigHeader).set('Date', dateStr).send({});

    const agent1 = await storage.getAgentByDid(did);
    assert.ok(agent1, 'shadow agent must exist after first request');

    // Second request: should reuse existing agent (not create duplicate)
    await request(app).post(targetPath).set('Host', headers.host).set('Signature', sigHeader).set('Date', dateStr).send({});

    const agent2 = await storage.getAgentByDid(did);
    assert.equal(agent1.agent_id, agent2.agent_id, 'shadow agent must be deduplicated');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('trust model: DID web — fetch failure → rejected at global gate (fail closed)', async () => {
  const domain = `did-web-unreachable-${Date.now()}.example.com`;
  const did = `did:web:${domain}`;
  const shadowAgentId = `did-web:${domain}`;

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error('Network unreachable');
  };

  try {
    // Sign some content (invalid signature but DID resolution fails first anyway)
    const sigHeader = `keyId="${did}",algorithm="ed25519",headers="(request-target) host date",signature="invalidsig"`;
    const targetPath = `/api/agents/${encodeURIComponent(shadowAgentId)}/heartbeat`;

    const res = await request(app)
      .post(targetPath)
      .set('Signature', sigHeader)
      .set('Date', new Date().toUTCString())
      .set('Host', '127.0.0.1')
      .send({});

    // After Fix 1: invalid/unverifiable signature is rejected at the global gate
    // with 401 instead of falling through to route-level auth (404).
    // The system still fails closed — the request is denied.
    assert.equal(res.status, 401, 'failed DID fetch must be rejected (fail closed)');
    assert.equal(res.body.error, 'SIGNATURE_INVALID');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('trust model: DID web — approval_required policy → shadow agent starts pending', async () => {
  const domain = `did-web-pending-${Date.now()}.example.com`;
  const did = `did:web:${domain}`;
  const shadowAgentId = `did-web:${domain}`;
  const keypair = nacl.sign.keyPair();
  const pubKeyB64 = toBase64(keypair.publicKey);

  const didDoc = {
    '@context': ['https://www.w3.org/ns/did/v1'],
    id: did,
    verificationMethod: [{
      id: `${did}#key-1`,
      type: 'Ed25519VerificationKey2020',
      controller: did,
      publicKeyBase64: pubKeyB64
    }]
  };

  const originalFetch = globalThis.fetch;
  const didDocUrl = `https://${domain}/.well-known/did.json`;
  globalThis.fetch = async (url, init) => {
    if (url === didDocUrl) {
      const body = JSON.stringify(didDoc);
      return { ok: true, json: async () => didDoc, text: async () => body, headers: new Map([['content-length', String(Buffer.byteLength(body))]]) };
    }
    return originalFetch ? originalFetch(url, init) : Promise.reject(new Error('no fetch'));
  };

  const savedPolicy = process.env.REGISTRATION_POLICY;
  process.env.REGISTRATION_POLICY = 'approval_required';

  try {
    const targetPath = `/api/agents/${encodeURIComponent(shadowAgentId)}/heartbeat`;
    const dateStr = new Date().toUTCString();
    const headers = { host: '127.0.0.1', date: dateStr };
    const signatureHeader = signRequest('POST', targetPath, headers, keypair.secretKey, did);

    const res = await request(app)
      .post(targetPath)
      .set('Host', headers.host)
      .set('Signature', signatureHeader)
      .set('Date', dateStr)
      .send({});

    // S2 fix: pending DID:web agents now get an actionable 403 REGISTRATION_PENDING
    // instead of a misleading 401 SIGNATURE_INVALID. The global gate propagates
    // the specific reason from verifyHttpSignatureOnly so agents know to wait
    // for approval rather than debugging their signature implementation.
    assert.equal(res.status, 403, `Expected 403 REGISTRATION_PENDING, got ${res.status}: ${JSON.stringify(res.body)}`);
    assert.equal(res.body.error, 'REGISTRATION_PENDING');

    // Shadow agent should be persisted with pending status
    const shadowAgent = await storage.getAgentByDid(did);
    assert.ok(shadowAgent, 'shadow agent must be created even when pending');
    assert.equal(shadowAgent.registration_status, 'pending');
    assert.equal(shadowAgent.registration_mode, 'did-web');
  } finally {
    globalThis.fetch = originalFetch;
    if (savedPolicy !== undefined) process.env.REGISTRATION_POLICY = savedPolicy;
    else delete process.env.REGISTRATION_POLICY;
  }
});

test('trust model: scoped enrollment token — rejects when target_agent_id does not exist', async () => {
  const masterKey = `test-master-scope-validation-${Date.now()}`;
  const savedMaster = process.env.MASTER_API_KEY;
  const savedRequired = process.env.API_KEY_REQUIRED;
  process.env.MASTER_API_KEY = masterKey;
  process.env.API_KEY_REQUIRED = 'true';

  try {
    const nonExistentAgentId = `nonexistent-${Date.now()}`;

    const res = await request(app)
      .post('/api/keys/issue')
      .set('x-api-key', masterKey)
      .send({
        client_id: `scope-test-${Date.now()}`,
        single_use: true,
        target_agent_id: nonExistentAgentId
      });

    assert.equal(res.status, 400, `Expected 400 AGENT_NOT_FOUND, got ${res.status}: ${JSON.stringify(res.body)}`);
    assert.equal(res.body.error, 'AGENT_NOT_FOUND', 'Should reject issuance when target agent does not exist');
  } finally {
    process.env.MASTER_API_KEY = savedMaster;
    process.env.API_KEY_REQUIRED = savedRequired;
  }
});

test('trust model: reject is idempotent — second rejection returns success', async () => {
  const masterKey = `test-master-reject-idem-${Date.now()}`;
  const savedMaster = process.env.MASTER_API_KEY;
  const savedRequired = process.env.API_KEY_REQUIRED;
  process.env.MASTER_API_KEY = masterKey;
  process.env.API_KEY_REQUIRED = 'true';

  try {
    const tenantId = `tenant-reject-idem-${Date.now()}`;
    await storage.createTenant({ tenant_id: tenantId, name: tenantId, registration_policy: 'approval_required', metadata: {} });

    const regRes = await request(app)
      .post('/api/agents/register')
      .send({ agent_id: `reject-idem-${Date.now()}`, tenant_id: tenantId });
    assert.equal(regRes.status, 201);
    const agentId = regRes.body.agent_id;

    // First rejection
    const res1 = await request(app)
      .post(`/api/agents/${encodeURIComponent(agentId)}/reject`)
      .set('x-api-key', masterKey)
      .send({ reason: 'test reason' });
    assert.equal(res1.status, 200, `First rejection should succeed: ${JSON.stringify(res1.body)}`);
    assert.equal(res1.body.registration_status, 'rejected');

    // Second rejection — must not throw, must return 200
    const res2 = await request(app)
      .post(`/api/agents/${encodeURIComponent(agentId)}/reject`)
      .set('x-api-key', masterKey)
      .send({ reason: 'retry' });
    assert.equal(res2.status, 200, `Idempotent second rejection should succeed: ${JSON.stringify(res2.body)}`);
    assert.equal(res2.body.registration_status, 'rejected');
  } finally {
    process.env.MASTER_API_KEY = savedMaster;
    process.env.API_KEY_REQUIRED = savedRequired;
  }
});

test('key issuance: expires_in_days: 0 returns 400', async () => {
  const masterKey = `test-master-exp-zero-${Date.now()}`;
  const savedMaster = process.env.MASTER_API_KEY;
  const savedRequired = process.env.API_KEY_REQUIRED;
  process.env.MASTER_API_KEY = masterKey;
  process.env.API_KEY_REQUIRED = 'true';

  try {
    const res = await request(app)
      .post('/api/keys/issue')
      .set('x-api-key', masterKey)
      .send({ client_id: `expire-zero-${Date.now()}`, expires_in_days: 0 });

    assert.equal(res.status, 400, `expires_in_days: 0 should be rejected: ${JSON.stringify(res.body)}`);
    assert.equal(res.body.error, 'INVALID_EXPIRES_IN_DAYS');
  } finally {
    process.env.MASTER_API_KEY = savedMaster;
    process.env.API_KEY_REQUIRED = savedRequired;
  }
});

test('trust model: approve is idempotent — second approval returns success', async () => {
  const masterKey = `test-master-idempotent-${Date.now()}`;
  const savedMaster = process.env.MASTER_API_KEY;
  const savedRequired = process.env.API_KEY_REQUIRED;
  process.env.MASTER_API_KEY = masterKey;
  process.env.API_KEY_REQUIRED = 'true';

  try {
    const tenantId = `tenant-idempotent-${Date.now()}`;
    await storage.createTenant({ tenant_id: tenantId, name: tenantId, registration_policy: 'approval_required', metadata: {} });

    const regRes = await request(app)
      .post('/api/agents/register')
      .send({ agent_id: `idem-test-${Date.now()}`, tenant_id: tenantId });

    assert.equal(regRes.status, 201);
    const agentId = regRes.body.agent_id;

    // First approval
    const res1 = await request(app)
      .post(`/api/agents/${encodeURIComponent(agentId)}/approve`)
      .set('x-api-key', masterKey);
    assert.equal(res1.status, 200, `First approval should succeed: ${JSON.stringify(res1.body)}`);
    assert.equal(res1.body.registration_status, 'approved');

    // Second approval — must not throw, must return 200
    const res2 = await request(app)
      .post(`/api/agents/${encodeURIComponent(agentId)}/approve`)
      .set('x-api-key', masterKey);
    assert.equal(res2.status, 200, `Idempotent second approval should succeed: ${JSON.stringify(res2.body)}`);
    assert.equal(res2.body.registration_status, 'approved');
  } finally {
    process.env.MASTER_API_KEY = savedMaster;
    process.env.API_KEY_REQUIRED = savedRequired;
  }
});

test('trust model: tenant creation accepts registration_policy field', async () => {
  const masterKey = `test-master-tenant-policy-${Date.now()}`;
  const savedMaster = process.env.MASTER_API_KEY;
  const savedRequired = process.env.API_KEY_REQUIRED;
  process.env.MASTER_API_KEY = masterKey;
  process.env.API_KEY_REQUIRED = 'true';

  try {
    const tenantId = `tenant-policy-test-${Date.now()}`;
    const res = await request(app)
      .post('/api/agents/tenants')
      .set('x-api-key', masterKey)
      .send({ tenant_id: tenantId, name: 'Policy Test', registration_policy: 'approval_required' });

    assert.equal(res.status, 201);
    assert.equal(res.body.registration_policy, 'approval_required');
  } finally {
    process.env.MASTER_API_KEY = savedMaster;
    process.env.API_KEY_REQUIRED = savedRequired;
  }
});

test('trust model: tenant creation rejects invalid registration_policy', async () => {
  const masterKey = `test-master-bad-policy-${Date.now()}`;
  const savedMaster = process.env.MASTER_API_KEY;
  const savedRequired = process.env.API_KEY_REQUIRED;
  process.env.MASTER_API_KEY = masterKey;
  process.env.API_KEY_REQUIRED = 'true';

  try {
    const tenantId = `tenant-bad-policy-${Date.now()}`;
    const res = await request(app)
      .post('/api/agents/tenants')
      .set('x-api-key', masterKey)
      .send({ tenant_id: tenantId, registration_policy: 'unsupported_value' });

    assert.equal(res.status, 400);
    assert.equal(res.body.error, 'INVALID_REGISTRATION_POLICY');
  } finally {
    process.env.MASTER_API_KEY = savedMaster;
    process.env.API_KEY_REQUIRED = savedRequired;
  }
});

// ============ SECURITY FIX TESTS ============

// --- Fix 1: Reject invalid signatures (don't fall through to API key) ---

test('Fix1: invalid Signature header returns 401 even when valid API key present', async () => {
  const savedRequired = process.env.API_KEY_REQUIRED;
  const savedMaster = process.env.MASTER_API_KEY;
  process.env.API_KEY_REQUIRED = 'true';
  process.env.MASTER_API_KEY = 'test-master-key-fix1';

  try {
    const agent = await registerAgent('fix1-bad-sig');
    const agentId = agent.agent_id;
    const path = `/api/agents/${encodeURIComponent(agentId)}`;

    // Create a bogus signature with a different key
    const bogusKeyPair = nacl.sign.keyPair();
    const headers = {
      host: '127.0.0.1',
      date: new Date().toUTCString()
    };
    const sigHeader = signRequest('GET', path, headers, bogusKeyPair.secretKey, agentId);

    // Send with BOTH invalid Signature AND valid API key
    const res = await request(app)
      .get(path)
      .set('host', headers.host)
      .set('date', headers.date)
      .set('signature', sigHeader)
      .set('x-api-key', 'test-master-key-fix1');

    // Should reject with 401 SIGNATURE_INVALID, NOT succeed via API key
    assert.equal(res.status, 401);
    assert.equal(res.body.error, 'SIGNATURE_INVALID');
  } finally {
    process.env.API_KEY_REQUIRED = savedRequired;
    process.env.MASTER_API_KEY = savedMaster;
  }
});

test('Fix1: no Signature header still falls through to requireApiKey', async () => {
  const savedRequired = process.env.API_KEY_REQUIRED;
  const savedMaster = process.env.MASTER_API_KEY;
  process.env.API_KEY_REQUIRED = 'true';
  process.env.MASTER_API_KEY = 'test-master-key-fix1b';

  try {
    const agent = await registerAgent('fix1-no-sig');
    const agentId = agent.agent_id;
    const path = `/api/agents/${encodeURIComponent(agentId)}`;

    // No Signature header, but valid API key — should succeed
    const res = await request(app)
      .get(path)
      .set('x-api-key', 'test-master-key-fix1b');

    assert.equal(res.status, 200);
  } finally {
    process.env.API_KEY_REQUIRED = savedRequired;
    process.env.MASTER_API_KEY = savedMaster;
  }
});

test('Fix1: valid Signature header bypasses API key (existing behavior preserved)', async () => {
  const savedRequired = process.env.API_KEY_REQUIRED;
  const savedMaster = process.env.MASTER_API_KEY;
  process.env.API_KEY_REQUIRED = 'true';
  process.env.MASTER_API_KEY = 'test-master-key-fix1c';

  try {
    const agent = await registerAgent('fix1-valid-sig');
    const agentId = agent.agent_id;
    const secretKey = fromBase64(agent.secret_key);
    const path = `/api/agents/${encodeURIComponent(agentId)}`;

    const headers = {
      host: '127.0.0.1',
      date: new Date().toUTCString()
    };
    const sigHeader = signRequest('GET', path, headers, secretKey, agentId);

    // Valid Signature, no API key — should succeed
    const res = await request(app)
      .get(path)
      .set('host', headers.host)
      .set('date', headers.date)
      .set('signature', sigHeader);

    assert.equal(res.status, 200);
  } finally {
    process.env.API_KEY_REQUIRED = savedRequired;
    process.env.MASTER_API_KEY = savedMaster;
  }
});

// --- Fix 2: Replay protection — validate Date header freshness ---

test('Fix2: stale Date header rejected by verifyHttpSignatureOnly (global gate)', async () => {
  const agent = await registerAgent('fix2-stale-date');
  const agentId = agent.agent_id;
  const secretKey = fromBase64(agent.secret_key);
  const path = `/api/agents/${encodeURIComponent(agentId)}`;

  // Date 10 minutes in the past
  const staleDate = new Date(Date.now() - 10 * 60 * 1000).toUTCString();
  const headers = {
    host: '127.0.0.1',
    date: staleDate
  };
  const sigHeader = signRequest('GET', path, headers, secretKey, agentId);

  const res = await request(app)
    .get(path)
    .set('host', headers.host)
    .set('date', staleDate)
    .set('signature', sigHeader);

  // Should be rejected — stale date means potential replay
  assert.ok([401, 403].includes(res.status), `Expected 401 or 403, got ${res.status}`);
});

test('Fix2: missing Date header rejected by authenticateHttpSignature', async () => {
  const agent = await registerAgent('fix2-missing-date');
  const agentId = agent.agent_id;
  const secretKey = fromBase64(agent.secret_key);
  const path = `/api/agents/${encodeURIComponent(agentId)}/messages`;

  // Sign WITHOUT date in headers list
  const headers = {
    host: '127.0.0.1'
  };
  const sigHeader = signRequest('GET', path, headers, secretKey, agentId, ['(request-target)', 'host']);

  const res = await request(app)
    .get(path)
    .set('host', headers.host)
    .set('signature', sigHeader);

  // Should be rejected — date must always be signed
  assert.ok([400, 401, 403].includes(res.status), `Expected 400/401/403, got ${res.status}`);
});

test('Fix2: stale Date header rejected by authenticateHttpSignature', async () => {
  const sender = await registerAgent('fix2-stale-auth');
  const recipient = await registerAgent('fix2-stale-recip');
  const secretKey = fromBase64(sender.secret_key);
  const path = `/api/agents/${encodeURIComponent(recipient.agent_id)}/messages`;

  // Date 10 minutes in the past
  const staleDate = new Date(Date.now() - 10 * 60 * 1000).toUTCString();
  const headers = {
    host: '127.0.0.1',
    date: staleDate
  };
  const sigHeader = signRequest('POST', path, headers, secretKey, sender.agent_id);

  const envelope = {
    version: '1.0',
    id: `msg-fix2-${Date.now()}`,
    type: 'task.request',
    from: sender.agent_id,
    to: recipient.agent_id,
    subject: 'replay-test',
    body: { test: true },
    timestamp: new Date().toISOString(),
    ttl_sec: 3600
  };
  envelope.signature = signMessage(envelope, fromBase64(sender.secret_key));

  const res = await request(app)
    .post(path)
    .set('host', headers.host)
    .set('date', staleDate)
    .set('signature', sigHeader)
    .send(envelope);

  // Should be rejected due to stale date
  assert.ok([400, 401, 403].includes(res.status), `Expected 400/401/403, got ${res.status}`);
});

test('Fix2: fresh Date header passes (existing behavior)', async () => {
  const agent = await registerAgent('fix2-fresh-date');
  const agentId = agent.agent_id;
  const secretKey = fromBase64(agent.secret_key);
  const path = `/api/agents/${encodeURIComponent(agentId)}`;

  const headers = {
    host: '127.0.0.1',
    date: new Date().toUTCString()
  };
  const sigHeader = signRequest('GET', path, headers, secretKey, agentId);

  const res = await request(app)
    .get(path)
    .set('host', headers.host)
    .set('date', headers.date)
    .set('signature', sigHeader);

  assert.equal(res.status, 200);
});

// --- Fix 3: Authorization check in verifyHttpSignatureOnly ---

test('Fix3: Agent A signing request targeting Agent B resources is rejected', async () => {
  const agentA = await registerAgent('fix3-agent-a');
  const agentB = await registerAgent('fix3-agent-b');
  const secretKeyA = fromBase64(agentA.secret_key);

  // Agent A signs a request targeting Agent B's endpoint
  const path = `/api/agents/${encodeURIComponent(agentB.agent_id)}/messages`;
  const headers = {
    host: '127.0.0.1',
    date: new Date().toUTCString()
  };
  const sigHeader = signRequest('GET', path, headers, secretKeyA, agentA.agent_id);

  const res = await request(app)
    .get(path)
    .set('host', headers.host)
    .set('date', headers.date)
    .set('signature', sigHeader);

  // Should be rejected — Agent A cannot access Agent B's resources
  assert.ok([401, 403].includes(res.status), `Expected 401 or 403, got ${res.status}`);
});

test('Fix3: Agent A signing request targeting own resources is allowed', async () => {
  const agentA = await registerAgent('fix3-agent-own');
  const secretKeyA = fromBase64(agentA.secret_key);

  // Agent A signs a request targeting own endpoint
  const path = `/api/agents/${encodeURIComponent(agentA.agent_id)}`;
  const headers = {
    host: '127.0.0.1',
    date: new Date().toUTCString()
  };
  const sigHeader = signRequest('GET', path, headers, secretKeyA, agentA.agent_id);

  const res = await request(app)
    .get(path)
    .set('host', headers.host)
    .set('date', headers.date)
    .set('signature', sigHeader);

  assert.equal(res.status, 200);
});

test('Fix3: non-agent paths (e.g. /api/stats) skip authorization check', async () => {
  const agent = await registerAgent('fix3-stats');
  const secretKey = fromBase64(agent.secret_key);

  const path = '/api/stats';
  const headers = {
    host: '127.0.0.1',
    date: new Date().toUTCString()
  };
  const sigHeader = signRequest('GET', path, headers, secretKey, agent.agent_id);

  const res = await request(app)
    .get(path)
    .set('host', headers.host)
    .set('date', headers.date)
    .set('signature', sigHeader);

  assert.equal(res.status, 200);
});

test('trust model: DID web with path segments — resolves URL and creates shadow agent', async () => {
  const domain = `did-web-path-${Date.now()}.example.com`;
  const did = `did:web:${domain}:users:alice`;
  const expectedUrl = `https://${domain}/users/alice/did.json`;
  const expectedAgentId = `did-web:${domain}/users/alice`;
  const keypair = nacl.sign.keyPair();
  const pubKeyB64 = toBase64(keypair.publicKey);

  const didDoc = {
    '@context': ['https://www.w3.org/ns/did/v1'],
    id: did,
    verificationMethod: [{
      id: `${did}#key-1`,
      type: 'Ed25519VerificationKey2020',
      controller: did,
      publicKeyBase64: pubKeyB64
    }]
  };

  const originalFetch = globalThis.fetch;
  let fetchedUrl = null;
  globalThis.fetch = async (url, init) => {
    if (url === expectedUrl) {
      fetchedUrl = url;
      const body = JSON.stringify(didDoc);
      return { ok: true, json: async () => didDoc, text: async () => body, headers: new Map([['content-length', String(Buffer.byteLength(body))]]) };
    }
    return originalFetch ? originalFetch(url, init) : Promise.reject(new Error('no fetch'));
  };

  // DID:web auto-approval requires the domain to be in the allowlist
  const savedAllowedDomains = process.env.DID_WEB_ALLOWED_DOMAINS;
  process.env.DID_WEB_ALLOWED_DOMAINS = domain;

  try {
    const targetPath = `/api/agents/${encodeURIComponent(expectedAgentId)}/heartbeat`;
    const dateStr = new Date().toUTCString();
    const headers = { host: '127.0.0.1', date: dateStr };
    const signatureHeader = signRequest('POST', targetPath, headers, keypair.secretKey, did);

    const res = await request(app)
      .post(targetPath)
      .set('Host', headers.host)
      .set('Signature', signatureHeader)
      .set('Date', dateStr)
      .send({});

    // Auth should succeed (not 401/403)
    assert.notEqual(res.status, 401, 'DID web with path segments auth should not return 401');
    assert.notEqual(res.status, 403, `DID web with path segments auth should not return 403 (got: ${JSON.stringify(res.body)})`);

    // Verify the correct URL was fetched (path segments mapped correctly)
    assert.equal(fetchedUrl, expectedUrl, `DID document should be fetched from ${expectedUrl}`);

    // Verify shadow agent was created with the correct agent_id
    const shadowAgent = await storage.getAgentByDid(did);
    assert.ok(shadowAgent, 'shadow agent must be created for did:web with path segments');
    assert.equal(shadowAgent.agent_id, expectedAgentId, `agent_id should be ${expectedAgentId}`);
    assert.equal(shadowAgent.registration_mode, 'did-web');
    assert.equal(shadowAgent.registration_status, 'approved');
  } finally {
    globalThis.fetch = originalFetch;
    if (savedAllowedDomains !== undefined) process.env.DID_WEB_ALLOWED_DOMAINS = savedAllowedDomains;
    else delete process.env.DID_WEB_ALLOWED_DOMAINS;
  }
});

test('trust model: DID web — crafted keyId with .. segment is rejected (SSRF guard)', async () => {
  // Confirm SAFE_DID_SEGMENT's '..' guard in resolveDIDWebAgent() fires before any
  // outbound fetch. A crafted keyId like did:web:evil.com:.. would produce the URL
  // https://evil.com/../did.json — blocked before the fetch is attempted.
  // Note: newline injection in keyId is blocked at the HTTP client level (headers
  // cannot contain newlines), not at the server validation layer.
  const domain = `did-web-ssrf-${Date.now()}.example.com`;
  const maliciousKeyIds = [
    `did:web:${domain}:..`,      // path traversal via '..' segment
    `did:web:${domain}:a:..`,    // '..' deeper in path
  ];

  const keypair = nacl.sign.keyPair();
  const savedAllowedDomains = process.env.DID_WEB_ALLOWED_DOMAINS;
  process.env.DID_WEB_ALLOWED_DOMAINS = domain;
  let fetchCalled = false;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    fetchCalled = true;
    throw new Error('fetch should not be called for crafted DID:web keyIds');
  };

  try {
    for (const keyId of maliciousKeyIds) {
      fetchCalled = false;
      const dateStr = new Date().toUTCString();
      const targetPath = `/api/agents/any-agent/heartbeat`;
      const headers = { host: '127.0.0.1', date: dateStr };
      const signatureHeader = signRequest('POST', targetPath, headers, keypair.secretKey, keyId);

      const res = await request(app)
        .post(targetPath)
        .set('Host', headers.host)
        .set('Signature', signatureHeader)
        .set('Date', dateStr)
        .send({});

      assert.equal(res.status, 401, `Crafted DID:web keyId ${JSON.stringify(keyId)} should return 401`);
      assert.equal(fetchCalled, false, `fetch should not be called for crafted keyId ${JSON.stringify(keyId)}`);
    }
  } finally {
    globalThis.fetch = originalFetch;
    if (savedAllowedDomains !== undefined) process.env.DID_WEB_ALLOWED_DOMAINS = savedAllowedDomains;
    else delete process.env.DID_WEB_ALLOWED_DOMAINS;
  }
});

// ============ ROUND TABLE TESTS ============

test('round table: full lifecycle — create, speak, resolve', async () => {
  const facilitator = await registerAgent('rt-facilitator');
  const participant1 = await registerAgent('rt-participant-one');
  const participant2 = await registerAgent('rt-participant-two');

  // Create
  const createRes = await request(app)
    .post('/api/round-tables')
    .set('X-Agent-ID', facilitator.agent_id)
    .send({
      topic: 'Should we use push or pull for credential sync?',
      goal: 'Reach consensus on sync strategy',
      participants: [participant1.agent_id, participant2.agent_id],
      timeout_minutes: 60
    });

  assert.equal(createRes.status, 201);
  assert.ok(createRes.body.id.startsWith('rt_'));
  assert.equal(createRes.body.status, 'open');
  assert.equal(createRes.body.facilitator, facilitator.agent_id);
  assert.equal(createRes.body.thread.length, 0);
  assert.ok(createRes.body.group_id);

  const rtId = createRes.body.id;

  // Speak (participant)
  const speakRes = await request(app)
    .post(`/api/round-tables/${rtId}/speak`)
    .set('X-Agent-ID', participant1.agent_id)
    .send({ message: 'I recommend pull-on-start for simplicity.' });

  assert.equal(speakRes.status, 201);
  assert.equal(speakRes.body.thread_length, 1);

  // Read — participant sees thread
  const getRes = await request(app)
    .get(`/api/round-tables/${rtId}`)
    .set('X-Agent-ID', participant2.agent_id);

  assert.equal(getRes.status, 200);
  assert.equal(getRes.body.thread.length, 1);
  assert.equal(getRes.body.thread[0].from, participant1.agent_id);

  // Resolve (facilitator)
  const resolveRes = await request(app)
    .post(`/api/round-tables/${rtId}/resolve`)
    .set('X-Agent-ID', facilitator.agent_id)
    .send({ outcome: 'Consensus: pull-on-start for all targets.', decision: 'approved' });

  assert.equal(resolveRes.status, 200);
  assert.equal(resolveRes.body.status, 'resolved');
  assert.equal(resolveRes.body.outcome, 'Consensus: pull-on-start for all targets.');

  // Speak after resolve → 409
  const lateSpeak = await request(app)
    .post(`/api/round-tables/${rtId}/speak`)
    .set('X-Agent-ID', participant1.agent_id)
    .send({ message: 'Too late.' });

  assert.equal(lateSpeak.status, 409);
});

test('round table: non-participant cannot read or speak', async () => {
  const facilitator = await registerAgent('rt-priv-facilitator');
  const participant = await registerAgent('rt-priv-participant');
  const outsider = await registerAgent('rt-outsider');

  const createRes = await request(app)
    .post('/api/round-tables')
    .set('X-Agent-ID', facilitator.agent_id)
    .send({
      topic: 'Private deliberation',
      goal: 'Internal decision',
      participants: [participant.agent_id],
      timeout_minutes: 30
    });

  assert.equal(createRes.status, 201);
  const rtId = createRes.body.id;

  // Outsider cannot read
  const getRes = await request(app)
    .get(`/api/round-tables/${rtId}`)
    .set('X-Agent-ID', outsider.agent_id);
  assert.equal(getRes.status, 403);

  // Outsider cannot speak
  const speakRes = await request(app)
    .post(`/api/round-tables/${rtId}/speak`)
    .set('X-Agent-ID', outsider.agent_id)
    .send({ message: 'Intruder!' });
  assert.equal(speakRes.status, 403);
});

test('round table: non-facilitator cannot resolve', async () => {
  const facilitator = await registerAgent('rt-res-facilitator');
  const participant = await registerAgent('rt-res-participant');

  const createRes = await request(app)
    .post('/api/round-tables')
    .set('X-Agent-ID', facilitator.agent_id)
    .send({
      topic: 'Who resolves?',
      goal: 'Test auth',
      participants: [participant.agent_id],
      timeout_minutes: 30
    });

  assert.equal(createRes.status, 201);
  const rtId = createRes.body.id;

  const resolveRes = await request(app)
    .post(`/api/round-tables/${rtId}/resolve`)
    .set('X-Agent-ID', participant.agent_id)
    .send({ outcome: 'Sneaky resolve.' });

  assert.equal(resolveRes.status, 403);
});

test('round table: participants cap enforced at 20', async () => {
  const facilitator = await registerAgent('rt-cap-facilitator');

  const tooManyParticipants = Array.from({ length: 21 }, (_, i) => `fake-agent-${i}`);

  const res = await request(app)
    .post('/api/round-tables')
    .set('X-Agent-ID', facilitator.agent_id)
    .send({
      topic: 'Overcrowded',
      goal: 'Test cap',
      participants: tooManyParticipants,
      timeout_minutes: 30
    });

  assert.equal(res.status, 400);
  assert.ok(res.body.message.includes('20'));
});

test('round table: missing required fields return 400', async () => {
  const agent = await registerAgent('rt-validation');

  const noTopic = await request(app)
    .post('/api/round-tables')
    .set('X-Agent-ID', agent.agent_id)
    .send({ goal: 'Missing topic', participants: ['other'] });
  assert.equal(noTopic.status, 400);

  const noParticipants = await request(app)
    .post('/api/round-tables')
    .set('X-Agent-ID', agent.agent_id)
    .send({ topic: 'Missing participants', goal: 'Test', participants: [] });
  assert.equal(noParticipants.status, 400);
});

test('round table: facilitator can speak in their own session', async () => {
  const facilitator = await registerAgent('rt-fac-speak');
  const participant = await registerAgent('rt-fac-speak-p');

  const createRes = await request(app)
    .post('/api/round-tables')
    .set('X-Agent-ID', facilitator.agent_id)
    .send({
      topic: 'Facilitator speech test',
      goal: 'Verify facilitator can speak',
      participants: [participant.agent_id],
      timeout_minutes: 30
    });

  assert.equal(createRes.status, 201);
  const rtId = createRes.body.id;

  const speakRes = await request(app)
    .post(`/api/round-tables/${rtId}/speak`)
    .set('X-Agent-ID', facilitator.agent_id)
    .send({ message: 'I am the facilitator and I can speak.' });

  assert.equal(speakRes.status, 201);
  assert.equal(speakRes.body.thread_length, 1);
});

test('round table: expireStale marks session expired and notifies facilitator and participants', async () => {
  const facilitator = await registerAgent('rt-expire-fac');
  const participant = await registerAgent('rt-expire-p');

  const createRes = await request(app)
    .post('/api/round-tables')
    .set('X-Agent-ID', facilitator.agent_id)
    .send({
      topic: 'Expiry test',
      goal: 'Verify expiry',
      participants: [participant.agent_id],
      timeout_minutes: 60
    });

  assert.equal(createRes.status, 201);
  const rtId = createRes.body.id;

  // Drain the work_order invitation from participant inbox before backdating
  await request(app)
    .post(`/api/agents/${encodeURIComponent(participant.agent_id)}/inbox/pull`)
    .set('X-Agent-ID', participant.agent_id);

  // Backdate the expiry to force expiration
  await storage.updateRoundTable(rtId, {
    expires_at: new Date(Date.now() - 1000).toISOString()
  });

  const expired = await roundTableService.expireStale();
  assert.ok(expired >= 1, 'at least one session should be expired');

  // Confirm status is now expired via storage
  const rt = await storage.getRoundTable(rtId);
  assert.equal(rt.status, 'expired');

  // Participant inbox should have an expiry notification
  const participantPull = await request(app)
    .post(`/api/agents/${encodeURIComponent(participant.agent_id)}/inbox/pull`)
    .set('X-Agent-ID', participant.agent_id);
  assert.equal(participantPull.status, 200);
  assert.equal(participantPull.body.envelope.type, 'notification');
  assert.equal(participantPull.body.envelope.body.round_table_id, rtId);
  assert.equal(participantPull.body.envelope.body.reason, 'timeout');

  // Facilitator inbox should also have an expiry notification
  const facilitatorPull = await request(app)
    .post(`/api/agents/${encodeURIComponent(facilitator.agent_id)}/inbox/pull`)
    .set('X-Agent-ID', facilitator.agent_id);
  assert.equal(facilitatorPull.status, 200);
  assert.equal(facilitatorPull.body.envelope.type, 'notification');
  assert.equal(facilitatorPull.body.envelope.body.round_table_id, rtId);

  // Confirm speak returns 409
  const lateSpeak = await request(app)
    .post(`/api/round-tables/${rtId}/speak`)
    .set('X-Agent-ID', participant.agent_id)
    .send({ message: 'Too late.' });
  assert.equal(lateSpeak.status, 409);
});

test('round table: duplicate participants are deduplicated', async () => {
  const facilitator = await registerAgent('rt-dedup-fac');
  const participant = await registerAgent('rt-dedup-p');

  const createRes = await request(app)
    .post('/api/round-tables')
    .set('X-Agent-ID', facilitator.agent_id)
    .send({
      topic: 'Dedup test',
      goal: 'Verify dedup',
      participants: [participant.agent_id, participant.agent_id, participant.agent_id],
      timeout_minutes: 30
    });

  assert.equal(createRes.status, 201);
  assert.equal(createRes.body.participants.length, 1, 'duplicates should be removed');
  assert.equal(createRes.body.participants[0], participant.agent_id);
});

test('round table: missing goal returns 400', async () => {
  const agent = await registerAgent('rt-no-goal');

  const res = await request(app)
    .post('/api/round-tables')
    .set('X-Agent-ID', agent.agent_id)
    .send({ topic: 'No goal here', participants: ['other-agent'] });

  assert.equal(res.status, 400);
  assert.ok(res.body.error === 'INVALID_GOAL');
});

test('round table: non-integer timeout_minutes returns 400', async () => {
  const agent = await registerAgent('rt-float-timeout');
  const participant = await registerAgent('rt-float-timeout-p');

  const res = await request(app)
    .post('/api/round-tables')
    .set('X-Agent-ID', agent.agent_id)
    .send({
      topic: 'Float timeout',
      goal: 'Test integer validation',
      participants: [participant.agent_id],
      timeout_minutes: 1.5
    });

  assert.equal(res.status, 400);
  assert.ok(res.body.error === 'INVALID_TIMEOUT');
});

test('round table: zero-enrollment returns 400 and leaves no orphaned groups', async () => {
  const facilitator = await registerAgent('rt-zero-enroll-fac');
  const unique = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  // Count groups the facilitator belongs to before the attempt
  const groupsBefore = (await groupService.listForAgent(facilitator.agent_id)).length;

  // All fake participants — addMember will throw "Agent not found" for each
  const res = await request(app)
    .post('/api/round-tables')
    .set('X-Agent-ID', facilitator.agent_id)
    .send({
      topic: 'Zero enrollment test',
      goal: 'All participants unknown',
      participants: [`ghost-${unique}-1`, `ghost-${unique}-2`],
      timeout_minutes: 30
    });

  assert.equal(res.status, 400);
  assert.ok(res.body.message.toLowerCase().includes('no participants'));

  // No orphaned round-table groups should remain
  const groupsAfter = (await groupService.listForAgent(facilitator.agent_id)).length;
  assert.equal(groupsAfter, groupsBefore, 'group created during enrollment should be cleaned up');
});

test('round table: partial enrollment — only enrolled participants stored, excluded_participants returned', async () => {
  const facilitator = await registerAgent('rt-partial-fac');
  const validParticipant = await registerAgent('rt-partial-p');
  const unique = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  const createRes = await request(app)
    .post('/api/round-tables')
    .set('X-Agent-ID', facilitator.agent_id)
    .send({
      topic: 'Partial enrollment test',
      goal: 'Verify split-brain prevention',
      participants: [validParticipant.agent_id, `ghost-${unique}`],
      timeout_minutes: 30
    });

  assert.equal(createRes.status, 201);

  // Only the valid participant should be in participants
  assert.equal(createRes.body.participants.length, 1);
  assert.equal(createRes.body.participants[0], validParticipant.agent_id);

  // The ghost agent should be in excluded_participants
  assert.ok(Array.isArray(createRes.body.excluded_participants));
  assert.equal(createRes.body.excluded_participants.length, 1);
  assert.ok(createRes.body.excluded_participants[0].startsWith('ghost-'));

  // The backing group's max_members should be aligned to enrolled count + 1 (= 2)
  const groupRes = await request(app)
    .get(`/api/groups/${encodeURIComponent(createRes.body.group_id)}`)
    .set('X-Agent-ID', facilitator.agent_id);
  assert.equal(groupRes.status, 200);
  assert.equal(groupRes.body.settings.max_members, 2);
});
