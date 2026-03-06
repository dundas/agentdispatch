# ADMP Email Ingestion Worker

Cloudflare Worker that receives inbound emails via Cloudflare Email Routing and forwards them to the ADMP server inbox.

## How It Works

1. Cloudflare Email Routing delivers all `*@agentdispatch.io` mail to this Worker via a catch-all rule.
2. The Worker extracts the agent ID from the recipient address: the local part of `{agentId}@agentdispatch.io` is the agent ID verbatim.
3. It reads the raw MIME, parses it with `postal-mime`, and POSTs the structured payload to the ADMP server.
4. If the agent is not found (404), the email is rejected with an SMTP `Unknown recipient` error.

## Prerequisites

- A Cloudflare account with the `agentdispatch.io` zone
- Cloudflare Email Routing enabled on the zone
- [Wrangler CLI](https://developers.cloudflare.com/workers/wrangler/) installed: `npm install -g wrangler`
- An ADMP server reachable from the internet

## Setup

### 1. Configure Cloudflare Email Routing

In the Cloudflare dashboard for `agentdispatch.io`:
- Go to **Email** → **Email Routing** → **Routing Rules**
- Enable Email Routing and verify the zone
- Add a **Catch-all** rule: Action = **Send to Worker** → `admp-email-ingestion`

### 2. Set Required Secrets

```bash
# Base URL of your ADMP server (no trailing slash)
wrangler secret put ADMP_URL
# → https://api.yourdomain.com

# Shared secret — must match INBOUND_EMAIL_SECRET on the ADMP server
wrangler secret put INBOUND_EMAIL_SECRET
```

### 3. Deploy

```bash
bun install
wrangler deploy
```

### Local Development

```bash
wrangler dev
```

Note: Email event testing locally requires [wrangler email test](https://developers.cloudflare.com/email-routing/email-workers/runtime-api/) or direct invocation via the Cloudflare dashboard.

## Email Address Format

Every agent's email address is `{agentId}@agentdispatch.io`. The local part is the agent ID verbatim — no namespace or tenant prefix is encoded in the address.

| Email | agentId |
|-------|---------|
| `alice@agentdispatch.io` | `alice` |
| `alice.v2@agentdispatch.io` | `alice.v2` |
| `my-support-bot@agentdispatch.io` | `my-support-bot` |

Tenant/org grouping is an internal concept and is never part of the address.

## Environment Variables

| Variable | How to Set | Description |
|----------|-----------|-------------|
| `ADMP_URL` | `wrangler secret put` | ADMP server base URL |
| `INBOUND_EMAIL_SECRET` | `wrangler secret put` | Authenticates Worker → ADMP requests |
| `INBOUND_EMAIL_DOMAIN` | `wrangler.toml [vars]` | Domain to strip from recipient addresses (default: `agentdispatch.io`) |
