# PRD: ADMP v1.0 Core Implementation

**Document ID:** 0001-prd-admp-v1-core-implementation
**Created:** 2025-10-23
**Status:** Draft
**Target Release:** v1.0.0
**Priority:** P0 (Critical)

---

## Introduction/Overview

The Agent Dispatch Messaging Protocol (ADMP) v1.0 is a universal inbox standard for autonomous AI agents. This PRD defines the implementation requirements for the initial v1.0 release, which establishes the core HTTP-based messaging protocol, security primitives, client SDKs, and developer tooling needed for production adoption.

**Problem Statement**: Autonomous agents currently lack a standardized, reliable way to communicate with each other. Teams build ad-hoc REST APIs, polling loops, or chat integrations that lack delivery guarantees, structured envelopes, and auditability.

**Solution**: ADMP provides a universal messaging layer where every agent has an inbox, every message follows a standard contract, and delivery semantics are deterministic and secure regardless of transport.

---

## Goals

1. **Deliver a production-ready HTTP messaging protocol** that teams can deploy and use immediately
2. **Provide at-least-once delivery guarantees** with explicit acknowledgment semantics
3. **Establish security-by-default** through signatures, authentication, and policy enforcement
4. **Enable rapid adoption** through client SDKs (JavaScript/TypeScript, Python), comprehensive documentation, and working examples
5. **Create foundation for federation** (v1.1+) through key management and signature infrastructure
6. **Demonstrate real-world value** through concrete examples (Detach integration, multi-agent workflows)

---

## User Stories

### Primary Users: Backend/Infrastructure Engineers

**US-1**: As a **backend engineer**, I want to send a message to another agent's inbox so that I can delegate work reliably without blocking.

**US-2**: As a **backend engineer**, I want to pull messages from my agent's inbox and process them with a lease so that I won't lose messages if my worker crashes.

**US-3**: As a **backend engineer**, I want to acknowledge message processing so that the relay knows the work is complete and won't retry.

**US-4**: As a **backend engineer**, I want to send correlated responses so that request/response patterns work naturally.

### Secondary Users: Agent Developers

**US-5**: As an **agent developer**, I want a client SDK that handles authentication, retries, and signatures so that I don't have to implement the protocol from scratch.

**US-6**: As an **agent developer**, I want to deploy ADMP locally with Docker in under 5 minutes so that I can prototype quickly.

**US-7**: As an **agent developer**, I want clear examples showing common patterns so that I understand how to build with ADMP.

### Tertiary Users: Platform/Security Engineers

**US-8**: As a **security engineer**, I want all messages to be signed and authenticated so that I can verify message origin and prevent tampering.

**US-9**: As a **platform engineer**, I want policy-based access control so that I can restrict which agents can send to which targets.

**US-10**: As a **platform engineer**, I want observability built-in (logs, metrics) so that I can monitor message flow in production.

---

## Functional Requirements

### Core Protocol (Priority 1)

#### Message Envelope

**FR-1**: The system MUST support a canonical JSON message envelope with the following required fields:
- `version` (string, default "1.0")
- `id` (UUID v4)
- `type` (string, enum: task.request, task.result, task.error, event)
- `from` (agent URI, format: `agent://[agent-id]`)
- `to` (agent URI, format: `agent://[agent-id]`)
- `subject` (string, max 255 chars)
- `body` (JSON object, max 1MB)
- `timestamp` (ISO8601 datetime with timezone)

**FR-2**: The system MUST support the following optional envelope fields:
- `correlation_id` (string, for request/response pairing)
- `headers` (JSON object, for metadata)
- `ttl_sec` (integer, default 86400, max 604800)
- `signature` (object with `alg`, `kid`, `sig`)

**FR-3**: The system MUST validate all message envelopes against a JSON Schema before accepting them.

**FR-4**: The system MUST reject messages with:
- Missing required fields → HTTP 422
- Invalid field types → HTTP 422
- Body size > 1MB → HTTP 413
- TTL > 7 days → HTTP 422

#### HTTP API Endpoints

**FR-5**: The system MUST implement `POST /v1/agents/{agentId}/messages` (SEND operation) that:
- Accepts a message envelope in request body
- Validates authentication (Bearer token or HMAC signature)
- Checks policy authorization (FR-40+)
- Inserts message into database with `status='delivered'`
- Returns HTTP 201 with `{"message_id": "<uuid>"}`

**FR-6**: The system MUST implement `POST /v1/agents/{agentId}/inbox/pull` (PULL operation) that:
- Accepts optional query param `visibility_timeout` (default: 30, max: 3600)
- Finds oldest message with `status='delivered'` for the agent
- Updates message to `status='leased'`, sets `lease_until = now() + timeout`
- Returns HTTP 200 with full message envelope
- Returns HTTP 204 if inbox is empty

**FR-7**: The system MUST implement `POST /v1/agents/{agentId}/messages/{messageId}/ack` (ACK operation) that:
- Verifies message exists and is leased to the requesting agent
- Updates message to `status='acked'`, sets `acked_at = now()`
- Returns HTTP 200 with `{"status": "acked"}`
- Returns HTTP 404 if message not found or lease expired

**FR-8**: The system MUST implement `POST /v1/agents/{agentId}/messages/{messageId}/nack` (NACK operation) that:
- Accepts optional query param `extend` (seconds to extend lease)
- If `extend` provided: extends `lease_until` by that duration
- If `extend` not provided: sets `status='delivered'`, clears lease, increments `attempts`
- Returns HTTP 200
- Returns HTTP 404 if message not found

**FR-9**: The system MUST implement `POST /v1/agents/{agentId}/messages/{messageId}/reply` (REPLY operation) that:
- Accepts request body with `result` (object) or `error` (object with code/message)
- Creates a new message with:
  - `from`: current agent
  - `to`: original message's `from`
  - `correlation_id`: original message's `correlation_id` or `id`
  - `type`: `task.result` or `task.error`
  - `body`: the provided result/error
- Marks original message as `acked`
- Returns HTTP 200 with `{"message_id": "<new-uuid>"}`

**FR-10**: The system MUST implement `GET /v1/messages/{messageId}/status` that:
- Returns message status, delivery timestamps, and lease information
- Returns HTTP 200 with status object
- Returns HTTP 404 if message not found

**FR-11**: The system MUST implement `GET /v1/agents/{agentId}/inbox/stats` that:
- Returns counts of messages by status (`ready`, `leased`, `dead`)
- Returns `oldest_age_sec` (age of oldest unprocessed message)
- Requires authentication

**FR-12**: The system MUST implement `POST /v1/agents/{agentId}/inbox/reclaim` that:
- Finds messages with `status='leased'` and `lease_until < now()`
- Sets them to `status='delivered'` if `attempts < max_attempts`
- Sets them to `status='dead'` if `attempts >= max_attempts`
- Returns HTTP 200 with count of reclaimed messages

**FR-13**: The system MUST implement `GET /health` that:
- Returns HTTP 200 with `{"status":"healthy","version":"1.0.0","uptime":<seconds>}`
- Checks database connectivity
- Does not require authentication

#### Database Schema

**FR-14**: The system MUST use PostgreSQL as the primary data store with the following tables:
- `agent` (agent registry)
- `message` (inbox queue)
- `policy` (authorization rules)
- `agent_key` (key rotation)
- `audit_log` (event tracking)

**FR-15**: The `message` table MUST have indexes on:
- `(to_agent_id, status)` for efficient inbox queries
- `(correlation_id)` for reply lookups
- `(to_agent_id, idempotency_key)` for deduplication
- `(lease_until)` for lease reclamation
- `(timestamp, ttl_sec)` for TTL expiration

**FR-16**: The system MUST enforce message lifecycle states:
- `queued` → initial state (reserved for future use)
- `sent` → SMTP channel (reserved for v1.1+)
- `delivered` → available for PULL
- `leased` → being processed by worker
- `acked` → successfully processed
- `nacked` → rejected, may retry
- `failed` → temporary failure, will retry
- `dead` → max attempts exceeded or TTL expired

### Reliability & Delivery Semantics (Priority 1)

**FR-17**: The system MUST provide at-least-once delivery guarantees:
- Messages remain in inbox until explicitly ACKed
- Expired leases automatically requeue messages
- Failed messages retry up to `max_attempts` (default: 3)

**FR-18**: The system MUST support idempotency via `idempotency_key`:
- Duplicate SEND with same `(to_agent_id, idempotency_key)` returns existing message ID
- Returns HTTP 201 with original message ID (not 409)
- Idempotency window: unlimited (relies on explicit key)

**FR-19**: The system MUST support fingerprint-based deduplication:
- Computes SHA256 of entire envelope as `source_fingerprint`
- Rejects duplicates within 10-minute window
- Returns HTTP 201 with existing message ID

**FR-20**: The system MUST enforce TTL expiration:
- Background job runs every 60 seconds
- Finds messages where `(now() - timestamp) > ttl_sec`
- Updates to `status='dead'`, sets `last_error='TTL expired'`

**FR-21**: The system MUST handle lease expiration:
- Background job runs every 30 seconds
- Finds messages where `status='leased'` AND `lease_until < now()`
- If `attempts < max_attempts`: set `status='delivered'`, increment `attempts`
- If `attempts >= max_attempts`: set `status='dead'`, set `last_error='Max attempts exceeded'`

### Security (Priority 1)

**FR-22**: The system MUST support Bearer token authentication:
- Accepts `Authorization: Bearer <token>` header
- Validates token against stored API keys
- Rejects invalid tokens with HTTP 401

**FR-23**: The system MUST support HMAC signature authentication:
- Accepts headers: `X-Agent-Id`, `X-Timestamp`, `X-Signature`
- Validates HMAC-SHA256 signature over canonical body
- Enforces ±5 minute timestamp window (replay protection)
- Rejects invalid signatures with HTTP 401

**FR-24**: The system MUST support Ed25519 message signatures:
- Validates `signature.sig` field using `signature.kid` public key
- Canonical base string: `timestamp\n<body-hash>\n<from>\n<to>\n<correlation_id>`
- Fetches public key from `/.well-known/agent-keys.json` or database
- Rejects invalid signatures with HTTP 403

**FR-25**: The system MUST implement timestamp-based replay protection:
- Rejects messages where `|now() - timestamp| > 300 seconds`
- Returns HTTP 422 with error `timestamp_window_exceeded`

**FR-26**: The system MUST hash API keys with bcrypt before storing in database.

**FR-27**: The system MUST log all authentication failures to `audit_log` table.

### Policy Engine (Priority 2)

**FR-28**: The system MUST support YAML-based policy files with rules containing:
- `name` (string, required)
- `enabled` (boolean, default: true)
- `priority` (integer, default: 100, lower = higher priority)
- `from_agent_pattern` (regex string, e.g., `^auth\..*`)
- `to_agent_pattern` (regex string)
- `type_pattern` (regex string)
- `subject_pattern` (regex string)
- `action` (enum: allow, deny)

**FR-29**: The system MUST evaluate policies in priority order (lowest number first).

**FR-30**: The system MUST stop evaluation at first matching policy:
- If `action='allow'`: accept message
- If `action='deny'`: reject with HTTP 403

**FR-31**: The system MUST have a default policy (priority 999, allow all) for development.

**FR-32**: The system MUST support hot-reload of policy files via `SIGHUP` signal.

**FR-33**: The system MUST support rate limiting per agent:
- `rate_limit_per_hour` field in policy
- Track message count per agent in sliding window
- Reject with HTTP 429 if exceeded

**FR-34**: The system MUST support size limits per policy:
- `max_size_kb` field in policy
- Reject messages exceeding limit with HTTP 413

### Observability (Priority 2)

**FR-35**: The system MUST use structured JSON logging with fields:
- `timestamp` (ISO8601)
- `level` (debug, info, warn, error)
- `message` (human-readable)
- `correlation_id` (if applicable)
- `agent_id` (if applicable)
- `message_id` (if applicable)

**FR-36**: The system MUST log the following events:
- Message sent (from, to, subject, message_id)
- Message pulled (agent_id, message_id, lease_until)
- Message acked (agent_id, message_id)
- Message nacked (agent_id, message_id, reason)
- Lease expired (message_id, attempts)
- TTL expired (message_id)
- Authentication failure (agent_id, reason)
- Policy denial (from, to, policy_name, reason)

**FR-37**: The system MUST expose Prometheus metrics at `/metrics` endpoint:
- `admp_messages_sent_total{type, from, to}` (counter)
- `admp_messages_received_total{agent_id}` (counter)
- `admp_messages_acked_total{agent_id}` (counter)
- `admp_messages_nacked_total{agent_id}` (counter)
- `admp_messages_dead_total{agent_id, reason}` (counter)
- `admp_lease_duration_seconds{agent_id}` (histogram)
- `admp_inbox_size{agent_id, status}` (gauge)
- `admp_policy_denials_total{policy_name}` (counter)
- `admp_auth_failures_total{reason}` (counter)

**FR-38**: The system MUST write audit log entries to `audit_log` table for:
- All message state transitions
- Authentication events
- Policy decisions

### Client SDKs (Priority 1)

#### JavaScript/TypeScript SDK

**FR-39**: The system MUST provide `@agent-dispatch/client` npm package with:
- TypeScript types for all message envelopes and API responses
- `ADMPClient` class with methods:
  - `send(options: SendOptions): Promise<string>` → returns message ID
  - `pull(options?: PullOptions): Promise<Message | null>`
  - `ack(messageId: string): Promise<void>`
  - `nack(messageId: string, options?: NackOptions): Promise<void>`
  - `reply(message: Message, response: ReplyOptions): Promise<string>`
  - `waitForReply(messageId: string, options: WaitOptions): Promise<Message>`
  - `inboxStats(): Promise<InboxStats>`
- Automatic retry logic for network errors (exponential backoff, max 3 retries)
- Optional Ed25519 signature generation (if `signingKey` provided)
- HMAC signature generation for authentication
- Idempotency key generation helper

**FR-40**: The JavaScript SDK MUST handle errors gracefully:
- Network errors: retry with exponential backoff
- API errors (4xx): throw descriptive error with code
- Timeout errors: throw `TimeoutError` after specified duration

**FR-41**: The JavaScript SDK MUST include JSDoc comments on all public methods.

#### Python SDK

**FR-42**: The system MUST provide `agent-dispatch-client` PyPI package with:
- Pydantic models for message envelopes and responses
- `ADMPClient` async class with methods:
  - `async send(to, type, subject, body, **kwargs) -> str`
  - `async pull(lease_duration=30) -> Message | None`
  - `async ack(message_id: str) -> None`
  - `async nack(message_id: str, extend: int = None) -> None`
  - `async reply(message: Message, result=None, error=None) -> str`
  - `async wait_for_reply(message_id: str, timeout=5.0) -> Message`
  - `async inbox_stats() -> InboxStats`
- Automatic retry logic (same as JS SDK)
- Optional PyNaCl signature generation
- HMAC signature generation

**FR-43**: The Python SDK MUST support both async and sync usage:
- Async via `await client.send(...)`
- Sync wrapper class for non-async codebases

**FR-44**: The Python SDK MUST include docstrings on all public methods.

### Deployment (Priority 1)

**FR-45**: The system MUST provide `docker-compose.yml` that:
- Starts PostgreSQL 16 with initialized schema
- Starts ADMP relay server on port 3030
- Configures health checks
- Mounts volumes for data persistence
- Sets up networking

**FR-46**: The relay server MUST provide a production-ready Dockerfile that:
- Uses multi-stage build (builder + runtime)
- Runs as non-root user
- Includes health check
- Sets appropriate resource limits in metadata

**FR-47**: The system MUST support configuration via environment variables:
- `DATABASE_URL` (required)
- `PORT` (default: 3030)
- `NODE_ENV` (development | production)
- `LOG_LEVEL` (debug | info | warn | error)
- `API_KEY` (default dev key)
- `POLICY_FILE` (path to YAML policy file)
- `LEASE_RECLAIM_INTERVAL_SEC` (default: 30)
- `TTL_CHECK_INTERVAL_SEC` (default: 60)

**FR-48**: The system MUST include database migration scripts in `/deploy/init-db.sql`.

**FR-49**: The system MUST start in under 10 seconds when database is ready.

### Documentation (Priority 1)

**FR-50**: The system MUST provide the following documentation:
- `README.md` (project overview, quickstart, features, architecture)
- `docs/quickstart.md` (5-minute getting started guide)
- `docs/architecture.md` (system design deep-dive)
- `docs/security.md` (authentication, signatures, policies)
- `docs/api-reference/` (generated from OpenAPI spec)
- `CONTRIBUTING.md` (contribution guidelines)

**FR-51**: The quickstart guide MUST enable a new user to:
- Start ADMP locally with Docker
- Send a message between two agents
- Receive and acknowledge a message
- All in under 5 minutes

**FR-52**: The API reference MUST be generated from OpenAPI 3.1 spec using a documentation generator.

### Examples (Priority 2)

**FR-53**: The system MUST provide a **request-response example** showing:
- Client agent sending a request
- Server agent pulling, processing, and replying
- Client receiving correlated response
- Complete with README and running instructions

**FR-54**: The system MUST provide a **task orchestration example** showing:
- Orchestrator agent coordinating multiple workers
- Parallel message distribution
- Result aggregation using correlation IDs
- Error handling and retry logic

**FR-55**: The system MUST provide a **Detach integration example** showing:
- Session lifecycle management (register/deregister)
- Approval workflow (request → human decision → response)
- Message injection (remote instruction delivery)
- Real-world production pattern

---

## Non-Goals (Out of Scope for v1.0)

**NG-1**: SMTP transport binding (deferred to v1.1)
- Inbound email webhook handlers
- Outbound SMTP sending
- DKIM verification
- DSN processing

**NG-2**: DNS-based key discovery (deferred to v1.1)
- `_agentkeys.<domain>` TXT records
- Automatic public key resolution

**NG-3**: Web dashboard UI (deferred to v1.2)
- Message flow visualization
- Real-time inbox browser
- Policy editor

**NG-4**: Additional language SDKs beyond JS/Python (community contributions)
- Go, Rust, Java, Ruby, etc.

**NG-5**: Alternative storage backends (PostgreSQL only for v1.0)
- Redis, DynamoDB, etc.

**NG-6**: Streaming/WebSocket transport

**NG-7**: Message-level encryption at rest

**NG-8**: Multi-recipient fanout/broadcast

**NG-9**: Cross-domain federation governance

---

## Design Considerations

### Message Envelope Design

The JSON envelope is designed to be:
- **Self-describing**: All metadata in the envelope
- **Extensible**: Custom fields allowed in `headers` and `body`
- **Transport-agnostic**: Same structure for HTTP, SMTP (v1.1+), WebSocket (v2.0+)

### Lease-Based Processing

Leasing prevents message loss when workers crash:
1. PULL atomically moves message to `leased` state
2. Worker processes the message
3. Worker ACKs before lease expires
4. If worker crashes, lease expires and message requeues

Trade-off: Messages may be processed more than once (at-least-once semantics).

### Idempotency Strategy

Two deduplication mechanisms:
1. **Explicit keys**: Client provides `idempotency_key` (unlimited window)
2. **Fingerprints**: Automatic based on envelope hash (10-minute window)

Explicit keys recommended for critical operations (e.g., payments, user creation).

### Policy Engine Design

Policies use regex matching for flexibility:
- `from_agent_pattern: '^auth\..*'` → all agents starting with `auth.`
- `subject_pattern: '^(create|update|delete)_user$'` → specific subjects

Priority ordering allows "default deny" with specific allow rules.

---

## Technical Considerations

### Technology Stack

- **Runtime**: Node.js 18+ (LTS)
- **Language**: TypeScript 5.3+
- **Framework**: Express 4.x (HTTP server)
- **Database**: PostgreSQL 16
- **ORM**: `pg` (raw SQL for performance)
- **Validation**: Zod (schema validation)
- **Crypto**: `tweetnacl` (Ed25519), built-in `crypto` (HMAC)
- **Logging**: Pino (structured JSON logs)
- **Testing**: Vitest (unit + integration tests)

### Database Considerations

**Inbox Query Optimization**: The primary query `SELECT * FROM message WHERE to_agent_id = $1 AND status = 'delivered' ORDER BY created_at ASC LIMIT 1` must be fast. Index on `(to_agent_id, status, created_at)` is critical.

**Lease Atomicity**: PULL operation must use `SELECT FOR UPDATE SKIP LOCKED` to prevent race conditions between concurrent workers.

**Scalability**: Single PostgreSQL instance should handle 1000+ messages/second. For higher throughput, consider read replicas or partitioning by agent_id (v2.0+).

### Security Architecture

**Defense in Depth**:
1. **Transport**: TLS required in production
2. **Authentication**: Bearer token or HMAC signature
3. **Authorization**: Policy engine
4. **Integrity**: Ed25519 message signatures
5. **Replay protection**: Timestamp validation

**Key Management**: v1.0 stores public keys in database. v1.1 adds HTTPS JWKS endpoint and DNS TXT fallback.

### Observability Strategy

**Logs**: Structured JSON for easy ingestion by log aggregators (Loki, Splunk, etc.)

**Metrics**: Prometheus-compatible for standard monitoring stacks (Grafana, Datadog, etc.)

**Audit Trail**: `audit_log` table provides compliance-ready history of all actions.

---

## Success Metrics

**SM-1: Adoption Metrics**
- 10+ production deployments within 3 months of release
- 100+ GitHub stars within 1 month
- 5+ community-contributed examples or integrations

**SM-2: Performance Metrics**
- Message throughput: 1000 msg/sec on modest hardware (4 vCPU, 8GB RAM)
- P95 latency for SEND operation: < 50ms
- P95 latency for PULL operation: < 10ms

**SM-3: Reliability Metrics**
- Zero message loss in stress tests (10,000 messages, simulated crashes)
- Lease reclamation success rate: 100%
- TTL expiration accuracy: ±30 seconds

**SM-4: Developer Experience Metrics**
- Time to first message sent: < 5 minutes (via quickstart guide)
- SDK installation success rate: > 95%
- Docker deployment success rate: > 90%

**SM-5: Security Metrics**
- Zero critical vulnerabilities in security audit
- 100% of messages authenticated
- Policy denial rate < 1% (indicates good policy design)

---

## Open Questions

**OQ-1**: Should we include a CLI tool for manual message sending/inspection in v1.0?
- **Decision**: Defer to v1.1, recommend using curl for now

**OQ-2**: Should PULL operation support batch pulling (multiple messages at once)?
- **Decision**: No for v1.0 (simplicity), consider for v1.1

**OQ-3**: Should we provide a Grafana dashboard template?
- **Decision**: Yes, include in `deploy/grafana/` as a nice-to-have

**OQ-4**: Should message body support binary data (base64-encoded)?
- **Decision**: No for v1.0 (JSON only), defer to v1.1 with attachment references

**OQ-5**: Should we implement message priority queuing?
- **Decision**: Defer to v1.1, FIFO only for v1.0

**OQ-6**: Should we support message cancellation (delete from inbox before processing)?
- **Decision**: Defer to v1.1

**OQ-7**: Should we include built-in message encryption?
- **Decision**: No for v1.0, recommend TLS for transport security

---

## Acceptance Criteria

**AC-1**: All functional requirements (FR-1 through FR-55) are implemented and tested.

**AC-2**: Test coverage > 80% for core relay server package.

**AC-3**: All examples run successfully with `npm run example`.

**AC-4**: Docker deployment starts successfully and passes health checks.

**AC-5**: Quickstart guide is validated by 3+ external testers completing it in < 5 minutes.

**AC-6**: Load testing achieves 1000 msg/sec throughput with < 50ms P95 latency.

**AC-7**: Security audit finds zero critical vulnerabilities.

**AC-8**: Documentation is complete and generated API reference matches OpenAPI spec.

**AC-9**: JavaScript and Python SDKs pass integration tests against live relay server.

**AC-10**: GitHub README, CONTRIBUTING, and LICENSE files are in place.

---

## Dependencies

**External Dependencies**:
- PostgreSQL 16 (database)
- Node.js 18+ (runtime)
- Docker & Docker Compose (deployment)

**Internal Dependencies**:
- OpenAPI 3.1 spec (already written in `spec/openapi.yaml`)
- Database schema (already written in `deploy/init-db.sql`)
- Whitepaper v1.0 (already written in `whitepaper/v1.md`)

**Tooling Dependencies**:
- TypeScript compiler
- Vitest (testing)
- Prettier & ESLint (linting)
- OpenAPI generator (for API docs)

---

## Risks & Mitigations

**R-1: Scalability Concerns**
- **Risk**: Single PostgreSQL instance may not handle high load
- **Mitigation**: Optimize queries, use connection pooling, document horizontal scaling approach for v2.0
- **Severity**: Medium

**R-2: SDK Adoption**
- **Risk**: Developers may not adopt if SDKs are hard to use
- **Mitigation**: Comprehensive examples, excellent documentation, focus on DX
- **Severity**: High

**R-3: Security Vulnerabilities**
- **Risk**: Protocol or implementation may have security flaws
- **Mitigation**: Security audit before release, clear vulnerability reporting process, follow OWASP best practices
- **Severity**: High

**R-4: Database Migration Complexity**
- **Risk**: Schema changes in future versions may break existing deployments
- **Mitigation**: Semantic versioning, migration scripts, deprecation notices
- **Severity**: Medium

**R-5: Message Loss Scenarios**
- **Risk**: Edge cases may cause message loss despite at-least-once guarantees
- **Mitigation**: Extensive testing, stress tests with simulated failures, audit logging
- **Severity**: High

---

## Timeline & Phases

### Phase 1: Core Protocol (Weeks 1-4)
- Database schema and migrations
- HTTP API endpoints (SEND, PULL, ACK, NACK, REPLY)
- Message validation
- Basic authentication (Bearer tokens)

### Phase 2: Reliability & Security (Weeks 5-7)
- Idempotency handling
- Lease expiration & reclamation
- TTL enforcement
- HMAC & Ed25519 signatures
- Policy engine

### Phase 3: SDKs & Tooling (Weeks 8-10)
- JavaScript/TypeScript SDK
- Python SDK
- Docker deployment
- CLI tools (if OQ-1 is yes)

### Phase 4: Observability & Testing (Weeks 11-12)
- Structured logging
- Prometheus metrics
- Audit logging
- Integration tests
- Load testing

### Phase 5: Documentation & Examples (Weeks 13-14)
- README, quickstart, architecture docs
- API reference generation
- Request-response example
- Task orchestration example
- Detach integration example

### Phase 6: Polish & Release (Week 15)
- Security audit
- Performance tuning
- Documentation review
- v1.0.0 release
- Announcement & promotion

**Total Duration**: ~15 weeks (3.5 months)

---

## Appendix: Message Envelope Example

```json
{
  "version": "1.0",
  "id": "m-123e4567-e89b-12d3-a456-426614174000",
  "type": "task.request",
  "from": "agent://auth.backend",
  "to": "agent://storage.pg",
  "subject": "create_user",
  "correlation_id": "c-12345-67890",
  "headers": {
    "priority": "high",
    "source": "api-gateway"
  },
  "body": {
    "email": "user@example.com",
    "name": "Alice Smith",
    "role": "developer"
  },
  "ttl_sec": 86400,
  "timestamp": "2025-10-23T17:30:00Z",
  "signature": {
    "alg": "ed25519",
    "kid": "yourco.com/key-2025-10-01",
    "sig": "VdO9hUzZN3...base64..."
  }
}
```

---

**End of PRD**
