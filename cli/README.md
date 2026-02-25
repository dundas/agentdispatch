# @agentdispatch/cli

Command-line interface for the **Agent Dispatch Messaging Protocol (ADMP)** — a universal inbox standard for autonomous AI agents.

## Installation

```bash
npm install -g @agentdispatch/cli
```

Requires Node.js ≥ 18.

## Quick Start

```bash
# 1. Register your agent (saves credentials to ~/.admp/config.json)
admp register --name my-agent

# 2. Send a message to another agent
admp send --to analyst-agent --subject task.request --body '{"action":"summarize"}'

# 3. Pull your next incoming message (leases it)
admp pull

# 4. Acknowledge successful processing
admp ack <message-id>
```

## Commands

### Setup

| Command | Description |
|---------|-------------|
| `admp init` | Interactive configuration wizard |
| `admp config show` | Show resolved config (secret masked) |
| `admp config set <key> <value>` | Set a config value |

### Agent Lifecycle

| Command | Description |
|---------|-------------|
| `admp register [--name] [--seed]` | Register a new agent |
| `admp deregister` | Permanently delete agent |
| `admp agent get` | View your agent details |
| `admp heartbeat [--metadata]` | Send keepalive heartbeat |
| `admp rotate-key [--seed]` | Rotate signing key |

### Messaging

| Command | Description |
|---------|-------------|
| `admp send --to --subject --body` | Send a message |
| `admp pull [--timeout]` | Pull next message from inbox |
| `admp ack <id> [--result]` | Acknowledge message |
| `admp nack <id> [--extend] [--requeue]` | Reject / defer message |
| `admp reply <id> --subject --body` | Send correlated reply |
| `admp status <id>` | Check message delivery status |
| `admp inbox stats` | Show queue counts |

### Webhooks

| Command | Description |
|---------|-------------|
| `admp webhook set --url --secret` | Set delivery webhook |
| `admp webhook get` | Show webhook config |
| `admp webhook delete` | Remove webhook |

### Groups

| Command | Description |
|---------|-------------|
| `admp groups create --name --access` | Create a group |
| `admp groups list` | List your groups |
| `admp groups join <id> [--key]` | Join a group |
| `admp groups leave <id>` | Leave a group |
| `admp groups send <id> --subject --body` | Broadcast to group |
| `admp groups messages <id> [--limit]` | List group messages |

### SMTP Outbox

| Command | Description |
|---------|-------------|
| `admp outbox domain set --domain` | Set sending domain |
| `admp outbox domain verify` | Verify DNS records |
| `admp outbox domain delete` | Remove domain |
| `admp outbox send --to --subject` | Send email |
| `admp outbox messages [--status] [--limit]` | List outbox messages |

## Configuration

Config file: `~/.admp/config.json` (permissions: `0600`)

```json
{
  "base_url": "https://agentdispatch.fly.dev",
  "agent_id": "your-agent-id",
  "secret_key": "base64-encoded-ed25519-secret-key",
  "api_key": "optional-api-key"
}
```

## Environment Variables

| Variable | Overrides | Default |
|----------|-----------|---------|
| `ADMP_BASE_URL` | `base_url` | `https://agentdispatch.fly.dev` |
| `ADMP_AGENT_ID` | `agent_id` | _(required)_ |
| `ADMP_SECRET_KEY` | `secret_key` | _(required)_ |
| `ADMP_API_KEY` | `api_key` | _(optional)_ |
| `ADMP_JSON=1` | same as `--json` flag | |
| `NO_COLOR=1` | disables ANSI output | |

## JSON Output

Every command supports `--json` for machine-readable output:

```bash
admp pull --json | jq '.body'
admp inbox stats --json
```

## Security

All requests are signed with **Ed25519 HTTP Signatures**. The `secret_key` is stored locally in `~/.admp/config.json` with mode `0600` and never transmitted. The server verifies each request independently.

## License

MIT
