# PRD: Brain Process Manager + ADMP CLI

## 1. Introduction/Overview

The Brain Process Manager is a core module that enables autonomous brain operation by managing long-running processes within a brain. Combined with an ADMP CLI for debugging and manual interaction, this provides a complete solution for operating self-improving brains.

**Problem:** Currently, the AgentDispatch brain runs as a monolithic process without structured management of its concurrent tasks (heartbeat, inbox polling, webhook server, self-improvement). If one task fails, there's no automatic recovery. There's also no way to manually interact with AgentDispatch for testing.

**Solution:** A hybrid approach:
1. **Brain Process Manager** - Built into the brain, manages all background processes with health monitoring and restart on failure
2. **ADMP CLI** - Command-line tool for debugging and manual testing

## 2. Goals

1. **Autonomous Operation** - Brain can run indefinitely with automatic recovery from failures
2. **Observability** - Clear visibility into what processes are running and their health
3. **Reliability** - Failed processes restart automatically within configured limits
4. **Graceful Shutdown** - Clean shutdown on SIGTERM/SIGINT without data loss
5. **Debuggability** - CLI for manual testing and troubleshooting
6. **Inbox Integration** - Brain can receive and respond to messages

## 3. User Stories

### Brain Process Manager

1. **As a brain**, I want to register multiple background processes so they all run concurrently
2. **As a brain**, I want failed processes to restart automatically so I can operate autonomously
3. **As a brain**, I want to see the status of all my processes so I can report my health
4. **As a brain**, I want graceful shutdown so I don't lose data when stopped
5. **As a brain**, I want to poll my inbox so I can receive and respond to messages

### ADMP CLI

6. **As an operator**, I want to send messages to agents so I can test communication
7. **As an operator**, I want to check an agent's inbox so I can debug message delivery
8. **As an operator**, I want to register test agents so I can simulate multi-agent scenarios
9. **As an operator**, I want to check hub health so I can verify the system is working

## 4. Functional Requirements

### 4.1 Process Manager

| ID | Requirement |
|----|-------------|
| PM-1 | Register processes with name, run function, type (interval/persistent/once), and options |
| PM-2 | Support interval processes that run on a schedule (e.g., heartbeat every 30s) |
| PM-3 | Support persistent processes that run continuously (e.g., webhook server) |
| PM-4 | Support one-time processes that run once and complete |
| PM-5 | Track process state: pending, running, stopped, failed, completed |
| PM-6 | Restart failed processes automatically (configurable max restarts) |
| PM-7 | Track run count, error count, last error, restart count per process |
| PM-8 | Provide status API to get state of all processes |
| PM-9 | Print formatted status table to console |
| PM-10 | Start all enabled processes on `start()` |
| PM-11 | Stop all processes gracefully on `stop()` |
| PM-12 | Handle SIGTERM/SIGINT for graceful shutdown |

### 4.2 Inbox Polling Process

| ID | Requirement |
|----|-------------|
| IP-1 | Poll inbox on configurable interval (default 5s) |
| IP-2 | Pull messages with visibility timeout (lease) |
| IP-3 | Process messages and generate responses |
| IP-4 | Acknowledge successfully processed messages |
| IP-5 | Nack/requeue failed messages |
| IP-6 | Support webhook delivery as primary method (polling as fallback) |

### 4.3 ADMP Client Extensions

| ID | Requirement |
|----|-------------|
| AC-1 | Add `pullMessages()` method to pull from inbox |
| AC-2 | Add `ackMessage(id)` method to acknowledge messages |
| AC-3 | Add `nackMessage(id)` method to reject/requeue messages |
| AC-4 | Add `getInboxStats()` method to get inbox statistics |
| AC-5 | Store and use Ed25519 keys for authenticated requests |

### 4.4 ADMP CLI

| ID | Requirement |
|----|-------------|
| CLI-1 | `admp health` - Check hub health |
| CLI-2 | `admp register [--type TYPE]` - Register a new agent |
| CLI-3 | `admp send <to> <message> [--subject SUBJECT]` - Send message |
| CLI-4 | `admp inbox [--agent ID]` - List inbox messages |
| CLI-5 | `admp inbox pull [--agent ID]` - Pull next message |
| CLI-6 | `admp inbox ack <message-id>` - Acknowledge message |
| CLI-7 | `admp agents` - List registered agents (if permitted) |
| CLI-8 | `admp config set <key> <value>` - Set configuration |
| CLI-9 | `admp config get <key>` - Get configuration |
| CLI-10 | Support config file (`~/.admp/config.json`) and env vars |
| CLI-11 | Env vars override config file values |

## 5. Non-Goals (Out of Scope)

1. **Process dependencies** - No support for "start B after A completes" (future enhancement)
2. **Distributed process management** - Single brain only, not cluster coordination
3. **Web UI** - CLI only for MVP
4. **Message routing/transformation** - Brain handles raw messages
5. **Rate limiting** - Rely on hub's rate limiting
6. **CLI auto-completion** - Nice to have, not MVP

## 6. Design Considerations

### Process Manager Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    Brain Process Manager                     │
├─────────────────────────────────────────────────────────────┤
│  Processes Map          │  States Map          │  Timers    │
│  ─────────────          │  ──────────          │  ──────    │
│  name → config          │  name → state        │  name → id │
├─────────────────────────────────────────────────────────────┤
│  register(config)       │  start()             │  stop()    │
│  startProcess(name)     │  stopProcess(name)   │  status()  │
└─────────────────────────────────────────────────────────────┘
```

### Default Processes for AgentDispatch Brain

| Process | Type | Interval | Description |
|---------|------|----------|-------------|
| heartbeat | interval | 30s | Send heartbeat to hub |
| inbox-poller | interval | 5s | Poll inbox for messages |
| health-check | interval | 60s | Check hub health |
| self-improve | interval | 24h | Run self-improvement cycle |
| webhook-server | persistent | - | HTTP server for webhooks |

### CLI Config File Structure

```json
{
  "hub_url": "https://agentdispatch.fly.dev",
  "agent_id": "agent://my-agent",
  "secret_key": "base64...",
  "public_key": "base64..."
}
```

## 7. Technical Considerations

1. **Runtime**: Bun (not Node.js)
2. **Location**: `agentdispatch/brain/lib/process-manager.ts`
3. **CLI Location**: `agentdispatch/cli/` with entry point `cli/index.ts`
4. **Testing**: `bun test` with test files co-located
5. **No external dependencies** for process manager (pure TypeScript)
6. **CLI uses Commander.js** or similar for argument parsing

## 8. Success Metrics

1. **Uptime**: Brain runs for 7+ days without manual intervention
2. **Recovery**: Failed processes restart within 10 seconds
3. **Message Latency**: Inbox messages processed within 10 seconds of arrival
4. **CLI Response**: All CLI commands complete within 5 seconds

## 9. Open Questions

1. Should the process manager expose metrics for Prometheus scraping? (Future)
2. Should inbox polling backoff when no messages are found? (Probably yes)
3. Should CLI support interactive mode for message composition? (Nice to have)

---

*Created: 2026-02-04*
*Status: Draft*
