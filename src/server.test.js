import test from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';

import app from './server.js';
import { fromBase64, signMessage } from './utils/crypto.js';

async function registerAgent(name, metadata = {}) {
  const res = await request(app)
    .post('/api/agents/register')
    .send({
      agent_id: `agent://${name}`,
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
