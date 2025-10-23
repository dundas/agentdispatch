# Request/Response Example

A simple ping-pong example demonstrating the basic ADMP request/response pattern.

## What This Example Shows

1. **Client agent** sends a message to server
2. **Server agent** pulls the message from its inbox
3. Server processes the request
4. **Server agent** replies with a correlated response
5. **Client agent** receives and displays the response

## Architecture

```
┌──────────┐                    ┌─────────────┐                    ┌──────────┐
│  Client  │                    │  ADMP Relay │                    │  Server  │
│  Agent   │                    │  (HTTP API) │                    │  Agent   │
└────┬─────┘                    └──────┬──────┘                    └────┬─────┘
     │                                  │                                │
     │  1. SEND (type: task.request)   │                                │
     ├─────────────────────────────────>│                                │
     │     correlation_id: abc-123      │                                │
     │                                  │                                │
     │                                  │  2. PULL                       │
     │                                  │<───────────────────────────────┤
     │                                  │    (leases message)            │
     │                                  │                                │
     │                                  │  3. REPLY                      │
     │                                  │<───────────────────────────────┤
     │                                  │    (type: task.result)         │
     │                                  │    correlation_id: abc-123     │
     │                                  │                                │
     │  4. PULL (check for replies)     │                                │
     │<─────────────────────────────────┤                                │
     │     (receives correlated reply)  │                                │
     │                                  │                                │
     │  5. ACK                          │                                │
     ├─────────────────────────────────>│                                │
     │                                  │                                │
```

## Running the Example

### 1. Start ADMP Services

```bash
# From repository root
npm run docker:up

# Wait for services to be healthy
docker-compose -f deploy/docker-compose.yml ps
```

### 2. Install Dependencies

```bash
cd examples/request-response
npm install
```

### 3. Run the Example

```bash
npm run example
```

### Expected Output

```
🚀 Starting Request/Response Example...

[Client] Registering as agent: ping-client
[Server] Registering as agent: pong-server
[Server] Listening for messages...

[Client] Sending ping message...
  → to: pong-server
  → subject: ping
  → correlation_id: abc-123-def-456
  ✓ Message sent: m-123e4567-e89b-12d3-a456-426614174000

[Server] Received message:
  ← from: ping-client
  ← subject: ping
  ← body: { message: "Hello, Server!" }
  → Processing...

[Server] Sending reply...
  → type: task.result
  → correlation_id: abc-123-def-456
  ✓ Reply sent

[Client] Polling for reply...
[Client] Received reply:
  ← from: pong-server
  ← body: { message: "Hello, Client! Received your ping." }
  ← correlation_id: abc-123-def-456 ✓ matches
  → Acknowledging message

✅ Example completed successfully!

Summary:
- Round-trip time: 142ms
- Messages sent: 2
- Messages received: 2
- Acknowledgments: 2
```

## Key Code Snippets

### Client: Sending a Request

```typescript
import { ADMPClient } from '@agent-dispatch/client';

const client = new ADMPClient({
  agentId: 'ping-client',
  relayUrl: 'http://localhost:3030',
  apiKey: 'dev-key-admp-local'
});

// Send request
const messageId = await client.send({
  to: 'pong-server',
  type: 'task.request',
  subject: 'ping',
  body: { message: 'Hello, Server!' },
  correlationId: 'abc-123'
});

// Poll for reply
const reply = await client.waitForReply(messageId, { timeout: 5000 });
console.log('Reply received:', reply);
```

### Server: Processing and Replying

```typescript
const server = new ADMPClient({
  agentId: 'pong-server',
  relayUrl: 'http://localhost:3030',
  apiKey: 'dev-key-admp-local'
});

// Pull message from inbox
const message = await server.pull({ leaseDuration: 30 });

if (message) {
  // Process the request
  const result = processRequest(message.body);

  // Send reply
  await server.reply(message, {
    result: { message: 'Hello, Client! Received your ping.' }
  });
}
```

## What's Happening Behind the Scenes

1. **SEND**: Client calls `POST /v1/agents/pong-server/messages`
   - Relay validates the message envelope
   - Inserts into `message` table with `status='delivered'`
   - Returns message ID

2. **PULL**: Server calls `POST /v1/agents/pong-server/inbox/pull`
   - Relay finds the oldest `delivered` message for this agent
   - Updates status to `leased`, sets `lease_until = now() + 30s`
   - Returns the message

3. **REPLY**: Server calls `POST /v1/agents/pong-server/messages/{id}/reply`
   - Relay creates a new message with:
     - `from: pong-server`
     - `to: ping-client`
     - `correlation_id: abc-123` (copied from original)
     - `type: task.result`
   - Marks original message as `acked`

4. **Client PULL**: Client calls `POST /v1/agents/ping-client/inbox/pull`
   - Relay returns the reply message (matches correlation ID)

5. **ACK**: Client calls `POST /v1/agents/ping-client/messages/{reply-id}/ack`
   - Relay deletes the message from inbox

## Extending This Example

### Add Error Handling

```typescript
try {
  const reply = await client.waitForReply(messageId, { timeout: 5000 });
  if (reply.error) {
    console.error('Server returned error:', reply.error);
  }
} catch (err) {
  if (err.code === 'TIMEOUT') {
    console.error('No reply received within 5 seconds');
  }
}
```

### Add Idempotency

```typescript
const messageId = await client.send({
  // ... other fields
  idempotencyKey: `ping-${Date.now()}`
});

// If you send again with the same key, you get back the same message ID
```

### Add Signatures

```typescript
const client = new ADMPClient({
  agentId: 'ping-client',
  relayUrl: 'http://localhost:3030',
  apiKey: 'dev-key-admp-local',
  signingKey: loadEd25519PrivateKey()
});

// All messages automatically signed
```

## Next Steps

- **Try the Task Orchestration example** to see multi-agent coordination
- **Read the [Architecture docs](../../docs/architecture.md)** to understand message lifecycle
- **Explore the [API reference](../../docs/api-reference/)** for all available operations
- **Check out the [Detach integration](../detach-integration/)** for a real-world use case

## Troubleshooting

### "Connection refused" error

Make sure ADMP services are running:
```bash
npm run docker:up
curl http://localhost:3030/health
```

### "Agent not found" error

The relay might not know about your agent. Check the database:
```bash
docker exec -it admp-postgres psql -U admp -c "SELECT * FROM agent;"
```

### Messages not being pulled

Check the message status:
```bash
curl -H "Authorization: Bearer dev-key-admp-local" \
  "http://localhost:3030/v1/agents/pong-server/inbox/stats"
```

If messages are `leased` but expired, reclaim them:
```bash
curl -X POST -H "Authorization: Bearer dev-key-admp-local" \
  "http://localhost:3030/v1/agents/pong-server/inbox/reclaim"
```
