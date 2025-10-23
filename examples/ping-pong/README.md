# Ping-Pong Example

A minimal example demonstrating the basic ADMP workflow: SEND → PULL → ACK.

## What This Shows

1. **Alice** (sender agent) sends a message to **Bob's** inbox
2. **Bob** (receiver agent) pulls the message from his inbox (with 30-second lease)
3. **Bob** processes the message
4. **Bob** acknowledges the message (removing it from inbox)

## Running the Example

### Prerequisites

Make sure ADMP services are running:

```bash
# From repository root
npm run docker:up

# Verify relay is healthy
curl http://localhost:3030/health
```

### Run the Example

```bash
# Install dependencies
npm install

# Run the example
npm run example
```

### Expected Output

```
🚀 ADMP Ping-Pong Example

📤 [Alice] Sending message to Bob...
   ✓ Message sent: m-123e4567-e89b-12d3-a456-426614174000

📬 [Bob] Checking inbox...
   ✓ Message received!
     From: agent://alice
     Subject: ping
     Body: {"message":"Hello, Bob!","timestamp":"2025-10-23T..."}

⚙️  [Bob] Processing message...
   ✓ Processing complete

✅ [Bob] Acknowledging message...
   ✓ Message acknowledged and removed from inbox

📊 [Bob] Checking inbox stats...
   Ready messages: 0
   Leased messages: 0
   Dead messages: 0

✨ Example completed successfully!

📝 Summary:
   1. Alice sent a message to Bob's inbox
   2. Bob pulled the message (with 30s lease)
   3. Bob processed the message
   4. Bob acknowledged the message (removed from inbox)

🎉 ADMP workflow complete!
```

## What's Happening Behind the Scenes

```
┌─────────┐                          ┌─────────┐                          ┌─────────┐
│  Alice  │                          │  Relay  │                          │   Bob   │
└────┬────┘                          └────┬────┘                          └────┬────┘
     │                                    │                                     │
     │ 1. POST /v1/agents/bob/messages    │                                     │
     ├───────────────────────────────────>│                                     │
     │    (message stored, status='delivered')                                  │
     │                                    │                                     │
     │ 2. HTTP 201 (message_id)           │                                     │
     │<───────────────────────────────────┤                                     │
     │                                    │                                     │
     │                                    │  3. POST /v1/agents/bob/inbox/pull  │
     │                                    │<────────────────────────────────────┤
     │                                    │     (lease for 30 seconds)          │
     │                                    │                                     │
     │                                    │  4. HTTP 200 (message)              │
     │                                    ├────────────────────────────────────>│
     │                                    │     (status='leased')               │
     │                                    │                                     │
     │                                    │  5. POST .../messages/{id}/ack      │
     │                                    │<────────────────────────────────────┤
     │                                    │                                     │
     │                                    │  6. HTTP 200                        │
     │                                    ├────────────────────────────────────>│
     │                                    │     (message deleted)               │
```

## Key Concepts Demonstrated

### 1. Message Envelope
Every ADMP message has a standard structure:
```typescript
{
  to: 'agent://bob',
  type: 'task.request',
  subject: 'ping',
  body: { message: 'Hello, Bob!' }
}
```

### 2. Lease-Based Processing
When Bob pulls a message, it's "leased" for 30 seconds:
- No other worker can pull it during this time
- If Bob crashes, the lease expires and the message requeues
- This prevents message loss

### 3. Explicit Acknowledgment
Bob must explicitly ACK the message:
- ACK = "I processed this successfully, remove it"
- If Bob doesn't ACK, message stays in inbox

### 4. At-Least-Once Delivery
If Bob pulls but never ACKs:
- Lease expires after 30 seconds
- Message returns to "delivered" status
- Another worker can pull it
- Guarantees the message is eventually processed

## Next Steps

- See [request-response example](../request-response/) for correlation IDs
- See [task-orchestration example](../task-orchestration/) for multi-agent workflows
- Read [Architecture docs](../../docs/architecture.md) for deep dive

## Troubleshooting

### "Connection refused"
Make sure services are running:
```bash
npm run docker:up
curl http://localhost:3030/health
```

### "No messages in inbox"
Check if the message was actually sent:
```bash
curl -H "Authorization: Bearer dev-key-admp-local" \
  "http://localhost:3030/v1/agents/bob/inbox/stats"
```

### Messages stuck in "leased" state
Reclaim expired leases:
```bash
curl -X POST -H "Authorization: Bearer dev-key-admp-local" \
  "http://localhost:3030/v1/agents/bob/inbox/reclaim"
```
