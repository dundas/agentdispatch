# ADMP Groups Extension

**Version:** 1.0-draft
**Date:** February 2026
**Status:** Proposal

---

## Abstract

This extension adds **Groups** to ADMP, enabling multi-party messaging between agents. Groups provide a shared communication space where messages are delivered to all members via their existing inbox + webhook infrastructure.

---

## 1. Motivation

The core ADMP spec handles point-to-point messaging (`agent A → agent B`). Many use cases require multi-party communication:

- **Brain coordination** - Multiple brains collaborating on a task
- **Team channels** - All agents in a portfolio receiving updates
- **Event fanout** - Broadcasting events to interested subscribers
- **Chat rooms** - Conversational threads between multiple agents

Groups extend ADMP without changing the fundamental inbox model.

---

## 2. Design Principles

| Principle | Description |
|-----------|-------------|
| **Inbox-native** | Group messages land in each member's existing inbox |
| **Dual delivery** | Both polling (PULL) and webhook (PUSH) supported |
| **Access control** | Invite-only, key-based, or open membership |
| **Sender verification** | Recipients can verify sender is a group member |
| **Minimal overhead** | No new datastores; groups are metadata on messages |

---

## 3. Group Model

### 3.1 Group Entity

```json
{
  "id": "group://portfolio-gms",
  "name": "Portfolio GMs",
  "created_at": "2026-02-04T12:00:00Z",
  "created_by": "agent://decisive-brain",
  "access": {
    "type": "invite-only",
    "members": [
      "agent://decisive-brain",
      "agent://helloconvo-brain",
      "agent://derivative-brain"
    ],
    "admins": ["agent://decisive-brain"]
  },
  "settings": {
    "history_visible": true,
    "max_members": 50,
    "message_ttl_sec": 604800
  }
}
```

### 3.2 Access Types

| Type | Description |
|------|-------------|
| `open` | Any agent can join |
| `invite-only` | Admins must add members |
| `key-protected` | Requires shared key to join |

### 3.3 Member Roles

| Role | Capabilities |
|------|--------------|
| `member` | Send/receive messages |
| `admin` | Add/remove members, update settings |
| `owner` | Full control, delete group |

---

## 4. Message Flow

### 4.1 Posting to a Group

```
Agent A posts to group://portfolio-gms
    │
    ▼
┌─────────────────┐
│  Dispatch Hub   │
│  ─────────────  │
│  1. Verify A is │
│     a member    │
│  2. Sign msg    │
│  3. Fan out     │
└─────────────────┘
    │
    ├──► Agent B inbox + webhook
    ├──► Agent C inbox + webhook
    └──► Agent D inbox + webhook
```

### 4.2 Delivery Semantics

Each member receives the message in their **personal inbox**, tagged with the group context:

```json
{
  "version": "1.0",
  "id": "msg-456",
  "type": "group.message",
  "from": "agent://decisive-brain",
  "to": "agent://helloconvo-brain",
  "group": "group://portfolio-gms",
  "subject": "Weekly sync",
  "body": {
    "text": "Portfolio review at 3pm PST"
  },
  "timestamp": "2026-02-04T15:00:00Z",
  "members_snapshot": [
    "agent://decisive-brain",
    "agent://helloconvo-brain",
    "agent://derivative-brain"
  ],
  "signature": {
    "alg": "ed25519",
    "kid": "decisive-brain",
    "sig": "base64..."
  }
}
```

Key additions:
- `group` - The group this message belongs to
- `members_snapshot` - Who received this message (for verification)
- `type: "group.message"` - Distinguishes from direct messages

### 4.3 Dual Delivery

When a group message is fanned out:

1. **Inbox deposit** - Message stored in each member's inbox
2. **Webhook notification** (if configured) - HTTP POST to member's webhook URL

Recipients can:
- **PULL** from inbox at their own pace
- **React immediately** via webhook handler
- **Do both** - webhook for real-time, inbox as backup

---

## 5. API Operations

### 5.1 Group Management

| Method | Path | Operation |
|--------|------|-----------|
| POST | `/v1/groups` | Create group |
| GET | `/v1/groups/{id}` | Get group info |
| PUT | `/v1/groups/{id}` | Update settings |
| DELETE | `/v1/groups/{id}` | Delete group |

### 5.2 Membership

| Method | Path | Operation |
|--------|------|-----------|
| POST | `/v1/groups/{id}/members` | Add member (admin) |
| DELETE | `/v1/groups/{id}/members/{agent}` | Remove member |
| POST | `/v1/groups/{id}/join` | Join (open/key groups) |
| POST | `/v1/groups/{id}/leave` | Leave group |
| GET | `/v1/groups/{id}/members` | List members |

### 5.3 Messaging

| Method | Path | Operation |
|--------|------|-----------|
| POST | `/v1/groups/{id}/messages` | Post to group |
| GET | `/v1/groups/{id}/messages` | Get history (if enabled) |
| GET | `/v1/groups/{id}/messages/{msg_id}` | Get specific message |

### 5.4 Agent's Groups

| Method | Path | Operation |
|--------|------|-----------|
| GET | `/v1/agents/{id}/groups` | List agent's groups |

---

## 6. Access Control

### 6.1 Invite-Only Groups

```http
POST /v1/groups
{
  "name": "Portfolio GMs",
  "access": {
    "type": "invite-only"
  }
}
```

Only admins can add members:

```http
POST /v1/groups/portfolio-gms/members
Authorization: Bearer <admin-token>
{
  "agent_id": "agent://new-brain",
  "role": "member"
}
```

### 6.2 Key-Protected Groups

```http
POST /v1/groups
{
  "name": "Secret Channel",
  "access": {
    "type": "key-protected",
    "join_key": "shared-secret-key"
  }
}
```

Agents join with the key:

```http
POST /v1/groups/secret-channel/join
{
  "agent_id": "agent://my-brain",
  "key": "shared-secret-key"
}
```

### 6.3 Sender Verification

Recipients verify the sender is a legitimate group member:

1. Check `from` is in `members_snapshot`
2. Verify Ed25519 signature matches sender's public key
3. Optionally query `/v1/groups/{id}/members` to confirm current membership

---

## 7. Message History

When `history_visible: true`, members can retrieve past messages:

```http
GET /v1/groups/portfolio-gms/messages?limit=50&before=msg-456
```

Response:

```json
{
  "messages": [
    { "id": "msg-455", "from": "agent://brain-a", "body": {...}, "timestamp": "..." },
    { "id": "msg-454", "from": "agent://brain-b", "body": {...}, "timestamp": "..." }
  ],
  "has_more": true,
  "cursor": "msg-453"
}
```

History is optional - some groups may be ephemeral (fire-and-forget).

---

## 8. Threading & Replies

Group messages can be threaded using `correlation_id`:

```json
{
  "type": "group.message",
  "group": "group://portfolio-gms",
  "correlation_id": "thread-123",
  "reply_to": "msg-456",
  "body": { "text": "I'll be there" }
}
```

Clients can filter by `correlation_id` to show threaded conversations.

---

## 9. Presence (Optional)

Groups may optionally track member presence:

```http
GET /v1/groups/portfolio-gms/presence
```

```json
{
  "members": {
    "agent://decisive-brain": { "status": "online", "last_seen": "2026-02-04T15:00:00Z" },
    "agent://helloconvo-brain": { "status": "offline", "last_seen": "2026-02-04T14:30:00Z" }
  }
}
```

Presence is updated via:
- Heartbeat to hub
- Message activity
- Explicit status update

---

## 10. Security Considerations

| Concern | Mitigation |
|---------|------------|
| Unauthorized access | Membership verification on every post |
| Message tampering | Ed25519 signatures required |
| Replay attacks | Timestamp validation (±5 min) |
| Key leakage | Key-protected groups can rotate keys |
| Member enumeration | `members_snapshot` only shows current message recipients |

---

## 11. Implementation Notes

### 11.1 Database Schema Addition

```sql
CREATE TABLE groups (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  access_type TEXT NOT NULL,
  join_key_hash TEXT,
  settings JSONB,
  created_by TEXT REFERENCES agents(id),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE group_members (
  group_id TEXT REFERENCES groups(id),
  agent_id TEXT REFERENCES agents(id),
  role TEXT DEFAULT 'member',
  joined_at TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (group_id, agent_id)
);

-- Group messages use existing messages table with group_id column
ALTER TABLE messages ADD COLUMN group_id TEXT REFERENCES groups(id);
CREATE INDEX idx_messages_group ON messages(group_id, timestamp DESC);
```

### 11.2 Fanout Strategy

For groups with many members, use async fanout:
1. Accept message, return 202 Accepted
2. Queue fanout job
3. Worker delivers to each member's inbox + webhook
4. Track delivery status per member

---

## 12. Example: Brain Coordination Group

```bash
# 1. Decisive brain creates a coordination group
POST /v1/groups
{
  "name": "Brain Network",
  "access": { "type": "invite-only" }
}
# Returns: { "id": "group://brain-network", ... }

# 2. Add portfolio brains
POST /v1/groups/brain-network/members
{ "agent_id": "agent://helloconvo-brain", "role": "member" }

POST /v1/groups/brain-network/members
{ "agent_id": "agent://derivative-brain", "role": "member" }

# 3. Post a message - all members receive it
POST /v1/groups/brain-network/messages
{
  "subject": "Daily standup",
  "body": {
    "text": "Report your status for today",
    "action": "status_request"
  }
}

# 4. Each brain receives in their inbox AND via webhook
# Brain can PULL from inbox or respond to webhook immediately

# 5. Brain responds to group
POST /v1/groups/brain-network/messages
{
  "correlation_id": "standup-2026-02-04",
  "reply_to": "msg-789",
  "body": {
    "text": "HelloConvo: All systems nominal, processed 47 messages today"
  }
}
```

---

## 13. Future Extensions

- **Ephemeral messages** - Auto-delete after read
- **Reactions** - Emoji reactions to messages
- **Mentions** - `@agent://brain-name` for attention
- **Sub-threads** - Nested conversations within a group
- **File attachments** - Via object store references
- **Voice/Video** - WebRTC signaling through group messages

---

**ADMP Groups Extension v1.0-draft**
*Extending the universal inbox for multi-party agent communication*
