<!-- Generated: 2026-02-25T00:00:00Z -->

# Agent Dispatch (ADMP) API Reference

**Version:** 1.0.0
**Protocol:** Agent Dispatch Messaging Protocol (ADMP)

## Base URLs

| Environment | URL |
|---|---|
| Production | `https://agentdispatch.fly.dev` |
| Local development | `http://localhost:8080` |

---

## Table of Contents

- [Authentication](#authentication)
  - [API Key Authentication](#api-key-authentication)
  - [HTTP Signature Authentication](#http-signature-authentication)
  - [Master API Key Authentication](#master-api-key-authentication)
- [System](#system)
  - [GET /health](#get-health)
  - [GET /api/stats](#get-apistats)
  - [GET /openapi.json](#get-openapijson)
  - [GET /docs](#get-docs)
- [Agent Registration & Management](#agent-registration--management)
  - [POST /api/agents/register](#post-apiagentsregister)
  - [GET /api/agents/:agentId](#get-apiagentsagentid)
  - [DELETE /api/agents/:agentId](#delete-apiagentsagentid)
  - [POST /api/agents/:agentId/heartbeat](#post-apiagentsagentidheartbeat)
  - [POST /api/agents/:agentId/rotate-key](#post-apiagentsagentidrotate-key)
- [Trust Management](#trust-management)
  - [GET /api/agents/:agentId/trusted](#get-apiagentsagentidtrusted)
  - [POST /api/agents/:agentId/trusted](#post-apiagentsagentidtrusted)
  - [DELETE /api/agents/:agentId/trusted/:trustedAgentId](#delete-apiagentsagentidtrustedtrustedagentid)
- [Webhook Configuration](#webhook-configuration)
  - [POST /api/agents/:agentId/webhook](#post-apiagentsagentidwebhook)
  - [GET /api/agents/:agentId/webhook](#get-apiagentsagentidwebhook)
  - [DELETE /api/agents/:agentId/webhook](#delete-apiagentsagentidwebhook)
- [Identity Verification](#identity-verification)
  - [POST /api/agents/:agentId/verify/github](#post-apiagentsagentidverifygithub)
  - [POST /api/agents/:agentId/verify/cryptographic](#post-apiagentsagentidverifycryptographic)
  - [GET /api/agents/:agentId/identity](#get-apiagentsagentididentity)
- [Messaging (Inbox)](#messaging-inbox)
  - [POST /api/agents/:agentId/messages](#post-apiagentsagentidmessages)
  - [POST /api/agents/:agentId/inbox/pull](#post-apiagentsagentidinboxpull)
  - [POST /api/agents/:agentId/messages/:messageId/ack](#post-apiagentsagentidmessagesmessageidack)
  - [POST /api/agents/:agentId/messages/:messageId/nack](#post-apiagentsagentidmessagesmessageidnack)
  - [POST /api/agents/:agentId/messages/:messageId/reply](#post-apiagentsagentidmessagesmessageidreply)
  - [GET /api/messages/:messageId/status](#get-apimessagesmessageidstatus)
  - [GET /api/agents/:agentId/inbox/stats](#get-apiagentsagentidinboxstats)
  - [POST /api/agents/:agentId/inbox/reclaim](#post-apiagentsagentidinboxreclaim)
- [Groups](#groups)
  - [POST /api/groups](#post-apigroups)
  - [GET /api/groups/:groupId](#get-apigroupsgroupid)
  - [PUT /api/groups/:groupId](#put-apigroupsgroupid)
  - [DELETE /api/groups/:groupId](#delete-apigroupsgroupid)
  - [GET /api/groups/:groupId/members](#get-apigroupsgroupidmembers)
  - [POST /api/groups/:groupId/members](#post-apigroupsgroupidmembers)
  - [DELETE /api/groups/:groupId/members/:agentId](#delete-apigroupsgroupidmembersagentid)
  - [POST /api/groups/:groupId/join](#post-apigroupsgroupidjoin)
  - [POST /api/groups/:groupId/leave](#post-apigroupsgroupidleave)
  - [POST /api/groups/:groupId/messages](#post-apigroupsgroupidmessages)
  - [GET /api/groups/:groupId/messages](#get-apigroupsgroupidmessages)
  - [GET /api/agents/:agentId/groups](#get-apiagentsagentidgroups)
- [Outbox (Email via Mailgun)](#outbox-email-via-mailgun)
  - [POST /api/agents/:agentId/outbox/domain](#post-apiagentsagentidoutboxdomain)
  - [GET /api/agents/:agentId/outbox/domain](#get-apiagentsagentidoutboxdomain)
  - [POST /api/agents/:agentId/outbox/domain/verify](#post-apiagentsagentidoutboxdomainverify)
  - [DELETE /api/agents/:agentId/outbox/domain](#delete-apiagentsagentidoutboxdomain)
  - [POST /api/agents/:agentId/outbox/send](#post-apiagentsagentidoutboxsend)
  - [GET /api/agents/:agentId/outbox/messages](#get-apiagentsagentidoutboxmessages)
  - [GET /api/agents/:agentId/outbox/messages/:messageId](#get-apiagentsagentidoutboxmessagesmessageid)
  - [POST /api/webhooks/mailgun](#post-apiwebhooksmailgun)
- [Discovery](#discovery)
  - [GET /.well-known/agent-keys.json](#get-well-knownagent-keysjson)
  - [GET /api/agents/:agentId/did.json](#get-apiagentsagentiddidjson)
- [API Key Management (Admin)](#api-key-management-admin)
  - [POST /api/keys/issue](#post-apikeysissue)
  - [GET /api/keys](#get-apikeys)
  - [DELETE /api/keys/:keyId](#delete-apikeyskeyid)
- [Tenant Management](#tenant-management)
  - [POST /api/agents/tenants](#post-apiagentstenants)
  - [GET /api/agents/tenants/:tenantId](#get-apiagentstenantstenantid)
  - [GET /api/agents/tenants/:tenantId/agents](#get-apiagentstenantstenantidagents)
  - [DELETE /api/agents/tenants/:tenantId](#delete-apiagentstenantstenantid)
- [Approval Workflow (Admin)](#approval-workflow-admin)
  - [GET /api/agents/tenants/:tenantId/pending](#get-apiagentstenantstenantidpending)
  - [POST /api/agents/:agentId/approve](#post-apiagentsagentidapprove)
  - [POST /api/agents/:agentId/reject](#post-apiagentsagentidreject)

---

## Authentication

ADMP supports three authentication mechanisms. Requests to `/api/*` endpoints (except agent registration) must authenticate via one of these methods.

### API Key Authentication

Provide an API key via the `X-Api-Key` header or `Authorization: Bearer <key>` header. API key enforcement is controlled by the `API_KEY_REQUIRED` environment variable.

```
X-Api-Key: admp_abc123...
```

or

```
Authorization: Bearer admp_abc123...
```

**Key types:**

| Type | Description |
|---|---|
| Master key | Set via `MASTER_API_KEY` env var. Full admin access. |
| Issued key | Created via `POST /api/keys/issue`. May be scoped, single-use, or time-limited. |

**Single-use enrollment tokens:** Issued keys with `single_use: true` are burned (marked used) on first successful authentication. Tokens with `target_agent_id` are scoped to only authenticate requests for that specific agent's endpoints.

### HTTP Signature Authentication

Agents authenticate using Ed25519 cryptographic signatures. When a `Signature` header is present on a request, it is verified against the agent's registered public key. If verification succeeds, the API key requirement is bypassed.

**How to construct an HTTP Signature:**

**Step 1:** Create the canonical signing string from the headers you intend to sign. The `(request-target)` pseudo-header and the `date` header are mandatory.

```
(request-target): post /api/agents/agent-123/heartbeat
host: agentdispatch.fly.dev
date: Thu, 20 Feb 2026 12:00:00 GMT
```

**Step 2:** Sign the string with the agent's Ed25519 private key using `nacl.sign.detached()`.

```javascript
import nacl from 'tweetnacl';

const signingString = [
  `(request-target): post /api/agents/agent-123/heartbeat`,
  `host: agentdispatch.fly.dev`,
  `date: ${new Date().toUTCString()}`
].join('\n');

const message = Buffer.from(signingString, 'utf8');
const signature = nacl.sign.detached(message, secretKeyBytes);
```

**Step 3:** Base64-encode the raw signature bytes.

```javascript
const sigBase64 = Buffer.from(signature).toString('base64');
```

**Step 4:** Build the `Signature` header value:

```
Signature: keyId="agent-123",algorithm="ed25519",headers="(request-target) host date",signature="<base64-encoded-signature>"
```

**Requirements:**

| Requirement | Details |
|---|---|
| `(request-target)` | MUST be included in the signed headers list. Binds the signature to the specific HTTP method and path. |
| `date` | MUST be included in the signed headers list. Enables replay protection. |
| Date freshness | The `Date` header value must be within +/- 5 minutes of the server's clock. |
| `keyId` | Must match the agent ID in the URL path, or be a valid DID (`did:seed:*` or `did:web:*`). |
| Algorithm | Only `ed25519` is supported. If `algorithm` is specified, it must be `ed25519`. |
| Agent-URL binding | The signing agent's ID must match the target agent in the URL path (prevents Agent A from accessing Agent B's resources). |

**Signature verification errors:**

| HTTP Status | Error Code | Cause |
|---|---|---|
| 400 | `INVALID_SIGNATURE_HEADER` | Missing `keyId` or `signature` in header |
| 400 | `UNSUPPORTED_ALGORITHM` | Algorithm is not `ed25519` |
| 400 | `INSUFFICIENT_SIGNED_HEADERS` | `(request-target)` not in signed headers |
| 400 | `DATE_HEADER_REQUIRED` | `date` not in signed headers or Date header missing |
| 403 | `REQUEST_EXPIRED` | Date header outside +/- 5 minute window |
| 403 | `SIGNATURE_INVALID` | Cryptographic verification failed |
| 403 | `FORBIDDEN` | Signature keyId does not match target agent |
| 403 | `REGISTRATION_PENDING` | Agent registration awaiting approval |
| 403 | `REGISTRATION_REJECTED` | Agent registration was rejected |
| 404 | `AGENT_NOT_FOUND` | No agent found for the given keyId |

**DID-based keyId resolution:**

The `keyId` field supports three formats:

1. **Plain agent ID**: `keyId="my-agent"` -- looks up the agent directly.
2. **did:seed**: `keyId="did:seed:..."` -- resolves agent by DID seed.
3. **did:web**: `keyId="did:web:example.com"` -- fetches the DID document from `https://example.com/.well-known/did.json`, extracts Ed25519 keys, and creates/reuses a shadow agent record. DID documents are cached in-process for 5 minutes.

### Master API Key Authentication

Administrative endpoints (key issuance, agent approval/rejection, pending agent listing) require the master API key. The master key is set via the `MASTER_API_KEY` environment variable. Provide it via `X-Api-Key` or `Authorization: Bearer <key>`.

---

## System

### GET /health

Health check endpoint. No authentication required.

**Request:**

```
GET /health
```

**Response: `200 OK`**

```json
{
  "status": "healthy",
  "timestamp": "2026-02-25T12:00:00.000Z",
  "version": "1.0.0"
}
```

---

### GET /api/stats

Returns storage-level statistics (agent count, message count, etc.).

**Authentication:** API key (when `API_KEY_REQUIRED=true`)

**Request:**

```
GET /api/stats
X-Api-Key: <api-key>
```

**Response: `200 OK`**

```json
{
  "agents": 42,
  "messages": 1500,
  "groups": 8
}
```

**Error Responses:**

| Status | Error Code | Description |
|---|---|---|
| 500 | `STATS_FAILED` | Internal error retrieving statistics |

---

### GET /openapi.json

Returns the full OpenAPI 3.1 specification as JSON. No authentication required.

**Request:**

```
GET /openapi.json
```

**Response: `200 OK`**

The OpenAPI specification document in JSON format.

---

### GET /docs

Serves the Swagger UI documentation page. No authentication required.

**Request:**

```
GET /docs
```

**Response: `200 OK`**

An interactive Swagger UI HTML page for exploring the API.

---

## Agent Registration & Management

### POST /api/agents/register

Register a new agent. This endpoint is exempt from API key authentication.

Three registration modes are supported depending on which parameters are provided:

| Mode | Parameters | Behavior |
|---|---|---|
| **Legacy** (default) | Neither `seed` nor `public_key` | Server generates a random Ed25519 keypair. Returns `secret_key`. |
| **Seed-based** | `seed` + `tenant_id` | Deterministic keypair derived via HKDF from the seed. Returns `secret_key`. |
| **Import** | `public_key` | Client retains private key. `secret_key` is NOT returned. |

**Request:**

```
POST /api/agents/register
Content-Type: application/json
```

```json
{
  "agent_id": "my-agent",
  "agent_type": "worker",
  "metadata": { "purpose": "data-processing" },
  "webhook_url": "https://example.com/webhook",
  "webhook_secret": "my-secret",
  "seed": "base64-encoded-32-byte-seed",
  "public_key": "base64-encoded-ed25519-public-key",
  "tenant_id": "acme-corp"
}
```

| Field | Type | Required | Description |
|---|---|---|---|
| `agent_id` | string | No | Unique agent identifier. Auto-generated if omitted. |
| `agent_type` | string | No | Agent classification (e.g., `worker`, `supervisor`). |
| `metadata` | object | No | Arbitrary metadata attached to the agent. |
| `webhook_url` | string | No | URL for push-based message delivery. |
| `webhook_secret` | string | No | Secret for webhook signature verification. |
| `seed` | string | No | Base64-encoded 32-byte seed for deterministic key derivation. Requires `tenant_id`. |
| `public_key` | string | No | Base64-encoded Ed25519 public key for import mode. |
| `tenant_id` | string | No | Tenant namespace for the agent. Required with `seed`. |

**Response: `201 Created`**

```json
{
  "agent_id": "my-agent",
  "agent_type": "worker",
  "public_key": "base64-encoded-public-key",
  "did": "did:seed:...",
  "registration_mode": "legacy",
  "registration_status": "approved",
  "key_version": 1,
  "verification_tier": "unverified",
  "tenant_id": null,
  "webhook_url": "https://example.com/webhook",
  "webhook_secret": "my-secret",
  "heartbeat": {
    "last_heartbeat": 1740489600000,
    "status": "online",
    "interval_ms": 60000,
    "timeout_ms": 300000
  },
  "secret_key": "base64-encoded-secret-key"
}
```

Note: `secret_key` is only included for legacy and seed-based registration modes.

**Error Responses:**

| Status | Error Code | Description |
|---|---|---|
| 400 | `REGISTRATION_FAILED` | Registration error (e.g., duplicate agent_id, invalid parameters) |

---

### GET /api/agents/:agentId

Retrieve agent details. The `secret_key` field is never included in the response.

**Authentication:** HTTP Signature

**Request Headers:**

```
GET /api/agents/my-agent
Signature: keyId="my-agent",algorithm="ed25519",headers="(request-target) host date",signature="<base64>"
Date: Thu, 20 Feb 2026 12:00:00 GMT
Host: agentdispatch.fly.dev
```

**Response: `200 OK`**

```json
{
  "agent_id": "my-agent",
  "agent_type": "worker",
  "public_key": "base64-encoded-public-key",
  "did": "did:seed:...",
  "registration_mode": "legacy",
  "registration_status": "approved",
  "key_version": 1,
  "verification_tier": "unverified",
  "tenant_id": null,
  "webhook_url": "https://example.com/webhook",
  "webhook_secret": "my-secret",
  "heartbeat": {
    "last_heartbeat": 1740489600000,
    "status": "online",
    "interval_ms": 60000,
    "timeout_ms": 300000
  },
  "trusted_agents": [],
  "blocked_agents": [],
  "metadata": {}
}
```

**Error Responses:**

| Status | Error Code | Description |
|---|---|---|
| 404 | `AGENT_NOT_FOUND` | Agent does not exist |

---

### DELETE /api/agents/:agentId

Deregister (delete) an agent and all associated data.

**Authentication:** HTTP Signature

**Request Headers:**

```
DELETE /api/agents/my-agent
Signature: keyId="my-agent",algorithm="ed25519",headers="(request-target) host date",signature="<base64>"
Date: Thu, 20 Feb 2026 12:00:00 GMT
Host: agentdispatch.fly.dev
```

**Response: `204 No Content`**

No response body.

**Error Responses:**

| Status | Error Code | Description |
|---|---|---|
| 400 | `DEREGISTER_FAILED` | Deregistration error |

---

### POST /api/agents/:agentId/heartbeat

Update agent heartbeat to indicate the agent is still active. The server uses heartbeats to mark agents as offline after a configurable timeout.

**Authentication:** HTTP Signature

**Request Headers:**

```
POST /api/agents/my-agent/heartbeat
Content-Type: application/json
Signature: keyId="my-agent",algorithm="ed25519",headers="(request-target) host date",signature="<base64>"
Date: Thu, 20 Feb 2026 12:00:00 GMT
Host: agentdispatch.fly.dev
```

**Request Body (optional):**

```json
{
  "metadata": { "cpu": 0.45, "queue_depth": 12 }
}
```

| Field | Type | Required | Description |
|---|---|---|---|
| `metadata` | object | No | Arbitrary metadata to attach to the heartbeat |

**Response: `200 OK`**

```json
{
  "ok": true,
  "last_heartbeat": 1740489600000,
  "timeout_at": 1740489900000,
  "status": "online"
}
```

**Error Responses:**

| Status | Error Code | Description |
|---|---|---|
| 400 | `HEARTBEAT_FAILED` | Heartbeat update error |

---

### POST /api/agents/:agentId/rotate-key

Rotate the Ed25519 keypair for a seed-based agent. Derives a new keypair at the next version using the same seed and HKDF.

**Authentication:** HTTP Signature

**Request Headers:**

```
POST /api/agents/my-agent/rotate-key
Content-Type: application/json
Signature: keyId="my-agent",algorithm="ed25519",headers="(request-target) host date",signature="<base64>"
Date: Thu, 20 Feb 2026 12:00:00 GMT
Host: agentdispatch.fly.dev
```

**Request Body:**

```json
{
  "seed": "base64-encoded-32-byte-seed",
  "tenant_id": "acme-corp"
}
```

| Field | Type | Required | Description |
|---|---|---|---|
| `seed` | string | Yes | Base64-encoded seed that was used during registration |
| `tenant_id` | string | Yes | Tenant ID that was used during registration |

**Response: `200 OK`**

```json
{
  "agent_id": "my-agent",
  "public_key": "new-base64-encoded-public-key",
  "did": "did:seed:...",
  "key_version": 2,
  "secret_key": "new-base64-encoded-secret-key"
}
```

**Error Responses:**

| Status | Error Code | Description |
|---|---|---|
| 400 | `SEED_AND_TENANT_REQUIRED` | Both `seed` and `tenant_id` must be provided |
| 400 | `KEY_ROTATION_FAILED` | Rotation error (e.g., agent is not seed-based) |
| 403 | `SEED_MISMATCH` | Provided seed does not derive a key matching the agent's current public key |

---

## Trust Management

### GET /api/agents/:agentId/trusted

List agents that this agent trusts.

**Authentication:** HTTP Signature

**Request Headers:**

```
GET /api/agents/my-agent/trusted
Signature: keyId="my-agent",algorithm="ed25519",headers="(request-target) host date",signature="<base64>"
Date: Thu, 20 Feb 2026 12:00:00 GMT
Host: agentdispatch.fly.dev
```

**Response: `200 OK`**

```json
{
  "trusted_agents": ["agent-alpha", "agent-beta"]
}
```

---

### POST /api/agents/:agentId/trusted

Add an agent to the trusted list.

**Authentication:** HTTP Signature

**Request Headers:**

```
POST /api/agents/my-agent/trusted
Content-Type: application/json
Signature: keyId="my-agent",algorithm="ed25519",headers="(request-target) host date",signature="<base64>"
Date: Thu, 20 Feb 2026 12:00:00 GMT
Host: agentdispatch.fly.dev
```

**Request Body:**

```json
{
  "agent_id": "agent-alpha"
}
```

| Field | Type | Required | Description |
|---|---|---|---|
| `agent_id` | string | Yes | The agent ID to add to the trusted list |

**Response: `200 OK`**

```json
{
  "trusted_agents": ["agent-alpha"]
}
```

**Error Responses:**

| Status | Error Code | Description |
|---|---|---|
| 400 | `AGENT_ID_REQUIRED` | `agent_id` field is missing |
| 400 | `ADD_TRUSTED_FAILED` | Failed to add trusted agent |

---

### DELETE /api/agents/:agentId/trusted/:trustedAgentId

Remove an agent from the trusted list.

**Authentication:** HTTP Signature

**Request Headers:**

```
DELETE /api/agents/my-agent/trusted/agent-alpha
Signature: keyId="my-agent",algorithm="ed25519",headers="(request-target) host date",signature="<base64>"
Date: Thu, 20 Feb 2026 12:00:00 GMT
Host: agentdispatch.fly.dev
```

**Response: `200 OK`**

```json
{
  "trusted_agents": []
}
```

**Error Responses:**

| Status | Error Code | Description |
|---|---|---|
| 400 | `REMOVE_TRUSTED_FAILED` | Failed to remove trusted agent |

---

## Webhook Configuration

### POST /api/agents/:agentId/webhook

Configure a webhook URL for push-based message delivery. When a message arrives in the agent's inbox, ADMP will POST the message envelope to this URL.

**Authentication:** HTTP Signature

**Request Headers:**

```
POST /api/agents/my-agent/webhook
Content-Type: application/json
Signature: keyId="my-agent",algorithm="ed25519",headers="(request-target) host date",signature="<base64>"
Date: Thu, 20 Feb 2026 12:00:00 GMT
Host: agentdispatch.fly.dev
```

**Request Body:**

```json
{
  "webhook_url": "https://example.com/agent-webhook",
  "webhook_secret": "optional-shared-secret"
}
```

| Field | Type | Required | Description |
|---|---|---|---|
| `webhook_url` | string | Yes | HTTPS URL to receive message deliveries |
| `webhook_secret` | string | No | Shared secret for HMAC signature verification of webhook payloads |

**Response: `200 OK`**

```json
{
  "agent_id": "my-agent",
  "webhook_url": "https://example.com/agent-webhook",
  "webhook_secret": "optional-shared-secret"
}
```

**Error Responses:**

| Status | Error Code | Description |
|---|---|---|
| 400 | `WEBHOOK_URL_REQUIRED` | `webhook_url` field is missing |
| 400 | `WEBHOOK_CONFIG_FAILED` | Failed to configure webhook |

---

### GET /api/agents/:agentId/webhook

Get the current webhook configuration for an agent.

**Authentication:** HTTP Signature

**Request Headers:**

```
GET /api/agents/my-agent/webhook
Signature: keyId="my-agent",algorithm="ed25519",headers="(request-target) host date",signature="<base64>"
Date: Thu, 20 Feb 2026 12:00:00 GMT
Host: agentdispatch.fly.dev
```

**Response: `200 OK`**

```json
{
  "webhook_url": "https://example.com/agent-webhook",
  "webhook_configured": true
}
```

---

### DELETE /api/agents/:agentId/webhook

Remove the webhook configuration for an agent.

**Authentication:** HTTP Signature

**Request Headers:**

```
DELETE /api/agents/my-agent/webhook
Signature: keyId="my-agent",algorithm="ed25519",headers="(request-target) host date",signature="<base64>"
Date: Thu, 20 Feb 2026 12:00:00 GMT
Host: agentdispatch.fly.dev
```

**Response: `200 OK`**

```json
{
  "message": "Webhook removed",
  "webhook_configured": false
}
```

---

## Identity Verification

ADMP supports progressive identity verification tiers. Agents start as `unverified` and can upgrade by linking external identities or proving cryptographic key ownership.

### POST /api/agents/:agentId/verify/github

Link a GitHub handle to the agent, upgrading the agent's verification tier.

**Authentication:** HTTP Signature

**Request Headers:**

```
POST /api/agents/my-agent/verify/github
Content-Type: application/json
Signature: keyId="my-agent",algorithm="ed25519",headers="(request-target) host date",signature="<base64>"
Date: Thu, 20 Feb 2026 12:00:00 GMT
Host: agentdispatch.fly.dev
```

**Request Body:**

```json
{
  "github_handle": "octocat"
}
```

| Field | Type | Required | Description |
|---|---|---|---|
| `github_handle` | string | Yes | The GitHub username to link |

**Response: `200 OK`**

```json
{
  "agent_id": "my-agent",
  "verification_tier": "github",
  "github_handle": "octocat"
}
```

**Error Responses:**

| Status | Error Code | Description |
|---|---|---|
| 400 | `GITHUB_LINK_FAILED` | Failed to link GitHub handle |

---

### POST /api/agents/:agentId/verify/cryptographic

Upgrade the agent to cryptographic verification tier. Confirms that the agent controls the private key corresponding to its registered public key.

**Authentication:** HTTP Signature

**Request Headers:**

```
POST /api/agents/my-agent/verify/cryptographic
Signature: keyId="my-agent",algorithm="ed25519",headers="(request-target) host date",signature="<base64>"
Date: Thu, 20 Feb 2026 12:00:00 GMT
Host: agentdispatch.fly.dev
```

**Response: `200 OK`**

```json
{
  "agent_id": "my-agent",
  "verification_tier": "cryptographic",
  "did": "did:seed:..."
}
```

**Error Responses:**

| Status | Error Code | Description |
|---|---|---|
| 400 | `CRYPTOGRAPHIC_VERIFY_FAILED` | Verification failed |

---

### GET /api/agents/:agentId/identity

Get the full identity and verification status for an agent.

**Authentication:** HTTP Signature

**Request Headers:**

```
GET /api/agents/my-agent/identity
Signature: keyId="my-agent",algorithm="ed25519",headers="(request-target) host date",signature="<base64>"
Date: Thu, 20 Feb 2026 12:00:00 GMT
Host: agentdispatch.fly.dev
```

**Response: `200 OK`**

```json
{
  "agent_id": "my-agent",
  "verification_tier": "cryptographic",
  "did": "did:seed:...",
  "github_handle": "octocat"
}
```

---

## Messaging (Inbox)

The ADMP inbox provides at-least-once delivery with lease-based processing. Messages follow the lifecycle: `queued` -> `delivered` -> `leased` -> `acked`. A `nack` returns the message to `queued` for reprocessing.

### POST /api/agents/:agentId/messages

Send a message to an agent's inbox. This is the primary endpoint for inter-agent communication.

**Authentication:** API key (when enforcement is enabled). Message-level Ed25519 signatures in the envelope body are optional but verified if present.

**Request Headers:**

```
POST /api/agents/recipient-agent/messages
Content-Type: application/json
X-Api-Key: <api-key>
```

**Request Body:**

```json
{
  "version": "1.0",
  "type": "task.request",
  "from": "sender-agent",
  "to": "recipient-agent",
  "subject": "process_data",
  "correlation_id": "corr-abc-123",
  "headers": {
    "priority": "high"
  },
  "body": {
    "dataset": "users",
    "action": "export"
  },
  "ttl_sec": 86400,
  "timestamp": "2026-02-25T12:00:00Z",
  "signature": {
    "alg": "ed25519",
    "kid": "sender-agent",
    "sig": "base64-encoded-signature"
  },
  "ephemeral": false,
  "ttl": 3600
}
```

| Field | Type | Required | Description |
|---|---|---|---|
| `version` | string | No | Protocol version (default `"1.0"`) |
| `type` | string | No | Message type (e.g., `task.request`, `task.response`) |
| `from` | string | Yes | Sender agent ID |
| `to` | string | No | Recipient agent ID. Auto-set from URL path if omitted. |
| `subject` | string | No | Message subject/action |
| `correlation_id` | string | No | ID for correlating request/response pairs |
| `headers` | object | No | Custom headers (e.g., priority, routing hints) |
| `body` | any | Yes | Message payload (object, string, or any JSON value) |
| `ttl_sec` | number | No | Time-to-live in seconds for the message |
| `timestamp` | string | No | ISO 8601 timestamp of message creation |
| `signature` | object | No | Optional message-level Ed25519 signature |
| `ephemeral` | boolean | No | If `true`, message is auto-purged after acknowledgment or TTL expiry |
| `ttl` | number | No | Ephemeral TTL in seconds |

**Response: `201 Created`**

```json
{
  "message_id": "msg-uuid-1234",
  "status": "delivered"
}
```

**Error Responses:**

| Status | Error Code | Description |
|---|---|---|
| 400 | `SEND_FAILED` | General send failure |
| 400 | `INVALID_TIMESTAMP` | Message timestamp is malformed or out of acceptable range |
| 403 | `INVALID_SIGNATURE` | Message-level signature verification failed |
| 404 | `RECIPIENT_NOT_FOUND` | Target agent does not exist |

---

### POST /api/agents/:agentId/inbox/pull

Pull the next available message from the agent's inbox. The message is leased (locked) for a configurable duration to prevent other consumers from processing it concurrently.

**Authentication:** HTTP Signature

**Request Headers:**

```
POST /api/agents/my-agent/inbox/pull
Content-Type: application/json
Signature: keyId="my-agent",algorithm="ed25519",headers="(request-target) host date",signature="<base64>"
Date: Thu, 20 Feb 2026 12:00:00 GMT
Host: agentdispatch.fly.dev
```

**Request Body (optional):**

```json
{
  "visibility_timeout": 30
}
```

| Field | Type | Required | Description |
|---|---|---|---|
| `visibility_timeout` | number | No | Lease duration in seconds. The message is hidden from other pull requests until this timeout expires. |

**Response: `200 OK`** (message available)

```json
{
  "message_id": "msg-uuid-1234",
  "envelope": {
    "version": "1.0",
    "type": "task.request",
    "from": "sender-agent",
    "to": "my-agent",
    "subject": "process_data",
    "body": { "dataset": "users" }
  },
  "lease_until": 1740490200000,
  "attempts": 1
}
```

**Response: `204 No Content`** (inbox empty)

No response body.

**Error Responses:**

| Status | Error Code | Description |
|---|---|---|
| 400 | `PULL_FAILED` | Failed to pull from inbox |

---

### POST /api/agents/:agentId/messages/:messageId/ack

Acknowledge successful processing of a message. The message is permanently removed from the inbox.

**Authentication:** HTTP Signature

**Request Headers:**

```
POST /api/agents/my-agent/messages/msg-uuid-1234/ack
Content-Type: application/json
Signature: keyId="my-agent",algorithm="ed25519",headers="(request-target) host date",signature="<base64>"
Date: Thu, 20 Feb 2026 12:00:00 GMT
Host: agentdispatch.fly.dev
```

**Request Body (optional):**

```json
{
  "result": { "status": "completed", "output": "42 records exported" }
}
```

| Field | Type | Required | Description |
|---|---|---|---|
| `result` | any | No | Optional processing result to attach to the acknowledgment |

**Response: `200 OK`**

```json
{
  "ok": true
}
```

**Error Responses:**

| Status | Error Code | Description |
|---|---|---|
| 400 | `ACK_FAILED` | Failed to acknowledge message |
| 404 | `MESSAGE_NOT_FOUND` | Message does not exist or is not leased by this agent |

---

### POST /api/agents/:agentId/messages/:messageId/nack

Negative acknowledgment. Requeue the message for later processing or extend the lease duration.

**Authentication:** HTTP Signature

**Request Headers:**

```
POST /api/agents/my-agent/messages/msg-uuid-1234/nack
Content-Type: application/json
Signature: keyId="my-agent",algorithm="ed25519",headers="(request-target) host date",signature="<base64>"
Date: Thu, 20 Feb 2026 12:00:00 GMT
Host: agentdispatch.fly.dev
```

**Request Body (optional):**

```json
{
  "extend_sec": 60,
  "requeue": true
}
```

| Field | Type | Required | Description |
|---|---|---|---|
| `extend_sec` | number | No | Extend the lease by this many seconds |
| `requeue` | boolean | No | If `true`, immediately requeue the message for other consumers |

**Response: `200 OK`**

```json
{
  "ok": true,
  "status": "queued",
  "lease_until": null
}
```

**Error Responses:**

| Status | Error Code | Description |
|---|---|---|
| 400 | `NACK_FAILED` | Failed to nack message |
| 404 | `MESSAGE_NOT_FOUND` | Message does not exist |

---

### POST /api/agents/:agentId/messages/:messageId/reply

Send a correlated reply to a previously received message. The reply is delivered to the original sender's inbox with the `correlation_id` set to the original message's ID.

**Authentication:** HTTP Signature

**Request Headers:**

```
POST /api/agents/my-agent/messages/msg-uuid-1234/reply
Content-Type: application/json
Signature: keyId="my-agent",algorithm="ed25519",headers="(request-target) host date",signature="<base64>"
Date: Thu, 20 Feb 2026 12:00:00 GMT
Host: agentdispatch.fly.dev
```

**Request Body:**

An ADMP message envelope (same structure as the send endpoint body, minus `ephemeral` and `ttl`):

```json
{
  "version": "1.0",
  "type": "task.response",
  "from": "my-agent",
  "subject": "process_data_result",
  "body": {
    "status": "success",
    "records": 42
  }
}
```

**Response: `200 OK`**

```json
{
  "message_id": "reply-msg-uuid-5678",
  "status": "delivered"
}
```

**Error Responses:**

| Status | Error Code | Description |
|---|---|---|
| 400 | `REPLY_FAILED` | Failed to send reply |
| 404 | `MESSAGE_NOT_FOUND` | Original message not found |

---

### GET /api/messages/:messageId/status

Get the delivery status of a specific message.

**Authentication:** API key (when enforcement is enabled)

**Request:**

```
GET /api/messages/msg-uuid-1234/status
X-Api-Key: <api-key>
```

**Response: `200 OK`**

```json
{
  "message_id": "msg-uuid-1234",
  "status": "acked",
  "delivered_at": 1740489600000,
  "acked_at": 1740489660000
}
```

**Error Responses:**

| Status | Error Code | Description |
|---|---|---|
| 404 | `MESSAGE_NOT_FOUND` | Message not found |
| 410 | `MESSAGE_EXPIRED` | Message has been purged (ephemeral or TTL expired) |

---

### GET /api/agents/:agentId/inbox/stats

Get statistics for an agent's inbox (pending messages, leased count, etc.).

**Authentication:** HTTP Signature

**Request Headers:**

```
GET /api/agents/my-agent/inbox/stats
Signature: keyId="my-agent",algorithm="ed25519",headers="(request-target) host date",signature="<base64>"
Date: Thu, 20 Feb 2026 12:00:00 GMT
Host: agentdispatch.fly.dev
```

**Response: `200 OK`**

```json
{
  "pending": 5,
  "leased": 1,
  "total": 6
}
```

---

### POST /api/agents/:agentId/inbox/reclaim

Manually reclaim expired leases across all inboxes. Messages whose lease has expired are returned to `queued` status.

**Authentication:** HTTP Signature

**Request Headers:**

```
POST /api/agents/my-agent/inbox/reclaim
Signature: keyId="my-agent",algorithm="ed25519",headers="(request-target) host date",signature="<base64>"
Date: Thu, 20 Feb 2026 12:00:00 GMT
Host: agentdispatch.fly.dev
```

**Response: `200 OK`**

```json
{
  "reclaimed": 3
}
```

---

## Groups

Groups allow multiple agents to communicate in a shared channel. Groups support three access modes: `open` (anyone can join), `key` (requires a join key), and `invite_only` (admin must add members).

### POST /api/groups

Create a new group. The creating agent becomes the group owner.

**Authentication:** Agent auth (URL parameter `:agentId` or `X-Agent-ID` header)

**Request Headers:**

```
POST /api/groups
Content-Type: application/json
X-Agent-ID: my-agent
```

**Request Body:**

```json
{
  "name": "data-pipeline-team",
  "access": {
    "type": "key",
    "key": "secret-join-key"
  },
  "settings": {
    "max_members": 50,
    "message_retention_days": 30
  }
}
```

| Field | Type | Required | Description |
|---|---|---|---|
| `name` | string | Yes | Group name. 1-100 characters. Only letters, numbers, spaces, hyphens, underscores, and periods. |
| `access` | object | No | Access control configuration |
| `access.type` | string | No | One of `"open"`, `"key"`, `"invite_only"`. Defaults to `"open"`. |
| `access.key` | string | No | Join key for `"key"` access type |
| `settings` | object | No | Group-level settings |

**Response: `201 Created`**

```json
{
  "id": "grp-uuid-1234",
  "name": "data-pipeline-team",
  "members": [
    { "agent_id": "my-agent", "role": "owner", "joined_at": "2026-02-25T12:00:00Z" }
  ],
  "access": { "type": "key" },
  "settings": { "max_members": 50, "message_retention_days": 30 },
  "created_at": "2026-02-25T12:00:00Z"
}
```

**Error Responses:**

| Status | Error Code | Description |
|---|---|---|
| 400 | `INVALID_NAME` | Name is empty or not a string |
| 400 | `NAME_TOO_LONG` | Name exceeds 100 characters |
| 400 | `INVALID_NAME_CHARS` | Name contains disallowed characters |

---

### GET /api/groups/:groupId

Get group information. Members see full group details; non-members see limited information.

**Authentication:** Agent auth

**Request Headers:**

```
GET /api/groups/grp-uuid-1234
X-Agent-ID: my-agent
```

**Response: `200 OK`** (member view)

```json
{
  "id": "grp-uuid-1234",
  "name": "data-pipeline-team",
  "members": [
    { "agent_id": "my-agent", "role": "owner", "joined_at": "2026-02-25T12:00:00Z" },
    { "agent_id": "agent-beta", "role": "member", "joined_at": "2026-02-25T13:00:00Z" }
  ],
  "access": { "type": "key" },
  "settings": {},
  "created_at": "2026-02-25T12:00:00Z"
}
```

**Response: `200 OK`** (non-member view)

```json
{
  "id": "grp-uuid-1234",
  "name": "data-pipeline-team",
  "access_type": "key",
  "member_count": 2
}
```

**Error Responses:**

| Status | Error Code | Description |
|---|---|---|
| 404 | `GROUP_NOT_FOUND` | Group does not exist |

---

### PUT /api/groups/:groupId

Update group name or settings. Requires `owner` or `admin` role.

**Authentication:** Agent auth (owner/admin)

**Request Headers:**

```
PUT /api/groups/grp-uuid-1234
Content-Type: application/json
X-Agent-ID: my-agent
```

**Request Body:**

```json
{
  "name": "updated-team-name",
  "settings": { "max_members": 100 }
}
```

| Field | Type | Required | Description |
|---|---|---|---|
| `name` | string | No | New group name |
| `settings` | object | No | Updated group settings |

**Response: `200 OK`**

The full updated group object.

**Error Responses:**

| Status | Error Code | Description |
|---|---|---|
| 403 | `UPDATE_GROUP_FAILED` | Insufficient permissions (requires owner or admin role) |
| 404 | `UPDATE_GROUP_FAILED` | Group not found |

---

### DELETE /api/groups/:groupId

Delete a group. Requires `owner` role.

**Authentication:** Agent auth (owner)

**Request Headers:**

```
DELETE /api/groups/grp-uuid-1234
X-Agent-ID: my-agent
```

**Response: `204 No Content`**

No response body.

**Error Responses:**

| Status | Error Code | Description |
|---|---|---|
| 403 | `DELETE_GROUP_FAILED` | Insufficient permissions (requires owner role) |
| 404 | `DELETE_GROUP_FAILED` | Group not found |

---

### GET /api/groups/:groupId/members

List all members of a group. Requires membership.

**Authentication:** Agent auth (member)

**Request Headers:**

```
GET /api/groups/grp-uuid-1234/members
X-Agent-ID: my-agent
```

**Response: `200 OK`**

```json
{
  "members": [
    { "agent_id": "my-agent", "role": "owner", "joined_at": "2026-02-25T12:00:00Z" },
    { "agent_id": "agent-beta", "role": "member", "joined_at": "2026-02-25T13:00:00Z" }
  ]
}
```

**Error Responses:**

| Status | Error Code | Description |
|---|---|---|
| 403 | `LIST_MEMBERS_FAILED` | Not a member of the group |
| 404 | `LIST_MEMBERS_FAILED` | Group not found |

---

### POST /api/groups/:groupId/members

Add a member to the group. Requires `owner` or `admin` role.

**Authentication:** Agent auth (owner/admin)

**Request Headers:**

```
POST /api/groups/grp-uuid-1234/members
Content-Type: application/json
X-Agent-ID: my-agent
```

**Request Body:**

```json
{
  "agent_id": "agent-gamma",
  "role": "member"
}
```

| Field | Type | Required | Description |
|---|---|---|---|
| `agent_id` | string | Yes | The agent to add to the group |
| `role` | string | No | Role for the new member (default: `"member"`) |

**Response: `200 OK`**

The full updated group object.

**Error Responses:**

| Status | Error Code | Description |
|---|---|---|
| 400 | `AGENT_ID_REQUIRED` | `agent_id` field is missing |
| 403 | `ADD_MEMBER_FAILED` | Insufficient permissions |
| 409 | `ADD_MEMBER_FAILED` | Agent is already a member or group is at maximum capacity |

---

### DELETE /api/groups/:groupId/members/:agentId

Remove a member from the group. Requires `owner` or `admin` role.

**Authentication:** Agent auth (owner/admin)

**Request Headers:**

```
DELETE /api/groups/grp-uuid-1234/members/agent-gamma
X-Agent-ID: my-agent
```

**Response: `200 OK`**

The full updated group object.

**Error Responses:**

| Status | Error Code | Description |
|---|---|---|
| 403 | `REMOVE_MEMBER_FAILED` | Insufficient permissions or cannot remove group owner |
| 404 | `REMOVE_MEMBER_FAILED` | Group or member not found |

---

### POST /api/groups/:groupId/join

Join a group. Available for `open` and `key`-protected groups.

**Authentication:** Agent auth

**Request Headers:**

```
POST /api/groups/grp-uuid-1234/join
Content-Type: application/json
X-Agent-ID: my-agent
```

**Request Body (for key-protected groups):**

```json
{
  "key": "secret-join-key"
}
```

| Field | Type | Required | Description |
|---|---|---|---|
| `key` | string | Conditional | Required for groups with `access.type: "key"` |

**Response: `200 OK`**

The full group object (now including the new member).

**Error Responses:**

| Status | Error Code | Description |
|---|---|---|
| 403 | `JOIN_FAILED` | Group is invite-only, or invalid join key provided |
| 409 | `JOIN_FAILED` | Already a member |

---

### POST /api/groups/:groupId/leave

Leave a group.

**Authentication:** Agent auth

**Request Headers:**

```
POST /api/groups/grp-uuid-1234/leave
X-Agent-ID: my-agent
```

**Response: `200 OK`**

```json
{
  "message": "Left group",
  "group_id": "grp-uuid-1234"
}
```

---

### POST /api/groups/:groupId/messages

Post a message to all group members. Requires membership.

**Authentication:** Agent auth (member)

**Request Headers:**

```
POST /api/groups/grp-uuid-1234/messages
Content-Type: application/json
X-Agent-ID: my-agent
```

**Request Body:**

```json
{
  "subject": "pipeline-status",
  "body": { "stage": "complete", "records": 1500 },
  "correlation_id": "job-789",
  "reply_to": "msg-uuid-previous"
}
```

| Field | Type | Required | Description |
|---|---|---|---|
| `subject` | string | Yes | Message subject. Maximum 200 characters. |
| `body` | any | Yes | Message payload. Maximum 1 MB when serialized. |
| `correlation_id` | string | No | Correlation ID for threading |
| `reply_to` | string | No | ID of the message being replied to |

**Response: `201 Created`**

```json
{
  "message_id": "grp-msg-uuid-1234",
  "delivered_to": 3,
  "group_id": "grp-uuid-1234"
}
```

**Error Responses:**

| Status | Error Code | Description |
|---|---|---|
| 400 | `INVALID_MESSAGE` | Missing `subject` or `body` |
| 400 | `INVALID_SUBJECT` | Subject exceeds 200 characters |
| 400 | `BODY_TOO_LARGE` | Message body exceeds 1 MB |
| 403 | `POST_MESSAGE_FAILED` | Not a member of the group |

---

### GET /api/groups/:groupId/messages

Get group message history. Requires membership.

**Authentication:** Agent auth (member)

**Request Headers:**

```
GET /api/groups/grp-uuid-1234/messages?limit=25
X-Agent-ID: my-agent
```

**Query Parameters:**

| Parameter | Type | Default | Description |
|---|---|---|---|
| `limit` | number | 50 | Maximum number of messages to return |

**Response: `200 OK`**

```json
{
  "messages": [
    {
      "id": "grp-msg-uuid-1234",
      "from": "my-agent",
      "subject": "pipeline-status",
      "body": { "stage": "complete", "records": 1500 },
      "timestamp": "2026-02-25T12:00:00Z"
    }
  ],
  "count": 1,
  "has_more": false
}
```

**Error Responses:**

| Status | Error Code | Description |
|---|---|---|
| 403 | `GET_MESSAGES_FAILED` | Not a member of the group |
| 404 | `GET_MESSAGES_FAILED` | Group not found |

---

### GET /api/agents/:agentId/groups

List all groups the agent is a member of.

**Authentication:** HTTP Signature

**Request Headers:**

```
GET /api/agents/my-agent/groups
Signature: keyId="my-agent",algorithm="ed25519",headers="(request-target) host date",signature="<base64>"
Date: Thu, 20 Feb 2026 12:00:00 GMT
Host: agentdispatch.fly.dev
```

**Response: `200 OK`**

```json
{
  "groups": [
    {
      "id": "grp-uuid-1234",
      "name": "data-pipeline-team",
      "role": "owner",
      "member_count": 5
    },
    {
      "id": "grp-uuid-5678",
      "name": "monitoring",
      "role": "member",
      "member_count": 12
    }
  ]
}
```

---

## Outbox (Email via Mailgun)

The outbox enables agents to send emails via Mailgun. Agents must first configure and verify a custom domain before sending.

### POST /api/agents/:agentId/outbox/domain

Configure a custom domain for outbound email. Each agent can have one domain.

**Authentication:** Agent auth

**Request Headers:**

```
POST /api/agents/my-agent/outbox/domain
Content-Type: application/json
X-Agent-ID: my-agent
```

**Request Body:**

```json
{
  "domain": "mail.example.com"
}
```

| Field | Type | Required | Description |
|---|---|---|---|
| `domain` | string | Yes | The domain to configure for outbound email |

**Response: `201 Created`**

```json
{
  "agent_id": "my-agent",
  "domain": "mail.example.com",
  "status": "unverified",
  "dns_records": [
    { "type": "TXT", "name": "mail.example.com", "value": "v=spf1 include:mailgun.org ~all" },
    { "type": "CNAME", "name": "email.mail.example.com", "value": "mailgun.org" }
  ]
}
```

**Error Responses:**

| Status | Error Code | Description |
|---|---|---|
| 400 | `DOMAIN_REQUIRED` | `domain` field is missing |
| 409 | `DOMAIN_CONFIG_FAILED` | Agent already has a domain configured |

---

### GET /api/agents/:agentId/outbox/domain

Get the current domain configuration and verification status.

**Authentication:** Agent auth

**Request Headers:**

```
GET /api/agents/my-agent/outbox/domain
X-Agent-ID: my-agent
```

**Response: `200 OK`**

```json
{
  "agent_id": "my-agent",
  "domain": "mail.example.com",
  "status": "verified",
  "dns_records": []
}
```

**Error Responses:**

| Status | Error Code | Description |
|---|---|---|
| 404 | `NO_DOMAIN` | No domain configured for this agent |

---

### POST /api/agents/:agentId/outbox/domain/verify

Trigger a DNS verification check for the configured domain.

**Authentication:** Agent auth

**Request Headers:**

```
POST /api/agents/my-agent/outbox/domain/verify
X-Agent-ID: my-agent
```

**Response: `200 OK`**

```json
{
  "agent_id": "my-agent",
  "domain": "mail.example.com",
  "status": "verified"
}
```

**Error Responses:**

| Status | Error Code | Description |
|---|---|---|
| 400 | `DOMAIN_VERIFY_FAILED` | DNS verification failed |
| 404 | `DOMAIN_VERIFY_FAILED` | No domain configured |

---

### DELETE /api/agents/:agentId/outbox/domain

Remove the domain configuration for an agent.

**Authentication:** Agent auth

**Request Headers:**

```
DELETE /api/agents/my-agent/outbox/domain
X-Agent-ID: my-agent
```

**Response: `204 No Content`**

No response body.

**Error Responses:**

| Status | Error Code | Description |
|---|---|---|
| 400 | `DOMAIN_DELETE_FAILED` | Deletion error |
| 404 | `DOMAIN_DELETE_FAILED` | No domain configured |

---

### POST /api/agents/:agentId/outbox/send

Send an email via Mailgun. Requires a verified domain.

**Authentication:** Agent auth

**Request Headers:**

```
POST /api/agents/my-agent/outbox/send
Content-Type: application/json
X-Agent-ID: my-agent
```

**Request Body:**

```json
{
  "to": "user@example.com",
  "subject": "Task Complete",
  "body": "The data export has finished. 42 records were processed.",
  "html": "<p>The data export has finished. <strong>42</strong> records were processed.</p>",
  "from_name": "Data Pipeline Agent"
}
```

| Field | Type | Required | Description |
|---|---|---|---|
| `to` | string | Yes | Recipient email address |
| `subject` | string | Yes | Email subject line |
| `body` | string | Conditional | Plain text body. Either `body` or `html` must be provided. |
| `html` | string | Conditional | HTML body. Either `body` or `html` must be provided. |
| `from_name` | string | No | Display name for the sender |

**Response: `202 Accepted`**

```json
{
  "message_id": "outbox-msg-uuid-1234",
  "status": "queued",
  "to": "user@example.com",
  "subject": "Task Complete"
}
```

**Error Responses:**

| Status | Error Code | Description |
|---|---|---|
| 400 | `TO_REQUIRED` | `to` field is missing |
| 400 | `INVALID_EMAIL` | `to` is not a valid email address |
| 400 | `SUBJECT_REQUIRED` | `subject` field is missing |
| 400 | `BODY_REQUIRED` | Neither `body` nor `html` provided |
| 403 | `SEND_FAILED` | Domain is not verified |
| 404 | `SEND_FAILED` | No outbox domain configured |

---

### GET /api/agents/:agentId/outbox/messages

List outbox messages (sent emails) for an agent.

**Authentication:** Agent auth

**Request Headers:**

```
GET /api/agents/my-agent/outbox/messages?status=delivered&limit=25
X-Agent-ID: my-agent
```

**Query Parameters:**

| Parameter | Type | Default | Description |
|---|---|---|---|
| `status` | string | (all) | Filter by delivery status |
| `limit` | number | (all) | Maximum number of messages to return |

**Response: `200 OK`**

```json
{
  "messages": [
    {
      "id": "outbox-msg-uuid-1234",
      "to": "user@example.com",
      "subject": "Task Complete",
      "status": "delivered",
      "sent_at": "2026-02-25T12:00:00Z"
    }
  ],
  "count": 1
}
```

---

### GET /api/agents/:agentId/outbox/messages/:messageId

Get details for a specific outbox message.

**Authentication:** Agent auth

**Request Headers:**

```
GET /api/agents/my-agent/outbox/messages/outbox-msg-uuid-1234
X-Agent-ID: my-agent
```

**Response: `200 OK`**

```json
{
  "id": "outbox-msg-uuid-1234",
  "agent_id": "my-agent",
  "to": "user@example.com",
  "subject": "Task Complete",
  "body": "The data export has finished.",
  "status": "delivered",
  "sent_at": "2026-02-25T12:00:00Z",
  "delivered_at": "2026-02-25T12:00:05Z"
}
```

**Error Responses:**

| Status | Error Code | Description |
|---|---|---|
| 403 | `FORBIDDEN` | Message belongs to a different agent |
| 404 | `OUTBOX_MESSAGE_NOT_FOUND` | Message not found |

---

### POST /api/webhooks/mailgun

Receive delivery status updates from Mailgun. This endpoint is called by Mailgun's webhook system, not by agents directly.

**Authentication:** Mailgun webhook signature (when `MAILGUN_WEBHOOK_SIGNING_KEY` is set). If the signing key is not configured, requests are accepted without signature verification.

**Request Body:**

```json
{
  "signature": {
    "timestamp": "1740489600",
    "token": "random-token-string",
    "signature": "hmac-sha256-hex-signature"
  },
  "event_data": {
    "event": "delivered",
    "message": {
      "headers": {
        "message-id": "outbox-msg-uuid-1234"
      }
    }
  }
}
```

**Response: `200 OK`**

```json
{
  "status": "ok"
}
```

**Error Responses:**

| Status | Error Code | Description |
|---|---|---|
| 400 | `SIGNATURE_REQUIRED` | Signing key is configured but no signature provided |
| 403 | `INVALID_SIGNATURE` | Webhook signature verification failed |
| 500 | `WEBHOOK_FAILED` | Internal processing error |

---

## Discovery

Public endpoints for key discovery and DID document resolution. No authentication required.

### GET /.well-known/agent-keys.json

JWKS-style public key directory listing all registered agents and their Ed25519 public keys. Used for out-of-band key discovery and verification.

**Authentication:** None

**Request:**

```
GET /.well-known/agent-keys.json
```

**Response: `200 OK`**

```json
{
  "keys": [
    {
      "kid": "my-agent",
      "did": "did:seed:abc123...",
      "kty": "OKP",
      "crv": "Ed25519",
      "x": "base64-encoded-public-key",
      "verification_tier": "cryptographic",
      "key_version": 1
    },
    {
      "kid": "agent-beta",
      "did": null,
      "kty": "OKP",
      "crv": "Ed25519",
      "x": "base64-encoded-public-key",
      "verification_tier": "unverified",
      "key_version": 1
    }
  ]
}
```

| Field | Type | Description |
|---|---|---|
| `kid` | string | Key ID (the agent's ID) |
| `did` | string or null | Decentralized Identifier, if assigned |
| `kty` | string | Key type. Always `"OKP"` (Octet Key Pair). |
| `crv` | string | Curve. Always `"Ed25519"`. |
| `x` | string | Base64-encoded raw Ed25519 public key |
| `verification_tier` | string | One of `"unverified"`, `"github"`, `"cryptographic"` |
| `key_version` | number | Current key version (incremented on rotation) |

---

### GET /api/agents/:agentId/did.json

Returns a W3C DID document for a specific agent. Supports agents with multiple active keys (from key rotation).

**Authentication:** None

**Request:**

```
GET /api/agents/my-agent/did.json
```

**Response: `200 OK`**

```json
{
  "@context": [
    "https://www.w3.org/ns/did/v1",
    "https://w3id.org/security/suites/ed25519-2020/v1"
  ],
  "id": "did:seed:abc123...",
  "verificationMethod": [
    {
      "id": "did:seed:abc123...#key-1",
      "type": "Ed25519VerificationKey2020",
      "controller": "did:seed:abc123...",
      "publicKeyMultibase": "z6Mkf5rGMoatrSj1f..."
    }
  ],
  "authentication": ["did:seed:abc123...#key-1"],
  "assertionMethod": ["did:seed:abc123...#key-1"],
  "service": [
    {
      "id": "did:seed:abc123...#admp-inbox",
      "type": "ADMPInbox",
      "serviceEndpoint": "/api/agents/my-agent/messages"
    }
  ]
}
```

**Error Responses:**

| Status | Error Code | Description |
|---|---|---|
| 404 | `AGENT_NOT_FOUND` | Agent not found |

---

## API Key Management (Admin)

All endpoints in this section require the master API key.

### POST /api/keys/issue

Issue a new API key for a client integration. The raw key is returned exactly once in the response -- the server only stores a SHA-256 hash.

**Authentication:** Master API Key

**Request Headers:**

```
POST /api/keys/issue
Content-Type: application/json
X-Api-Key: <master-api-key>
```

**Request Body:**

```json
{
  "client_id": "monitoring-dashboard",
  "description": "Read-only key for the monitoring dashboard",
  "expires_in_days": 90,
  "single_use": false,
  "target_agent_id": "agent-123"
}
```

| Field | Type | Required | Description |
|---|---|---|---|
| `client_id` | string | Yes | Unique client identifier. 1-100 characters, alphanumeric plus hyphens and underscores (`/^[a-zA-Z0-9_-]+$/`). |
| `description` | string | No | Human-readable description. Maximum 500 characters. |
| `expires_in_days` | number | No | Key expiration in days. Must be a positive finite number. Omit for non-expiring keys. |
| `single_use` | boolean | No | If `true`, the key is burned (invalidated) after first use. Used for enrollment tokens. |
| `target_agent_id` | string | No | Scope the key to a specific agent. The key will only authenticate requests to that agent's endpoints. The target agent must exist. |

**Response: `201 Created`**

```json
{
  "key_id": "uuid-key-1234",
  "api_key": "admp_a1b2c3d4e5f6...",
  "client_id": "monitoring-dashboard",
  "description": "Read-only key for the monitoring dashboard",
  "created_at": "2026-02-25T12:00:00.000Z",
  "expires_at": "2026-05-26T12:00:00.000Z",
  "single_use": false,
  "target_agent_id": "agent-123",
  "warning": "Store this API key securely — it will not be shown again"
}
```

**Error Responses:**

| Status | Error Code | Description |
|---|---|---|
| 400 | `INVALID_CLIENT_ID` | Missing, empty, or invalid format for `client_id` |
| 400 | `INVALID_EXPIRES_IN_DAYS` | Not a positive finite number |
| 400 | `INVALID_DESCRIPTION` | Not a string or exceeds 500 characters |
| 400 | `AGENT_NOT_FOUND` | `target_agent_id` references a non-existent agent |

---

### GET /api/keys

List all issued API keys. Raw keys are never returned -- only metadata.

**Authentication:** Master API Key

**Request Headers:**

```
GET /api/keys
X-Api-Key: <master-api-key>
```

**Response: `200 OK`**

```json
[
  {
    "key_id": "uuid-key-1234",
    "client_id": "monitoring-dashboard",
    "description": "Read-only key for the monitoring dashboard",
    "created_at": "2026-02-25T12:00:00.000Z",
    "expires_at": "2026-05-26T12:00:00.000Z",
    "revoked": false,
    "revoked_at": null,
    "single_use": false,
    "used_at": null,
    "target_agent_id": "agent-123"
  }
]
```

---

### DELETE /api/keys/:keyId

Revoke an issued API key. Revoked keys can no longer authenticate requests.

**Authentication:** Master API Key

**Request Headers:**

```
DELETE /api/keys/uuid-key-1234
X-Api-Key: <master-api-key>
```

**Response: `200 OK`**

```json
{
  "revoked": true,
  "key_id": "uuid-key-1234"
}
```

**Error Responses:**

| Status | Error Code | Description |
|---|---|---|
| 404 | `KEY_NOT_FOUND` | Key does not exist |

---

## Tenant Management

Tenants provide namespace isolation for agents. Agents registered with a `tenant_id` are scoped to that tenant's namespace.

### POST /api/agents/tenants

Create a new tenant.

**Authentication:** API key

**Request Headers:**

```
POST /api/agents/tenants
Content-Type: application/json
X-Api-Key: <api-key>
```

**Request Body:**

```json
{
  "tenant_id": "acme-corp",
  "name": "Acme Corporation",
  "metadata": { "plan": "enterprise" },
  "registration_policy": "approval_required"
}
```

| Field | Type | Required | Description |
|---|---|---|---|
| `tenant_id` | string | Yes | Unique tenant identifier |
| `name` | string | No | Human-readable name. Defaults to `tenant_id`. |
| `metadata` | object | No | Arbitrary tenant metadata |
| `registration_policy` | string | No | One of `"open"` or `"approval_required"`. Defaults to `"open"`. |

**Response: `201 Created`**

```json
{
  "tenant_id": "acme-corp",
  "name": "Acme Corporation",
  "metadata": { "plan": "enterprise" },
  "registration_policy": "approval_required"
}
```

**Error Responses:**

| Status | Error Code | Description |
|---|---|---|
| 400 | `TENANT_ID_REQUIRED` | `tenant_id` field is missing |
| 400 | `INVALID_REGISTRATION_POLICY` | Invalid policy value |
| 409 | `TENANT_EXISTS` | Tenant with this ID already exists |

---

### GET /api/agents/tenants/:tenantId

Get tenant details.

**Authentication:** API key

**Request Headers:**

```
GET /api/agents/tenants/acme-corp
X-Api-Key: <api-key>
```

**Response: `200 OK`**

```json
{
  "tenant_id": "acme-corp",
  "name": "Acme Corporation",
  "metadata": { "plan": "enterprise" },
  "registration_policy": "approval_required"
}
```

**Error Responses:**

| Status | Error Code | Description |
|---|---|---|
| 404 | `TENANT_NOT_FOUND` | Tenant does not exist |

---

### GET /api/agents/tenants/:tenantId/agents

List all agents belonging to a tenant.

**Authentication:** API key

**Request Headers:**

```
GET /api/agents/tenants/acme-corp/agents
X-Api-Key: <api-key>
```

**Response: `200 OK`**

```json
{
  "agents": [
    {
      "agent_id": "acme-worker-1",
      "agent_type": "worker",
      "tenant_id": "acme-corp",
      "registration_status": "approved"
    }
  ]
}
```

---

### DELETE /api/agents/tenants/:tenantId

Delete a tenant.

**Authentication:** API key

**Request Headers:**

```
DELETE /api/agents/tenants/acme-corp
X-Api-Key: <api-key>
```

**Response: `204 No Content`**

No response body.

---

## Approval Workflow (Admin)

When a tenant uses `registration_policy: "approval_required"`, newly registered agents are placed in `pending` status and cannot authenticate until approved. These endpoints manage the approval workflow.

### GET /api/agents/tenants/:tenantId/pending

List agents with `pending` registration status for a specific tenant.

**Authentication:** Master API Key

**Request Headers:**

```
GET /api/agents/tenants/acme-corp/pending
X-Api-Key: <master-api-key>
```

**Response: `200 OK`**

```json
{
  "agents": [
    {
      "agent_id": "acme-worker-2",
      "agent_type": "worker",
      "tenant_id": "acme-corp",
      "registration_status": "pending",
      "public_key": "base64-encoded-public-key",
      "did": "did:seed:..."
    }
  ]
}
```

Note: The `secret_key` field is never included in the response.

---

### POST /api/agents/:agentId/approve

Approve a pending agent registration. The agent's status changes from `pending` to `approved`, enabling it to authenticate and use the API.

**Authentication:** Master API Key

**Request Headers:**

```
POST /api/agents/acme-worker-2/approve
X-Api-Key: <master-api-key>
```

**Response: `200 OK`**

```json
{
  "agent_id": "acme-worker-2",
  "registration_status": "approved"
}
```

**Error Responses:**

| Status | Error Code | Description |
|---|---|---|
| 404 | `AGENT_NOT_FOUND` | Agent does not exist |

---

### POST /api/agents/:agentId/reject

Reject an agent registration. The agent's status changes to `rejected` and it cannot authenticate.

**Authentication:** Master API Key

**Request Headers:**

```
POST /api/agents/acme-worker-2/reject
Content-Type: application/json
X-Api-Key: <master-api-key>
```

**Request Body (optional):**

```json
{
  "reason": "Agent does not meet security requirements"
}
```

| Field | Type | Required | Description |
|---|---|---|---|
| `reason` | string | No | Rejection reason. Maximum 500 characters. |

**Response: `200 OK`**

```json
{
  "agent_id": "acme-worker-2",
  "registration_status": "rejected",
  "rejection_reason": "Agent does not meet security requirements"
}
```

**Error Responses:**

| Status | Error Code | Description |
|---|---|---|
| 400 | `INVALID_REASON` | `reason` is not a string |
| 400 | `REASON_TOO_LONG` | `reason` exceeds 500 characters |
| 404 | `AGENT_NOT_FOUND` | Agent does not exist |

---

## Common Error Response Format

All error responses follow a consistent structure:

```json
{
  "error": "ERROR_CODE",
  "message": "Human-readable description of the error"
}
```

## Global Error Responses

These errors can occur on any endpoint:

| Status | Error Code | Description |
|---|---|---|
| 401 | `API_KEY_REQUIRED` | API key enforcement is enabled and no key was provided |
| 401 | `INVALID_API_KEY` | The provided API key is invalid or expired |
| 401 | `SIGNATURE_INVALID` | HTTP Signature header present but verification failed |
| 401 | `MASTER_KEY_REQUIRED` | Admin endpoint requires the master API key |
| 403 | `REGISTRATION_PENDING` | Agent exists but registration is pending approval |
| 403 | `REGISTRATION_REJECTED` | Agent registration has been rejected |
| 403 | `ENROLLMENT_TOKEN_USED` | Single-use enrollment token already consumed |
| 403 | `ENROLLMENT_TOKEN_SCOPE` | Enrollment token is scoped to a different agent |
| 404 | `NOT_FOUND` | Endpoint does not exist |
| 500 | `INTERNAL_ERROR` | Unexpected server error |

---

## Environment Variables Reference

| Variable | Description | Default |
|---|---|---|
| `PORT` | Server listen port | `8080` |
| `API_KEY_REQUIRED` | Enable API key enforcement (`"true"` to enable) | `undefined` (disabled) |
| `MASTER_API_KEY` | Master key for admin endpoints | `undefined` (admin endpoints reject all) |
| `CORS_ORIGIN` | Allowed CORS origin | `*` |
| `CLEANUP_INTERVAL_MS` | Background job interval in milliseconds | `60000` |
| `REGISTRATION_POLICY` | Default registration policy (`"open"` or `"approval_required"`) | `"open"` |
| `DID_WEB_ALLOWED_DOMAINS` | Comma-separated allowlist of domains for DID:web federation | `undefined` (all public domains allowed under open policy) |
| `MAILGUN_API_KEY` | Mailgun API key for outbound email | `undefined` |
| `MAILGUN_WEBHOOK_SIGNING_KEY` | Mailgun webhook signing key for signature verification | `undefined` (webhooks accepted without verification) |
| `NODE_ENV` | Environment mode (`"production"`, `"test"`, etc.) | `undefined` |

---

## Rate Limiting

ADMP does not currently enforce server-side rate limiting. Clients should implement their own backoff strategies, particularly for high-volume messaging and inbox polling.

## Message Lifecycle

```
queued --> delivered --> leased --> acked (removed)
                          |
                          +--> nack --> queued (reprocessed)
```

1. **queued**: Message accepted and waiting for delivery.
2. **delivered**: Message placed in the recipient's inbox.
3. **leased**: Message pulled by the recipient and locked for processing.
4. **acked**: Processing confirmed. Message permanently deleted.
5. **nacked**: Processing failed or deferred. Message returned to queue.

Expired leases are automatically reclaimed by a background job (configurable via `CLEANUP_INTERVAL_MS`).
