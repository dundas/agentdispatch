# ADMP Quickstart Guide

Get started with ADMP in **5 minutes**. This guide walks you through:
1. Starting ADMP services locally
2. Sending your first message
3. Receiving and acknowledging messages
4. Understanding the basic workflow

---

## Prerequisites

- **Node.js** >= 18 (check: `node --version`)
- **Docker** with Docker Compose (check: `docker --version`)
- **curl** for testing (check: `curl --version`)

---

## Step 1: Start ADMP Services (1 minute)

Clone the repository and start the services:

```bash
git clone https://github.com/agent-dispatch/agent-dispatch.git
cd agent-dispatch
npm run docker:up
```

This starts:
- **PostgreSQL** (port 5432) — message storage
- **ADMP Relay** (port 3030) — HTTP API server

Wait for services to be healthy (~10 seconds):

```bash
# Check relay health
curl http://localhost:3030/health

# Expected output:
# {"status":"healthy","version":"1.0.0","uptime":12}
```

---

## Step 2: Install the Client SDK (30 seconds)

```bash
# Create a new project
mkdir admp-hello && cd admp-hello
npm init -y
npm install @agent-dispatch/client
```

Or use Python:

```bash
pip install agent-dispatch-client
```

---

## Step 3: Send Your First Message (2 minutes)

Create `sender.js`:

```javascript
import { ADMPClient } from '@agent-dispatch/client';

const alice = new ADMPClient({
  agentId: 'agent-alice',
  relayUrl: 'http://localhost:3030',
  apiKey: 'dev-key-admp-local'
});

async function sendMessage() {
  const messageId = await alice.send({
    to: 'agent-bob',
    type: 'task.request',
    subject: 'hello',
    body: {
      message: 'Hello from Alice!',
      timestamp: new Date().toISOString()
    }
  });

  console.log('✅ Message sent!');
  console.log('   Message ID:', messageId);
  console.log('   Destination:', 'agent-bob inbox');
}

sendMessage().catch(console.error);
```

Run it:

```bash
node sender.js
```

**Output:**
```
✅ Message sent!
   Message ID: m-123e4567-e89b-12d3-a456-426614174000
   Destination: agent-bob inbox
```

---

## Step 4: Receive and Process the Message (2 minutes)

Create `receiver.js`:

```javascript
import { ADMPClient } from '@agent-dispatch/client';

const bob = new ADMPClient({
  agentId: 'agent-bob',
  relayUrl: 'http://localhost:3030',
  apiKey: 'dev-key-admp-local'
});

async function receiveMessage() {
  console.log('📬 Checking inbox for agent-bob...');

  // Pull message from inbox (30 second lease)
  const message = await bob.pull({ leaseDuration: 30 });

  if (!message) {
    console.log('📭 Inbox is empty');
    return;
  }

  console.log('\n📨 Received message:');
  console.log('   From:', message.from);
  console.log('   Subject:', message.subject);
  console.log('   Body:', message.body);

  // Simulate processing
  console.log('\n⚙️  Processing...');
  await new Promise(resolve => setTimeout(resolve, 1000));

  // Acknowledge completion
  await bob.ack(message.id);
  console.log('✅ Message processed and removed from inbox');
}

receiveMessage().catch(console.error);
```

Run it:

```bash
node receiver.js
```

**Output:**
```
📬 Checking inbox for agent-bob...

📨 Received message:
   From: agent-alice
   Subject: hello
   Body: { message: 'Hello from Alice!', timestamp: '2025-10-23T...' }

⚙️  Processing...
✅ Message processed and removed from inbox
```

---

## Step 5: Verify the Workflow

Let's verify what happened in the database:

```bash
# Check inbox stats for bob
curl -H "Authorization: Bearer dev-key-admp-local" \
  "http://localhost:3030/v1/agents/agent-bob/inbox/stats"

# Expected output (after acking):
# {"ready":0,"leased":0,"dead":0,"oldest_age_sec":null}
```

All messages acknowledged and removed! ✅

---

## What Just Happened?

### Behind the Scenes

```
┌─────────┐                          ┌──────────┐                          ┌─────────┐
│  Alice  │                          │  Relay   │                          │   Bob   │
│ (sender)│                          │  Server  │                          │(receiver)│
└────┬────┘                          └────┬─────┘                          └────┬────┘
     │                                    │                                     │
     │  1. SEND message                   │                                     │
     ├───────────────────────────────────>│                                     │
     │    to: agent-bob                   │                                     │
     │    subject: hello                  │                                     │
     │                                    │                                     │
     │  2. HTTP 201 Created               │                                     │
     │<───────────────────────────────────┤                                     │
     │    message_id: m-123...            │                                     │
     │                                    │                                     │
     │                                    │  3. Message stored in DB            │
     │                                    │     status: 'delivered'             │
     │                                    │     to_agent_id: 'agent-bob'        │
     │                                    │                                     │
     │                                    │  4. PULL inbox                      │
     │                                    │<────────────────────────────────────┤
     │                                    │                                     │
     │                                    │  5. Lease message (30s)             │
     │                                    │    status: 'leased'                 │
     │                                    │    lease_until: now + 30s           │
     │                                    │                                     │
     │                                    │  6. HTTP 200 OK (message)           │
     │                                    ├────────────────────────────────────>│
     │                                    │                                     │
     │                                    │                                     │
     │                                    │  7. ACK message                     │
     │                                    │<────────────────────────────────────┤
     │                                    │                                     │
     │                                    │  8. Delete from inbox               │
     │                                    │    status: 'acked'                  │
     │                                    │                                     │
     │                                    │  9. HTTP 200 OK                     │
     │                                    ├────────────────────────────────────>│
     │                                    │                                     │
```

### Key Operations

1. **SEND** (`POST /v1/agents/{to}/messages`)
   - Validates message envelope
   - Inserts into PostgreSQL with `status='delivered'`
   - Returns message ID

2. **PULL** (`POST /v1/agents/{id}/inbox/pull`)
   - Finds oldest `delivered` message for agent
   - Sets `status='leased'` with expiration time
   - Returns message (prevents other workers from pulling same message)

3. **ACK** (`POST /v1/messages/{id}/ack`)
   - Updates `status='acked'`
   - Removes from inbox (marks as processed)

### Why Leasing?

The **lease mechanism** prevents message loss if Bob crashes during processing:

- If Bob crashes after PULL but before ACK, the lease expires (30s)
- Relay automatically reclaims the message (`status='delivered'` again)
- Another worker can pull and process it

This ensures **at-least-once delivery**.

---

## Next Steps

### Add Request/Response Pattern

Alice can wait for Bob's reply:

```javascript
// Alice sends and waits for reply
const messageId = await alice.send({
  to: 'agent-bob',
  subject: 'calculate',
  body: { operation: 'add', numbers: [1, 2, 3] }
});

// Wait up to 5 seconds for reply
const reply = await alice.waitForReply(messageId, { timeout: 5000 });
console.log('Result:', reply.body.result); // 6
```

Bob replies:

```javascript
const message = await bob.pull();

// Process request
const result = message.body.numbers.reduce((a, b) => a + b, 0);

// Send reply
await bob.reply(message, {
  result: { result }
});
```

### Add Error Handling

```javascript
const message = await bob.pull();

try {
  const result = processRequest(message.body);
  await bob.reply(message, { result });
} catch (err) {
  await bob.reply(message, {
    error: {
      code: 'PROCESSING_ERROR',
      message: err.message
    }
  });
}
```

### Add Idempotency

Prevent duplicate processing:

```javascript
await alice.send({
  to: 'agent-bob',
  subject: 'create_user',
  body: { email: 'user@example.com' },
  idempotencyKey: 'user-creation-2025-10-23-001'
});

// If sent again with same key, returns existing message ID
// Bob will only process it once
```

### Add Message Signatures

Cryptographically sign messages:

```javascript
import { generateKeyPair } from '@agent-dispatch/client/crypto';

const { publicKey, privateKey } = generateKeyPair();

const alice = new ADMPClient({
  agentId: 'agent-alice',
  relayUrl: 'http://localhost:3030',
  apiKey: 'dev-key-admp-local',
  signingKey: privateKey
});

// All messages automatically signed with Ed25519
await alice.send({ /* ... */ });
```

---

## Troubleshooting

### "ECONNREFUSED" Error

**Problem**: Can't connect to relay server.

**Solution**: Make sure services are running:
```bash
npm run docker:up
curl http://localhost:3030/health
```

### "Message not found" when ACKing

**Problem**: Lease expired before ACK was called.

**Solution**: Increase lease duration:
```javascript
const message = await bob.pull({ leaseDuration: 60 }); // 60 seconds
```

### Messages Stuck in "leased" State

**Problem**: Worker crashed without ACKing.

**Solution**: Reclaim expired leases:
```bash
curl -X POST -H "Authorization: Bearer dev-key-admp-local" \
  "http://localhost:3030/v1/agents/agent-bob/inbox/reclaim"
```

Or wait for automatic reclamation (runs every 30 seconds).

---

## Where to Go Next

- **[Examples](../examples/)** — Working code for common patterns
- **[Architecture](architecture.md)** — Deep dive into how ADMP works
- **[API Reference](api-reference/)** — Full endpoint documentation
- **[Security Guide](security.md)** — Signatures, policies, and best practices
- **[Whitepaper](../whitepaper/v1.md)** — Complete protocol specification

---

**You're now ready to build with ADMP!** 🚀

Start with the [request-response example](../examples/request-response/) to see a complete workflow, or jump into the [task orchestration example](../examples/task-orchestration/) to see multi-agent coordination.
