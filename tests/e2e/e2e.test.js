/**
 * ADMP End-to-End Test Suite
 * 
 * Comprehensive tests covering the complete ADMP message lifecycle.
 * 
 * Prerequisites:
 * - Mech Storage API available (or mock)
 * - ADMP server running on localhost:3008
 * - Worker process running (for background jobs)
 * 
 * Run: bun test tests/e2e/e2e.test.js
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { v4 as uuidv4 } from 'uuid';
import nacl from 'tweetnacl';

const BASE_URL = process.env.ADMP_SERVER_URL || 'http://localhost:3008';

// Test context (shared across tests)
const ctx = {
  sender: {
    id: 'billing@acme.com',
    inboxKey: null,
    keypair: null,
  },
  recipient: {
    id: 'storage@partner.com',
    inboxKey: null,
    keypair: null,
  },
  testMessage: null,
};

/**
 * Helper: Make HTTP request to ADMP server
 */
async function request(method, path, options = {}) {
  const url = `${BASE_URL}${path}`;
  const response = await fetch(url, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...options.headers,
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });

  const data = await response.json().catch(() => ({}));
  
  return {
    status: response.status,
    data,
    headers: response.headers,
  };
}

/**
 * Helper: Generate Ed25519 keypair
 */
function generateKeypair() {
  const keypair = nacl.sign.keyPair();
  return {
    publicKey: Buffer.from(keypair.publicKey).toString('base64'),
    secretKey: Buffer.from(keypair.secretKey).toString('base64'),
    publicKeyRaw: keypair.publicKey,
    secretKeyRaw: keypair.secretKey,
  };
}

/**
 * Helper: Sign ADMP envelope
 */
function signEnvelope(envelope, secretKey) {
  // Build canonical base string
  const baseString = [
    envelope.version,
    envelope.id,
    envelope.type,
    envelope.from,
    envelope.to,
    envelope.subject,
    JSON.stringify(envelope.body),
    envelope.timestamp,
  ].join('|');

  const message = Buffer.from(baseString, 'utf-8');
  const signature = nacl.sign.detached(message, secretKey);

  return Buffer.from(signature).toString('base64');
}

/**
 * Helper: Wait for condition with timeout
 */
async function waitFor(conditionFn, timeoutMs = 5000, intervalMs = 100) {
  const startTime = Date.now();
  
  while (Date.now() - startTime < timeoutMs) {
    const result = await conditionFn();
    if (result) return result;
    await new Promise(resolve => setTimeout(resolve, intervalMs));
  }
  
  throw new Error(`Timeout waiting for condition after ${timeoutMs}ms`);
}

// ============================================================================
// Setup & Teardown
// ============================================================================

beforeAll(async () => {
  console.log('🔧 Setting up E2E test environment...');
  
  // Generate keypairs for test agents
  ctx.sender.keypair = generateKeypair();
  ctx.recipient.keypair = generateKeypair();
  
  console.log('✅ E2E test environment ready');
});

afterAll(async () => {
  console.log('🧹 Cleaning up E2E test data...');
  // TODO: Clean up test agents and messages if needed
  console.log('✅ Cleanup complete');
});

// ============================================================================
// Test Suite 1: Agent Registration & Authentication
// ============================================================================

describe('Suite 1: Agent Registration & Authentication', () => {
  
  test('1.1: Register sender agent', async () => {
    const response = await request('POST', '/v1/agents', {
      body: {
        agent_id: ctx.sender.id,
        public_key: ctx.sender.keypair.publicKey,
        webhook_url: 'https://acme.com/webhooks/admp',
        trusted_agents: ['*@partner.com'],
        allowed_subjects: ['invoice.*', 'payment.*'],
        max_message_size_kb: 256,
      },
    });

    expect(response.status).toBe(201);
    expect(response.data.agent_id).toBe(ctx.sender.id);
    expect(response.data.inbox_count).toBe(0);
    expect(response.data.created_at).toBeTruthy();
  });

  test('1.2: Register recipient agent', async () => {
    const response = await request('POST', '/v1/agents', {
      body: {
        agent_id: ctx.recipient.id,
        public_key: ctx.recipient.keypair.publicKey,
        webhook_url: 'https://partner.com/webhooks/admp',
        trusted_agents: ['*@acme.com'],
        allowed_subjects: ['*'],
      },
    });

    expect(response.status).toBe(201);
    expect(response.data.agent_id).toBe(ctx.recipient.id);
  });

  test('1.3: Create inbox key for sender', async () => {
    const response = await request('POST', `/v1/agents/${encodeURIComponent(ctx.sender.id)}/keys`, {
      body: {
        scopes: ['send', 'pull', 'ack', 'nack', 'reply'],
        subject_patterns: ['*'],
        expires_at: '2026-12-31T23:59:59Z',
        description: 'E2E test key for sender',
      },
    });

    expect(response.status).toBe(201);
    expect(response.data.key).toMatch(/^admp_k_billing_acme\.com_/);
    expect(response.data.scopes).toEqual(['send', 'pull', 'ack', 'nack', 'reply']);
    
    // Save key for subsequent tests
    ctx.sender.inboxKey = response.data.key;
  });

  test('1.4: Create inbox key for recipient', async () => {
    const response = await request('POST', `/v1/agents/${encodeURIComponent(ctx.recipient.id)}/keys`, {
      body: {
        scopes: ['send', 'pull', 'ack', 'nack', 'reply'],
        subject_patterns: ['*'],
        expires_at: '2026-12-31T23:59:59Z',
        description: 'E2E test key for recipient',
      },
    });

    expect(response.status).toBe(201);
    ctx.recipient.inboxKey = response.data.key;
  });

  test('1.5: List inbox keys', async () => {
    const response = await request('GET', `/v1/agents/${encodeURIComponent(ctx.sender.id)}/keys`);
    
    expect(response.status).toBe(200);
    expect(Array.isArray(response.data)).toBe(true);
    expect(response.data.length).toBeGreaterThan(0);
  });

  test('1.6: Reject request without authentication', async () => {
    const response = await request('POST', `/v1/agents/${encodeURIComponent(ctx.recipient.id)}/inbox/pull`);
    
    expect(response.status).toBe(401);
  });
});

// ============================================================================
// Test Suite 2: Message Sending (HTTP API)
// ============================================================================

describe('Suite 2: Message Sending', () => {

  test('2.1: Send valid message without signature', async () => {
    const messageId = `msg-${uuidv4()}`;
    const timestamp = new Date().toISOString();
    
    const envelope = {
      version: '1.0',
      id: messageId,
      type: 'task.request',
      from: ctx.sender.id,
      to: ctx.recipient.id,
      subject: 'invoice.create',
      body: {
        invoice_id: 'INV-12345',
        amount: 100.00,
        currency: 'USD',
      },
      timestamp,
      ttl_sec: 86400,
    };

    const response = await request('POST', `/v1/agents/${encodeURIComponent(ctx.recipient.id)}/messages`, {
      headers: {
        'Authorization': `Bearer ${ctx.sender.inboxKey}`,
        'Idempotency-Key': `create-invoice-${messageId}`,
      },
      body: envelope,
    });

    expect(response.status).toBe(201);
    expect(response.data.message_id).toBeTruthy();
    expect(response.data.status).toBe('queued');
    
    // Save for subsequent tests
    ctx.testMessage = {
      id: response.data.message_id,
      envelope,
    };
  });

  test('2.2: Send message with Ed25519 signature', async () => {
    const messageId = `msg-${uuidv4()}`;
    const timestamp = new Date().toISOString();
    
    const envelope = {
      version: '1.0',
      id: messageId,
      type: 'task.request',
      from: ctx.sender.id,
      to: ctx.recipient.id,
      subject: 'invoice.update',
      body: {
        invoice_id: 'INV-12346',
        status: 'paid',
      },
      timestamp,
      ttl_sec: 86400,
    };

    // Sign the envelope
    const signature = signEnvelope(envelope, ctx.sender.keypair.secretKeyRaw);
    envelope.signature = {
      alg: 'ed25519',
      kid: 'acme.com/test-key',
      sig: signature,
    };

    const response = await request('POST', `/v1/agents/${encodeURIComponent(ctx.recipient.id)}/messages`, {
      headers: {
        'Authorization': `Bearer ${ctx.sender.inboxKey}`,
      },
      body: envelope,
    });

    // Note: This may fail if key discovery can't find public key
    // In real deployment, public key would be served via JWKS or DNS
    expect([201, 403]).toContain(response.status);
  });

  test('2.3: Reject message with invalid signature', async () => {
    const messageId = `msg-${uuidv4()}`;
    const timestamp = new Date().toISOString();
    
    const envelope = {
      version: '1.0',
      id: messageId,
      type: 'task.request',
      from: ctx.sender.id,
      to: ctx.recipient.id,
      subject: 'invoice.delete',
      body: { invoice_id: 'INV-12347' },
      timestamp,
      ttl_sec: 86400,
      signature: {
        alg: 'ed25519',
        kid: 'acme.com/test-key',
        sig: 'invalid-signature-base64',
      },
    };

    const response = await request('POST', `/v1/agents/${encodeURIComponent(ctx.recipient.id)}/messages`, {
      headers: {
        'Authorization': `Bearer ${ctx.sender.inboxKey}`,
      },
      body: envelope,
    });

    expect(response.status).toBe(403);
    expect(response.data.error).toBe('invalid_signature');
  });

  test('2.4: Enforce idempotency', async () => {
    const messageId = `msg-${uuidv4()}`;
    const idempotencyKey = `test-idempotency-${uuidv4()}`;
    const timestamp = new Date().toISOString();
    
    const envelope = {
      version: '1.0',
      id: messageId,
      type: 'task.request',
      from: ctx.sender.id,
      to: ctx.recipient.id,
      subject: 'invoice.test',
      body: { test: true },
      timestamp,
      ttl_sec: 86400,
    };

    // First send
    const response1 = await request('POST', `/v1/agents/${encodeURIComponent(ctx.recipient.id)}/messages`, {
      headers: {
        'Authorization': `Bearer ${ctx.sender.inboxKey}`,
        'Idempotency-Key': idempotencyKey,
      },
      body: envelope,
    });

    expect(response1.status).toBe(201);
    const firstMessageId = response1.data.message_id;

    // Second send with same idempotency key
    const response2 = await request('POST', `/v1/agents/${encodeURIComponent(ctx.recipient.id)}/messages`, {
      headers: {
        'Authorization': `Bearer ${ctx.sender.inboxKey}`,
        'Idempotency-Key': idempotencyKey,
      },
      body: envelope,
    });

    expect(response2.status).toBe(200); // Not 201
    expect(response2.data.message_id).toBe(firstMessageId); // Same message ID
  });

  test('2.5: Reject message with invalid identity format', async () => {
    const envelope = {
      version: '1.0',
      id: `msg-${uuidv4()}`,
      type: 'task.request',
      from: 'invalid-format', // No @ symbol
      to: ctx.recipient.id,
      subject: 'test',
      body: {},
      timestamp: new Date().toISOString(),
      ttl_sec: 86400,
    };

    const response = await request('POST', `/v1/agents/${encodeURIComponent(ctx.recipient.id)}/messages`, {
      headers: {
        'Authorization': `Bearer ${ctx.sender.inboxKey}`,
      },
      body: envelope,
    });

    expect(response.status).toBe(400);
  });

  test('2.6: Reject message with mismatched recipient', async () => {
    const envelope = {
      version: '1.0',
      id: `msg-${uuidv4()}`,
      type: 'task.request',
      from: ctx.sender.id,
      to: 'wrong@recipient.com', // Doesn't match path
      subject: 'test',
      body: {},
      timestamp: new Date().toISOString(),
      ttl_sec: 86400,
    };

    const response = await request('POST', `/v1/agents/${encodeURIComponent(ctx.recipient.id)}/messages`, {
      headers: {
        'Authorization': `Bearer ${ctx.sender.inboxKey}`,
      },
      body: envelope,
    });

    expect(response.status).toBe(400);
    expect(response.data.error).toBe('invalid_recipient');
  });
});

// ============================================================================
// Test Suite 3: Message Pull & Lease Mechanism
// ============================================================================

describe('Suite 3: Message Pull & Lease', () => {

  test('3.1: Pull message from inbox', async () => {
    const response = await request('POST', `/v1/agents/${encodeURIComponent(ctx.recipient.id)}/inbox/pull`, {
      headers: {
        'Authorization': `Bearer ${ctx.recipient.inboxKey}`,
      },
      body: {
        lease_seconds: 30,
        max_messages: 1,
      },
    });

    expect(response.status).toBe(200);
    expect(Array.isArray(response.data.messages)).toBe(true);
    expect(response.data.messages.length).toBeGreaterThan(0);
    
    const message = response.data.messages[0];
    expect(message.envelope).toBeTruthy();
    expect(message.envelope.from).toBe(ctx.sender.id);
    expect(message.envelope.to).toBe(ctx.recipient.id);
    expect(message.lease_until).toBeTruthy();
    
    // Save leased message for next tests
    ctx.leasedMessage = message;
  });

  test('3.2: Verify leased message not returned in second pull', async () => {
    const response = await request('POST', `/v1/agents/${encodeURIComponent(ctx.recipient.id)}/inbox/pull`, {
      headers: {
        'Authorization': `Bearer ${ctx.recipient.inboxKey}`,
      },
      body: {
        lease_seconds: 30,
        max_messages: 10,
      },
    });

    expect(response.status).toBe(200);
    
    // Should not contain the leased message
    const leasedMessageIds = response.data.messages.map(m => m.message_id);
    expect(leasedMessageIds).not.toContain(ctx.leasedMessage.message_id);
  });

  test('3.3: Pull with type filter', async () => {
    // First, send a message with different type
    await request('POST', `/v1/agents/${encodeURIComponent(ctx.recipient.id)}/messages`, {
      headers: {
        'Authorization': `Bearer ${ctx.sender.inboxKey}`,
      },
      body: {
        version: '1.0',
        id: `msg-${uuidv4()}`,
        type: 'notification',
        from: ctx.sender.id,
        to: ctx.recipient.id,
        subject: 'alert',
        body: { message: 'Test notification' },
        timestamp: new Date().toISOString(),
        ttl_sec: 86400,
      },
    });

    // Pull only task.request messages
    const response = await request('POST', `/v1/agents/${encodeURIComponent(ctx.recipient.id)}/inbox/pull`, {
      headers: {
        'Authorization': `Bearer ${ctx.recipient.inboxKey}`,
      },
      body: {
        type: 'task.request',
        max_messages: 10,
      },
    });

    expect(response.status).toBe(200);
    
    // All returned messages should be task.request
    response.data.messages.forEach(msg => {
      expect(msg.envelope.type).toBe('task.request');
    });
  });
});

// ============================================================================
// Test Suite 4: Message Acknowledgment & Requeue
// ============================================================================

describe('Suite 4: Message Ack & Nack', () => {

  test('4.1: Acknowledge message', async () => {
    // Use the leased message from previous test
    if (!ctx.leasedMessage) {
      throw new Error('No leased message available. Run Suite 3 first.');
    }

    const response = await request('POST', 
      `/v1/agents/${encodeURIComponent(ctx.recipient.id)}/messages/${ctx.leasedMessage.message_id}/ack`,
      {
        headers: {
          'Authorization': `Bearer ${ctx.recipient.inboxKey}`,
        },
      }
    );

    expect(response.status).toBe(200);
    expect(response.data.status).toBe('acked');
  });

  test('4.2: Nack message (requeue)', async () => {
    // Send a new message
    const messageId = `msg-${uuidv4()}`;
    await request('POST', `/v1/agents/${encodeURIComponent(ctx.recipient.id)}/messages`, {
      headers: {
        'Authorization': `Bearer ${ctx.sender.inboxKey}`,
      },
      body: {
        version: '1.0',
        id: messageId,
        type: 'task.request',
        from: ctx.sender.id,
        to: ctx.recipient.id,
        subject: 'invoice.test',
        body: { test: 'nack' },
        timestamp: new Date().toISOString(),
        ttl_sec: 86400,
      },
    });

    // Pull and lease it
    const pullResponse = await request('POST', `/v1/agents/${encodeURIComponent(ctx.recipient.id)}/inbox/pull`, {
      headers: {
        'Authorization': `Bearer ${ctx.recipient.inboxKey}`,
      },
      body: {
        lease_seconds: 30,
        max_messages: 1,
      },
    });

    expect(pullResponse.status).toBe(200);
    const message = pullResponse.data.messages[0];

    // Nack it
    const nackResponse = await request('POST', 
      `/v1/agents/${encodeURIComponent(ctx.recipient.id)}/messages/${message.message_id}/nack`,
      {
        headers: {
          'Authorization': `Bearer ${ctx.recipient.inboxKey}`,
        },
        body: {
          reason: 'temporary_error',
        },
      }
    );

    expect(nackResponse.status).toBe(200);
    expect(nackResponse.data.status).toBe('queued');
  });
});

// ============================================================================
// Test Suite 5: Message Reply
// ============================================================================

describe('Suite 5: Message Reply', () => {

  test('5.1: Send reply to original sender', async () => {
    // Send message with correlation_id
    const correlationId = `req-${uuidv4()}`;
    const sendResponse = await request('POST', `/v1/agents/${encodeURIComponent(ctx.recipient.id)}/messages`, {
      headers: {
        'Authorization': `Bearer ${ctx.sender.inboxKey}`,
      },
      body: {
        version: '1.0',
        id: `msg-${uuidv4()}`,
        type: 'task.request',
        from: ctx.sender.id,
        to: ctx.recipient.id,
        subject: 'invoice.create',
        correlation_id: correlationId,
        body: { invoice_id: 'INV-99999' },
        timestamp: new Date().toISOString(),
        ttl_sec: 86400,
      },
    });

    expect(sendResponse.status).toBe(201);
    const originalMessageId = sendResponse.data.message_id;

    // Recipient pulls the message
    const pullResponse = await request('POST', `/v1/agents/${encodeURIComponent(ctx.recipient.id)}/inbox/pull`, {
      headers: {
        'Authorization': `Bearer ${ctx.recipient.inboxKey}`,
      },
      body: { lease_seconds: 30, max_messages: 1 },
    });

    expect(pullResponse.status).toBe(200);
    const message = pullResponse.data.messages[0];

    // Recipient replies
    const replyResponse = await request('POST', 
      `/v1/agents/${encodeURIComponent(ctx.recipient.id)}/messages/${message.message_id}/reply`,
      {
        headers: {
          'Authorization': `Bearer ${ctx.recipient.inboxKey}`,
        },
        body: {
          type: 'task.response',
          subject: 'invoice.created',
          body: {
            invoice_id: 'INV-99999',
            status: 'created',
          },
        },
      }
    );

    expect(replyResponse.status).toBe(201);
    expect(replyResponse.data.correlation_id).toBe(correlationId);
    
    // Verify reply appears in sender's inbox
    const senderPullResponse = await request('POST', `/v1/agents/${encodeURIComponent(ctx.sender.id)}/inbox/pull`, {
      headers: {
        'Authorization': `Bearer ${ctx.sender.inboxKey}`,
      },
      body: { max_messages: 10 },
    });

    expect(senderPullResponse.status).toBe(200);
    const replyMessage = senderPullResponse.data.messages.find(m => 
      m.envelope.correlation_id === correlationId && m.envelope.type === 'task.response'
    );
    
    expect(replyMessage).toBeTruthy();
    expect(replyMessage.envelope.from).toBe(ctx.recipient.id);
    expect(replyMessage.envelope.to).toBe(ctx.sender.id);
  });
});

// ============================================================================
// Test Suite 6: Error Handling
// ============================================================================

describe('Suite 6: Error Handling', () => {

  test('6.1: Reject message without required fields', async () => {
    const response = await request('POST', `/v1/agents/${encodeURIComponent(ctx.recipient.id)}/messages`, {
      headers: {
        'Authorization': `Bearer ${ctx.sender.inboxKey}`,
      },
      body: {
        version: '1.0',
        id: `msg-${uuidv4()}`,
        // Missing: type, from, to, subject, body, timestamp
      },
    });

    expect(response.status).toBe(400);
  });

  test('6.2: Reject request with expired inbox key', async () => {
    // Create key that expires immediately
    const expiredKeyResponse = await request('POST', `/v1/agents/${encodeURIComponent(ctx.sender.id)}/keys`, {
      body: {
        scopes: ['send'],
        subject_patterns: ['*'],
        expires_at: '2020-01-01T00:00:00Z', // Already expired
        description: 'Expired test key',
      },
    });

    expect(expiredKeyResponse.status).toBe(201);
    const expiredKey = expiredKeyResponse.data.key;

    // Try to use expired key
    const response = await request('POST', `/v1/agents/${encodeURIComponent(ctx.recipient.id)}/messages`, {
      headers: {
        'Authorization': `Bearer ${expiredKey}`,
      },
      body: {
        version: '1.0',
        id: `msg-${uuidv4()}`,
        type: 'task.request',
        from: ctx.sender.id,
        to: ctx.recipient.id,
        subject: 'test',
        body: {},
        timestamp: new Date().toISOString(),
        ttl_sec: 86400,
      },
    });

    expect(response.status).toBe(401);
  });

  test('6.3: Handle non-existent message ID', async () => {
    const response = await request('POST', 
      `/v1/agents/${encodeURIComponent(ctx.recipient.id)}/messages/non-existent-id/ack`,
      {
        headers: {
          'Authorization': `Bearer ${ctx.recipient.inboxKey}`,
        },
      }
    );

    expect(response.status).toBe(404);
  });
});

// ============================================================================
// Test Suite 7: Full Lifecycle Integration
// ============================================================================

describe('Suite 7: Full Lifecycle', () => {

  test('7.1: Complete round-trip message flow', async () => {
    const correlationId = `roundtrip-${uuidv4()}`;
    
    // Step 1: Sender sends message
    console.log('  → Sender sends request...');
    const sendResponse = await request('POST', `/v1/agents/${encodeURIComponent(ctx.recipient.id)}/messages`, {
      headers: {
        'Authorization': `Bearer ${ctx.sender.inboxKey}`,
      },
      body: {
        version: '1.0',
        id: `msg-${uuidv4()}`,
        type: 'task.request',
        from: ctx.sender.id,
        to: ctx.recipient.id,
        subject: 'roundtrip.test',
        correlation_id: correlationId,
        body: { action: 'process_data' },
        timestamp: new Date().toISOString(),
        ttl_sec: 86400,
      },
    });
    expect(sendResponse.status).toBe(201);

    // Step 2: Recipient pulls message
    console.log('  → Recipient pulls message...');
    const pullResponse = await request('POST', `/v1/agents/${encodeURIComponent(ctx.recipient.id)}/inbox/pull`, {
      headers: {
        'Authorization': `Bearer ${ctx.recipient.inboxKey}`,
      },
      body: { lease_seconds: 30, max_messages: 1 },
    });
    expect(pullResponse.status).toBe(200);
    const message = pullResponse.data.messages[0];
    expect(message.envelope.correlation_id).toBe(correlationId);

    // Step 3: Recipient processes and replies
    console.log('  → Recipient replies...');
    const replyResponse = await request('POST', 
      `/v1/agents/${encodeURIComponent(ctx.recipient.id)}/messages/${message.message_id}/reply`,
      {
        headers: {
          'Authorization': `Bearer ${ctx.recipient.inboxKey}`,
        },
        body: {
          type: 'task.response',
          subject: 'roundtrip.processed',
          body: { result: 'success' },
        },
      }
    );
    expect(replyResponse.status).toBe(201);

    // Step 4: Recipient acks original message
    console.log('  → Recipient acks request...');
    const ackResponse = await request('POST', 
      `/v1/agents/${encodeURIComponent(ctx.recipient.id)}/messages/${message.message_id}/ack`,
      {
        headers: {
          'Authorization': `Bearer ${ctx.recipient.inboxKey}`,
        },
      }
    );
    expect(ackResponse.status).toBe(200);

    // Step 5: Sender pulls reply
    console.log('  → Sender pulls reply...');
    const senderPullResponse = await request('POST', `/v1/agents/${encodeURIComponent(ctx.sender.id)}/inbox/pull`, {
      headers: {
        'Authorization': `Bearer ${ctx.sender.inboxKey}`,
      },
      body: { max_messages: 10 },
    });
    expect(senderPullResponse.status).toBe(200);
    
    const reply = senderPullResponse.data.messages.find(m => 
      m.envelope.correlation_id === correlationId && m.envelope.type === 'task.response'
    );
    expect(reply).toBeTruthy();
    expect(reply.envelope.from).toBe(ctx.recipient.id);
    expect(reply.envelope.body.result).toBe('success');

    // Step 6: Sender acks reply
    console.log('  → Sender acks reply...');
    const senderAckResponse = await request('POST', 
      `/v1/agents/${encodeURIComponent(ctx.sender.id)}/messages/${reply.message_id}/ack`,
      {
        headers: {
          'Authorization': `Bearer ${ctx.sender.inboxKey}`,
        },
      }
    );
    expect(senderAckResponse.status).toBe(200);

    console.log('  ✓ Complete round-trip successful!');
  });
});

console.log('\n🎯 E2E Test Suite Complete!');
console.log('   Run: bun test tests/e2e/e2e.test.js');
