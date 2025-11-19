## Relevant Files

- `src/index.js` - Production entry point; starts server with background jobs and graceful shutdown.
- `src/server.js` - Express app configuration, route wiring, middleware, and lifecycle exports.
- `src/routes/agents.js` - HTTP routes for agent registration, heartbeat, and agent queries.
- `src/routes/inbox.js` - HTTP routes for send, pull, ack, nack, reply, and inbox stats.
- `src/services/agent.service.js` - Agent lifecycle logic (registration, heartbeat, trust lists, webhooks).
- `src/services/inbox.service.js` - Inbox/message lifecycle, leasing, ack/nack, webhook dispatch.
- `src/services/webhook.service.js` - Webhook delivery, retries, and signature verification.
- `src/storage/index.js` - Storage backend selector; imports appropriate storage implementation.
- `src/storage/memory.js` - In-memory storage implementation; reference for defining a pluggable Storage interface.
- `src/middleware/auth.js` - Agent authentication and optional API key enforcement.
- `src/utils/crypto.js` - Ed25519 keypair generation, message signing, signature and timestamp validation.
- `openapi.yaml` - Canonical API contract for ADMP HTTP endpoints and schemas.
- `examples/basic-usage.js` - End-to-end registration and messaging example; useful for integration test scenarios.
- `examples/webhook-push.js` - Webhook push example; reference for webhook integration tests.
- `examples/webhook-receiver.js` - Example webhook receiver; reference for webhook signature behavior.
- `src/server.test.js` - Integration tests covering registration, messaging, signatures, and error cases.
- `README.md` - Project documentation including Quick Start, API docs, and test instructions.
- `package.json` - NPM configuration with start/dev/test scripts.
- `src/services/agent.service.test.js` - Tests for agent lifecycle behavior (to be created).
- `src/services/inbox.service.test.js` - Tests for send/pull/ack/nack/lease semantics (to be created).
- `src/services/webhook.service.test.js` - Tests for webhook delivery and retry logic (to be created).

### Notes

- Prefer **integration-style tests** that exercise the HTTP API where practical (`node --test` via `npm test`).
- Place test files alongside the modules they cover when reasonable (e.g., `src/server.js` and `src/server.test.js`).
- Keep `openapi.yaml` and tests in sync; when changing API behavior or schemas, update both.

## Tasks

- [x] 1.0 Establish test harness and core integration tests for ADMP
  - [x] 1.1 Add node:test-based test runner wiring and npm script configuration
  - [x] 1.2 Write integration tests for server boot, /health, and /api/stats
  - [x] 1.3 Write integration tests for agent registration, heartbeat, and get agent
  - [x] 1.4 Write integration tests for send → pull → ack → status flows
  - [x] 1.5 Add negative tests for invalid signatures, timestamps, and unknown recipients
  - [x] 1.6 Document how to run tests locally and in CI

- [ ] 2.0 Introduce a pluggable Storage interface and refactor existing in-memory storage
  - [ ] 2.1 Design and document a Storage interface based on current MemoryStorage methods
  - [ ] 2.2 Refactor src/storage/memory.js to implement the new Storage interface
  - [ ] 2.3 Add configuration to select storage backend via environment variable (e.g., STORAGE_BACKEND)
  - [ ] 2.4 Update services (agent, inbox, webhook) to depend on the Storage abstraction instead of MemoryStorage directly
  - [ ] 2.5 Add tests to ensure behavior parity between the abstracted storage and existing in-memory behavior

- [ ] 3.0 Implement and wire a persistent storage backend suitable for production
  - [ ] 3.1 Choose and document first persistent backend (e.g., Postgres or SQLite) and rationale
  - [ ] 3.2 Define database schema for agents, messages, and inbox queries
  - [ ] 3.3 Implement a DB-backed Storage implementation that satisfies the Storage interface
  - [ ] 3.4 Add configuration and connection management for the DB backend (env vars, pooling, migrations)
  - [ ] 3.5 Add integration tests that run against the DB backend for core flows (register, send, pull, ack, stats)
  - [ ] 3.6 Update deployment docs (README, DOCKER.md, DEPLOY_DIGITALOCEAN.md) to cover the DB mode

- [ ] 4.0 Harden authentication, signatures, and trust policies for message flows
  - [ ] 4.1 Enforce signature presence and validity by default on message send operations
  - [ ] 4.2 Enforce timestamp validation on incoming messages using validateTimestamp
  - [ ] 4.3 Implement and document trust-list enforcement for recipients with trusted_agents configured
  - [ ] 4.4 Review and refine API key behavior (API_KEY_REQUIRED, MASTER_API_KEY) and production defaults
  - [ ] 4.5 Add tests for auth and trust failure cases (invalid key, untrusted sender, expired timestamp, unsigned messages)
  - [ ] 4.6 Update security section in README to reflect hardened behavior and configuration knobs

- [ ] 5.0 Improve operations, observability, and CI/CD around the ADMP server
  - [ ] 5.1 Ensure health and stats endpoints are documented for use in load balancers and orchestrators
  - [ ] 5.2 Add basic metrics or clear guidance for exporting metrics (e.g., Prometheus or log-based metrics)
  - [ ] 5.3 Review and update Docker and deployment configs for production defaults (NODE_ENV, API_KEY_REQUIRED, DB config)
  - [ ] 5.4 Enhance GitHub workflows to run tests on PRs and main and optionally build Docker images
  - [ ] 5.5 Add operational runbooks or notes (e.g., common failure modes, backup/restore for DB)
  - [ ] 5.6 Validate production checklist from the README against the implemented features
