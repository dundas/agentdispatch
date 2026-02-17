# AgentDispatch Runbook (Local + Production)

This runbook answers: "what needs to be running" for AgentDispatch to be tested and deployed effectively.

## System Pieces (What Talks To What)

**Runs as services:**
- **ADMP Server** (`src/`) - Express.js HTTP API providing agent registration, message inbox (send/pull/ack/nack), groups, ephemeral messages, and webhook push delivery. Exposes REST API on port `8080` with Swagger UI at `/docs`.
- **Brain** (`brain/`) - Bun-based self-improving monitor that watches hub health, tracks agent activity, and can implement improvements via Teleportation. Runs on port `8081` with a webhook receiver.

**Background jobs (inside ADMP Server):**
- **Lease reclamation** - Requeues messages whose lease expired (agent crashed mid-processing)
- **Message expiration** - Marks old messages as `expired` based on `ttl_sec`
- **Expired message cleanup** - Deletes expired/acked messages older than 1 hour
- **Ephemeral purge sweep** - Strips body from ephemeral messages past their TTL
- **Heartbeat checker** - Marks agents offline when heartbeat times out

All background jobs run on the `CLEANUP_INTERVAL_MS` interval (default: 60s).

**External dependencies:**
- **Mech Storage** (`https://storage.mechdna.net`) - Remote NoSQL backend for persistent storage (production). Optional; in-memory storage used by default for development.
- **Teleportation** (`https://relay.teleportation.io`) - Code change relay for Brain's self-improvement (Brain only, optional)
- **ThinkBrowse** (`https://api.thinkbrowse.io`) - Research API for Brain's analysis (Brain only, optional)

---

## Local Testing (What Must Be Running)

### Minimum to test core ADMP messaging

1. **ADMP Server** running on `http://localhost:8080`

That's it. The server uses in-memory storage by default, so no external databases or services are needed.

Docs: `openapi.yaml:1` | Swagger UI: `http://localhost:8080/docs`

### Full local end-to-end (closest to real usage)

In addition to the minimum above:

2. **Brain** running on `http://localhost:8081` (monitors hub, sends heartbeats)
3. **Mech Storage** credentials configured (for persistent storage testing)

Environment variables required for full E2E:
- `STORAGE_BACKEND=mech` (switches from memory to Mech)
- `MECH_APP_ID` (from https://mechdna.net)
- `MECH_API_KEY` (from https://mechdna.net)

### Local bring-up checklist

**1) Configure environment**

```bash
# From repo root
cp .env.example .env
# Edit .env — defaults work for local dev (memory storage, no API key required)
```

Required vars for minimum setup: none (defaults work).

**2) Install dependencies**

```bash
bun install
```

**3) Start ADMP Server**

```bash
# Development mode with auto-reload
bun run dev

# Or directly
node --watch src/index.js

# Or production mode
node src/index.js
```

Server starts on `http://localhost:8080`.

**4) Start Brain (optional)**

```bash
cd brain
cp .env.example .env
# Edit .env — set BACKEND_URL=http://localhost:8080
bun install
bun run index.ts
```

Brain starts on `http://localhost:8081`.

**5) Smoke checks**

```bash
# Health check
curl http://localhost:8080/health
# Expected: {"status":"healthy","timestamp":"...","version":"1.0.0"}

# API docs load
open http://localhost:8080/docs

# Register a test agent
curl -X POST http://localhost:8080/api/agents \
  -H "Content-Type: application/json" \
  -d '{"agent_id":"agent://test-agent","name":"Test Agent","capabilities":["test"]}'
# Expected: 201 with agent details including public_key and secret_key

# List agents
curl http://localhost:8080/api/agents
# Expected: 200 with array containing the test agent

# System stats
curl http://localhost:8080/api/stats
# Expected: {"agents":{"total":1,...},"messages":{...},"groups":{...}}
```

**6) Run tests**

```bash
bun run test
# Or: node --test src/server.test.js
# Expected: 30 tests passing
```

---

## Production Testing (What Must Be Running)

### Production deployment (Fly.io)

- **ADMP Server** deployed to Fly.io (`agentdispatch.fly.dev`)
- **Mech Storage** configured with production credentials
- **Secrets** set via `fly secrets set`:
  - `MECH_APP_ID` - Mech Storage application ID
  - `MECH_API_KEY` - Mech Storage API key

Production environment variables (set in `fly.toml`):
- `STORAGE_BACKEND=mech`
- `NODE_ENV=production`
- `PORT=8080`
- `CORS_ORIGIN=*`
- `MESSAGE_TTL_SEC=86400`
- `CLEANUP_INTERVAL_MS=60000`

Docs: `fly.toml:1`

### Deploy to production

```bash
# Deploy ADMP Server
fly deploy

# Set production secrets (one-time)
fly secrets set MECH_APP_ID=<value> MECH_API_KEY=<value>

# Check deployment status
fly status
```

### Production smoke test checklist

1. **Server is up:**
   ```bash
   curl https://agentdispatch.fly.dev/health
   # Expected: {"status":"healthy","timestamp":"...","version":"1.0.0"}
   ```

2. **API docs accessible:**
   ```bash
   curl -s -o /dev/null -w "%{http_code}" https://agentdispatch.fly.dev/docs
   # Expected: 200
   ```

3. **Agent registration works:**
   ```bash
   curl -X POST https://agentdispatch.fly.dev/api/agents \
     -H "Content-Type: application/json" \
     -d '{"agent_id":"agent://smoke-test","name":"Smoke Test","capabilities":["test"]}'
   # Expected: 201
   ```

4. **Message send+pull+ack flow:**
   ```bash
   # Register sender
   SENDER=$(curl -s -X POST https://agentdispatch.fly.dev/api/agents \
     -H "Content-Type: application/json" \
     -d '{"agent_id":"agent://sender","name":"Sender","capabilities":["send"]}')

   # Register receiver
   RECEIVER=$(curl -s -X POST https://agentdispatch.fly.dev/api/agents \
     -H "Content-Type: application/json" \
     -d '{"agent_id":"agent://receiver","name":"Receiver","capabilities":["receive"]}')

   # Send a message (use secret_key from sender registration to sign)
   curl -X POST https://agentdispatch.fly.dev/api/agents/agent%3A%2F%2Freceiver/inbox \
     -H "Content-Type: application/json" \
     -d '{
       "envelope": {
         "version": "1.0",
         "from": "agent://sender",
         "to": "agent://receiver",
         "subject": "smoke.test",
         "timestamp": "'$(date -u +%Y-%m-%dT%H:%M:%SZ)'",
         "body": {"hello": "world"}
       }
     }'
   # Expected: 201

   # Pull message
   curl -X POST https://agentdispatch.fly.dev/api/agents/agent%3A%2F%2Freceiver/inbox/pull
   # Expected: 200 with message

   # Ack message (use message id from pull response)
   curl -X POST "https://agentdispatch.fly.dev/api/agents/agent%3A%2F%2Freceiver/inbox/<message_id>/ack" \
     -H "Content-Type: application/json" \
     -d '{"result": {"status": "processed"}}'
   # Expected: 200
   ```

5. **Stats endpoint works:**
   ```bash
   curl https://agentdispatch.fly.dev/api/stats
   # Expected: 200 with agents/messages/groups counts
   ```

6. **Cleanup (delete smoke test agents):**
   ```bash
   curl -X DELETE https://agentdispatch.fly.dev/api/agents/agent%3A%2F%2Fsmoke-test
   curl -X DELETE https://agentdispatch.fly.dev/api/agents/agent%3A%2F%2Fsender
   curl -X DELETE https://agentdispatch.fly.dev/api/agents/agent%3A%2F%2Freceiver
   ```

---

## Docker Deployment

### Run with Docker Compose

```bash
# Start all services (ADMP Server + Brain)
docker-compose up -d

# Start only ADMP Server
docker-compose up -d admp-server

# View logs
docker-compose logs -f admp-server

# Stop
docker-compose down
```

### Run ADMP Server standalone

```bash
docker build -t admp-server .
docker run -p 8080:8080 --env-file .env admp-server
```

---

## Notes / Common Gotchas

- **Storage backend mismatch:** If you switch `STORAGE_BACKEND` from `memory` to `mech` (or vice versa), all data from the previous backend is lost. Memory storage is wiped on server restart.

- **Mech Storage 1000-document limit:** All list/sweep operations on Mech Storage cap at 1000 documents per query. High-volume deployments may need multiple sweep cycles for cleanup jobs to catch everything.

- **Signature verification skipped for unregistered senders:** If a sender agent isn't registered on the hub, signature verification is silently skipped. Only registered agents' signatures are validated.

- **Ephemeral TTL vs message TTL:** Two distinct TTL systems exist:
  - `envelope.ttl_sec` / `MESSAGE_TTL_SEC` - Controls message expiration lifecycle (`queued` -> `expired` status)
  - `options.ttl` (ephemeral) - Controls body purge timing (body stripped, metadata preserved, returns `410 Gone`)

- **Port conflicts:** Default port `8080` may conflict with other services. Override with `PORT` env var.

- **Brain requires ADMP Server:** Brain depends on the hub being healthy. If the hub is down, Brain will log errors but continue retrying on its health check interval.

- **Tests use in-memory storage:** The test suite (`src/server.test.js`) always uses memory storage regardless of `STORAGE_BACKEND` setting, so tests work without Mech credentials.

- **Node.js version:** Requires Node.js >= 18.0.0 (for native `fetch`, test runner, and `--watch` flag). Brain requires Bun.

---

*Runbook generated 2026-02-17 by Claude Code*
