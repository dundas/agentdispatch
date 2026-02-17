# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**Agent Dispatch** is a messaging protocol implementation for autonomous AI agents. The project defines the **Agent Dispatch Messaging Protocol (ADMP)** - a universal inbox standard that enables reliable, secure, structured message exchange among autonomous agents using both HTTP and SMTP transports.

### Core Concept

ADMP is built on two fundamental principles:
1. Every agent has an **inbox**
2. Every message follows the same **contract** - regardless of transport

Think of it as "SMTP for AI agents" - a universal, minimal, and extensible framework for inter-agent communication that provides deterministic delivery, security, and auditability independent of vendor or environment.

## Repository Structure

```
agent_dispatch/
├── discovery/          # Research and ideation documents
│   ├── problem.md      # Original problem statement (agent communication gaps)
│   ├── ideation.md     # Research on SMTP/MCP integration patterns
│   ├── openapi-spec.md # Full OpenAPI 3.1 spec + SMTP bridge implementation examples
│   ├── service-options.md
│   └── self-hosted-mailcow.md
├── whitepaper/
│   └── v1.md          # Complete ADMP v1.0 specification (RFC-style)
├── tasks/             # PRD and task list output directory
├── ai-dev-tasks/      # Task methodology documentation
│   ├── create-prd.md      # PRD creation guidelines
│   ├── generate-tasks.md  # Task generation process
│   └── process-task-list.md
├── .claude/
│   ├── commands/      # Slash commands for workflows
│   ├── skills/        # Reusable skill modules (orchestrator, prd-writer, task-processor, tasklist-generator)
│   └── agents/        # Specialized agent configurations
└── .windsurf/
    └── workflows/     # Windsurf IDE workflow definitions
```

## Development Workflow

This repository uses a **structured development methodology** centered around PRD-driven task execution with confirmation gates.

### Custom Skills

The project provides four skills (use via `/skill` command):

1. **dev-workflow-orchestrator**: Full pipeline - PRD → tasks → processing with user confirmations
2. **prd-writer**: Creates detailed Product Requirements Documents with clarifying questions
3. **tasklist-generator**: Generates high-level tasks and gated sub-tasks from PRDs
4. **task-processor**: Processes task lists one sub-task at a time with test/commit protocol

### Slash Commands

- `/dev-pipeline` - Runs the full orchestrated workflow
- `/prd-writer` - Creates PRD documents in `/tasks/`
- `/generate-tasks` - Generates task lists from existing PRDs
- `/process-tasks` - Executes tasks with gated confirmations

### Workflow Phases

**Phase 1: PRD Creation**
- Ask clarifying questions to understand requirements
- Generate structured PRD following template in `ai-dev-tasks/create-prd.md`
- Save as `/tasks/[n]-prd-[feature-name].md` (zero-padded 4-digit sequence)
- Target audience: junior developers (explicit, unambiguous requirements)

**Phase 2: Task Generation**
- Read the PRD
- Generate parent tasks and present for approval ("Go")
- After approval, generate sub-tasks with relevant files and testing notes
- Save as `/tasks/tasks-[prd-file-name].md`

**Phase 3: Task Processing**
- Work one sub-task at a time
- Pause between sub-tasks for user confirmation ("yes"/"y")
- When parent task completes:
  1. Run full test suite
  2. Stage changes (`git add .`)
  3. Clean up temporary files
  4. Commit with conventional commit style and multi-`-m` messages
  5. Mark parent task complete
- Keep "Relevant Files" section accurate throughout

## Architecture Concepts

### Message Model

All ADMP messages use a canonical JSON envelope:

```json
{
  "version": "1.0",
  "id": "uuid",
  "type": "task.request",
  "from": "agent://auth.backend",
  "to": "agent://storage.pg",
  "subject": "create_user",
  "correlation_id": "c-12345",
  "headers": {"priority":"high"},
  "body": {"email":"user@example.com"},
  "ttl_sec": 86400,
  "timestamp": "2025-10-22T17:30:00Z",
  "signature": {
    "alg": "ed25519",
    "kid": "domain.com/key-2025-10-01",
    "sig": "base64..."
  }
}
```

### Message Lifecycle

```
queued → delivered → leased → acked
                    ↘
                     nack → queued
```

### Core Operations

- **SEND**: Submit message to agent's inbox
- **PULL**: Retrieve message for processing (with lease)
- **ACK**: Confirm successful processing (deletes from inbox)
- **NACK**: Reject/defer processing (requeues)
- **REPLY**: Return correlated response

### Transport Bindings

**HTTP (Internal Agents)**
- REST API at `/v1/agents/{id}/messages`
- Bearer token or HMAC authentication
- Immediate delivery (status: `delivered`)

**SMTP (Federated/External Agents)**
- Standard email with JSON body + custom `X-Agent-*` headers
- DKIM + Ed25519 signature verification
- DSN-based delivery confirmation (status: `sent` → `delivered`)
- Both transports share same PostgreSQL datastore

## Key Documentation

### Essential Reading

1. **whitepaper/v1.md** - Complete ADMP specification
   - RFC-style technical standard
   - Message format, delivery semantics, security architecture
   - Federation model using DNS + PKI
   - Interoperability with MCP, A2A, SMTP

2. **discovery/openapi-spec.md** - Implementation details
   - Full OpenAPI 3.1 spec for HTTP API
   - Node.js (Express) SMTP bridge implementation
   - Python (FastAPI) SMTP bridge implementation
   - DKIM verification + signature validation code

3. **discovery/problem.md** - Original motivation
   - Real-world issue report showing agent communication breakdown
   - Two agents (backend service + client) unable to coordinate
   - Demonstrates need for universal messaging protocol

4. **discovery/ideation.md** - Research on SMTP integration
   - Why SMTP for agent communication
   - Authentication patterns (per-agent credentials, signed tokens)
   - Comparison with MCP and Code Mode approaches
   - Hybrid architecture recommendations

## Implementation Notes

### Security Model

- **Authentication**: Ed25519/HMAC signatures on every message
- **Authorization**: Policy-based (from→to, subject/type regex, size limits)
- **Replay Protection**: Timestamp validation (±5 minutes)
- **Key Discovery**: DNS TXT (`_agentkeys.<domain>`) or HTTPS JWKS (`/.well-known/agent-keys.json`)
- **Transport Security**: TLS required for all channels

### Delivery Guarantees

- **At-least-once delivery** with idempotency keys
- **Lease-based processing** prevents message loss during agent crashes
- **TTL expiration** for graceful timeout handling
- **Dead-letter queues** for failed messages

### Design Principles

1. **Transport Independence**: Same semantics over HTTP, SMTP, or future bindings
2. **Federation-Ready**: Uses existing DNS and PKI infrastructure
3. **Minimal Core**: Essential verbs only, extensible via message types
4. **Deterministic**: Explicit ack/nack, no silent failures
5. **Auditable**: Every state transition logged and traceable

## Development Targets

When implementing ADMP components, reference:

- **HTTP API**: See OpenAPI spec in `discovery/openapi-spec.md`
- **SMTP Bridge**: Node/Python examples in `discovery/openapi-spec.md` (lines 286-676)
- **Message Schema**: Whitepaper section 3.1 (lines 100-140)
- **Security Primitives**: Whitepaper section 6 (lines 193-236)

## Common Patterns

### Agent Registration

Agents register with central hub providing:
- Agent ID (e.g., `auth.backend`)
- SMTP credentials (for federated messaging)
- Capabilities list
- Public key (for signature verification)

### Message Sending (HTTP)

```
POST /v1/agents/{to_agent_id}/messages
Authorization: Bearer <token>
Content-Type: application/json

{...envelope...}
```

### Message Sending (SMTP)

```
From: sender@agents.domain.com
To: receiver@agents.otherdomain.com
Subject: [ADMP] task.request create_user
X-Agent-ID: auth.backend
X-Agent-Signature: <sig>
Content-Type: application/json

{...envelope...}
```

### Message Processing

1. Agent calls `POST /inbox/pull` (leases message)
2. Processes the task
3. Calls `POST /messages/{id}/ack` (removes from inbox)
4. Optionally calls `/reply` to send correlated response

## Dependencies

- **External**: `agentbootup` (local package from `../agentbootup`)
- **Future**: PostgreSQL for message persistence, SMTP library for email transport

## Notes for Contributors

- PRDs target **junior developers** - be explicit and unambiguous
- Follow **test-first protocol** when processing tasks
- Use **conventional commits** with detailed multi-line messages
- Reference PRD/task numbers in commit messages
- One sub-task at a time with confirmation gates
- Keep "Relevant Files" sections up to date

## Related Standards

- **MCP (Model Context Protocol)**: Tool integration layer - ADMP provides messaging transport for MCP endpoints
- **A2A (Agent-to-Agent)**: RPC-style tasks - ADMP offers queued messaging abstraction
- **SMTP**: Email standard - ADMP uses SMTP for federated agent communication
- **HTTP REST**: Intra-domain transport - ADMP verbs as HTTP endpoints


## Autonomous Memory System

This project uses the agentbootup self-improvement system for continuous learning and autonomous operation.

### Memory Files (Always Consult)

**At session start, read**:
1. `memory/MEMORY.md` - Core operational knowledge and protocols
2. `memory/daily/<today>.md` - Today's session log (if exists)

**At session end, update**:
1. `memory/daily/<today>.md` - Session summary, decisions, learnings
2. `memory/MEMORY.md` - New permanent patterns (if discovered)

### Autonomous Operation Protocols

See `.ai/protocols/AUTONOMOUS_OPERATION.md` for complete protocols including:
- Decision-making authority (what to act on vs ask about)
- Phase gate protocol (when to pause for confirmation)
- Error handling protocol (fix immediately, never defer)
- Skill acquisition protocol (building permanent capabilities)
- Memory management protocol (what/when/how to update)

### Key Principles

**Decision-Making**:
- ✅ Act autonomously on: technical choices, testing, documentation, memory updates
- ❌ Ask for input on: destructive actions, external communications, strategic direction

**Communication Style**:
- Be decisive, not deferential
- State decisions with reasoning
- Signal confidence levels
- Silence = normal operation

**Error Handling**:
- Fix issues immediately
- Never mark tasks complete with caveats
- Test until it actually works
- Update memory with lessons learned

**Phase Gates**:
- Complete each phase fully
- Pause at major transitions
- Wait for explicit "Go" or "yes"
- No partial work left behind

### Skills System

**Location**: `.ai/skills/` (CLI-agnostic) or `.claude/skills/` (Claude-specific)

**Core Skills**:
- `skill-acquisition/` - Systematic skill building workflow
- `memory-manager/` - Automated memory management

**Creating New Skills**:
1. **Phase 0**: Check existing skills first (MANDATORY)
2. Only build if no existing skill covers the capability
3. Use skill-acquisition workflow for structured creation

### Task Management

**Use Claude Code native tasks**:
- TaskCreate - Create new tasks
- TaskUpdate - Update task status
- TaskList - View all tasks
- TaskGet - Get task details

**Coordinate with memory**:
- Tasks = tactical execution
- WORKQUEUE.md = strategic direction (if used)
- Memory = long-term knowledge

### Standing Orders

Execute continuously without being asked:

1. Check memory at session start
2. Monitor system health proactively
3. Learn continuously - update memory after significant interactions
4. Build skills permanently for novel challenges (check existing first!)
5. Pause at phase gates
6. Test before completion
7. Act proactively on routine items
8. Ask before destructive actions
9. Document decisions in daily logs
10. Fix issues immediately
