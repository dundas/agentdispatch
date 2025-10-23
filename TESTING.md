# Testing the ADMP MVP

This guide walks you through testing the minimal working prototype we've built.

## What We've Built

✅ **Core Relay Server** (`packages/core/`)
- Express HTTP API with 5 endpoints
- PostgreSQL inbox implementation
- Bearer token authentication
- Lease-based message processing
- Background lease reclamation job

✅ **JavaScript Client SDK** (`packages/client-js/`)
- `send()` - Send messages
- `pull()` - Pull from inbox with lease
- `ack()` - Acknowledge processing
- `inboxStats()` - Get inbox statistics
- `waitForReply()` - Poll for correlated responses

✅ **Ping-Pong Example** (`examples/ping-pong/`)
- Complete SEND → PULL → ACK workflow
- Two agents: Alice (sender) and Bob (receiver)
- Demonstrates basic message exchange

---

## Quick Start (5 Minutes)

### Step 1: Start Services

```bash
# From repository root
npm run docker:up
```

This starts:
- **PostgreSQL** on port 5432 (with schema initialized)
- **ADMP Relay** on port 3030

Wait ~10 seconds for services to initialize.

### Step 2: Verify Services

```bash
# Check relay health
curl http://localhost:3030/health

# Expected output:
# {"status":"healthy","version":"1.0.0","uptime":5,"database":"connected"}
```

### Step 3: Run the Ping-Pong Example

```bash
cd examples/ping-pong
npm install
npm run example
```

### Expected Output

```
🚀 ADMP Ping-Pong Example

📤 [Alice] Sending message to Bob...
   ✓ Message sent: m-...

📬 [Bob] Checking inbox...
   ✓ Message received!
     From: agent://alice
     Subject: ping
     Body: {"message":"Hello, Bob!","timestamp":"..."}

⚙️  [Bob] Processing message...
   ✓ Processing complete

✅ [Bob] Acknowledging message...
   ✓ Message acknowledged and removed from inbox

📊 [Bob] Checking inbox stats...
   Ready messages: 0
   Leased messages: 0
   Dead messages: 0

✨ Example completed successfully!
```

**If you see this output, ADMP is working! 🎉**

---

## Manual Testing with curl

### Test 1: Send a Message

```bash
curl -X POST http://localhost:3030/v1/agents/test-bob/messages \
  -H "Authorization: Bearer dev-key-admp-local" \
  -H "Content-Type: application/json" \
  -d '{
    "type": "task.request",
    "from": "agent://test-alice",
    "subject": "hello",
    "body": {"message": "Hello from curl!"}
  }'

# Expected response:
# {"message_id":"m-..."}
```

### Test 2: Pull the Message

```bash
curl -X POST "http://localhost:3030/v1/agents/test-bob/inbox/pull?visibility_timeout=30" \
  -H "Authorization: Bearer dev-key-admp-local"

# Expected response (full message envelope):
# {
#   "id": "m-...",
#   "from": "agent://test-alice",
#   "to": "agent://test-bob",
#   "subject": "hello",
#   "body": {"message": "Hello from curl!"},
#   "status": "leased",
#   "lease_until": "...",
#   ...
# }
```

### Test 3: Acknowledge the Message

```bash
# Copy the message ID from Step 2
MESSAGE_ID="m-..."

curl -X POST "http://localhost:3030/v1/agents/test-bob/messages/$MESSAGE_ID/ack" \
  -H "Authorization: Bearer dev-key-admp-local"

# Expected response:
# {"status":"acked"}
```

### Test 4: Verify Inbox is Empty

```bash
curl -X POST "http://localhost:3030/v1/agents/test-bob/inbox/pull?visibility_timeout=30" \
  -H "Authorization: Bearer dev-key-admp-local"

# Expected: HTTP 204 No Content (empty inbox)
```

---

## Testing Lease Expiration

### Scenario: Pull Without Ack

```bash
# 1. Send a message
curl -X POST http://localhost:3030/v1/agents/bob/messages \
  -H "Authorization: Bearer dev-key-admp-local" \
  -H "Content-Type: application/json" \
  -d '{"type":"task.request","from":"agent://alice","subject":"test","body":{}}'

# 2. Pull with SHORT lease (10 seconds)
curl -X POST "http://localhost:3030/v1/agents/bob/inbox/pull?visibility_timeout=10" \
  -H "Authorization: Bearer dev-key-admp-local"

# Message is now leased for 10 seconds

# 3. Wait 15 seconds
sleep 15

# 4. Pull again - message should be available (lease expired)
curl -X POST "http://localhost:3030/v1/agents/bob/inbox/pull?visibility_timeout=30" \
  -H "Authorization: Bearer dev-key-admp-local"

# You should get the same message again!
```

This demonstrates **at-least-once delivery** - messages don't get lost if workers crash.

---

## Testing Idempotency

### Scenario: Send Same Message Twice

```bash
# Send message with idempotency key
curl -X POST http://localhost:3030/v1/agents/bob/messages \
  -H "Authorization: Bearer dev-key-admp-local" \
  -H "Content-Type: application/json" \
  -d '{
    "type":"task.request",
    "from":"agent://alice",
    "subject":"idempotent-test",
    "body":{"value":123},
    "idempotency_key":"test-key-001"
  }'

# Response: {"message_id":"m-abc123"}

# Send AGAIN with same idempotency key
curl -X POST http://localhost:3030/v1/agents/bob/messages \
  -H "Authorization: Bearer dev-key-admp-local" \
  -H "Content-Type: application/json" \
  -d '{
    "type":"task.request",
    "from":"agent://alice",
    "subject":"idempotent-test",
    "body":{"value":123},
    "idempotency_key":"test-key-001"
  }'

# Response: {"message_id":"m-abc123"}
# ☝️ SAME message ID! No duplicate created.

# Verify only ONE message in inbox
curl http://localhost:3030/v1/agents/bob/inbox/stats \
  -H "Authorization: Bearer dev-key-admp-local"

# Response: {"ready":1,"leased":0,"dead":0,...}
```

---

## Testing Inbox Stats

```bash
# Get statistics for an agent
curl http://localhost:3030/v1/agents/bob/inbox/stats \
  -H "Authorization: Bearer dev-key-admp-local"

# Response:
# {
#   "ready": 3,      # Messages available to pull
#   "leased": 1,     # Messages currently being processed
#   "dead": 0,       # Messages that failed max attempts
#   "oldest_age_sec": 45  # Age of oldest unprocessed message
# }
```

---

## Direct Database Inspection

```bash
# Connect to PostgreSQL
docker exec -it admp-postgres psql -U admp -d admp

# View all messages
SELECT id, from_agent, to_agent_id, subject, status, created_at
FROM message
ORDER BY created_at DESC
LIMIT 10;

# View inbox for specific agent
SELECT * FROM message
WHERE to_agent_id = 'bob'
  AND status = 'delivered'
ORDER BY created_at ASC;

# View leased messages with expiry
SELECT id, to_agent_id, subject, status, lease_until
FROM message
WHERE status = 'leased';

# Exit psql
\q
```

---

## Troubleshooting

### Services Won't Start

```bash
# Check if ports are already in use
lsof -i :3030  # Relay
lsof -i :5432  # PostgreSQL

# View logs
docker compose -f deploy/docker-compose.yml logs relay
docker compose -f deploy/docker-compose.yml logs postgres
```

### "Database not connected"

```bash
# Check PostgreSQL health
docker exec admp-postgres pg_isready -U admp

# Restart services
npm run docker:down
npm run docker:up
```

### "Unauthorized" Error

Make sure you're using the correct API key:
```bash
-H "Authorization: Bearer dev-key-admp-local"
```

### Messages Stuck in "leased"

Manually reclaim expired leases:
```bash
curl -X POST "http://localhost:3030/v1/agents/bob/inbox/reclaim" \
  -H "Authorization: Bearer dev-key-admp-local"
```

Or wait 30 seconds for the background job to run.

---

## Performance Testing

### Load Test with curl

```bash
# Send 100 messages rapidly
for i in {1..100}; do
  curl -X POST http://localhost:3030/v1/agents/bob/messages \
    -H "Authorization: Bearer dev-key-admp-local" \
    -H "Content-Type: application/json" \
    -d "{\"type\":\"task.request\",\"from\":\"agent://alice\",\"subject\":\"msg-$i\",\"body\":{\"index\":$i}}" &
done

wait

# Check inbox stats
curl http://localhost:3030/v1/agents/bob/inbox/stats \
  -H "Authorization: Bearer dev-key-admp-local"

# Should show ~100 ready messages
```

---

## What's Next?

After verifying the MVP works:

1. **Add NACK and REPLY operations** (Priority 1.5)
2. **Implement policy engine** (Priority 2)
3. **Add Ed25519 signatures** (Priority 2)
4. **Build Python SDK** (Priority 3)
5. **Create task orchestration example** (Priority 3)
6. **Add comprehensive tests** (Priority 4)

See the PRD (`tasks/0001-prd-admp-v1-core-implementation.md`) for the full roadmap.

---

## Success Criteria

✅ All curl tests pass
✅ Ping-pong example runs successfully
✅ Health check returns healthy
✅ Messages persist in database
✅ Lease expiration works correctly
✅ Idempotency prevents duplicates

**If all criteria met: MVP is complete!** 🚀
