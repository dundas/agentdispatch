# Agent Dispatch Messaging Protocol (ADMP)

**A Universal Inbox Standard for Autonomous Agents**

[![License](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](LICENSE)
[![Version](https://img.shields.io/badge/version-1.0.0-green.svg)](https://github.com/agent-dispatch/agent-dispatch)
[![Protocol](https://img.shields.io/badge/protocol-ADMP%20v1.0-orange.svg)](whitepaper/v1.md)

---

## What is ADMP?

ADMP is an open messaging protocol that enables **reliable, secure, structured communication** between autonomous AI agents. Think "SMTP for AI agents" — a universal standard where:

1. **Every agent has an inbox**
2. **Every message follows the same contract** — regardless of transport

### The Problem

Autonomous agents (coding assistants, storage agents, AI workers) communicate through ad-hoc mechanisms:
- Custom REST APIs (brittle, no delivery guarantees)
- Polling loops (inefficient, no acknowledgment)
- Chat channels (unstructured, no correlation)
- Message queues (vendor lock-in, complex setup)

**ADMP provides**: deterministic delivery, explicit acknowledgment, structured envelopes, security by default, and federation-ready architecture.

### Real-World Use Case

See [Detach](examples/detach-integration/) — a production system using ADMP for:
- Claude Code session management
- Remote approval workflows
- Message injection for agent coordination

---

## Quick Start (5 minutes)

### 1. Start ADMP Services

```bash
git clone https://github.com/agent-dispatch/agent-dispatch.git
cd agent-dispatch
npm run docker:up
```

Verify services are running:
```bash
curl http://localhost:3030/health
# {"status":"healthy","version":"1.0.0"}
```

### 2. Send Your First Message

```bash
# Install the client
npm install @agent-dispatch/client

# Create two agents: sender and receiver
```

```javascript
// sender.js
import { ADMPClient } from '@agent-dispatch/client';

const sender = new ADMPClient({
  agentId: 'agent-alice',
  relayUrl: 'http://localhost:3030',
  apiKey: 'dev-key-admp-local'
});

await sender.send({
  to: 'agent-bob',
  type: 'task.request',
  subject: 'hello',
  body: { message: 'Hello from Alice!' }
});

console.log('✅ Message sent to Bob\'s inbox');
```

```javascript
// receiver.js
import { ADMPClient } from '@agent-dispatch/client';

const receiver = new ADMPClient({
  agentId: 'agent-bob',
  relayUrl: 'http://localhost:3030',
  apiKey: 'dev-key-admp-local'
});

// Pull message from inbox (30 second lease)
const message = await receiver.pull({ leaseDuration: 30 });

console.log('📨 Received:', message.body);
// { message: 'Hello from Alice!' }

// Process the message...
console.log('Processing...');

// Acknowledge completion
await receiver.ack(message.id);
console.log('✅ Message processed and removed from inbox');
```

**That's it!** You now have reliable agent-to-agent messaging.

---

## Core Concepts

### Message Envelope

All ADMP messages use a canonical JSON structure:

```json
{
  "version": "1.0",
  "id": "m-123e4567",
  "type": "task.request",
  "from": "agent://alice",
  "to": "agent://bob",
  "subject": "create_user",
  "correlation_id": "c-12345",
  "body": { "email": "user@example.com" },
  "ttl_sec": 86400,
  "timestamp": "2025-10-22T17:30:00Z",
  "signature": {
    "alg": "ed25519",
    "kid": "domain.com/key-2025",
    "sig": "..."
  }
}
```

### Message Lifecycle

```
┌─────────┐    SEND     ┌───────────┐    PULL     ┌─────────┐
│ Sender  │────────────>│   Relay   │────────────>│Receiver │
│  Agent  │             │   Inbox   │  (lease)    │  Agent  │
└─────────┘             └─────┬─────┘             └────┬────┘
                              │                        │
                              │        ACK/NACK        │
                              │<───────────────────────┘
                              │
                        Status: acked
                        (removed from inbox)
```

**States**: `queued` → `delivered` → `leased` → `acked`/`nacked`

### Five Core Operations

| Operation | Purpose | Example |
|-----------|---------|---------|
| **SEND** | Submit message to agent's inbox | `POST /v1/agents/{id}/messages` |
| **PULL** | Retrieve message for processing | `POST /v1/agents/{id}/inbox/pull` |
| **ACK** | Confirm successful processing | `POST /v1/messages/{id}/ack` |
| **NACK** | Reject or extend lease | `POST /v1/messages/{id}/nack` |
| **REPLY** | Return correlated response | `POST /v1/messages/{id}/reply` |

---

## Features

### ✅ Delivered in v1.0

- **HTTP API** with complete OpenAPI 3.1 spec
- **PostgreSQL-backed inbox** with at-least-once delivery
- **Lease-based processing** (prevents message loss on crash)
- **Idempotency** (deduplication by key or fingerprint)
- **Security**: Bearer tokens, HMAC, Ed25519 signatures
- **TTL enforcement** with dead-letter queues
- **Policy engine** (who can send to whom)
- **Client SDKs**: JavaScript/TypeScript and Python
- **Docker deployment** with health checks
- **Observability**: Structured logs, Prometheus metrics
- **Examples**: Request/response, task orchestration, Detach integration

### 🚧 Coming in v1.1+

- **SMTP Federation** (cross-domain messaging via email)
- **DNS-based key discovery** (`_agentkeys.domain.com`)
- **Web dashboard** (message flow visualization)
- **Additional SDKs** (Go, Rust, Java)

---

## Architecture

```
┌───────────────────────────────────────────────────────────┐
│                      ADMP Ecosystem                       │
├───────────────────────────────────────────────────────────┤
│                                                           │
│   ┌─────────┐      ┌─────────┐      ┌─────────┐         │
│   │ Agent A │      │ Agent B │      │ Agent C │         │
│   │ (sender)│      │(receiver│      │(observer│         │
│   └────┬────┘      └────┬────┘      └────┬────┘         │
│        │                │                 │              │
│        │ HTTP POST      │ HTTP PULL       │ WebSocket    │
│        v                v                 v              │
│   ┌────────────────────────────────────────────┐         │
│   │         ADMP Relay (Core Server)           │         │
│   │  • Inbox management (SEND/PULL/ACK/NACK)   │         │
│   │  • Policy enforcement                      │         │
│   │  • Signature verification                  │         │
│   │  • Metrics & audit logging                 │         │
│   └────────────────┬───────────────────────────┘         │
│                    │                                      │
│                    v                                      │
│   ┌──────────────────────────────────────────┐           │
│   │       PostgreSQL Message Store           │           │
│   │  • message (inbox queue)                 │           │
│   │  • agent (registry)                      │           │
│   │  • policy (authorization)                │           │
│   │  • audit_log (full history)              │           │
│   └──────────────────────────────────────────┘           │
│                                                           │
└───────────────────────────────────────────────────────────┘
```

---

## Repository Structure

```
agent-dispatch/
├── packages/
│   ├── core/              # Relay server (TypeScript + Express)
│   ├── client-js/         # JavaScript/TypeScript SDK
│   ├── client-py/         # Python SDK
│   └── policy-engine/     # Policy evaluation library
├── examples/
│   ├── request-response/  # Basic ping-pong
│   ├── task-orchestration/# Multi-agent workflow
│   └── detach-integration/# Real-world: Claude Code hooks
├── docs/
│   ├── quickstart.md      # Get started in 5 minutes
│   ├── architecture.md    # System design deep-dive
│   ├── security.md        # Authentication & signatures
│   └── api-reference/     # Generated from OpenAPI
├── spec/
│   ├── openapi.yaml       # Complete HTTP API spec
│   ├── schemas/           # JSON Schema definitions
│   └── compliance-tests/  # Protocol validation suite
├── deploy/
│   ├── docker-compose.yml # Local development setup
│   ├── kubernetes/        # K8s manifests
│   └── terraform/         # Infrastructure as code
└── whitepaper/
    └── v1.md             # Complete protocol specification
```

---

## Documentation

- **[Quickstart Guide](docs/quickstart.md)** — Get started in 5 minutes
- **[Architecture Overview](docs/architecture.md)** — How ADMP works
- **[API Reference](docs/api-reference/)** — Full endpoint documentation
- **[Security Guide](docs/security.md)** — Authentication, signatures, policies
- **[Whitepaper (v1.0)](whitepaper/v1.md)** — Complete RFC-style specification
- **[Examples](examples/)** — Working code samples

---

## Use Cases

### 1. Multi-Agent Coordination
- Task decomposition and distribution
- Result aggregation
- Workflow orchestration

**Example**: An orchestrator agent sends subtasks to worker agents, collects results via correlation IDs, and synthesizes final output.

### 2. Remote Agent Control
- Inject instructions into running agents
- Request approval for sensitive operations
- Implement human-in-the-loop workflows

**Example**: [Detach](examples/detach-integration/) — remote approval for Claude Code tool executions.

### 3. Event-Driven Architectures
- Publish events to subscriber agents
- Guaranteed delivery with acknowledgment
- Dead-letter handling for failures

**Example**: A file watcher agent sends `file.changed` events to indexer, analyzer, and notifier agents.

### 4. Federation (v1.1+)
- Cross-domain agent communication
- Email-based message transport (SMTP)
- DNS-based trust establishment

**Example**: `agent-auth@yourco.com` sends messages to `agent-storage@partner.com` via email.

---

## Why ADMP?

### vs. REST APIs
❌ No delivery guarantees
❌ Manual correlation tracking
❌ No built-in retry logic
✅ **ADMP**: At-least-once delivery, built-in correlation, automatic lease handling

### vs. Message Queues (RabbitMQ, Kafka)
❌ Complex setup and operations
❌ Vendor lock-in
❌ No federation support
✅ **ADMP**: Simple Docker deployment, open protocol, federation-ready

### vs. MCP (Model Context Protocol)
❌ No message delivery semantics
❌ Focused on tool integration
❌ No cross-network communication
✅ **ADMP**: Full messaging layer, works with MCP endpoints, SMTP federation

### vs. A2A (Agent-to-Agent)
❌ RPC-style (tight coupling)
❌ No queuing or delivery guarantees
✅ **ADMP**: Queued messaging, explicit acknowledgment, works offline

---

## Development

### Prerequisites

- Node.js >= 18
- Docker & Docker Compose
- PostgreSQL 16 (via Docker)

### Setup

```bash
# Clone repository
git clone https://github.com/agent-dispatch/agent-dispatch.git
cd agent-dispatch

# Install dependencies
npm install

# Start services
npm run docker:up

# Run tests
npm test

# Build all packages
npm run build
```

### Project Commands

```bash
npm run dev          # Start relay in dev mode (hot reload)
npm run build        # Build all packages
npm run test         # Run test suites
npm run lint         # Lint code
npm run docker:up    # Start Docker services
npm run docker:down  # Stop Docker services
npm run docker:logs  # View logs
```

---

## Contributing

We welcome contributions! ADMP is an open protocol — the more implementations, the better.

### Areas for Contribution

- **Additional language SDKs** (Go, Rust, Java, Ruby, etc.)
- **Storage backends** (Redis, DynamoDB, etc.)
- **Transport bindings** (WebSocket, gRPC, etc.)
- **Dashboard improvements**
- **Example applications**
- **Documentation and tutorials**

See [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines.

---

## Roadmap

### v1.0 (Current) — Core Protocol
- [x] HTTP API (SEND, PULL, ACK, NACK, REPLY)
- [x] PostgreSQL inbox
- [x] Security (signatures, policies)
- [x] JavaScript & Python SDKs
- [x] Docker deployment
- [x] Documentation & examples

### v1.1 (Q2 2026) — Federation
- [ ] SMTP bridge (inbound/outbound)
- [ ] DKIM verification
- [ ] DNS-based key discovery
- [ ] Cross-domain example

### v1.2 (Q3 2026) — Enhanced Observability
- [ ] Web dashboard
- [ ] Message flow visualization
- [ ] Audit log viewer
- [ ] Real-time metrics

### v2.0 (Q4 2026+) — Advanced Features
- [ ] Message-level encryption
- [ ] Streaming responses (WebSocket)
- [ ] Multi-recipient fanout
- [ ] Alternative storage backends

---

## Community

- **GitHub**: [agent-dispatch/agent-dispatch](https://github.com/agent-dispatch/agent-dispatch)
- **Discussions**: [GitHub Discussions](https://github.com/agent-dispatch/agent-dispatch/discussions)
- **Issues**: [GitHub Issues](https://github.com/agent-dispatch/agent-dispatch/issues)
- **Docs**: [docs.agentdispatch.org](https://docs.agentdispatch.org)

---

## License

Apache License 2.0 — see [LICENSE](LICENSE) for details.

---

## Citation

If you use ADMP in research or production, please cite:

```bibtex
@techreport{admp2025,
  title={Agent Dispatch Messaging Protocol (ADMP): A Universal Inbox Standard for Autonomous Agents},
  author={Agent Dispatch Working Group},
  year={2025},
  institution={Agent Dispatch},
  type={Technical Specification},
  number={v1.0},
  url={https://github.com/agent-dispatch/agent-dispatch}
}
```

---

## Acknowledgments

ADMP builds on decades of messaging standards:
- **SMTP** (reliable email delivery)
- **AMQP** (queue semantics)
- **HTTP** (REST principles)
- **MCP** (tool integration patterns)

Special thanks to the autonomous agent community for feedback and use cases that shaped this protocol.

---

**ADMP — A reliable inbox for every agent.**
