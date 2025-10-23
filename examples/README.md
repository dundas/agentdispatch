# ADMP Examples

This directory contains example applications demonstrating various ADMP usage patterns.

## Available Examples

### 1. Detach Integration (`detach-integration/`)

Real-world integration showing how ADMP powers the Detach system for Claude Code session management:

- **Session lifecycle management** (registration, deregistration)
- **Approval workflows** (tool use requests and responses)
- **Message injection** (remote instruction delivery)
- **Multi-agent coordination** (relay, session agents, human approvers)

**Key patterns demonstrated:**
- Session registration using `session.register` messages
- Request/response pattern with correlation IDs
- Policy-based auto-approval for safe commands
- TTL-based approval timeouts

**Start here if:** You want to see ADMP solving a real production problem.

### 2. Task Orchestration (`task-orchestration/`)

Multi-agent workflow showing three agents collaborating to complete a complex task:

- **Orchestrator agent** (coordinates workflow)
- **Worker agents** (process subtasks)
- **Result aggregation** (collect and combine outputs)

**Key patterns demonstrated:**
- Task decomposition and distribution
- Parallel message processing
- Result correlation using correlation_id
- Error handling and retry logic

**Start here if:** You're building multi-agent systems that need to coordinate work.

### 3. Request/Response (`request-response/`)

Simple ping-pong example showing the basic request/response pattern:

- **Client agent** sends request
- **Server agent** processes and replies
- **Client** receives correlated response

**Key patterns demonstrated:**
- Basic SEND → PULL → REPLY flow
- Correlation ID usage
- Message acknowledgment
- Idempotency handling

**Start here if:** You're new to ADMP and want to understand the basics.

## Running the Examples

### Prerequisites

1. **Start ADMP services:**
   ```bash
   npm run docker:up
   ```

2. **Verify services are healthy:**
   ```bash
   curl http://localhost:3030/health
   ```

### Run an Example

Each example has its own README with specific instructions. General pattern:

```bash
cd examples/<example-name>
npm install
npm run example
```

## Example Structure

Each example follows this structure:

```
example-name/
├── README.md          # Detailed walkthrough
├── package.json       # Dependencies
├── src/
│   ├── agents/        # Agent implementations
│   └── index.ts       # Main entry point
└── .env.example       # Configuration template
```

## Learn More

- [ADMP Quickstart](../docs/quickstart.md)
- [Architecture Overview](../docs/architecture.md)
- [API Reference](../docs/api-reference/)
- [Whitepaper](../whitepaper/v1.md)
