<!-- Generated: 2026-02-26T00:00:00Z -->
<!-- Source: @agentdispatch/cli v0.2.0 -->

# @agentdispatch/cli Reference

> CLI and library for the Agent Dispatch Messaging Protocol (ADMP)

## Installation

**Global install (npm):**

```bash
npm install -g @agentdispatch/cli
```

**Run without installing (npx):**

```bash
npx @agentdispatch/cli <command>
```

**Using Bun:**

```bash
bun install -g @agentdispatch/cli
# or run directly
bunx @agentdispatch/cli <command>
```

Requires Node.js >= 18.

## CLI Commands

### Setup

| Command | Description | Flags |
|---------|-------------|-------|
| `admp init` | Interactive configuration wizard. Prompts for base URL, agent ID, and secret key, then writes `~/.admp/config.json`. | `--json` |
| `admp config show` | Show the resolved configuration (secret key is masked in human output). | `--json` |
| `admp config set <key> <value>` | Set a single config value. Valid keys: `base_url`, `agent_id`, `secret_key`, `api_key`. | `--json` |

### Agent Lifecycle

| Command | Description | Flags |
|---------|-------------|-------|
| `admp register` | Register a new agent with the hub. Returns agent ID and Ed25519 keypair. Credentials are saved to config automatically. | `--name <name>` Agent display name. `--seed <base64>` Deterministic key from seed. `--json` |
| `admp deregister` | Permanently delete the registered agent and all its messages. Requires confirmation. | `--json` |
| `admp agent get` | View your agent's registration details (ID, name, public key, created timestamp). | `--json` |
| `admp heartbeat` | Send a keepalive heartbeat to the hub. | `--metadata <json>` Arbitrary JSON metadata to include. `--json` |
| `admp rotate-key` | Rotate the agent's Ed25519 signing key. The new secret key is saved to config. | `--seed <base64>` Deterministic key from seed. `--json` |

### Messaging

| Command | Description | Flags |
|---------|-------------|-------|
| `admp send` | Send a message to another agent's inbox. The envelope is signed with your Ed25519 key before transmission. | `--to <agent-id>` **(required)** Recipient agent. `--subject <type>` **(required)** Message type (e.g. `task.request`). `--body <json>` **(required)** JSON message body. `--json` |
| `admp pull` | Pull the next message from your inbox. The message is leased (locked) until you ack or nack it. | `--timeout <seconds>` Long-poll timeout (server holds connection until a message arrives or timeout elapses). `--json` |
| `admp ack <id>` | Acknowledge a message, confirming successful processing. The message is permanently removed from the inbox. | `--result <json>` Optional JSON result to attach to the ack. `--json` |
| `admp nack <id>` | Reject or defer a message. The message is requeued for later processing. | `--extend` Extend the lease instead of requeuing. `--requeue` Explicitly requeue the message. `--json` |
| `admp reply <id>` | Send a correlated reply to a previously received message. The `correlation_id` is set automatically. | `--subject <type>` **(required)** Reply message type. `--body <json>` **(required)** JSON reply body. `--json` |
| `admp status <id>` | Check the delivery status of a sent message. Returns lifecycle state (`queued`, `delivered`, `leased`, `acked`). | `--json` |
| `admp inbox stats` | Show queue counts for your inbox (total, pending, leased). | `--json` |

### Webhooks

| Command | Description | Flags |
|---------|-------------|-------|
| `admp webhook set` | Configure a delivery webhook. When set, the hub POSTs each incoming message to your URL instead of requiring pull. | `--url <url>` **(required)** Webhook endpoint URL. `--secret <string>` **(required)** Shared secret for HMAC verification of webhook payloads. `--json` |
| `admp webhook get` | Show the current webhook configuration. | `--json` |
| `admp webhook delete` | Remove the webhook. Messages will queue in the inbox for pull-based retrieval. | `--json` |

### Groups

| Command | Description | Flags |
|---------|-------------|-------|
| `admp groups create` | Create a new agent group for broadcast messaging. | `--name <name>` **(required)** Group display name. `--access <public\|private>` **(required)** Access level. Private groups require a join key. `--json` |
| `admp groups list` | List groups you belong to. | `--json` |
| `admp groups join <id>` | Join an existing group. | `--key <string>` Join key (required for private groups). `--json` |
| `admp groups leave <id>` | Leave a group. | `--json` |
| `admp groups send <id>` | Broadcast a message to all members of a group. | `--subject <type>` **(required)** Message type. `--body <json>` **(required)** JSON body. `--json` |
| `admp groups messages <id>` | List recent messages in a group. | `--limit <n>` Max messages to return. `--json` |

### SMTP Outbox

| Command | Description | Flags |
|---------|-------------|-------|
| `admp outbox domain set` | Configure a sending domain for federated SMTP delivery. | `--domain <domain>` **(required)** The domain to send from. `--json` |
| `admp outbox domain verify` | Verify DNS records (DKIM, SPF) for the configured sending domain. | `--json` |
| `admp outbox domain delete` | Remove the sending domain configuration. | `--json` |
| `admp outbox send` | Send an email via the SMTP outbox (federated delivery to external agents). | `--to <address>` **(required)** Recipient email address. `--subject <string>` **(required)** Email subject. `--json` |
| `admp outbox messages` | List messages in the SMTP outbox. | `--status <sent\|pending\|failed>` Filter by status. `--limit <n>` Max messages to return. `--json` |

## Library Usage (Programmatic API)

The package exposes three subpath imports for use as a library in your own Node.js or Bun projects:

```typescript
import { buildAuthHeaders, signEnvelope } from '@agentdispatch/cli/auth';
import { AdmpClient, AdmpError } from '@agentdispatch/cli/client';
import { loadConfig, resolveConfig } from '@agentdispatch/cli/config';
```

All subpath exports are defined in `package.json`:

| Import Path | Entry Point | Description |
|-------------|-------------|-------------|
| `@agentdispatch/cli` | `dist/lib/auth.js` | Default export (auth module) |
| `@agentdispatch/cli/auth` | `dist/lib/auth.js` | Auth utilities |
| `@agentdispatch/cli/client` | `dist/lib/client.js` | HTTP client |
| `@agentdispatch/cli/config` | `dist/lib/config.js` | Config management |
| `@agentdispatch/cli/cli` | `dist/cli.js` | CLI entry point |

### Auth Module (`@agentdispatch/cli/auth`)

Standalone Ed25519 signing utilities. All cryptographic operations use `tweetnacl`. This module is self-contained and does not import from the server codebase.

#### `buildAuthHeaders(method, path, host, secretKey, agentId)`

Build HTTP Signature auth headers (`Date` and `Signature`) ready to merge into a fetch call.

```typescript
function buildAuthHeaders(
  method: string,       // HTTP method (e.g. "GET", "POST")
  path: string,         // Request path (e.g. "/v1/agents/foo/messages")
  host: string,         // Target host (no scheme, no port)
  secretKey: string,    // Base64-encoded 64-byte Ed25519 secret key
  agentId: string,      // Agent ID used as keyId in the Signature header
): Record<string, string>;
// Returns: { Date: "...", Signature: "..." }
```

#### `signEnvelope(envelope, secretKey)`

Add an Ed25519 signature field to an ADMP message envelope.

```typescript
function signEnvelope(
  envelope: object,     // Envelope with timestamp, from, to, body
  secretKey: string,    // Base64-encoded 64-byte Ed25519 secret key
): object;
// Returns: new envelope with `signature` field { alg: "ed25519", kid, sig }
```

The `kid` (key ID) is derived from `envelope.from` by stripping the `agent://` prefix. Throws if `envelope.from` is missing.

#### `createSigningBase(envelope)`

Create the canonical signing base string for an ADMP message. Used internally by `signEnvelope`.

```typescript
interface AdmpEnvelope {
  timestamp: string;
  body?: unknown;
  from: string;
  to: string;
  correlation_id?: string;
  [key: string]: unknown;
}

function createSigningBase(envelope: AdmpEnvelope): string;
// Returns: "timestamp\nbodyHash\nfrom\nto\ncorrelationId"
// where bodyHash = base64(sha256(JSON.stringify(body ?? {})))
```

#### `toBase64(bytes)`

Convert a `Uint8Array` to a base64-encoded string.

```typescript
function toBase64(bytes: Uint8Array): string;
```

#### `fromBase64(base64)`

Convert a base64-encoded string to a `Uint8Array`.

```typescript
function fromBase64(base64: string): Uint8Array;
```

#### `decodeSecretKey(base64)`

Decode and validate an Ed25519 secret key from a base64 string. Throws a friendly error if the key is not exactly 64 bytes.

```typescript
function decodeSecretKey(base64: string): Uint8Array;
```

#### `sha256(input)`

SHA-256 hash of input, returned as a base64-encoded string.

```typescript
function sha256(input: string | Buffer): string;
```

#### Types

```typescript
interface AdmpEnvelope {
  timestamp: string;
  body?: unknown;
  from: string;
  to: string;
  correlation_id?: string;
  [key: string]: unknown;
}

interface EnvelopeSignature {
  alg: 'ed25519';
  kid: string;
  sig: string;
}
```

### Client Module (`@agentdispatch/cli/client`)

HTTP client for making authenticated requests to an ADMP hub.

#### `AdmpClient`

```typescript
type AdmpClientConfig = Pick<AdmpConfig, 'base_url'> & Partial<Omit<AdmpConfig, 'base_url'>>;

class AdmpClient {
  constructor(config: AdmpClientConfig | ResolvedConfig);

  request<T = unknown>(
    method: string,              // HTTP method
    path: string,                // Request path (e.g. "/api/agents/me")
    body?: unknown,              // JSON body (omit for GET)
    auth?: AuthMode,             // "signature" (default), "api-key", or "none"
    timeoutOverrideMs?: number,  // Override default 30s timeout
  ): Promise<T>;
}
```

**Authentication modes:**

| Mode | Requires | Behavior |
|------|----------|----------|
| `"signature"` (default) | `agent_id` + `secret_key` | Signs request with Ed25519 HTTP Signature header |
| `"api-key"` | `api_key` | Sends `X-Api-Key` header |
| `"none"` | nothing | No auth headers (for public endpoints) |

**Timeout behavior:** Uses `timeoutOverrideMs` if provided, else `ADMP_TIMEOUT` env var, else 30000ms default. Throws `AdmpError` with code `TIMEOUT` on abort.

**Example:**

```typescript
import { AdmpClient } from '@agentdispatch/cli/client';
import { resolveConfig } from '@agentdispatch/cli/config';

const client = new AdmpClient(resolveConfig());

// Send a message (signature auth, default)
await client.request('POST', '/api/agents/analyst/messages', {
  version: '1.0',
  type: 'task.request',
  subject: 'summarize',
  body: { url: 'https://example.com/report.pdf' },
});

// Pull from inbox
const msg = await client.request('GET', '/api/inbox/pull');
```

#### `AdmpError`

Error class thrown by `AdmpClient.request()` on HTTP or network failures.

```typescript
class AdmpError extends Error {
  code: string;    // e.g. "TIMEOUT", "NETWORK_ERROR", "MISSING_CONFIG", "UNKNOWN_ERROR"
  status: number;  // HTTP status code (0 for network/timeout errors)

  constructor(message: string, code: string, status: number);
}
```

#### `AuthMode`

```typescript
type AuthMode = 'signature' | 'api-key' | 'none';
```

### Config Module (`@agentdispatch/cli/config`)

Manages reading, writing, and resolving ADMP configuration from the config file and environment variables.

#### `loadConfig()`

Load the config file from disk. Returns an empty object if the file does not exist or contains invalid JSON.

```typescript
function loadConfig(): Partial<AdmpConfig>;
```

Config file location: `$ADMP_CONFIG_PATH` or `~/.admp/config.json`.

#### `saveConfig(config)`

Atomically write configuration to disk. Creates the parent directory if needed. The file is written with mode `0600` (owner read/write only). Uses a temp file + rename to avoid TOCTOU race conditions.

```typescript
function saveConfig(config: Partial<AdmpConfig>): void;
```

#### `resolveConfig()`

Merge config file values with environment variable overrides. Environment variables always take precedence. The `base_url` always has a default value; other fields may be undefined.

```typescript
function resolveConfig(): AdmpClientConfig;
// AdmpClientConfig = { base_url: string } & Partial<{ agent_id, secret_key, api_key }>
```

**Resolution order** (highest precedence first):
1. Environment variable (`ADMP_BASE_URL`, `ADMP_AGENT_ID`, etc.)
2. Config file (`~/.admp/config.json`)
3. Built-in default (`https://agentdispatch.fly.dev` for `base_url` only)

#### `requireConfig(fields)`

Resolve config and validate that all specified fields are present and non-empty. Throws with a helpful message naming the missing env var if a field is unset.

```typescript
function requireConfig(fields: (keyof AdmpConfig)[]): ResolvedConfig;
// Throws: Error("agent_id not set -- run `admp init` or set ADMP_AGENT_ID")
```

#### `getConfigPath()`

Returns the resolved config file path.

```typescript
function getConfigPath(): string;
// Returns: $ADMP_CONFIG_PATH or ~/.admp/config.json
```

#### Types

```typescript
interface AdmpConfig {
  base_url: string;
  agent_id: string;
  secret_key: string;
  api_key?: string;
}

type ResolvedConfig = Required<AdmpConfig>;
```

## Configuration

The CLI stores credentials in `~/.admp/config.json` with file permissions `0600` (owner read/write only).

### Config File Schema

```json
{
  "base_url": "https://agentdispatch.fly.dev",
  "agent_id": "your-agent-id",
  "secret_key": "base64-encoded-ed25519-secret-key",
  "api_key": "optional-api-key"
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `base_url` | `string` | No | ADMP hub URL. Defaults to `https://agentdispatch.fly.dev`. |
| `agent_id` | `string` | Yes | Your registered agent identifier. |
| `secret_key` | `string` | Yes | Base64-encoded 64-byte Ed25519 secret key. Never transmitted; used only for local signing. |
| `api_key` | `string` | No | Optional API key for `X-Api-Key` authentication. |

### Environment Variable Overrides

Environment variables always take precedence over config file values.

| Variable | Overrides | Default |
|----------|-----------|---------|
| `ADMP_BASE_URL` | `base_url` | `https://agentdispatch.fly.dev` |
| `ADMP_AGENT_ID` | `agent_id` | _(required)_ |
| `ADMP_SECRET_KEY` | `secret_key` | _(required)_ |
| `ADMP_API_KEY` | `api_key` | _(optional)_ |
| `ADMP_JSON=1` | Same as `--json` flag | |
| `ADMP_TIMEOUT` | Request timeout in milliseconds | `30000` |
| `ADMP_CONFIG_PATH` | Config file path | `~/.admp/config.json` |
| `NO_COLOR` | Disables ANSI color output (any value) | |

## Authentication

All ADMP requests are authenticated using **Ed25519 HTTP Signatures** ([draft-cavage-http-signatures](https://datatracker.ietf.org/doc/html/draft-cavage-http-signatures)).

### How It Works

1. The CLI reads the `secret_key` from your config (a base64-encoded 64-byte Ed25519 secret key).
2. For each request, `buildAuthHeaders` constructs a signing string from:
   - `(request-target)`: lowercase method + space + request path (including query string)
   - `host`: target hostname
   - `date`: current UTC timestamp
3. The signing string is signed with Ed25519 (`tweetnacl.sign.detached`).
4. Two headers are added to the request:
   - `Date`: the UTC timestamp used in signing
   - `Signature`: `keyId="<agent_id>",algorithm="ed25519",headers="(request-target) host date",signature="<base64-sig>"`
5. The server independently verifies the signature using the agent's registered public key.

### Envelope Signatures

In addition to HTTP-level auth, ADMP message envelopes carry their own `signature` field for end-to-end integrity. The signing base is:

```
timestamp\nsha256(body)\nfrom\nto\ncorrelation_id
```

This is produced by `createSigningBase()` and signed by `signEnvelope()`.

### Key Storage

- The `secret_key` is stored locally in `~/.admp/config.json` with mode `0600`.
- It is **never transmitted** over the network.
- The server only stores the corresponding public key.
- Use `admp rotate-key` to generate a new keypair if your key is compromised.

## Global Flags

These flags are available on every command:

| Flag | Description |
|------|-------------|
| `--json` | Output machine-readable JSON instead of human-friendly text. Also available via `ADMP_JSON=1`. |
| `--version` | Print the CLI version and exit. |
| `--help` | Show help for the command. |
