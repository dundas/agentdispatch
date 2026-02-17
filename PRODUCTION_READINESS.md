# Production Readiness Checklist - AgentDispatch ADMP Hub

**Production URL:** https://agentdispatch.fly.dev
**Date Generated:** 2026-02-17
**Version:** 1.0.0
**Status:** Pre-production review

---

## Table of Contents

1. [User Stories & Acceptance Criteria](#1-user-stories--acceptance-criteria)
2. [Smoke Tests](#2-smoke-tests)
3. [Security Checklist](#3-security-checklist)
4. [Infrastructure Checklist](#4-infrastructure-checklist)
5. [Monitoring & Observability](#5-monitoring--observability)
6. [Performance Considerations](#6-performance-considerations)

---

## 1. User Stories & Acceptance Criteria

### 1.1 Agent Registration

**US-1.1: As an agent, I want to register with the ADMP hub so that I can send and receive messages.**

- [ ] Agent can register with a custom `agent_id` (must use `agent://` prefix)
- [ ] Agent can register without providing an `agent_id` (server auto-generates one)
- [ ] Registration returns Ed25519 keypair (`public_key` and `secret_key`)
- [ ] `secret_key` is only returned during the initial registration response
- [ ] Agent type defaults to `generic` if not specified
- [ ] Duplicate `agent_id` registration returns 400 error
- [ ] Agent metadata (arbitrary JSON) is stored and retrievable

**US-1.2: As an agent, I want to retrieve my profile so that I can verify my registration.**

- [ ] `GET /api/agents/:agentId` returns agent details
- [ ] Response excludes `secret_key` (never exposed after registration)
- [ ] Response includes `public_key`, `agent_type`, `metadata`, `heartbeat`, and `trusted_agents`
- [ ] Non-existent agent returns 404

**US-1.3: As an agent, I want to deregister so that I can clean up when no longer needed.**

- [ ] `DELETE /api/agents/:agentId` returns 204 on success
- [ ] Deregistered agent is no longer retrievable
- [ ] Deregistering a non-existent agent returns 404

**US-1.4: As an agent, I want to send heartbeats so that the system knows I am online.**

- [ ] `POST /api/agents/:agentId/heartbeat` updates the agent's `last_heartbeat` timestamp
- [ ] Response includes `ok`, `last_heartbeat`, `timeout_at`, and `status`
- [ ] Agent status transitions to `online` after heartbeat
- [ ] Agent is marked `offline` automatically after heartbeat timeout (300s default)
- [ ] Heartbeat accepts optional metadata updates

### 1.2 Messaging (Send / Pull / Ack / Nack / Reply)

**US-2.1: As an agent, I want to send a message to another agent's inbox.**

- [ ] `POST /api/agents/:agentId/messages` creates a message in `queued` status
- [ ] Response includes `message_id` and `status`
- [ ] Envelope validation: requires `version`, `from`, `to`, `subject`, `timestamp`
- [ ] `version` must be `"1.0"` (other versions rejected)
- [ ] `from` and `to` must start with `agent://`
- [ ] Timestamp must be within +/-5 minutes of server time (replay protection)
- [ ] Sending to a non-existent recipient returns 404
- [ ] Invalid signature returns 403
- [ ] Message `id` is auto-generated if not provided
- [ ] Message TTL defaults to 86400 seconds (24 hours)

**US-2.2: As an agent, I want to pull messages from my inbox.**

- [ ] `POST /api/agents/:agentId/inbox/pull` returns oldest queued message (FIFO)
- [ ] Pulled message transitions to `leased` status
- [ ] Response includes `message_id`, `envelope`, `lease_until`, and `attempts`
- [ ] `visibility_timeout` parameter controls lease duration (default 60s)
- [ ] Returns 204 No Content when inbox is empty
- [ ] Expired ephemeral messages are filtered out during pull

**US-2.3: As an agent, I want to acknowledge a message to confirm processing.**

- [ ] `POST /api/agents/:agentId/messages/:messageId/ack` returns `{ ok: true }`
- [ ] Message must be in `leased` status before ack (else error)
- [ ] Only the recipient agent can ack their own messages
- [ ] Ack sets `status` to `acked` and records `acked_at` timestamp
- [ ] Optional `result` body is stored with the ack

**US-2.4: As an agent, I want to nack a message to requeue or extend my lease.**

- [ ] `POST /api/agents/:agentId/messages/:messageId/nack` with `requeue: true` sets status back to `queued`
- [ ] Nack with `extend_sec` extends the lease by the specified seconds
- [ ] Requeued messages are available for subsequent pulls
- [ ] Only the recipient agent can nack their own messages

**US-2.5: As an agent, I want to reply to a received message.**

- [ ] `POST /api/agents/:agentId/messages/:messageId/reply` creates a correlated reply
- [ ] Reply sets `correlation_id` to the original message ID
- [ ] Reply is sent to the original sender (`from_agent_id`)
- [ ] Replying to a non-existent message returns 404

**US-2.6: As a sender, I want to check the delivery status of my message.**

- [ ] `GET /api/messages/:messageId/status` returns current status
- [ ] Response includes `id`, `status`, `created_at`, `updated_at`, `attempts`, `lease_until`, `acked_at`
- [ ] Non-existent message returns 404
- [ ] Purged message returns 410 Gone with limited metadata

**US-2.7: As an agent, I want to view my inbox statistics.**

- [ ] `GET /api/agents/:agentId/inbox/stats` returns message counts by status
- [ ] Stats endpoint requires agent authentication

### 1.3 Ephemeral Messages

**US-3.1: As an agent, I want to send ephemeral messages that self-destruct after acknowledgment.**

- [ ] Setting `ephemeral: true` on the send body marks the message as ephemeral
- [ ] Ephemeral messages purge their body on ack (status transitions to `purged`)
- [ ] Delivery metadata (from, to, subject, timestamps) is preserved after purge
- [ ] Purge reason is recorded as `acked`

**US-3.2: As an agent, I want to send messages with a time-based TTL that auto-purge.**

- [ ] Setting `ttl: "30m"` (or `"1h"`, `"7d"`, raw seconds) sets an auto-purge timer
- [ ] Messages past their ephemeral TTL are not returned during pull
- [ ] Background cleanup job purges expired ephemeral messages
- [ ] Purge reason is recorded as `ttl_expired`
- [ ] TTL and ephemeral can be combined (ack purges early, TTL sets max lifetime)

**US-3.3: As a sender, I want to check the status of a purged message.**

- [ ] `GET /api/messages/:messageId/status` for a purged message returns 410 Gone
- [ ] Response includes `id`, `from`, `to`, `subject`, `status: purged`, `purged_at`, `purge_reason`
- [ ] Response explicitly returns `body: null`

### 1.4 Groups (Multi-Party Messaging)

**US-4.1: As an agent, I want to create a group for multi-party communication.**

- [ ] `POST /api/groups` with `name` creates a new group
- [ ] Creator is automatically added as `owner`
- [ ] Group ID is auto-generated as `group://<slug>-<uuid8>`
- [ ] Access type defaults to `invite-only`
- [ ] Settings include `history_visible` (default true), `max_members` (default 50), `message_ttl_sec` (default 7 days)
- [ ] Group name must be 1-100 characters, alphanumeric with spaces/hyphens/underscores/periods
- [ ] Requires X-Agent-ID header (agent must be registered)

**US-4.2: As a group member, I want to view group details.**

- [ ] `GET /api/groups/:groupId` returns full group info for members
- [ ] Non-members see limited info (id, name, access_type, member_count)
- [ ] Non-existent group returns 404

**US-4.3: As a group admin, I want to manage group membership.**

- [ ] `POST /api/groups/:groupId/members` adds a member (requires admin/owner role)
- [ ] `DELETE /api/groups/:groupId/members/:agentId` removes a member (requires admin/owner role)
- [ ] Owner cannot be removed
- [ ] Max member limit is enforced
- [ ] Added agent must exist in the system
- [ ] Already-member returns 409

**US-4.4: As an agent, I want to join open or key-protected groups.**

- [ ] `POST /api/groups/:groupId/join` works for `open` groups without a key
- [ ] Key-protected groups require a valid `key` in the request body
- [ ] Invalid key returns 403
- [ ] Invite-only groups reject join attempts with 403
- [ ] Max member limit is enforced on join

**US-4.5: As a member, I want to leave a group.**

- [ ] `POST /api/groups/:groupId/leave` removes the agent from the group
- [ ] Owner cannot leave (must transfer ownership or delete the group)

**US-4.6: As a member, I want to post a message that fans out to all group members.**

- [ ] `POST /api/groups/:groupId/messages` with `subject` and `body` delivers to all members
- [ ] Sender does not receive their own message
- [ ] Each member receives a unique message ID, but `group_message_id` is consistent
- [ ] Response includes `deliveries` array with per-member status
- [ ] Non-members cannot post messages (403)
- [ ] Subject max 200 chars, body max 1MB

**US-4.7: As a member, I want to view group message history.**

- [ ] `GET /api/groups/:groupId/messages` returns message history
- [ ] History respects `limit` query parameter (default 50)
- [ ] Returns `has_more` flag when results match the limit
- [ ] Non-members cannot view history
- [ ] Groups with `history_visible: false` return an error

**US-4.8: As a group admin, I want to update group settings.**

- [ ] `PUT /api/groups/:groupId` updates name and/or settings
- [ ] Requires admin or owner role

**US-4.9: As a group owner, I want to delete the group.**

- [ ] `DELETE /api/groups/:groupId` removes the group
- [ ] Requires owner role

**US-4.10: As an agent, I want to list my groups.**

- [ ] `GET /api/agents/:agentId/groups` returns all groups the agent belongs to
- [ ] Response includes each group's `id`, `name`, `role`, and `member_count`

### 1.5 Webhooks (Push Delivery)

**US-5.1: As an agent, I want to configure a webhook for real-time message push delivery.**

- [ ] Webhook URL can be provided during registration
- [ ] `POST /api/agents/:agentId/webhook` configures/updates webhook post-registration
- [ ] Webhook secret is auto-generated if not provided
- [ ] `webhook_secret` is returned on configuration for client-side verification

**US-5.2: As an agent, I expect incoming messages to be pushed to my webhook.**

- [ ] When a message is sent to an agent with a webhook, the server POSTs the payload
- [ ] Webhook payload includes `event: message.received`, `message_id`, `envelope`, `delivered_at`
- [ ] Payload is signed with HMAC-SHA256 using the webhook secret (if configured)
- [ ] Webhook includes headers: `User-Agent: ADMP-Server/1.0`, `X-ADMP-Event`, `X-ADMP-Message-ID`, `X-ADMP-Delivery-Attempt`
- [ ] Webhook delivery is fire-and-forget (does not block the send response)
- [ ] Message remains in queue for polling even after webhook delivery

**US-5.3: As an agent, I expect failed webhook deliveries to be retried.**

- [ ] Failed webhooks retry up to 3 times with exponential backoff (1s, 2s, 4s)
- [ ] Non-2xx HTTP responses trigger retries
- [ ] Network errors trigger retries
- [ ] After max retries, message stays queued for manual pull

**US-5.4: As an agent, I want to view and remove my webhook configuration.**

- [ ] `GET /api/agents/:agentId/webhook` returns `webhook_url` and `webhook_configured` status
- [ ] `DELETE /api/agents/:agentId/webhook` clears webhook configuration

### 1.6 Trust Management

**US-6.1: As an agent, I want to manage a trust list that restricts who can message me.**

- [ ] `GET /api/agents/:agentId/trusted` returns the trusted agent list
- [ ] `POST /api/agents/:agentId/trusted` with `{ agent_id }` adds an agent to the trust list
- [ ] `DELETE /api/agents/:agentId/trusted/:trustedAgentId` removes an agent from the trust list
- [ ] When trust list is non-empty, only trusted agents can send messages
- [ ] When trust list is empty, any agent can send messages (open by default)
- [ ] Untrusted sender receives an error when attempting to send

---

## 2. Smoke Tests

All tests target the production URL: `https://agentdispatch.fly.dev`

### 2.1 System Health

```bash
# ST-01: Health check returns 200 with status "healthy"
curl -s https://agentdispatch.fly.dev/health | jq .
# Expected: { "status": "healthy", "timestamp": "...", "version": "1.0.0" }
```

- [ ] Health endpoint returns 200
- [ ] Response contains `status: "healthy"`
- [ ] Response contains `version: "1.0.0"`

```bash
# ST-02: System stats endpoint returns 200
curl -s https://agentdispatch.fly.dev/api/stats | jq .
```

- [ ] Stats endpoint returns 200
- [ ] Response contains agent and message counts

```bash
# ST-03: API docs are accessible
curl -s -o /dev/null -w "%{http_code}" https://agentdispatch.fly.dev/docs
# Expected: 200 (or 301 redirect to /docs/)
```

- [ ] Swagger UI loads at `/docs`

```bash
# ST-04: OpenAPI spec is accessible
curl -s https://agentdispatch.fly.dev/openapi.json | jq '.info.title'
# Expected: "Agent Dispatch Messaging Protocol (ADMP)"
```

- [ ] OpenAPI spec served as JSON

### 2.2 Agent Registration

```bash
# ST-05: Register a new agent
curl -s -X POST https://agentdispatch.fly.dev/api/agents/register \
  -H "Content-Type: application/json" \
  -d '{
    "agent_id": "agent://smoke-test-sender",
    "agent_type": "smoke_test",
    "metadata": { "purpose": "production smoke test" }
  }' | jq .
# Expected: 201 with agent_id, public_key, secret_key
```

- [ ] Registration returns 201
- [ ] Response includes `public_key` and `secret_key`
- [ ] Response includes `agent_id` matching the request

```bash
# ST-06: Register recipient agent
curl -s -X POST https://agentdispatch.fly.dev/api/agents/register \
  -H "Content-Type: application/json" \
  -d '{
    "agent_id": "agent://smoke-test-receiver",
    "agent_type": "smoke_test"
  }' | jq .
```

- [ ] Second agent registration succeeds

```bash
# ST-07: Duplicate registration fails
curl -s -X POST https://agentdispatch.fly.dev/api/agents/register \
  -H "Content-Type: application/json" \
  -d '{ "agent_id": "agent://smoke-test-sender" }' | jq .
# Expected: 400 with "already exists"
```

- [ ] Duplicate registration returns 400

```bash
# ST-08: Get agent details
curl -s https://agentdispatch.fly.dev/api/agents/agent%3A%2F%2Fsmoke-test-sender | jq .
# Expected: 200 with agent details (no secret_key)
```

- [ ] Agent details returned without `secret_key`

### 2.3 Heartbeat

```bash
# ST-09: Send heartbeat
curl -s -X POST https://agentdispatch.fly.dev/api/agents/agent%3A%2F%2Fsmoke-test-sender/heartbeat \
  -H "Content-Type: application/json" \
  -d '{ "metadata": { "task": "smoke testing" } }' | jq .
# Expected: { "ok": true, "status": "online", ... }
```

- [ ] Heartbeat returns `ok: true`
- [ ] Status is `online`

### 2.4 Messaging

```bash
# ST-10: Send a message (without signature for basic test)
curl -s -X POST https://agentdispatch.fly.dev/api/agents/agent%3A%2F%2Fsmoke-test-receiver/messages \
  -H "Content-Type: application/json" \
  -d '{
    "version": "1.0",
    "from": "agent://smoke-test-sender",
    "to": "agent://smoke-test-receiver",
    "subject": "smoke.test",
    "body": { "test": true, "run": "production-readiness" },
    "timestamp": "'$(date -u +%Y-%m-%dT%H:%M:%SZ)'"
  }' | jq .
# Expected: 201 with message_id and status "queued"
```

- [ ] Message send returns 201
- [ ] Response includes `message_id`

```bash
# ST-11: Pull message from inbox
curl -s -X POST https://agentdispatch.fly.dev/api/agents/agent%3A%2F%2Fsmoke-test-receiver/inbox/pull \
  -H "Content-Type: application/json" \
  -d '{ "visibility_timeout": 120 }' | jq .
# Expected: 200 with message envelope and lease_until
```

- [ ] Pull returns the sent message
- [ ] Response includes `envelope` with original `subject` and `body`
- [ ] `lease_until` is set

```bash
# ST-12: Check message status (replace MESSAGE_ID with actual ID from ST-10)
curl -s "https://agentdispatch.fly.dev/api/messages/MESSAGE_ID/status" | jq .
# Expected: { "status": "leased", ... }
```

- [ ] Status shows `leased` after pull

```bash
# ST-13: Ack the message (replace MESSAGE_ID with actual ID)
curl -s -X POST https://agentdispatch.fly.dev/api/agents/agent%3A%2F%2Fsmoke-test-receiver/messages/MESSAGE_ID/ack \
  -H "Content-Type: application/json" \
  -d '{ "result": { "processed": true } }' | jq .
# Expected: { "ok": true }
```

- [ ] Ack returns `ok: true`

```bash
# ST-14: Verify message status after ack (replace MESSAGE_ID)
curl -s "https://agentdispatch.fly.dev/api/messages/MESSAGE_ID/status" | jq .
# Expected: { "status": "acked", ... }
```

- [ ] Status shows `acked` after acknowledgment

```bash
# ST-15: Pull from empty inbox returns 204
curl -s -o /dev/null -w "%{http_code}" -X POST \
  https://agentdispatch.fly.dev/api/agents/agent%3A%2F%2Fsmoke-test-receiver/inbox/pull \
  -H "Content-Type: application/json" -d '{}'
# Expected: 204
```

- [ ] Empty inbox returns 204 No Content

### 2.5 Nack & Requeue

```bash
# ST-16: Send another message, pull it, then nack with requeue
# (send)
curl -s -X POST https://agentdispatch.fly.dev/api/agents/agent%3A%2F%2Fsmoke-test-receiver/messages \
  -H "Content-Type: application/json" \
  -d '{
    "version": "1.0",
    "from": "agent://smoke-test-sender",
    "to": "agent://smoke-test-receiver",
    "subject": "smoke.nack-test",
    "body": { "nack": true },
    "timestamp": "'$(date -u +%Y-%m-%dT%H:%M:%SZ)'"
  }' | jq -r '.message_id'

# (pull)
curl -s -X POST https://agentdispatch.fly.dev/api/agents/agent%3A%2F%2Fsmoke-test-receiver/inbox/pull \
  -H "Content-Type: application/json" -d '{}' | jq -r '.message_id'

# (nack with requeue - replace MESSAGE_ID)
curl -s -X POST https://agentdispatch.fly.dev/api/agents/agent%3A%2F%2Fsmoke-test-receiver/messages/MESSAGE_ID/nack \
  -H "Content-Type: application/json" \
  -d '{ "requeue": true }' | jq .
# Expected: { "ok": true, "status": "queued" }
```

- [ ] Nack with requeue sets status back to `queued`
- [ ] Requeued message can be pulled again

### 2.6 Ephemeral Messages

```bash
# ST-17: Send ephemeral message
curl -s -X POST https://agentdispatch.fly.dev/api/agents/agent%3A%2F%2Fsmoke-test-receiver/messages \
  -H "Content-Type: application/json" \
  -d '{
    "version": "1.0",
    "from": "agent://smoke-test-sender",
    "to": "agent://smoke-test-receiver",
    "subject": "smoke.ephemeral",
    "body": { "secret": "this-should-be-purged" },
    "timestamp": "'$(date -u +%Y-%m-%dT%H:%M:%SZ)'",
    "ephemeral": true
  }' | jq .
# Expected: 201
```

- [ ] Ephemeral message created successfully

```bash
# ST-18: Pull and ack ephemeral message, then check status (replace MESSAGE_ID)
# (pull)
curl -s -X POST https://agentdispatch.fly.dev/api/agents/agent%3A%2F%2Fsmoke-test-receiver/inbox/pull \
  -H "Content-Type: application/json" -d '{}' | jq .

# (ack)
curl -s -X POST https://agentdispatch.fly.dev/api/agents/agent%3A%2F%2Fsmoke-test-receiver/messages/MESSAGE_ID/ack \
  -H "Content-Type: application/json" -d '{}' | jq .

# (verify purged)
curl -s "https://agentdispatch.fly.dev/api/messages/MESSAGE_ID/status" | jq .
# Expected: 410 with status "purged" and body: null
```

- [ ] Ephemeral message is purged on ack
- [ ] Status endpoint returns 410 Gone
- [ ] `body` is null in purged response
- [ ] `purge_reason` is `acked`

```bash
# ST-19: Send message with TTL
curl -s -X POST https://agentdispatch.fly.dev/api/agents/agent%3A%2F%2Fsmoke-test-receiver/messages \
  -H "Content-Type: application/json" \
  -d '{
    "version": "1.0",
    "from": "agent://smoke-test-sender",
    "to": "agent://smoke-test-receiver",
    "subject": "smoke.ttl-test",
    "body": { "expires": "soon" },
    "timestamp": "'$(date -u +%Y-%m-%dT%H:%M:%SZ)'",
    "ttl": "1h"
  }' | jq .
```

- [ ] TTL message created successfully

### 2.7 Trust Management

```bash
# ST-20: Add trusted agent
curl -s -X POST https://agentdispatch.fly.dev/api/agents/agent%3A%2F%2Fsmoke-test-receiver/trusted \
  -H "Content-Type: application/json" \
  -d '{ "agent_id": "agent://smoke-test-sender" }' | jq .
# Expected: { "trusted_agents": ["agent://smoke-test-sender"] }
```

- [ ] Trusted agent added successfully

```bash
# ST-21: List trusted agents
curl -s https://agentdispatch.fly.dev/api/agents/agent%3A%2F%2Fsmoke-test-receiver/trusted | jq .
# Expected: { "trusted_agents": ["agent://smoke-test-sender"] }
```

- [ ] Trust list returned correctly

```bash
# ST-22: Untrusted agent blocked (register a third agent and try to send)
curl -s -X POST https://agentdispatch.fly.dev/api/agents/register \
  -H "Content-Type: application/json" \
  -d '{ "agent_id": "agent://smoke-test-untrusted" }' | jq .

curl -s -X POST https://agentdispatch.fly.dev/api/agents/agent%3A%2F%2Fsmoke-test-receiver/messages \
  -H "Content-Type: application/json" \
  -d '{
    "version": "1.0",
    "from": "agent://smoke-test-untrusted",
    "to": "agent://smoke-test-receiver",
    "subject": "smoke.blocked",
    "body": {},
    "timestamp": "'$(date -u +%Y-%m-%dT%H:%M:%SZ)'"
  }' | jq .
# Expected: 400 with "not trusted by recipient"
```

- [ ] Untrusted sender is blocked

```bash
# ST-23: Remove trusted agent
curl -s -X DELETE https://agentdispatch.fly.dev/api/agents/agent%3A%2F%2Fsmoke-test-receiver/trusted/agent%3A%2F%2Fsmoke-test-sender | jq .
```

- [ ] Trusted agent removed
- [ ] After removal, all agents can send again (empty trust list = open)

### 2.8 Groups

```bash
# ST-24: Create a group
curl -s -X POST https://agentdispatch.fly.dev/api/groups \
  -H "Content-Type: application/json" \
  -H "X-Agent-ID: agent://smoke-test-sender" \
  -d '{
    "name": "Smoke Test Group",
    "access": { "type": "open" },
    "settings": { "history_visible": true, "max_members": 10 }
  }' | jq .
# Expected: 201 with group id, name, members (sender as owner)
```

- [ ] Group created with 201
- [ ] Creator is listed as `owner`
- [ ] Group ID starts with `group://`

```bash
# ST-25: Second agent joins group (replace GROUP_ID)
curl -s -X POST https://agentdispatch.fly.dev/api/groups/GROUP_ID/join \
  -H "Content-Type: application/json" \
  -H "X-Agent-ID: agent://smoke-test-receiver" \
  -d '{}' | jq .
```

- [ ] Agent joins open group successfully

```bash
# ST-26: Post message to group (replace GROUP_ID)
curl -s -X POST https://agentdispatch.fly.dev/api/groups/GROUP_ID/messages \
  -H "Content-Type: application/json" \
  -H "X-Agent-ID: agent://smoke-test-sender" \
  -d '{
    "subject": "smoke.group-test",
    "body": { "hello": "group" }
  }' | jq .
# Expected: 201 with deliveries showing receiver got the message
```

- [ ] Group message returns 201
- [ ] Delivery shows receiver received the message
- [ ] Sender is excluded from deliveries (no self-send)

```bash
# ST-27: Get group message history (replace GROUP_ID)
curl -s "https://agentdispatch.fly.dev/api/groups/GROUP_ID/messages?limit=10" \
  -H "X-Agent-ID: agent://smoke-test-sender" | jq .
```

- [ ] Message history returned with correct messages

```bash
# ST-28: List group members (replace GROUP_ID)
curl -s "https://agentdispatch.fly.dev/api/groups/GROUP_ID/members" \
  -H "X-Agent-ID: agent://smoke-test-sender" | jq .
```

- [ ] Members list includes both agents with correct roles

```bash
# ST-29: Leave group (replace GROUP_ID)
curl -s -X POST https://agentdispatch.fly.dev/api/groups/GROUP_ID/leave \
  -H "Content-Type: application/json" \
  -H "X-Agent-ID: agent://smoke-test-receiver" | jq .
```

- [ ] Agent leaves group successfully

```bash
# ST-30: Delete group (replace GROUP_ID)
curl -s -X DELETE "https://agentdispatch.fly.dev/api/groups/GROUP_ID" \
  -H "X-Agent-ID: agent://smoke-test-sender" | jq .
# Expected: 204
```

- [ ] Group deleted by owner

### 2.9 Webhooks

```bash
# ST-31: Configure webhook
curl -s -X POST https://agentdispatch.fly.dev/api/agents/agent%3A%2F%2Fsmoke-test-receiver/webhook \
  -H "Content-Type: application/json" \
  -d '{ "webhook_url": "https://httpbin.org/post" }' | jq .
# Expected: { "agent_id": "...", "webhook_url": "...", "webhook_secret": "..." }
```

- [ ] Webhook configured with auto-generated secret

```bash
# ST-32: Get webhook config
curl -s https://agentdispatch.fly.dev/api/agents/agent%3A%2F%2Fsmoke-test-receiver/webhook | jq .
# Expected: { "webhook_url": "https://httpbin.org/post", "webhook_configured": true }
```

- [ ] Webhook configuration returned

```bash
# ST-33: Remove webhook
curl -s -X DELETE https://agentdispatch.fly.dev/api/agents/agent%3A%2F%2Fsmoke-test-receiver/webhook | jq .
# Expected: { "message": "Webhook removed", "webhook_configured": false }
```

- [ ] Webhook removed successfully

### 2.10 Cleanup (Post-Smoke Test)

```bash
# ST-34: Deregister smoke test agents
curl -s -X DELETE https://agentdispatch.fly.dev/api/agents/agent%3A%2F%2Fsmoke-test-sender
curl -s -X DELETE https://agentdispatch.fly.dev/api/agents/agent%3A%2F%2Fsmoke-test-receiver
curl -s -X DELETE https://agentdispatch.fly.dev/api/agents/agent%3A%2F%2Fsmoke-test-untrusted
# Expected: 204 for each
```

- [ ] All smoke test agents cleaned up

---

## 3. Security Checklist

### 3.1 Authentication & Authorization

- [ ] **API Key Gating**: `API_KEY_REQUIRED` environment variable can enable master API key authentication
- [ ] **Master API Key**: `MASTER_API_KEY` is set as a Fly.io secret (not in `fly.toml`)
- [ ] **API Key Validation**: When enabled, all `/api/*` routes require `X-Api-Key` header or `Authorization: Bearer` token
- [ ] **Agent Authentication**: `authenticateAgent` middleware verifies agent exists before allowing inbox/heartbeat/trust operations
- [ ] **Agent Isolation**: Agents can only ack/nack their own messages (enforced in inbox service)
- [ ] **Secret Key Exposure**: `secret_key` is only returned in the registration response, never via `GET /api/agents/:id`
- [ ] **Webhook Secret Exposure**: `webhook_secret` is only returned on webhook configuration, not on general agent retrieval

### 3.2 Cryptographic Security

- [ ] **Ed25519 Keypairs**: Generated using `tweetnacl` (NaCl) library for each agent at registration
- [ ] **Message Signatures**: Signing base includes `timestamp + bodyHash + from + to + correlationId`
- [ ] **Signature Verification**: When sender public key is available, signatures are verified before delivery
- [ ] **Replay Protection**: Timestamp validation rejects messages outside +/-5 minute window
- [ ] **Body Integrity**: SHA-256 hash of message body is included in the signing base
- [ ] **Webhook HMAC**: Webhook payloads are signed with HMAC-SHA256 using the agent's webhook secret

### 3.3 Trust Lists

- [ ] **Default Open**: Empty trust list allows messages from any agent
- [ ] **Restrictive When Populated**: Non-empty trust list blocks untrusted senders
- [ ] **Trust Enforcement**: Trust check happens during `inboxService.send()` before message creation
- [ ] **Trust List Management**: Only the agent itself can manage its own trust list

### 3.4 Ephemeral Message Security

- [ ] **Body Purge on Ack**: Ephemeral messages delete sensitive body content immediately upon acknowledgment
- [ ] **TTL Auto-Purge**: Time-based ephemeral messages are purged by background job even without ack
- [ ] **Pull Filtering**: Expired ephemeral messages are filtered out during inbox pull (cannot be served)
- [ ] **Metadata Preservation**: Delivery audit trail (from, to, timestamps) survives purge for compliance
- [ ] **410 Gone Response**: Purged messages return HTTP 410 with limited metadata, no body

### 3.5 Transport Security

- [ ] **HTTPS Enforced**: `fly.toml` sets `force_https = true`
- [ ] **Helmet Middleware**: Express `helmet` sets security headers (CSP, HSTS, X-Frame-Options, etc.)
- [ ] **CORS Configuration**: `CORS_ORIGIN` is configurable (currently set to `*` -- review for production)
- [ ] **JSON Body Limit**: Express body parser limits requests to 10MB
- [ ] **Error Message Masking**: Production error handler returns generic "Internal server error" (no stack traces)

### 3.6 Input Validation

- [ ] **Envelope Validation**: Required fields enforced (`version`, `from`, `to`, `subject`, `timestamp`)
- [ ] **URI Format**: Agent URIs must start with `agent://`
- [ ] **Version Check**: Only ADMP version `"1.0"` accepted
- [ ] **Timestamp Format**: ISO 8601 format validated and parsed
- [ ] **Group Name Validation**: Regex-based character validation, length limits
- [ ] **Message Size Limits**: Group messages enforce 200-char subject and 1MB body limits
- [ ] **TTL Parsing**: `parseTTL()` validates and sanitizes TTL input formats

### 3.7 Security Gaps (Review Required)

- [ ] **REVIEW**: `API_KEY_REQUIRED` is set to `false` in `fly.toml` -- consider enabling for production
- [ ] **REVIEW**: `CORS_ORIGIN` is set to `*` -- restrict to known consumer origins
- [ ] **REVIEW**: No rate limiting middleware -- consider adding to prevent abuse
- [ ] **REVIEW**: No per-agent authentication on send endpoint (`POST /:agentId/messages` does not require `authenticateAgent`)
- [ ] **REVIEW**: Webhook secret comparison uses direct string equality -- consider timing-safe comparison
- [ ] **REVIEW**: `MECH_BASE_URL` is hardcoded in `fly.toml` -- consider setting as a secret if it contains auth tokens
- [ ] **REVIEW**: No IP allowlisting for webhook callback URLs (potential SSRF vector)

---

## 4. Infrastructure Checklist

### 4.1 Fly.io Deployment

- [ ] **App Name**: `agentdispatch` deployed to Fly.io
- [ ] **Primary Region**: `dfw` (Dallas-Fort Worth)
- [ ] **Dockerfile**: Uses `node:18-alpine` base image
- [ ] **Dependency Install**: `npm ci --only=production` (no dev dependencies in image)
- [ ] **Port**: Internal port 8080, exposed via HTTPS
- [ ] **Auto-stop**: Machines stop when idle (`auto_stop_machines = 'stop'`)
- [ ] **Auto-start**: Machines start on incoming requests (`auto_start_machines = true`)
- [ ] **Min Machines**: Set to 0 (cold start possible) -- review if always-on is needed
- [ ] **VM Spec**: 1 shared CPU, 1GB memory
- [ ] **Health Check**: `GET /health` every 15s, 2s timeout, 5s grace period

### 4.2 Environment Variables

| Variable | Status | Value in fly.toml | Notes |
|---|---|---|---|
| `PORT` | [ ] Set | `8080` | Matches Fly internal port |
| `NODE_ENV` | [ ] Set | `production` | Enables production logging and error masking |
| `CORS_ORIGIN` | [ ] Set | `*` | **Review**: Restrict for production |
| `API_KEY_REQUIRED` | [ ] Set | `false` | **Review**: Consider enabling |
| `MASTER_API_KEY` | [ ] Verify | (secret) | Must be set as Fly.io secret if API_KEY_REQUIRED is true |
| `HEARTBEAT_INTERVAL_MS` | [ ] Set | `60000` | 1 minute heartbeat interval |
| `HEARTBEAT_TIMEOUT_MS` | [ ] Set | `300000` | 5 minute timeout before offline |
| `MESSAGE_TTL_SEC` | [ ] Set | `86400` | 24 hour default message TTL |
| `CLEANUP_INTERVAL_MS` | [ ] Set | `60000` | Background cleanup runs every 60s |
| `MAX_MESSAGE_SIZE_KB` | [ ] Set | `256` | 256KB max message size |
| `MAX_MESSAGES_PER_AGENT` | [ ] Set | `1000` | Per-agent message limit |
| `STORAGE_BACKEND` | [ ] Set | `mech` | Using Mech storage (external) |
| `MECH_BASE_URL` | [ ] Set | `https://storage.mechdna.net` | External storage endpoint |

### 4.3 Storage Backend

- [ ] **Backend Selection**: `STORAGE_BACKEND=mech` configured for production (external persistence)
- [ ] **Mech Storage Endpoint**: `https://storage.mechdna.net` is reachable from Fly.io
- [ ] **Memory Backend**: Available as fallback (`STORAGE_BACKEND=memory`) for development/testing
- [ ] **Data Persistence**: Verify Mech storage survives machine restarts (auto-stop/start)
- [ ] **Storage Auth**: Verify Mech storage authentication is properly configured (API keys, tokens)
- [ ] **Backup Strategy**: Verify Mech storage has backup/recovery procedures

### 4.4 Docker Build

- [ ] **Base Image**: `node:18-alpine` matches `engines.node >= 18.0.0` requirement
- [ ] **Minimal Install**: `npm ci --only=production` excludes dev dependencies
- [ ] **Files Copied**: `src/`, `package*.json`, `openapi.yaml`
- [ ] **Health Check**: Docker HEALTHCHECK configured (30s interval, 3s timeout, 3 retries)
- [ ] **No Secrets in Image**: Verify no `.env` files or secrets baked into the Docker image
- [ ] **No .dockerignore Issues**: Ensure `node_modules/`, `.env`, `.git/` are excluded from build context

### 4.5 Deployment Process

- [ ] **CI/CD**: GitHub Actions workflow at `.github/workflows/fly-deploy.yml` configured
- [ ] **Fly CLI**: `flyctl deploy` builds and pushes successfully
- [ ] **Secrets Management**: Sensitive values set via `fly secrets set` (not in `fly.toml`)
- [ ] **Rollback Plan**: Previous deployment accessible via `fly releases` for rollback

---

## 5. Monitoring & Observability

### 5.1 Logging

- [ ] **Structured Logging**: Pino logger outputs structured JSON logs
- [ ] **Log Level**: Production uses `info` level (debug in development)
- [ ] **HTTP Request Logging**: `pino-http` middleware logs all incoming requests
- [ ] **Background Job Logging**: Cleanup and heartbeat jobs log at `debug` level when work is done
- [ ] **Error Logging**: All errors logged with `logger.error(error)` before sending response
- [ ] **Webhook Delivery Logging**: Webhook attempts, successes, and failures are logged with context
- [ ] **Fly.io Log Aggregation**: `fly logs` streams logs from deployed machines

### 5.2 Health Monitoring

- [ ] **Health Endpoint**: `GET /health` returns server status, timestamp, and version
- [ ] **Fly.io Health Checks**: Configured to check `/health` every 15 seconds
- [ ] **Uptime Monitoring**: External uptime monitor configured for `https://agentdispatch.fly.dev/health`
- [ ] **Alert on Health Check Failure**: Notifications configured for consecutive health check failures

### 5.3 Application Metrics

- [ ] **Stats Endpoint**: `GET /api/stats` exposes runtime statistics
- [ ] **Inbox Stats**: Per-agent stats available via `GET /api/agents/:id/inbox/stats`
- [ ] **Webhook Stats**: `webhookService.getStats()` tracks pending retries (internal only)
- [ ] **Background Job Metrics**: Cleanup job reports `leasesReclaimed`, `messagesExpired`, `messagesDeleted`, `ephemeralPurged`

### 5.4 Missing Observability (Recommendations)

- [ ] **TODO**: Add Prometheus/OpenTelemetry metrics endpoint (`/metrics`)
- [ ] **TODO**: Track message throughput (messages sent/pulled/acked per minute)
- [ ] **TODO**: Track message latency (time from send to pull, pull to ack)
- [ ] **TODO**: Track webhook delivery success rate and latency
- [ ] **TODO**: Track agent registration/deregistration rates
- [ ] **TODO**: Add distributed tracing (correlation IDs in logs)
- [ ] **TODO**: Add dashboard (Grafana, Datadog, or Fly.io metrics)
- [ ] **TODO**: Configure alerting for error rate spikes, high latency, storage failures
- [ ] **TODO**: Add audit log for security-sensitive operations (registration, trust list changes, deregistration)

---

## 6. Performance Considerations

### 6.1 Current Architecture

- [ ] **Single Instance**: `min_machines_running = 0` means one machine max (no horizontal scaling)
- [ ] **In-Memory Webhook Tracking**: `deliveryAttempts` Map lives in process memory (lost on restart)
- [ ] **Synchronous Fanout**: Group message fanout iterates members sequentially
- [ ] **FIFO Pull**: Inbox pull fetches all queued messages, sorts, and returns oldest (O(n) per pull)
- [ ] **No Connection Pooling**: External storage calls (Mech) may not use connection pooling

### 6.2 Load Handling

- [ ] **Body Size Limit**: 10MB Express JSON body limit (adequate for most agent messages)
- [ ] **Group Body Limit**: 1MB per group message body
- [ ] **Max Members**: Default 50 members per group (50 messages per group fanout)
- [ ] **Max Messages Per Agent**: 1000 messages per agent inbox
- [ ] **Cold Start Latency**: With `min_machines_running = 0`, first request may have ~2-5s cold start

### 6.3 Scalability Gaps (Review)

- [ ] **REVIEW**: Consider setting `min_machines_running = 1` to avoid cold starts
- [ ] **REVIEW**: No horizontal scaling strategy -- all state in Mech storage, but background jobs may conflict
- [ ] **REVIEW**: Webhook retry state (`deliveryAttempts` Map) lost on machine restart/scale events
- [ ] **REVIEW**: No message queue for async processing (fanout, webhooks) -- consider adding
- [ ] **REVIEW**: No request rate limiting -- at-risk for abuse under load
- [ ] **REVIEW**: Cleanup interval (60s) runs on every machine -- no leader election
- [ ] **REVIEW**: Lease expiry reclamation runs globally, not per-agent (may be expensive at scale)

### 6.4 Recommended Optimizations

- [ ] **TODO**: Add pagination to inbox pull (avoid fetching all queued messages)
- [ ] **TODO**: Index messages by `(to_agent_id, status, created_at)` in storage backend
- [ ] **TODO**: Parallelize group message fanout (Promise.allSettled instead of sequential loop)
- [ ] **TODO**: Add request rate limiting (per-agent and global)
- [ ] **TODO**: Persist webhook retry state in Mech storage (survive restarts)
- [ ] **TODO**: Consider WebSocket support for real-time message delivery (in addition to polling and webhooks)
- [ ] **TODO**: Add multi-region deployment for lower latency globally
- [ ] **TODO**: Load test with target throughput (e.g., 100 messages/sec, 10 agents, 5 groups)

---

## Sign-off

| Role | Name | Date | Status |
|---|---|---|---|
| Engineering Lead | | | [ ] Approved |
| Security Reviewer | | | [ ] Approved |
| Ops/SRE | | | [ ] Approved |
| Product Owner | | | [ ] Approved |

---

*Generated for AgentDispatch ADMP v1.0.0 -- https://agentdispatch.fly.dev*
