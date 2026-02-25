# Task List: ADMP CLI & Agent Skill
**PRD:** `tasks/0003-prd-admp-cli-and-agent-skill.md`
**Generated:** 2026-02-25

---

## Relevant Files

- `cli/package.json` — CLI package definition (`@agentdispatch/cli`, Node ≥18, `"bin": {"admp": "./bin/admp.js"}`)
- `cli/tsconfig.json` — TypeScript config targeting Node18, ES2022 modules
- `cli/bin/admp.js` — Entry point shebang wrapper (`#!/usr/bin/env node`)
- `cli/src/index.ts` — Commander root program, mounts all sub-commands
- `cli/src/config.ts` — Config read/write (`~/.admp/config.json`), env var resolution
- `cli/src/config.test.ts` — Unit tests for config module
- `cli/src/auth.ts` — HTTP Signature builder (wraps `signRequest` logic from `src/utils/crypto.js`)
- `cli/src/auth.test.ts` — Unit tests for auth module
- `cli/src/client.ts` — Typed ADMP HTTP client (fetch wrapper with auth injection)
- `cli/src/output.ts` — Formatted output helpers: color, pretty-print JSON, `--json` mode, stderr errors
- `cli/src/commands/init.ts` — `admp init` interactive setup
- `cli/src/commands/config.ts` — `admp config show|set`
- `cli/src/commands/register.ts` — `admp register` / `admp deregister`
- `cli/src/commands/send.ts` — `admp send`
- `cli/src/commands/pull.ts` — `admp pull`
- `cli/src/commands/ack.ts` — `admp ack`
- `cli/src/commands/nack.ts` — `admp nack`
- `cli/src/commands/reply.ts` — `admp reply`
- `cli/src/commands/status.ts` — `admp status`
- `cli/src/commands/inbox.ts` — `admp inbox stats`
- `cli/src/commands/heartbeat.ts` — `admp heartbeat`
- `cli/src/commands/rotate-key.ts` — `admp rotate-key`
- `cli/src/commands/webhook.ts` — `admp webhook set|get|delete`
- `cli/src/commands/groups.ts` — `admp groups create|list|join|send|messages`
- `cli/src/commands/outbox.ts` — `admp outbox domain set|verify|delete`, `outbox send`, `outbox messages`
- `cli/test/integration.test.ts` — Integration tests against local server
- `cli/README.md` — CLI usage docs
- `skill/admp-client/SKILL.md` — Self-contained AI agent skill (≤400 lines)
- `skill/admp-client/install.sh` — POSIX install script for `.claude/`, `.gemini/`, `.codex/` skill dirs

### Notes
- CLI lives in `cli/` subdirectory of the repo — separate package from the server.
- Auth logic ports `signRequest()` from `src/utils/crypto.js` — do not import from server src (keep CLI standalone).
- Tests use `bun test`. Integration tests require `ADMP_BASE_URL=http://localhost:3000` and a running local server.
- The skill `SKILL.md` is written by hand from the existing `llms.txt` and `docs/AGENT-GUIDE.md` — it is not generated.

---

## Tasks

- [x] 1.0 Scaffold the `cli/` package
  - [x] 1.1 Create `cli/` directory and `cli/package.json` with name `@agentdispatch/cli`, version `0.1.0`, `"type": "module"`, `"bin": {"admp": "./bin/admp.js"}`, engines `node >= 18`, dependencies: `commander`, `tweetnacl`
  - [x] 1.2 Create `cli/tsconfig.json` targeting `ES2022`, `NodeNext` modules, `strict: true`, `outDir: dist`, `rootDir: src`
  - [x] 1.3 Create `cli/bin/admp.js` with `#!/usr/bin/env node` shebang that imports and runs `../dist/index.js` (or `../src/index.ts` for dev via tsx)
  - [x] 1.4 Add build script to `cli/package.json`: `"build": "bun build src/index.ts --target node --outdir dist --minify"` and `"dev": "bun run src/index.ts"`
  - [x] 1.5 Add `"test": "bun test"` script to `cli/package.json`
  - [x] 1.6 Create `cli/src/index.ts` that creates a root `commander` program with name `admp`, version from package.json, and registers all sub-command modules (stubs for now)
  - [x] 1.7 Verify `bun run cli/src/index.ts --help` prints the top-level help with no errors

- [x] 2.0 Implement config module
  - [x] 2.1 Create `cli/src/config.ts` with types: `AdmpConfig { base_url, agent_id, secret_key, api_key? }` and `ResolvedConfig` (same shape, all values resolved)
  - [x] 2.2 Implement `getConfigPath(): string` — returns `~/.admp/config.json` (expand `~` using `os.homedir()`)
  - [x] 2.3 Implement `loadConfig(): Partial<AdmpConfig>` — reads and JSON-parses `~/.admp/config.json`; returns `{}` if file does not exist
  - [x] 2.4 Implement `saveConfig(config: AdmpConfig): void` — writes to `~/.admp/config.json`, creates `~/.admp/` dir if needed, sets file mode `0o600`
  - [x] 2.5 Implement `resolveConfig(): ResolvedConfig` — merges (env vars override file): `ADMP_BASE_URL` → `base_url` (default `https://agentdispatch.fly.dev`), `ADMP_AGENT_ID` → `agent_id`, `ADMP_SECRET_KEY` → `secret_key`, `ADMP_API_KEY` → `api_key`
  - [x] 2.6 Implement `requireConfig(fields: string[]): ResolvedConfig` — calls `resolveConfig()`, throws a user-friendly error for any missing required field (e.g. "agent_id not set — run `admp init` or set ADMP_AGENT_ID")
  - [x] 2.7 Implement `admp init` command in `cli/src/commands/init.ts` — interactively prompts for `base_url`, `agent_id`, `secret_key` (using `readline` or `@inquirer/prompts`), then calls `saveConfig()`; add `--from-env` flag to save from env vars without prompting
  - [x] 2.8 Implement `admp config show` — prints resolved config, masking `secret_key` to first 8 chars + `...`
  - [x] 2.9 Implement `admp config set <key> <value>` — loads existing config, sets the key, saves
  - [x] 2.10 Write unit tests in `cli/src/config.test.ts` covering: load missing file returns `{}`, save creates file with mode 0600, resolveConfig env override, requireConfig throws on missing field

- [x] 3.0 Implement HTTP Signature auth module
  - [x] 3.1 Create `cli/src/auth.ts` — copy the `signRequest` function logic from `src/utils/crypto.js` (do not import — keep CLI standalone). Include `toBase64`, `fromBase64`, and `signRequest` as local functions.
  - [x] 3.2 Implement `buildAuthHeaders(method: string, path: string, host: string, secretKey: string, agentId: string): Record<string, string>` — returns `{ Date, Signature }` headers ready to merge into a fetch call
  - [x] 3.3 Implement `signEnvelope(envelope: object, secretKey: string, agentId: string): object` — adds `signature` field to a message envelope using the message-level signing format from `src/utils/crypto.js`
  - [x] 3.4 Write unit tests in `cli/src/auth.test.ts` covering: `buildAuthHeaders` produces valid Signature header format (keyId, algorithm, headers, signature fields present), `signEnvelope` adds signature field, roundtrip sign+verify using tweetnacl

- [ ] 4.0 Implement HTTP client and core messaging commands
  - [ ] 4.1 Create `cli/src/client.ts` — `AdmpClient` class with constructor `(config: ResolvedConfig)` and a private `request(method, path, body?, useApiKey?)` method that: sets `Content-Type`, adds `Date` header, adds `Signature` header via `buildAuthHeaders` (or `X-Api-Key` when `useApiKey` is true), calls `fetch`, throws `AdmpError` on non-2xx
  - [ ] 4.2 Add `AdmpError` class to `cli/src/client.ts` with `code: string`, `message: string`, `status: number`
  - [ ] 4.3 Create `cli/src/output.ts` with: `success(msg, data?)` (green prefix, pretty JSON if data), `warn(msg)` (yellow), `error(msg, code?)` (red to stderr), `json(data)` (raw JSON.stringify to stdout), `printMessage(envelope)` (formatted message view), `isJsonMode(): boolean` (checks `--json` flag or `ADMP_JSON=1`)
  - [ ] 4.4 Implement `admp register` in `cli/src/commands/register.ts` — POST `/api/agents/register`, save returned `agent_id` and `secret_key` to config, print agent_id + DID + registration_mode + ⚠ warning if secret_key present
  - [ ] 4.5 Implement `admp deregister` — prompt "Are you sure? (y/N)", DELETE `/api/agents/:agentId`, clear agent_id and secret_key from config
  - [ ] 4.6 Implement `admp send` with flags `--to`, `--subject`, `--body`, `--type`, `--correlation-id`, `--ttl`, `--ephemeral`; parse `@file.json` body syntax; sign envelope; POST to `/api/agents/:to/messages` with API key auth; print `message_id` and `status`
  - [ ] 4.7 Implement `admp pull` with optional `--timeout` flag; POST `/api/agents/:agentId/inbox/pull` with HTTP Signature auth; print "Inbox empty" on 204; pretty-print envelope on success including `message_id`, `lease_until`, `attempts`
  - [ ] 4.8 Implement `admp ack <message-id>` with optional `--result <json>`; POST `/api/agents/:agentId/messages/:messageId/ack` with HTTP Signature auth
  - [ ] 4.9 Implement `admp nack <message-id>` with optional `--extend <seconds>` and `--requeue` flag
  - [ ] 4.10 Implement `admp reply <message-id>` — fetch original message status to get `from` for the `to` field, then POST a correlated reply signed with HTTP Signature
  - [ ] 4.11 Implement `admp status <message-id>` — GET `/api/messages/:messageId/status` with API key auth; print status, timestamps
  - [ ] 4.12 Implement `admp inbox stats` — GET `/api/agents/:agentId/inbox/stats` with HTTP Signature auth; print queued, leased, total counts

- [ ] 5.0 Implement agent management commands
  - [ ] 5.1 Implement `admp heartbeat` with optional `--metadata <json>`; POST `/api/agents/:agentId/heartbeat`; print confirmation with timestamp
  - [ ] 5.2 Implement `admp rotate-key --seed <hex>` — POST `/api/agents/:agentId/rotate-key`, update `secret_key` in config with returned new key, print ⚠ warning to save new key
  - [ ] 5.3 Implement `admp webhook set --url <url> --secret <secret>` — POST `/api/agents/:agentId/webhook`
  - [ ] 5.4 Implement `admp webhook get` — GET `/api/agents/:agentId/webhook`; print url and masked secret
  - [ ] 5.5 Implement `admp webhook delete` — DELETE `/api/agents/:agentId/webhook` after confirmation prompt

- [ ] 6.0 Implement groups commands
  - [ ] 6.1 Implement `admp groups create --name <name> --access <open|key-protected|invite>` — POST `/api/groups`; print group_id
  - [ ] 6.2 Implement `admp groups list` — GET `/api/agents/:agentId/groups`; print table of group_id, name, role, member_count
  - [ ] 6.3 Implement `admp groups join <group-id> --key <key>` — POST `/api/groups/:groupId/join`
  - [ ] 6.4 Implement `admp groups leave <group-id>` — POST `/api/groups/:groupId/leave` after confirmation
  - [ ] 6.5 Implement `admp groups send <group-id> --subject <subject> --body <json>` — POST `/api/groups/:groupId/messages`
  - [ ] 6.6 Implement `admp groups messages <group-id> --limit <n>` — GET `/api/groups/:groupId/messages`; print message table with from, subject, timestamp

- [ ] 7.0 Implement outbox commands
  - [ ] 7.1 Implement `admp outbox domain set --domain <domain>` — POST `/api/agents/:agentId/outbox/domain`
  - [ ] 7.2 Implement `admp outbox domain verify` — POST `/api/agents/:agentId/outbox/domain/verify`; print DNS verification status
  - [ ] 7.3 Implement `admp outbox domain delete` — DELETE `/api/agents/:agentId/outbox/domain` after confirmation
  - [ ] 7.4 Implement `admp outbox send --to <email> --subject <subject> --body <text> --html <html> --from-name <name>` — POST `/api/agents/:agentId/outbox/send`; print message_id and status
  - [ ] 7.5 Implement `admp outbox messages --status <status> --limit <n>` — GET `/api/agents/:agentId/outbox/messages`; print table with recipient, subject, status, timestamp

- [ ] 8.0 Output formatting, error handling, and UX polish
  - [ ] 8.1 Add global `--json` option to root commander program; update all commands to check `isJsonMode()` and output raw JSON instead of formatted output
  - [ ] 8.2 Add global error handler: catch `AdmpError` and print `error.code: error.message` to stderr then `process.exit(1)`; catch network errors with friendly "Could not connect to <base_url>" message
  - [ ] 8.3 Ensure all commands have `.description()` and `.addHelpText('after', 'Example: ...')` with a concrete usage example
  - [ ] 8.4 Add `--version` to root program reading from `package.json`
  - [ ] 8.5 Respect `NO_COLOR=1` env var in `cli/src/output.ts` — strip ANSI codes when set
  - [ ] 8.6 Add `admp agent get` command to GET `/api/agents/:agentId` and display agent details (useful for debugging config)
  - [ ] 8.7 Test all `--help` outputs manually for clarity and accuracy; fix any misleading descriptions

- [ ] 9.0 Tests
  - [ ] 9.1 Complete unit tests in `cli/src/config.test.ts` (see task 2.10)
  - [ ] 9.2 Complete unit tests in `cli/src/auth.test.ts` (see task 3.4)
  - [ ] 9.3 Create `cli/test/integration.test.ts` — start a local ADMP server (or use `ADMP_BASE_URL` env pointing to one), then test the full flow: register → send → pull → ack
  - [ ] 9.4 Add integration test for `rotate-key`: register with seed, rotate, verify old key no longer works and new key does
  - [ ] 9.5 Add integration test for groups: create group → join → send group message → list messages
  - [ ] 9.6 Add test for `--json` flag: verify every command outputs valid parseable JSON when `--json` is set
  - [ ] 9.7 Run `bun test` in `cli/` and fix all failures before marking this task complete

- [ ] 10.0 Build and publish configuration
  - [ ] 10.1 Verify `bun build cli/src/index.ts --target node --outfile cli/dist/index.js` produces a standalone Node.js file
  - [ ] 10.2 Test the built binary: `node cli/bin/admp.js --help` and `node cli/bin/admp.js register --help`
  - [ ] 10.3 Test on Node.js 18 and Node.js 20 (use `nvm use 18` / `nvm use 20`)
  - [ ] 10.4 Add `cli/.npmignore` to exclude `src/`, `test/`, `tsconfig.json`, `bun.lock` from published package
  - [ ] 10.5 Add `"files": ["dist/", "bin/", "README.md"]` to `cli/package.json`
  - [ ] 10.6 Write `cli/README.md` with: installation (`npm install -g @agentdispatch/cli`), quick start (register + send + pull + ack), all commands with examples, config reference, environment variables table
  - [ ] 10.7 Run `npm pack --dry-run` in `cli/` and verify the package contents are correct (no src, no secrets, correct entry point)

- [ ] 11.0 Write `admp-client` skill
  - [ ] 11.1 Create `skill/admp-client/` directory
  - [ ] 11.2 Write `skill/admp-client/SKILL.md` with the following sections (total ≤400 lines):
    - **What is ADMP** (3 sentences: universal inbox, at-least-once delivery, Ed25519 auth)
    - **Authentication** — API key header (`X-Api-Key`), HTTP Signature construction with `printf` signing string example (JS + curl), signing string format `(request-target)\nhost\ndate`
    - **Quick Start** — register (curl), send a message (curl with `X-Api-Key`), pull (curl with Signature), ack (curl with Signature)
    - **Message Lifecycle** — `queued → delivered → leased → acked` / `leased → nacked → queued`
    - **Message Envelope** — JSON schema with all fields annotated
    - **All Endpoints** — compact table: method, path, auth type, one-line description
    - **Key Error Codes** — table of the 15 most common codes with HTTP status, retryable, fix hint
    - **Best Practices for AI Agents** — store secret_key immediately, use import mode in production, always ack/nack, set TTL on messages, use correlation_id for request/response pairs, check lease_until before processing
    - **JavaScript Helper** — 30-line self-contained `signRequest` function using `tweetnacl` that an agent can paste into their project
  - [ ] 11.3 Verify `skill/admp-client/SKILL.md` is ≤400 lines with `wc -l skill/admp-client/SKILL.md`
  - [ ] 11.4 Write `skill/admp-client/install.sh` — POSIX shell script that:
    - Detects which skill directories exist (`.claude/skills/`, `.gemini/skills/`, `.codex/skills/`)
    - Creates `admp-client/` subdirectory in each found dir
    - Copies `SKILL.md` into each
    - Prints confirmation: "Installed admp-client skill to: .claude/skills/admp-client/"
    - Exits 0 on success, prints error and exits 1 if no skill directories found
  - [ ] 11.5 Make `install.sh` executable (`chmod +x skill/admp-client/install.sh`) and test it in a temp directory with `.claude/skills/` present
  - [ ] 11.6 Test skill by reading only `SKILL.md` and verifying you can write a working register + send + pull + ack sequence from it alone (no other docs)
