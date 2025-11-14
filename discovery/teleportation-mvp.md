# ADMP Integration with Teleportation - MVP Implementation Plan

**Version:** 1.0
**Date:** November 14, 2025
**Status:** Draft

---

## Executive Summary

This document outlines the MVP implementation plan for integrating **Agent Dispatch Messaging Protocol (ADMP)** into the **Teleportation** project. The integration transforms Teleportation sessions into ADMP agents with inboxes, enabling authenticated inter-agent messaging, heartbeat-based session management, and an edge agent pattern for security.

### What Changes

**Before (Current Teleportation):**
- Sessions register → User approves tool requests via mobile UI
- Polling-based approval workflow
- No agent-to-agent messaging

**After (ADMP Integration):**
- Sessions register **as ADMP agents** with inboxes
- **Heartbeat** keeps sessions alive
- Agents poll inboxes for **authenticated messages** from other agents
- **Edge agent** filters and routes external messages
- **Handshake protocol** controls who can message whom

---

## Architecture Overview

### Component Mapping

| Teleportation Concept | ADMP Concept | Implementation |
|----------------------|--------------|----------------|
| Session | Agent | Each session = one agent with unique agent_id |
| Session ID | Agent ID | session_id → agent://session-{uuid} |
| Session Registration | Agent Registration | POST /api/agents/register |
| Session Heartbeat | Agent Heartbeat | POST /api/agents/{id}/heartbeat |
| N/A | Agent Inbox | Each agent has an inbox for messages |
| Mobile UI | Edge Agent UI | Review external messages before routing |

### System Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                        Teleportation + ADMP                      │
└─────────────────────────────────────────────────────────────────┘

┌──────────────────┐         ┌──────────────────┐         ┌────────────────┐
│  Claude Session  │◀───────▶│   Relay API      │◀───────▶│   Mobile UI    │
│  (Local Agent)   │         │  (ADMP Hub)      │         │  (Edge Agent)  │
└──────────────────┘         └──────────────────┘         └────────────────┘
        │                             │                            │
        │                             │                            │
   ┌────┴────┐                   ┌────┴────┐                 ┌────┴────┐
   │ Hooks:  │                   │ ADMP:   │                 │ UI:     │
   │ - Start │                   │ - Inbox │                 │ - Review│
   │ - HB    │                   │ - Agent │                 │ - Route │
   │ - Poll  │                   │ - Policy│                 │ - Flag  │
   └─────────┘                   └─────────┘                 └─────────┘

External Agents ───▶ Edge Agent ───▶ Policy Check ───▶ Internal Agent Inbox
                        │                   │
                        │                   ▼
                        │            Human Approval
                        │            (if needed)
                        │
                        ▼
                   Relay API Storage
```

---

## Core Concepts

### 1. Session = Agent

Every Teleportation session becomes an ADMP agent:

```javascript
// Session registration creates agent
{
  agent_id: "agent://session-abc123",
  session_id: "abc123",
  agent_type: "claude_session",
  public_key: "ed25519-base64...",
  capabilities: ["tool_approval", "code_execution"],
  inbox: {
    messages: [],
    last_pull: null
  },
  heartbeat: {
    interval_ms: 60000,        // 1 minute
    last_heartbeat: 1699999999,
    timeout_ms: 300000,        // 5 minutes
    status: "online"           // online | offline | expired
  },
  trusted_agents: [],          // Agents allowed to send messages
  metadata: {
    project_name: "my-project",
    working_directory: "/path",
    branch: "main"
  }
}
```

### 2. Heartbeat Lifecycle

```
Session Start
     │
     ▼
Register Agent ──▶ Generate Keypair ──▶ Create Inbox
     │
     ▼
Start Heartbeat Loop (every 60s)
     │
     ├──▶ POST /api/agents/{id}/heartbeat
     │         │
     │         ▼
     │    Update last_heartbeat timestamp
     │         │
     │         ▼
     │    Check: now - last_heartbeat < timeout?
     │         │
     │         ├─ YES ──▶ status = "online"
     │         │
     │         └─ NO  ──▶ status = "offline" ──▶ Stop polling inbox
     │
     └──▶ Wait 60s ──▶ Loop

Session End ──▶ Stop heartbeat ──▶ Deregister agent
```

### 3. Inbox Polling

```
Agent Online?
     │
     └─ YES ──▶ Poll inbox (every 60s)
               │
               ▼
          GET /api/agents/{id}/inbox/pull
               │
               ├─ Empty ──▶ Wait 60s ──▶ Loop
               │
               └─ Message ──▶ Validate signature
                              │
                              ├─ Valid ──▶ Process message
                              │            │
                              │            ▼
                              │       POST /api/agents/{id}/messages/{mid}/ack
                              │
                              └─ Invalid ──▶ Reject (no ACK)
```

### 4. Agent Handshake

Agents must "handshake" before messaging:

```
Agent A wants to message Agent B
     │
     ▼
POST /api/agents/{agent_b_id}/handshake
Headers: Authorization: Bearer {agent_a_token}
Body: {
  from_agent_id: "agent://agent-a",
  public_key: "ed25519...",
  reason: "Need to send task results"
}
     │
     ▼
Agent B policy check:
  - Is agent_a in allowlist?
  - Is agent_a authenticated?
  - Does agent_a have required capabilities?
     │
     ├─ Auto-approve (internal agents) ──▶ Add to trusted_agents
     │                                     Return: { status: "approved" }
     │
     └─ Flag for human (external agents) ──▶ Show in Mobile UI
                                              │
                                              ├─ User approves ──▶ Add to trusted_agents
                                              │
                                              └─ User denies ──▶ Reject
```

### 5. Edge Agent Pattern

**Edge Agent** sits between external world and internal agents:

```
External Message Arrives
     │
     ▼
Edge Agent Receives
     │
     ▼
Policy Enforcement:
  ├─ Check DKIM (if SMTP)
  ├─ Verify Ed25519 signature
  ├─ Check from_agent in allowlist
  ├─ Check subject matches pattern
  ├─ Check message size < limit
  └─ Check TTL not expired
     │
     ├─ PASS (trusted) ──▶ Auto-forward to internal agent inbox
     │
     └─ FAIL / UNKNOWN ──▶ Flag to human
                           │
                           ▼
                      Mobile UI shows:
                      "External agent 'xyz' wants to send:
                       From: agent://external.service
                       Subject: task_result
                       Authenticated: ✓
                       [Approve] [Deny] [Inspect]"
                           │
                           ├─ Approve ──▶ Forward to inbox
                           │              Add sender to allowlist
                           │
                           └─ Deny ──▶ Reject message
                                       Optionally block sender
```

---

## Implementation Plan

### Phase 1: Core ADMP Infrastructure

#### 1.1. Agent Registration

**New Endpoint:** `POST /api/agents/register`

```javascript
// Request
{
  session_id: "abc123",
  agent_type: "claude_session",
  metadata: {
    project_name: "my-project",
    working_directory: "/path",
    branch: "main"
  }
}

// Response
{
  agent_id: "agent://session-abc123",
  public_key: "ed25519-base64...",
  private_key_encrypted: "aes256...",  // Encrypted for storage
  inbox_url: "/api/agents/session-abc123/inbox"
}
```

**Implementation:**
- Generate Ed25519 keypair for agent
- Create agent record in storage
- Initialize empty inbox
- Set heartbeat status to "online"

**Files to modify:**
- `relay/server.js` - Add agent registration endpoint
- `lib/session/register.js` - Add agent registration logic

#### 1.2. Heartbeat Mechanism

**New Endpoint:** `POST /api/agents/{agent_id}/heartbeat`

```javascript
// Request
{
  status: "online",
  metadata: {
    last_file_edited: "src/app.js",
    current_branch: "main"
  }
}

// Response
{
  ok: true,
  last_heartbeat: 1699999999,
  timeout_at: 1700000299,  // last_heartbeat + timeout_ms
  inbox_count: 3           // Number of pending messages
}
```

**Heartbeat Logic:**
```javascript
// Server-side
function checkHeartbeat(agent) {
  const now = Date.now();
  const elapsed = now - agent.heartbeat.last_heartbeat;

  if (elapsed > agent.heartbeat.timeout_ms) {
    agent.heartbeat.status = "offline";
    // Stop processing inbox for this agent
  }
}
```

**Files to create:**
- `.claude/hooks/heartbeat.mjs` - Send heartbeat every 60s
- `relay/server.js` - Add heartbeat endpoint

#### 1.3. Inbox Implementation

**Inbox Data Structure:**
```javascript
{
  agent_id: "agent://session-abc123",
  messages: [
    {
      id: "msg-uuid",
      envelope: {...},  // ADMP message envelope
      status: "queued" | "leased" | "acked",
      lease_until: null | timestamp,
      created_at: 1699999999
    }
  ]
}
```

**New Endpoints:**

**SEND:** `POST /api/agents/{to_agent_id}/messages`
```javascript
// Request (ADMP envelope)
{
  version: "1.0",
  id: "msg-uuid",
  type: "task.request",
  from: "agent://sender-agent",
  to: "agent://session-abc123",
  subject: "execute_task",
  body: {
    command: "npm test",
    context: {...}
  },
  timestamp: "2025-11-14T10:00:00Z",
  signature: {
    alg: "ed25519",
    kid: "sender.com/key-2025-11",
    sig: "base64..."
  }
}

// Response
{
  message_id: "msg-uuid",
  status: "queued"
}
```

**PULL:** `POST /api/agents/{agent_id}/inbox/pull`
```javascript
// Request
{
  visibility_timeout: 60  // Lease for 60s
}

// Response (if message available)
{
  message_id: "msg-uuid",
  envelope: {...},        // Full ADMP envelope
  lease_until: 1700000059
}

// Response (if inbox empty)
{
  message: "No messages"
}
```

**ACK:** `POST /api/agents/{agent_id}/messages/{message_id}/ack`
```javascript
// Request
{
  result: {
    status: "success",
    output: "Tests passed"
  }
}

// Response
{
  ok: true
}
```

**Files to create:**
- `relay/admp/inbox.js` - Inbox management logic
- `relay/admp/signatures.js` - Ed25519 verification

#### 1.4. Message Polling Hook

**New Hook:** `.claude/hooks/poll_inbox.mjs`

```javascript
#!/usr/bin/env node
import { readConfig } from '../../lib/config/index.js';
import fetch from 'node-fetch';

const config = readConfig();
const SESSION_ID = process.env.CLAUDE_SESSION_ID;
const AGENT_ID = `agent://session-${SESSION_ID}`;

async function pollInbox() {
  try {
    // Pull one message
    const res = await fetch(
      `${config.relayUrl}/api/agents/${AGENT_ID}/inbox/pull`,
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${config.apiKey}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ visibility_timeout: 60 })
      }
    );

    if (res.status === 204) {
      // No messages
      return;
    }

    const { message_id, envelope } = await res.json();

    // Validate signature
    const valid = await verifySignature(envelope);
    if (!valid) {
      console.error('Invalid signature, rejecting message');
      return;
    }

    // Process message based on type
    await processMessage(envelope);

    // ACK message
    await fetch(
      `${config.relayUrl}/api/agents/${AGENT_ID}/messages/${message_id}/ack`,
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${config.apiKey}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ result: { status: 'processed' } })
      }
    );

  } catch (error) {
    console.error('Inbox poll error:', error);
  }
}

async function processMessage(envelope) {
  const { type, subject, body } = envelope;

  switch (type) {
    case 'task.request':
      // Handle incoming task
      console.log(`Received task: ${subject}`, body);
      break;
    case 'event':
      // Handle event
      console.log(`Received event: ${subject}`, body);
      break;
    default:
      console.log(`Unknown message type: ${type}`);
  }
}

// Poll every 60 seconds
setInterval(pollInbox, 60000);
pollInbox();  // Initial poll
```

**Integration with Teleportation:**
- Start polling when session starts (`session_start.mjs`)
- Stop polling when session ends (`session_end.mjs`)
- Poll only if heartbeat status is "online"

### Phase 2: Agent Handshake & Authorization

#### 2.1. Handshake Protocol

**New Endpoint:** `POST /api/agents/{agent_id}/handshake`

```javascript
// Request
{
  from_agent_id: "agent://requesting-agent",
  public_key: "ed25519-base64...",
  reason: "Need to send task results",
  capabilities: ["send_tasks", "receive_results"]
}

// Response (auto-approved)
{
  status: "approved",
  token: "bearer-token-for-messaging"
}

// Response (pending human approval)
{
  status: "pending",
  approval_id: "handshake-uuid",
  message: "Awaiting user approval"
}

// Response (denied)
{
  status: "denied",
  reason: "Not in allowlist"
}
```

**Handshake Logic:**
```javascript
function evaluateHandshake(targetAgent, request) {
  // Check if sender is in trusted_agents list
  if (targetAgent.trusted_agents.includes(request.from_agent_id)) {
    return { status: 'approved' };
  }

  // Check policy rules
  const policy = getPolicy(targetAgent);

  if (policy.auto_approve.includes(request.from_agent_id)) {
    // Auto-approve and add to trusted list
    targetAgent.trusted_agents.push(request.from_agent_id);
    return { status: 'approved' };
  }

  if (policy.auto_deny.includes(request.from_agent_id)) {
    return { status: 'denied', reason: 'Blocked by policy' };
  }

  // Default: require human approval
  const approvalId = createHandshakeApproval(request);
  return { status: 'pending', approval_id: approvalId };
}
```

**Files to create:**
- `relay/admp/handshake.js` - Handshake logic
- `relay/admp/policy.js` - Policy evaluation

#### 2.2. Trust Management

**Agent Trust List:**
```javascript
{
  agent_id: "agent://session-abc123",
  trusted_agents: [
    {
      agent_id: "agent://internal-service",
      added_at: 1699999999,
      added_by: "auto",  // auto | user
      capabilities: ["send_tasks", "receive_results"]
    }
  ],
  blocked_agents: [
    {
      agent_id: "agent://spam-bot",
      blocked_at: 1699999999,
      reason: "Spam"
    }
  ]
}
```

**New Endpoints:**

- `GET /api/agents/{agent_id}/trusted` - List trusted agents
- `POST /api/agents/{agent_id}/trusted` - Add to trusted list
- `DELETE /api/agents/{agent_id}/trusted/{other_agent_id}` - Remove from trusted list
- `POST /api/agents/{agent_id}/blocked` - Add to block list

### Phase 3: Edge Agent Pattern

#### 3.1. Edge Agent Architecture

**Edge Agent Role:**
- Receives all external messages first
- Applies policy checks
- Flags suspicious messages to human
- Routes approved messages to internal agent inboxes

**Edge Agent Implementation:**
```javascript
class EdgeAgent {
  constructor(agentId, policy) {
    this.agentId = agentId;
    this.policy = policy;
  }

  async receiveMessage(envelope) {
    // 1. Validate signature
    const sigValid = await this.verifySignature(envelope);
    if (!sigValid) {
      return { action: 'reject', reason: 'Invalid signature' };
    }

    // 2. Check sender authorization
    const authCheck = await this.checkAuthorization(envelope.from);
    if (authCheck.status === 'denied') {
      return { action: 'reject', reason: 'Sender not authorized' };
    }

    // 3. Check policy rules
    const policyCheck = await this.evaluatePolicy(envelope);
    if (policyCheck.status === 'denied') {
      return { action: 'reject', reason: policyCheck.reason };
    }

    // 4. Auto-approve or flag for human review
    if (authCheck.status === 'approved' && policyCheck.status === 'approved') {
      // Auto-forward to target inbox
      await this.forwardToInbox(envelope);
      return { action: 'forwarded' };
    }

    // 5. Flag for human review
    const flagId = await this.flagForReview(envelope, authCheck, policyCheck);
    return { action: 'flagged', flag_id: flagId };
  }

  async evaluatePolicy(envelope) {
    // Check subject whitelist
    if (this.policy.allowed_subjects) {
      const subjectMatch = this.policy.allowed_subjects.some(pattern =>
        new RegExp(pattern).test(envelope.subject)
      );
      if (!subjectMatch) {
        return { status: 'denied', reason: 'Subject not in allowed list' };
      }
    }

    // Check message size
    const bodySize = JSON.stringify(envelope.body).length;
    if (bodySize > this.policy.max_message_size) {
      return { status: 'denied', reason: 'Message too large' };
    }

    // Check TTL
    const age = Date.now() - new Date(envelope.timestamp).getTime();
    if (age > envelope.ttl_sec * 1000) {
      return { status: 'denied', reason: 'Message expired' };
    }

    return { status: 'approved' };
  }

  async flagForReview(envelope, authCheck, policyCheck) {
    const flag = {
      id: generateUuid(),
      type: 'message_review',
      envelope: envelope,
      checks: {
        signature: 'valid',
        authorization: authCheck.status,
        policy: policyCheck.status
      },
      status: 'pending',
      created_at: Date.now()
    };

    // Store flag for Mobile UI to display
    await storeFlag(flag);

    return flag.id;
  }
}
```

#### 3.2. Mobile UI Integration

**Message Review Screen:**

```
╔════════════════════════════════════════╗
║  External Message Review               ║
╠════════════════════════════════════════╣
║  From: agent://external.service        ║
║  To: agent://session-abc123           ║
║  Subject: task_result                  ║
║                                        ║
║  ✓ Signature valid                     ║
║  ⚠ First time sender                   ║
║  ✓ Subject allowed                     ║
║  ✓ Size: 1.2 KB                       ║
║                                        ║
║  Message Body:                         ║
║  {                                     ║
║    "status": "completed",              ║
║    "result": {...}                     ║
║  }                                     ║
║                                        ║
║  [Approve & Forward]  [Deny]           ║
║  [Approve & Trust]    [Block Sender]   ║
╚════════════════════════════════════════╝
```

**New Mobile UI Components:**
- Message review dashboard
- Trust management UI
- Policy editor

**Files to create:**
- `detach-mobile/src/pages/MessageReview.tsx`
- `detach-mobile/src/components/MessageCard.tsx`
- `detach-mobile/src/pages/TrustManagement.tsx`

### Phase 4: Policy System

#### 4.1. Policy Definition

**Policy Schema:**
```javascript
{
  agent_id: "agent://session-abc123",
  policy: {
    // Auto-approve rules
    auto_approve: {
      from_agents: [
        "agent://internal-service-*",  // Wildcard support
        "agent://trusted.domain/*"
      ],
      subjects: [
        "^task_result$",
        "^status_update$"
      ],
      types: ["task.result", "event"]
    },

    // Auto-deny rules
    auto_deny: {
      from_agents: [
        "agent://spam-bot"
      ],
      subjects: [
        "^spam.*"
      ]
    },

    // Constraints
    constraints: {
      max_message_size_kb: 256,
      max_ttl_sec: 86400,
      require_signature: true
    },

    // Human review triggers
    review_triggers: {
      new_sender: true,           // Flag first message from new sender
      large_message: 100,         // Flag messages > 100 KB
      suspicious_subject: true    // Flag subject not in allowlist
    }
  }
}
```

#### 4.2. Policy Endpoints

- `GET /api/agents/{agent_id}/policy` - Get policy
- `PUT /api/agents/{agent_id}/policy` - Update policy
- `POST /api/agents/{agent_id}/policy/evaluate` - Test policy against message

---

## Implementation Checklist

### Relay API (Backend)

- [ ] **Agent Registration**
  - [ ] `POST /api/agents/register` - Register new agent
  - [ ] Generate Ed25519 keypair
  - [ ] Store agent metadata
  - [ ] Initialize inbox

- [ ] **Heartbeat**
  - [ ] `POST /api/agents/{id}/heartbeat` - Update heartbeat
  - [ ] Background job to check expired heartbeats
  - [ ] Mark offline agents

- [ ] **Inbox (ADMP Core)**
  - [ ] `POST /api/agents/{to_id}/messages` - SEND
  - [ ] `POST /api/agents/{id}/inbox/pull` - PULL
  - [ ] `POST /api/agents/{id}/messages/{mid}/ack` - ACK
  - [ ] `POST /api/agents/{id}/messages/{mid}/nack` - NACK
  - [ ] Message lease management
  - [ ] TTL expiry cleanup

- [ ] **Handshake**
  - [ ] `POST /api/agents/{id}/handshake` - Request access
  - [ ] Policy evaluation logic
  - [ ] Human approval queue

- [ ] **Trust Management**
  - [ ] `GET /api/agents/{id}/trusted` - List trusted agents
  - [ ] `POST /api/agents/{id}/trusted` - Add to trusted list
  - [ ] `DELETE /api/agents/{id}/trusted/{other_id}` - Remove
  - [ ] `POST /api/agents/{id}/blocked` - Block agent

- [ ] **Edge Agent**
  - [ ] Message filtering logic
  - [ ] Policy enforcement
  - [ ] Flag creation for human review

- [ ] **Security**
  - [ ] Ed25519 signature verification
  - [ ] Replay protection (timestamp validation)
  - [ ] Key discovery (JWKS or DNS TXT)

### Claude Code Hooks

- [ ] **Session Start Hook** (modify existing `session_start.mjs`)
  - [ ] Call `POST /api/agents/register`
  - [ ] Store agent_id and keypair
  - [ ] Start heartbeat loop
  - [ ] Start inbox polling loop

- [ ] **Heartbeat Hook** (new `heartbeat.mjs`)
  - [ ] Send heartbeat every 60s
  - [ ] Update session metadata
  - [ ] Handle heartbeat failures

- [ ] **Inbox Polling Hook** (new `poll_inbox.mjs`)
  - [ ] Poll inbox every 60s
  - [ ] Validate message signatures
  - [ ] Process messages
  - [ ] ACK processed messages

- [ ] **Session End Hook** (modify existing `session_end.mjs`)
  - [ ] Stop heartbeat loop
  - [ ] Stop inbox polling loop
  - [ ] Deregister agent

### Mobile UI

- [ ] **Message Review**
  - [ ] Message review dashboard
  - [ ] Message detail view
  - [ ] Approve/deny actions
  - [ ] Trust sender action

- [ ] **Trust Management**
  - [ ] List trusted agents
  - [ ] Add/remove trusted agents
  - [ ] List blocked agents
  - [ ] Unblock agents

- [ ] **Policy Editor**
  - [ ] Edit auto-approve rules
  - [ ] Edit auto-deny rules
  - [ ] Edit constraints
  - [ ] Test policy against sample message

- [ ] **Session Dashboard** (enhance existing)
  - [ ] Show heartbeat status
  - [ ] Show inbox message count
  - [ ] Show trusted agents count

### Testing

- [ ] **Unit Tests**
  - [ ] Agent registration
  - [ ] Heartbeat logic
  - [ ] Inbox operations (SEND, PULL, ACK)
  - [ ] Signature verification
  - [ ] Policy evaluation

- [ ] **Integration Tests**
  - [ ] End-to-end message flow
  - [ ] Handshake approval flow
  - [ ] Edge agent filtering
  - [ ] Multi-agent messaging

- [ ] **Manual Testing**
  - [ ] Session lifecycle with heartbeat
  - [ ] Message sending between agents
  - [ ] Mobile UI message review
  - [ ] Policy enforcement

---

## Data Storage

### Current (MVP)

Use existing in-memory storage in Relay API:

```javascript
// In relay/server.js
const agents = new Map();          // agent_id -> agent object
const inboxes = new Map();         // agent_id -> message[]
const handshakes = new Map();      // approval_id -> handshake object
const flags = new Map();           // flag_id -> flag object
```

### Future (Production)

Migrate to mech-storage NoSQL:

```javascript
// Collections
collections: {
  agents: {
    // Agent records
    agent_id: string (primary key),
    session_id: string,
    public_key: string,
    trusted_agents: string[],
    policy: object,
    heartbeat: object,
    metadata: object
  },

  messages: {
    // ADMP messages
    message_id: string (primary key),
    to_agent_id: string (indexed),
    envelope: object,
    status: string,
    lease_until: number,
    created_at: number
  },

  handshakes: {
    // Handshake approval requests
    approval_id: string (primary key),
    to_agent_id: string,
    from_agent_id: string,
    status: string,
    created_at: number
  },

  flags: {
    // Messages flagged for human review
    flag_id: string (primary key),
    agent_id: string,
    envelope: object,
    status: string,
    created_at: number
  }
}
```

---

## Message Flow Examples

### Example 1: Internal Agent Task Request

**Scenario:** Internal service agent sends task to Claude session

```
1. Service Agent sends message
   POST /api/agents/session-abc123/messages
   {
     from: "agent://internal-service",
     to: "agent://session-abc123",
     subject: "run_tests",
     body: { project: "my-app" },
     signature: {...}
   }

2. Relay API checks handshake
   - internal-service in trusted_agents? → YES
   - Auto-forward to inbox

3. Claude session polls inbox
   GET /api/agents/session-abc123/inbox/pull
   Returns: { message_id, envelope }

4. Hook validates signature
   - Verify Ed25519 signature → VALID

5. Hook processes message
   - Run tests
   - Generate result

6. Hook ACKs message
   POST /api/agents/session-abc123/messages/{mid}/ack
   { result: { status: "passed" } }

7. Hook sends reply (optional)
   POST /api/agents/internal-service/messages
   {
     from: "agent://session-abc123",
     to: "agent://internal-service",
     subject: "test_results",
     correlation_id: "original-message-id",
     body: { status: "passed", ... }
   }
```

### Example 2: External Agent First Contact

**Scenario:** Unknown external agent tries to send message

```
1. External agent sends message
   POST /api/agents/session-abc123/messages
   {
     from: "agent://external.service",
     to: "agent://session-abc123",
     subject: "collaboration_request",
     body: {...},
     signature: {...}
   }

2. Relay API (Edge Agent) receives
   - Verify signature → VALID
   - Check trusted_agents → NOT FOUND
   - Check policy → No auto-approve rule

3. Edge Agent flags for review
   - Create flag object
   - Store in flags collection
   - DO NOT forward to inbox yet

4. Mobile UI polls for flags
   GET /api/flags?status=pending
   Returns: [{ flag_id, envelope, checks }]

5. User reviews in Mobile UI
   - Views sender: "agent://external.service"
   - Views message content
   - Checks signature: ✓ VALID
   - Decides: APPROVE

6. User approves
   POST /api/flags/{flag_id}/approve
   { action: "approve_and_trust" }

7. Edge Agent forwards message
   - Add external.service to trusted_agents
   - Forward message to session-abc123 inbox

8. Claude session polls inbox
   - Receives message
   - Processes normally
```

### Example 3: Policy-Based Auto-Deny

**Scenario:** Blocked agent tries to send message

```
1. Spam bot sends message
   POST /api/agents/session-abc123/messages
   {
     from: "agent://spam-bot",
     to: "agent://session-abc123",
     subject: "spam_message",
     body: {...}
   }

2. Edge Agent receives
   - Verify signature → VALID (but blocked)
   - Check blocked_agents → FOUND

3. Edge Agent rejects
   - Return 403 Forbidden
   - Log rejection
   - DO NOT create flag (auto-denied)

4. Spam bot receives error
   {
     error: "SENDER_BLOCKED",
     message: "You are blocked by target agent"
   }
```

---

## Security Considerations

### Message Authentication

- **Ed25519 signatures** on all messages
- **Replay protection** via timestamp validation (±5 minutes)
- **Key rotation** every 90 days (future)

### Authorization

- **Handshake protocol** before first message
- **Trust lists** (allowlist model)
- **Policy enforcement** at edge agent
- **Human-in-the-loop** for unknown senders

### Privacy

- **End-to-end encryption** (future: encrypt message body)
- **Scoped access** (agent can only read its own inbox)
- **Audit trail** of all message flows

### Rate Limiting

- **Per-agent limits** (e.g., 100 messages/hour)
- **Per-sender limits** to target (e.g., 10 messages/minute)
- **Exponential backoff** for failed deliveries

---

## Configuration

### Relay API Config

```javascript
// relay/config.json
{
  "admp": {
    "heartbeat": {
      "default_interval_ms": 60000,    // 1 minute
      "timeout_ms": 300000,            // 5 minutes
      "cleanup_interval_ms": 60000     // Check every minute
    },
    "inbox": {
      "poll_interval_ms": 60000,       // 1 minute
      "default_lease_sec": 60,
      "max_lease_sec": 3600,
      "message_ttl_sec": 86400         // 24 hours
    },
    "policy": {
      "max_message_size_kb": 256,
      "require_signature": true,
      "allow_unsigned_internal": false
    },
    "edge_agent": {
      "auto_approve_internal": true,
      "flag_new_senders": true,
      "flag_large_messages_kb": 100
    }
  }
}
```

### Hook Config

```javascript
// ~/.teleportation/admp-config.json
{
  "agent_id": "agent://session-abc123",
  "private_key_encrypted": "aes256...",
  "heartbeat_interval_ms": 60000,
  "inbox_poll_interval_ms": 60000,
  "trusted_agents": [
    "agent://internal-service"
  ]
}
```

---

## Migration Path

### Phase 1: Core Infrastructure (Week 1-2)

- [ ] Implement agent registration
- [ ] Implement heartbeat
- [ ] Implement basic inbox (SEND, PULL, ACK)
- [ ] Update session hooks

### Phase 2: Handshake & Trust (Week 3)

- [ ] Implement handshake protocol
- [ ] Implement trust management
- [ ] Add Mobile UI for handshake approval

### Phase 3: Edge Agent (Week 4)

- [ ] Implement edge agent filtering
- [ ] Implement policy evaluation
- [ ] Add Mobile UI for message review

### Phase 4: Polish & Production (Week 5-6)

- [ ] Migrate to mech-storage
- [ ] Add comprehensive tests
- [ ] Performance optimization
- [ ] Documentation

---

## Success Metrics

### Functional

- ✅ Sessions register as agents with inboxes
- ✅ Heartbeat keeps sessions alive/offline detection works
- ✅ Agents can send/receive authenticated messages
- ✅ Handshake protocol prevents unauthorized messaging
- ✅ Edge agent filters external messages
- ✅ Human review works via Mobile UI

### Performance

- Heartbeat latency < 100ms
- Inbox poll latency < 200ms
- Message delivery (internal) < 1 second
- Message delivery (external, auto-approved) < 2 seconds
- Message review (human) < 60 seconds average

### Security

- 100% of messages verified with signatures
- 0 unauthorized messages delivered
- All external messages reviewed (unless auto-approved by policy)

---

## Open Questions

1. **Key Storage:**
   - Where to store agent private keys? (Currently: encrypted in ~/.teleportation/credentials)
   - How to handle key rotation?

2. **Multi-Session Handling:**
   - How to handle multiple Claude sessions (one per project)?
   - Should each session = separate agent, or agent per user?

3. **Federation:**
   - Should we support SMTP transport for cross-domain messaging?
   - Or HTTP-only for MVP?

4. **Message Persistence:**
   - How long to keep messages after ACK?
   - Should we support message replay/audit trail?

5. **Offline Handling:**
   - What happens to messages sent to offline agents?
   - Queue until online, or reject immediately?

---

## Next Steps

1. **Review this plan** - Get feedback on approach
2. **Create PRD** - Detailed product requirements document
3. **Generate task list** - Break down into sub-tasks
4. **Begin implementation** - Start with Phase 1

---

**Document Version:** 1.0
**Last Updated:** November 14, 2025
**Author:** ADMP Integration Team
