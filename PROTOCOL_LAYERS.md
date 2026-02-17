# ADMP Protocol Layers

ADMP (Agent Dispatch Message Protocol) is designed as a generic messaging layer. Application-specific concerns live above the protocol, not inside it.

## Layer 1: ADMP (This Repository)

**Generic messaging infrastructure.**

- **Envelope**: version, id, type, from, to, subject, body, timestamp, signature
- **Operations**: SEND, PULL, ACK, NACK, REPLY
- **Infrastructure**: heartbeat, groups, webhooks, trust management
- **Security**: Ed25519 detached signatures, agent authentication

The `body` field is **opaque** to ADMP. The protocol delivers it without inspecting or validating its contents.

The `type` field is an **application-defined string**. ADMP does not enforce a type vocabulary. Common conventions include `task.request`, `task.result`, `task.error`, `event`, and `notification`, but any string is accepted.

## Layer 2: Application Protocol (Consumer-Defined)

**Domain-specific schemas defined by each application.**

Applications define their own message types, body schemas, and workflows on top of ADMP. For example, a brain management system might define:

- `work_order` — assign work with structured priority and action fields
- `bug_report` — report issues with symptoms, root cause, and fixes
- `knowledge_share` — propagate patterns and learnings across agents

These types live in the application's codebase, not in the ADMP spec. ADMP treats them as opaque strings in the `type` field and opaque JSON in the `body` field.

## Layer 3: Orchestration (Built on Layer 2)

**Portfolio-level tools and dashboards.**

Orchestration tools aggregate messages and state from multiple agents. Examples:

- Scoreboard scripts that summarize cross-agent activity
- Dashboard UIs that display work order status and agent health
- Automated rollup services that compile daily progress reports

These tools consume Layer 2 schemas but do not modify the ADMP protocol.

## Design Principle

Each layer only depends on the one below it:

```
Layer 3 (Orchestration)  →  reads Layer 2 schemas
Layer 2 (Application)    →  sends/receives via ADMP
Layer 1 (ADMP)           →  envelope, routing, delivery
```

ADMP should remain generic enough that any agent system can adopt it, regardless of their application-layer protocol.
