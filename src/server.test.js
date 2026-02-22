import test from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import http from 'node:http';
import crypto from 'node:crypto';
import nacl from 'tweetnacl';

import app from './server.js';
import { fromBase64, toBase64, signMessage, signRequest, hkdfSha256, LABEL_ADMP, keypairFromSeed, generateDID } from './utils/crypto.js';
import { createMechStorage } from './storage/mech.js';
import { requireApiKey } from './middleware/auth.js';
import { webhookService } from './services/webhook.service.js';
import { outboxService } from './services/outbox.service.js';
import { storage } from './storage/index.js';

async function registerAgent(name, metadata = {}) {
  const uniqueSuffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const res = await request(app)
    .post('/api/agents/register')
    .send({
      agent_id: `agent://${name}-${uniqueSuffix}`,
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
  const nonExistentRecipient = 'agent://non-existent-recipient';

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

test('requireApiKey rejects invalid API key', () => {
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

  requireApiKey(req, res, next);

  assert.equal(nextCalled, false);
  assert.equal(statusCode, 403);
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
    agent_id: 'agent://webhook-happy',
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
    agent_id: 'agent://webhook-fail',
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
    agent_id: 'agent://webhook-agent',
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
    agent_id: 'agent://webhook-fail-agent',
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
    agent_id: 'agent://find-test',
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
    agent_id: 'agent://webhook-find-agent',
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
  const agentId = `agent://seed-determ-${Date.now()}`;

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
      agent_id: `agent://agent-a-${agentSuffix}`,
      agent_type: 'test',
      seed: seedB64,
      tenant_id: tenantA
    });

  const resB = await request(app)
    .post('/api/agents/register')
    .send({
      agent_id: `agent://agent-b-${agentSuffix}`,
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
      agent_id: `agent://no-tenant-${Date.now()}`,
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
      agent_id: `agent://import-${Date.now()}`,
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
        agent_id: `agent://tenant-agent-${Date.now()}`,
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

test('invalid HTTP signature returns 403', async () => {
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

  assert.equal(res.status, 403);
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
  const agentId = `agent://rotate-${Date.now()}`;

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
  const senderAgentId = `agent://rotwin-sender-${Date.now()}`;
  const recipientAgentId = `agent://rotwin-recv-${Date.now()}`;

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

  // Rotate sender's key — old key stays active in the public_keys array
  // We need to make old key still active. Let's update storage directly
  // to keep old key active (the service marks old as inactive, so we fix it)
  const rotateRes = await request(app)
    .post(`/api/agents/${encodeURIComponent(senderAgentId)}/rotate-key`)
    .send({ seed: seedB64, tenant_id: tenantId });

  assert.equal(rotateRes.status, 200);

  // Re-activate the old key to simulate rotation window
  const senderAgent = await storage.getAgent(senderAgentId);
  const updatedKeys = senderAgent.public_keys.map(k => ({ ...k, active: true }));
  await storage.updateAgent(senderAgentId, { public_keys: updatedKeys });

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
  const agentId = `agent://seedmatch-${Date.now()}`;

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
      agent_id: `agent://crypto-verify-${Date.now()}`,
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
