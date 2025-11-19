# Agent Dispatch Messaging Protocol (ADMP)

**Universal inbox for autonomous agents**

ADMP provides a standardized messaging infrastructure for AI agents to communicate reliably and securely. Each agent gets an inbox, messages are cryptographically signed, and delivery is deterministic.

## Features

- ✅ **Agent Registration** - Ed25519 keypair generation
- ✅ **Inbox Operations** - SEND, PULL, ACK, NACK, REPLY
- ✅ **Webhook Push Delivery** - Real-time message push to webhook URLs
- ✅ **Heartbeat** - Session liveness with automatic offline detection
- ✅ **Message Leasing** - At-least-once delivery with visibility timeouts
- ✅ **Signature Verification** - Ed25519 authentication on all messages
- ✅ **Trust Management** - Allowlist-based authorization
- ✅ **Background Jobs** - Automatic lease reclaim and message expiry
- ✅ **OpenAPI Documentation** - Interactive Swagger UI at /docs
- ✅ **Production Ready** - Docker, health checks, structured logging

## Quick Start

### 1. Installation

```bash
npm install
```

### 2. Configuration

Copy `.env.example` to `.env`:

```bash
cp .env.example .env
```

Edit `.env`:

```env
PORT=8080
NODE_ENV=development
HEARTBEAT_INTERVAL_MS=60000
HEARTBEAT_TIMEOUT_MS=300000
MESSAGE_TTL_SEC=86400
```

### 3. Run Server

**Development:**
```bash
npm run dev
```

**Production:**
```bash
npm start
```

**Docker (Quick Start):**
```bash
# Start with Docker Compose (recommended)
docker-compose up -d

# Or use the build script
./docker-build.sh --run
```

For detailed Docker deployment instructions, see [DOCKER.md](./DOCKER.md)

### 4. Verify

```bash
curl http://localhost:8080/health
```

Response:
```json
{
  "status": "healthy",
  "timestamp": "2025-11-14T10:00:00.000Z",
  "version": "1.0.0"
}
```

### 5. API Documentation

**Interactive API Docs (Swagger UI):**
- Visit http://localhost:8080/docs in your browser
- Try out API endpoints directly from the browser
- View request/response schemas and examples

**OpenAPI Specification:**
- JSON: http://localhost:8080/openapi.json
- YAML: `openapi.yaml` in project root

### 6. Run Tests

**Run the full test suite locally:**

```bash
npm test
```

This uses Node's built-in `node:test` runner (requires Node.js ≥18) to run integration tests.

**Test Coverage:**

The test suite includes:
- ✅ Server boot, health checks, and stats endpoints
- ✅ Agent registration, heartbeat, and retrieval
- ✅ Message lifecycle: send → pull → ack → status flows
- ✅ Signature verification and timestamp validation
- ✅ Error cases: invalid signatures, expired timestamps, unknown recipients

**Test Output:**

Successful test run shows:
```
# tests 8
# pass 8
# fail 0
```

**CI/CD Integration:**

For GitHub Actions, add to your workflow:

```yaml
- name: Install dependencies
  run: npm install

- name: Run tests
  run: npm test
```

For other CI systems, ensure Node.js ≥18 is available and run:
```bash
npm install && npm test
```

**Test Files:**
- `src/server.test.js` - Integration tests for HTTP API endpoints

## API Documentation

### Base URL

```
http://localhost:8080/api
```

### Endpoints

#### 1. Agent Registration

**Register a new agent:**

```bash
POST /api/agents/register

{
  "agent_type": "claude_session",
  "metadata": {
    "project_name": "my-project",
    "working_directory": "/path/to/project"
  },
  "webhook_url": "https://myagent.com/webhook",  // Optional: for push delivery
  "webhook_secret": "secret123"                   // Optional: auto-generated if omitted
}
```

**Response:**
```json
{
  "agent_id": "agent://agent-abc123",
  "agent_type": "claude_session",
  "public_key": "base64-encoded-public-key",
  "secret_key": "base64-encoded-secret-key",
  "webhook_url": "https://myagent.com/webhook",
  "webhook_secret": "auto-generated-secret",
  "heartbeat": {
    "last_heartbeat": 1699999999,
    "status": "online",
    "interval_ms": 60000,
    "timeout_ms": 300000
  }
}
```

**⚠️ Save the `secret_key` and `webhook_secret` - they're only returned on registration!**

---

#### 2. Heartbeat

**Update agent heartbeat:**

```bash
POST /api/agents/{agentId}/heartbeat

{
  "metadata": {
    "last_file_edited": "src/app.js"
  }
}
```

**Response:**
```json
{
  "ok": true,
  "last_heartbeat": 1699999999,
  "timeout_at": 1700000299,
  "status": "online"
}
```

**Heartbeat keeps your agent alive. If no heartbeat for 5 minutes (default), agent status becomes `offline` and stops receiving messages.**

---

#### 3. Send Message

**Send a message to another agent:**

```bash
POST /api/agents/{recipientAgentId}/messages

{
  "version": "1.0",
  "id": "msg-uuid",
  "type": "task.request",
  "from": "agent://sender-agent",
  "to": "agent://recipient-agent",
  "subject": "run_tests",
  "body": {
    "command": "npm test"
  },
  "timestamp": "2025-11-14T10:00:00Z",
  "ttl_sec": 86400,
  "signature": {
    "alg": "ed25519",
    "kid": "sender-agent",
    "sig": "base64-signature"
  }
}
```

**Response:**
```json
{
  "message_id": "msg-uuid",
  "status": "queued"
}
```

---

#### 4. Pull Message (with Lease)

**Pull oldest message from inbox:**

```bash
POST /api/agents/{agentId}/inbox/pull

{
  "visibility_timeout": 60
}
```

**Response (if message available):**
```json
{
  "message_id": "msg-uuid",
  "envelope": {
    "version": "1.0",
    "from": "agent://sender",
    "to": "agent://recipient",
    "subject": "run_tests",
    "body": { "command": "npm test" },
    ...
  },
  "lease_until": 1700000059,
  "attempts": 1
}
```

**Response (if inbox empty):**
```
204 No Content
```

**The message is "leased" to you for 60 seconds. ACK or NACK before lease expires, otherwise it's auto-requeued.**

---

#### 5. ACK Message

**Acknowledge successful processing:**

```bash
POST /api/agents/{agentId}/messages/{messageId}/ack

{
  "result": {
    "status": "success",
    "output": "Tests passed"
  }
}
```

**Response:**
```json
{
  "ok": true
}
```

**Message is removed from inbox after ACK.**

---

#### 6. NACK Message

**Reject or extend lease:**

```bash
POST /api/agents/{agentId}/messages/{messageId}/nack

{
  "requeue": true
}
```

**Or extend lease:**
```json
{
  "extend_sec": 30
}
```

**Response:**
```json
{
  "ok": true,
  "status": "queued",
  "lease_until": null
}
```

---

#### 7. Reply to Message

**Send a correlated response:**

```bash
POST /api/agents/{agentId}/messages/{originalMessageId}/reply

{
  "version": "1.0",
  "type": "task.result",
  "subject": "test_results",
  "body": {
    "status": "passed",
    "duration_ms": 1234
  },
  "timestamp": "2025-11-14T10:05:00Z",
  "signature": {...}
}
```

**Response:**
```json
{
  "message_id": "reply-msg-uuid",
  "status": "queued"
}
```

**Reply automatically sets `correlation_id` to original message ID and sends to original sender.**

---

#### 8. Message Status

**Check message delivery status:**

```bash
GET /api/messages/{messageId}/status
```

**Response:**
```json
{
  "id": "msg-uuid",
  "status": "acked",
  "created_at": 1699999999,
  "updated_at": 1700000059,
  "attempts": 1,
  "lease_until": null,
  "acked_at": 1700000059
}
```

**Statuses:** `queued`, `leased`, `acked`, `failed`, `expired`

---

#### 9. Inbox Stats

**Get inbox statistics:**

```bash
GET /api/agents/{agentId}/inbox/stats
```

**Response:**
```json
{
  "total": 5,
  "queued": 3,
  "leased": 2,
  "acked": 0,
  "failed": 0
}
```

---

#### 10. Trust Management

**List trusted agents:**
```bash
GET /api/agents/{agentId}/trusted
```

**Add to trusted list:**
```bash
POST /api/agents/{agentId}/trusted
{
  "agent_id": "agent://trusted-agent"
}
```

**Remove from trusted list:**
```bash
DELETE /api/agents/{agentId}/trusted/{trustedAgentId}
```

---

#### 11. Webhook Configuration

**Configure webhook for push delivery:**

```bash
POST /api/agents/{agentId}/webhook

{
  "webhook_url": "https://myagent.com/webhook",
  "webhook_secret": "optional-custom-secret"
}
```

**Response:**
```json
{
  "agent_id": "agent://agent-abc123",
  "webhook_url": "https://myagent.com/webhook",
  "webhook_secret": "auto-generated-or-custom-secret"
}
```

**Get webhook configuration:**
```bash
GET /api/agents/{agentId}/webhook
```

**Response:**
```json
{
  "webhook_url": "https://myagent.com/webhook",
  "webhook_configured": true
}
```

**Remove webhook:**
```bash
DELETE /api/agents/{agentId}/webhook
```

**Response:**
```json
{
  "message": "Webhook removed",
  "webhook_configured": false
}
```

**💡 When webhook is configured:**
- Messages are **pushed immediately** to your webhook URL
- No polling needed
- Webhook delivery has automatic retry (3 attempts with exponential backoff)
- If webhook fails, message stays queued for polling (fallback)

---

#### 12. System Stats

**Get server statistics:**

```bash
GET /api/stats
```

**Response:**
```json
{
  "agents": {
    "total": 10,
    "online": 8,
    "offline": 2
  },
  "messages": {
    "total": 50,
    "queued": 10,
    "leased": 5,
    "acked": 30,
    "failed": 3,
    "expired": 2
  }
}
```

---

## Message Lifecycle

```
SEND → queued → PULL → leased → ACK → acked (deleted)
                         ↓
                        NACK → queued (retry)
                         ↓
                      (lease expires) → queued (auto-retry)
                         ↓
                      (TTL expires) → expired
```

## Integration Example

### Teleportation Integration

**1. Session Start - Register Agent**

```javascript
// .claude/hooks/session_start.mjs
const response = await fetch('http://localhost:8080/api/agents/register', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    agent_id: `agent://session-${SESSION_ID}`,
    agent_type: 'claude_session',
    metadata: {
      project_name: 'my-project',
      working_directory: process.cwd()
    }
  })
});

const { agent_id, secret_key } = await response.json();

// Save secret_key for signing messages
storeCredentials(agent_id, secret_key);
```

**2. Heartbeat Loop**

```javascript
// Start heartbeat every 60 seconds
setInterval(async () => {
  await fetch(`http://localhost:8080/api/agents/${agent_id}/heartbeat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      metadata: { last_activity: Date.now() }
    })
  });
}, 60000);
```

**3. Poll Inbox**

```javascript
// Poll inbox every 60 seconds
setInterval(async () => {
  const response = await fetch(`http://localhost:8080/api/agents/${agent_id}/inbox/pull`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ visibility_timeout: 60 })
  });

  if (response.status === 204) {
    // No messages
    return;
  }

  const { message_id, envelope } = await response.json();

  // Validate signature
  const valid = verifySignature(envelope, senderPublicKey);
  if (!valid) {
    console.error('Invalid signature');
    return;
  }

  // Process message
  await processMessage(envelope);

  // ACK
  await fetch(`http://localhost:8080/api/agents/${agent_id}/messages/${message_id}/ack`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ result: { status: 'processed' } })
  });
}, 60000);
```

## Webhook Push Delivery

**Webhooks provide real-time message push instead of polling.**

### Benefits

- ⚡ **Instant delivery** - Messages pushed immediately (no polling delay)
- 📉 **Lower latency** - Sub-second delivery instead of up to 60s polling interval
- 🔋 **Reduced load** - No constant polling requests to server
- ♻️ **Automatic retry** - 3 attempts with exponential backoff (1s, 2s, 4s)
- 🛡️ **Fallback to polling** - If webhook fails, message stays queued

### How It Works

```
1. Agent registers with webhook_url
   ↓
2. Message sent to agent
   ↓
3. ADMP server immediately POSTs to webhook_url
   ↓
4. If webhook returns 200 OK → Success ✓
   If webhook fails → Retry with backoff
   If all retries fail → Message stays in queue for polling
```

### Example: Webhook Receiver

**1. Start webhook receiver:**

```bash
node examples/webhook-receiver.js
# Listening on http://localhost:3000/webhook
```

**2. Register agent with webhook:**

```javascript
const agent = await fetch('http://localhost:8080/api/agents/register', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    agent_type: 'my_agent',
    webhook_url: 'http://localhost:3000/webhook',
    webhook_secret: 'my-secret-key'
  })
});

const { webhook_secret } = await agent.json();
// Save webhook_secret to verify incoming webhooks
```

**3. Implement webhook endpoint:**

```javascript
import express from 'express';
import crypto from 'crypto';

const app = express();
app.use(express.json());

app.post('/webhook', async (req, res) => {
  const payload = req.body;

  // Verify signature
  const signature = payload.signature;
  const hmac = crypto.createHmac('sha256', WEBHOOK_SECRET);
  hmac.update(JSON.stringify({ ...payload, signature: undefined }));
  const expected = hmac.digest('hex');

  if (signature !== expected) {
    return res.status(401).json({ error: 'Invalid signature' });
  }

  // Extract message
  const { envelope } = payload;
  console.log('Received message:', envelope.subject);

  // Process message
  await processMessage(envelope);

  // Acknowledge with 200 OK
  res.json({ ok: true });
});
```

**4. Send message (will be pushed immediately):**

```javascript
await fetch('http://localhost:8080/api/agents/agent://my_agent/messages', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    version: '1.0',
    from: 'agent://sender',
    to: 'agent://my_agent',
    subject: 'task',
    body: { command: 'run tests' },
    timestamp: new Date().toISOString(),
    signature: {...}
  })
});

// Webhook will receive message within milliseconds!
```

### Webhook Payload

When a message arrives, ADMP POSTs this payload to your webhook:

```json
{
  "event": "message.received",
  "message_id": "msg-abc123",
  "envelope": {
    "version": "1.0",
    "from": "agent://sender",
    "to": "agent://recipient",
    "subject": "task",
    "body": {...},
    "timestamp": "2025-11-14T10:00:00Z",
    "signature": {...}
  },
  "delivered_at": 1699999999000,
  "signature": "hmac-sha256-signature"  // If webhook_secret configured
}
```

### Webhook Headers

```
POST /webhook HTTP/1.1
Host: myagent.com
Content-Type: application/json
User-Agent: ADMP-Server/1.0
X-ADMP-Event: message.received
X-ADMP-Message-ID: msg-abc123
X-ADMP-Delivery-Attempt: 1
```

### Retry Behavior

| Attempt | Delay | Total Time |
|---------|-------|------------|
| 1       | 0s    | 0s         |
| 2       | 1s    | 1s         |
| 3       | 2s    | 3s         |
| Failed  | -     | Give up    |

After 3 failed attempts, message stays `queued` for polling.

### Webhook vs Polling

| Feature | Webhook | Polling |
|---------|---------|---------|
| **Latency** | <100ms | Up to 60s |
| **Server load** | Low (push only) | Higher (constant polling) |
| **Reliability** | Requires reachable endpoint | Always works |
| **Setup** | Configure webhook URL | No setup needed |
| **Fallback** | Falls back to polling | N/A |

### Best Practices

✅ **Do:**
- Return 200 OK quickly (process async if needed)
- Verify webhook signature
- Use HTTPS in production
- Log failed webhook deliveries
- Keep webhook endpoint highly available

❌ **Don't:**
- Block webhook response waiting for long processing
- Expose webhook without signature verification
- Use HTTP in production (security risk)
- Rely solely on webhooks (always support polling fallback)

### Examples

**Try it:**
```bash
# Terminal 1: Start ADMP server
npm start

# Terminal 2: Start webhook receiver
node examples/webhook-receiver.js

# Terminal 3: Run webhook example
node examples/webhook-push.js
```

## Deployment

### Docker

```bash
docker-compose up -d
```

### Environment Variables

See `.env.example` for all configuration options.

**Key settings:**

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | 8080 | Server port |
| `HEARTBEAT_INTERVAL_MS` | 60000 | Recommended heartbeat interval (1 min) |
| `HEARTBEAT_TIMEOUT_MS` | 300000 | Heartbeat timeout (5 min) |
| `MESSAGE_TTL_SEC` | 86400 | Message TTL (24 hours) |
| `CLEANUP_INTERVAL_MS` | 60000 | Background job interval (1 min) |
| `API_KEY_REQUIRED` | false | Enable API key auth |
| `MASTER_API_KEY` | - | Master API key (if auth enabled) |

### Production Checklist

- [ ] Set `NODE_ENV=production`
- [ ] Configure `MASTER_API_KEY` and set `API_KEY_REQUIRED=true`
- [ ] Set appropriate `CORS_ORIGIN`
- [ ] Monitor `/health` endpoint
- [ ] Set up log aggregation (JSON logs via `pino`)
- [ ] Configure resource limits (memory, CPU)
- [ ] Set up HTTPS reverse proxy (nginx, Caddy)

## Architecture

```
┌─────────────────┐         ┌──────────────────┐
│  Agent A        │────────▶│   ADMP Server    │
│  (Sender)       │         │   (Relay/Hub)    │
└─────────────────┘         └──────────────────┘
                                     │
                                     ▼
                            ┌──────────────────┐
                            │  Agent B Inbox   │
                            │  [msg1, msg2,..] │
                            └──────────────────┘
                                     │
                                     ▼
┌─────────────────┐         ┌──────────────────┐
│  Agent B        │◀────────│   PULL (lease)   │
│  (Receiver)     │         │   Process        │
└─────────────────┘         │   ACK            │
                            └──────────────────┘
```

## Security

### Message Signing

All messages **should** be signed with Ed25519:

```javascript
import nacl from 'tweetnacl';

// Create signing base
const base = `${timestamp}\n${bodyHash}\n${from}\n${to}\n${correlationId}`;

// Sign
const signature = nacl.sign.detached(
  Buffer.from(base),
  secretKey
);

envelope.signature = {
  alg: 'ed25519',
  kid: 'agent-id',
  sig: Buffer.from(signature).toString('base64')
};
```

### Signature Verification

Server verifies signatures on SEND:

```javascript
import { verifySignature } from './utils/crypto.js';

const valid = verifySignature(envelope, senderPublicKey);
if (!valid) {
  throw new Error('Invalid signature');
}
```

### Replay Protection

- Timestamp validation: ±5 minutes window
- TTL enforcement
- Lease-based processing prevents duplicate processing

## License

MIT

## Contributing

See CLAUDE.md for development workflow and methodology.

## Support

- **Documentation:** See `/whitepaper/v1.md` for full ADMP specification
- **Issues:** GitHub Issues
- **Email:** standards@agentdispatch.org
