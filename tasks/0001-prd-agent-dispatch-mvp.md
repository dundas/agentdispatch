# Product Requirements Document  
**Product:** Agent Dispatch Messaging Protocol (ADMP) Server  
**Scope:** MVP → path to production-ready

## 1. Overview

Agent Dispatch (ADMP) is an HTTP-based messaging hub that provides a **universal inbox for autonomous agents**. Agents register, obtain Ed25519 keys, and exchange signed messages via inbox queues supporting at-least-once delivery, TTL, and optional webhook push.

This PRD defines what is required to move from the current single-node, in-memory implementation to:

- A robust **MVP** for internal and early-adopter use.
- A clear path to a **production-ready, self-hostable reference implementation** for others to run in their own environments.

Assumptions (pragmatic defaults):

- Primary context: **Open-source reference implementation** that can also be run as an **internal infra service**.
- Primary persistent backend: **Mech Storage** (https://storage.mechdna.net) providing durable storage for agents and messages.
- In-memory storage, if present, is only for lightweight local experimentation and is not a supported deployment mode for dev/CI/staging/prod.
- Target scale: **Moderate** (10–100 agents, up to a few thousand messages/day).
- SDKs: HTTP + examples for MVP; Node SDK is **nice-to-have**, not blocking.

---

## 2. Goals

- **G1 – Spec-compliant, stable API:**  
  Align behavior with `openapi.yaml` and whitepaper; changes are deliberate and versioned.

- **G2 – Test-guarded core flows:**  
  Critical agent + inbox behaviors are covered by automated tests and enforced in CI.

- **G3 – Persistence for production:**  
  Provide at least one persistent storage backend so agents/messages survive restarts and multiple instances can share state.

- **G4 – Reasonable security posture:**  
  Enforce signatures, timestamps, and basic access control suitable for internal multi-team usage and self-hosted deployments.

- **G5 – Operationally simple:**  
  Easy to deploy via Docker, observable via health/stats/logs, with clear configuration.

---

## 3. User stories

### 3.1 Protocol implementer / infra engineer

- **U1:** As an infra engineer, I can deploy Agent Dispatch via Docker and configure it with a `.env` file or environment variables.
- **U2:** As an infra engineer, I can configure **Mech Storage** (app ID, API key, base URL) via environment variables and verify connectivity.
- **U3:** As an infra engineer, I can read metrics/stats to understand number of agents/messages and general health.

### 3.2 Agent developer (client of ADMP)

- **U4:** As an agent developer, I can register an agent, obtain keys, and send **signed** messages using documented HTTP APIs.
- **U5:** As an agent developer, my agent can use a simple pattern (register → heartbeat → pull/ack/reply) that works reliably without understanding all internals.
- **U6:** As an agent developer, I can configure an HTTP webhook for push delivery and verify webhook signatures.

### 3.3 Security/operations

- **U7:** As an operator, I can require an API key for external callers and restrict access to the ADMP API.
- **U8:** As an operator, I can see ADMPs health and stats and integrate this into monitoring.
- **U9:** As an operator, I can restart or upgrade the server without losing registered agents or in-flight messages (in persistent mode).

---

## 4. Functional requirements

### 4.1 Core API stability

- **F1:** The existing endpoints and semantics (`/health`, `/api/stats`, agents, messages, inbox, webhooks, trusted agents) remain as documented in `openapi.yaml`, or any breaking changes are versioned (e.g., `v1.1`).

- **F2:** A minimal **versioning policy** is documented (e.g., semantic version in `package.json` + `info.version` in OpenAPI), with rules for when breaking changes are allowed.

### 4.2 Automated tests

- **F3:** There is a `node:test`-based test suite covering at least:
  - Health and `/api/stats`.
  - Agent registration, heartbeat, `GET /api/agents/:agentId`.
  - Happy-path messaging:
    - `POST /api/agents/:to/messages` (signed).
    - `POST /api/agents/:agentId/inbox/pull`.
    - `POST /api/agents/:agentId/messages/:messageId/ack`.
    - `GET /api/messages/:messageId/status`.
  - NACK and lease behavior (auto requeue after visibility timeout).
  - Webhook happy path:
    - Test receiver that validates webhook signature and responds 200.

- **F4:** Tests include **negative cases**:
  - Invalid signature.
  - Timestamp outside the allowed window.
  - Unknown recipient agent.
  - Webhook failures and retry behavior (at least one retry observed).

- **F5:** GitHub CI workflow runs `npm test` on every PR and push to main; CI must pass before deploying.

### 4.3 Storage abstraction and persistence

- **F6:** A `Storage` abstraction is defined for agents/messages/inboxes/stats/cleanup, with:
  - Methods equivalent to those in `MemoryStorage`.
  - Clear documentation of semantics (FIFO, leases, TTLs).

- **F7:** **Mech Storage** is the canonical `Storage` backend and the default for all environments when `MECH_APP_ID` / `MECH_API_KEY` / `MECH_BASE_URL` are configured.

- **F8:** A **Mech Storage backend** is implemented as the first-class persistent backend:

  - Uses Mech's NoSQL and/or PostgreSQL APIs to store:
    - `admp_agents` (agents)
    - `admp_messages` (messages and inbox state)
  - Is configured solely via environment variables, without manual schema setup for typical users.

- **F9:** Behavior is consistent across backends:
  - Message ordering (best-effort FIFO per recipient).
  - Lease expiry and TTL behavior.
  - Cleanup of acked/expired messages.

### 4.4 Auth and trust

- **F10:** `API_KEY_REQUIRED` + `MASTER_API_KEY` continue to work as coarse-grained protection.

- **F11:** For message send operations:
  - Signatures must be **present and valid** by default.
  - A `DEV_ALLOW_UNSIGNED` or similar flag may exist to relax this in local dev, but is **off by default** in production mode.

- **F12:** Timestamps are validated using `validateTimestamp`; requests outside the allowed skew are rejected with an appropriate error code.

- **F13:** Trust lists are used to enforce that:
  - If recipient has non-empty `trusted_agents`, only those senders are allowed to send messages.
  - This behavior is documented and tested.

### 4.5 Operations and observability

- **F14:** The `/health` endpoint returns:
  - Status, timestamp, and version.
  - Can be used for Kubernetes/Load Balancer health checks.

- **F15:** `/api/stats` remains stable and can be used for simple dashboards.

- **F16 (nice-to-have for production):** A `/metrics` or similar endpoint (or instructions for scraping logs) is documented for Prometheus or equivalent monitoring stacks.

### 4.6 SDKs and examples

- **F17:** Existing examples (`basic-usage.js`, `webhook-push.js`, `webhook-receiver.js`) are kept up-to-date with the API and are tested manually/periodically.

- **F18 (optional for MVP, desirable for production):** A minimal Node client library is provided (can live in this repo initially) that wraps:
  - Register, heartbeat.
  - Signed send.
  - Pull/ack/reply helpers.

---

## 5. Non-goals (for this PRD)

- **N1:** Running Agent Dispatch as a fully managed multi-tenant SaaS is out of scope; we focus on self-hosted + internal use.
- **N2:** Complex role-based access control (RBAC) and org/project hierarchies are out of scope.
- **N3:** Advanced analytics dashboards or GUIs are not required; JSON APIs and logs/stats are sufficient.
- **N4:** Supporting every possible database backend is not required; one good persistent backend (e.g., Postgres/SQLite) is enough.

---

## 6. Design / technical considerations

- **D1 – Storage interface design**
  - Design `Storage` with clear contracts:
    - `createAgent`, `getAgent`, `updateAgent`, `deleteAgent`, `listAgents`.
    - `createMessage`, `getMessage`, `updateMessage`, `deleteMessage`.
    - Query operations for inbox (queued/leased) and stats.
  - Ensure operations that can be hot paths (pull, ack, nack) map cleanly onto DB queries and indexes.

- **D2 – Mech Storage schema**
  - Design collections/tables in Mech Storage for agents and messages that map cleanly onto the `Storage` interface.
  - Consider indexes via Mech's PostgreSQL layer on `to_agent_id`, `status`, `lease_until`, `created_at`.

- **D3 – Backwards compatibility**
  - Make Mech Storage the default backend; any in-memory backend, if retained, must be explicitly opted into for special cases.
  - Fail fast with clear errors when Mech configuration is missing or invalid.

- **D4 – Security defaults**
  - In production mode (`NODE_ENV=production`):
    - Reject unsigned messages.
    - Validate timestamps.
    - Encourage enabling API key auth.

- **D5 – Testing strategy**
  - Prefer integration-like tests using the HTTP interface instead of only unit tests, since this is a small service and HTTP semantics are the product.

---

## 7. Success metrics

- **S1:** Test coverage: critical flows (agents, send/pull/ack, webhooks) are all covered and stable in CI for at least N releases.
- **S2:** Dogfooding: ADMP runs reliably for internal agents over at least 4+ weeks without data loss in persistent mode.
- **S3:** Operational simplicity: a new engineer can deploy ADMP via Docker + DB in under 30 minutes using the docs.
- **S4:** External adoption: at least a small number of external/self-hosting users successfully run ADMP based on the README and OpenAPI spec (e.g., via GitHub issues/feedback).

---

## 8. Open questions

- **Q1:** Do we also need a *direct* database backend (e.g., raw Postgres) in addition to **Mech Storage**, or is Mech Storage alone sufficient as the first-class recommended backend?

- **Q2:** How strict should default auth be for **MVP builds** (dev vs prod configs)?  
  - Proposal: strict in `NODE_ENV=production`, relaxed in dev.

- **Q3:** Should we publish a separate **Node client package** to npm, or keep the client code as examples within this repo initially?

- **Q4:** Do we need explicit **rate limiting** in the service itself, or will we rely on API gateways (NGINX/Envoy) for that in most deployments?
