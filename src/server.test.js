import test from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import http from 'node:http';

import app from './server.js';
import { fromBase64, signMessage } from './utils/crypto.js';
import { createMechStorage } from './storage/mech.js';
import { requireApiKey } from './middleware/auth.js';
import { webhookService } from './services/webhook.service.js';

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

  const res = await request(app)
    .post(`/api/agents/${encodeURIComponent(recipientId)}/messages`)
    .send(envelope);

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
