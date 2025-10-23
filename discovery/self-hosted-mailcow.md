awesome — here’s the **ideal self-hosted setup** for Agent Dispatch with **Mailcow** as your SMTP edge. This design keeps Mailcow stock (no fork), adds one **Bridge** container, and lands both SMTP and HTTP traffic into the **same Postgres** (single source of truth).

---

# 0) What you get

* Clean separation: Mailcow handles **SMTP**, spam, DKIM/SPF/DMARC; your **Bridge** handles agent auth/policy and enqueue.
* One datastore: **PostgreSQL** for messages, policy, keyring.
* Identical semantics for **HTTP** and **SMTP** ingress.
* Rollback-safe: only a Postfix **transport map** and an extra container.

---

# 1) High-level architecture

```
[ Internet SMTP ]
        │
        ▼
┌───────────────────────┐
│   Mailcow (Postfix)   │  ← Rspamd, DKIM/SPF/DMARC, TLS
└──────────┬────────────┘
           │ (transport: agents.<domain>)
           ▼  LMTP over Docker network
┌───────────────────────┐
│  ADMP SMTP Bridge     │  ← DKIM check (optional trust A-R), verify X-Agent-*, policy
│   (LMTP receiver)     │  → enqueue_message(channel='smtp')
└──────────┬────────────┘
           │
           ▼
┌───────────────────────┐          ┌───────────────────────┐
│  ADMP HTTP API        │  ◀───▶   │  Agents / SDKs        │
│  (internal HTTPS)     │          │  (send/pull/ack/reply)│
└──────────┬────────────┘          └───────────────────────┘
           │
           ▼
┌───────────────────────┐
│  PostgreSQL (ADMP DB) │  ← single queue, status, logs, policy, keys
└───────────────────────┘
```

**Optional:** DSN/Webhook listener updates SMTP delivery → `sent/delivered/failed`.

---

# 2) DNS & identity

* **Subdomain for agents:** `agents.example.com`

  * **MX** → Mailcow (your public IP/host).
  * **DKIM**: Mailcow manages key; publish selector TXT.
  * **SPF/DMARC** aligned with Mailcow.
* **Agent public keys:** publish **JWKS** and/or **DNS TXT** for partners:

  * `https://example.com/.well-known/agent-keys.json`
  * `_agentkeys.example.com TXT "kid=example.com/key-2025-10-01; x=<base64pub>"`

---

# 3) Mailcow wiring (no fork)

## 3.1 Add the Bridge container

Create `docker-compose.override.yml` in Mailcow root:

```yaml
services:
  admp-bridge:
    image: ghcr.io/agent-dispatch/smtp-bridge:latest
    restart: unless-stopped
    environment:
      - DATABASE_URL=postgres://dispatch:***@dispatch-db:5432/dispatch
      - BRIDGE_LMTP_ADDR=0.0.0.0:2526
      - ENFORCE_DKIM=pass
      - ALLOW_RCPT_DOMAIN=agents.example.com
      - JWKS_CACHE_TTL=300
    networks:
      - mailcow-network
    expose:
      - "2526"

networks:
  mailcow-network:
    external: true
```

> If your Dispatch DB is separate, add a network or route appropriately.

## 3.2 Postfix transport map for the agents subdomain

Mount an extra Postfix config (Mailcow supports this):

`data/conf/postfix/extra.cf`

```
transport_maps = hash:/opt/postfix/conf/transport
```

`data/conf/postfix/transport`

```
agents.example.com   lmtp:[admp-bridge]:2526
```

Then in the postfix container:

```
postmap /opt/postfix/conf/transport
postfix reload
```

Result: only mail to `*@agents.example.com` is handed to the Bridge via **LMTP**.

---

# 4) Bridge behavior (golden path)

1. Accept LMTP from Postfix (local network only).
2. Read full **raw MIME** (needed for DKIM).
3. Validate:

   * **Domain auth**: DKIM/SPF/DMARC = pass

     * Either re-verify DKIM or trust `Authentication-Results:` from Rspamd (recommended: enforce `dkim=pass`).
   * **Agent auth**: `X-Agent-*` headers

     * `X-Agent-ID`, `X-Agent-KID`, `X-Agent-Timestamp`, `X-Agent-Signature` (Ed25519)
     * Check timestamp ±5 min; fetch public key via JWKS/DNS; verify signature base string.
4. Parse JSON body → ADMP envelope; run **policy engine** (allow from→to, type/subject, size).
5. Compute **source_fingerprint** (sha256 of canonical envelope) for dedupe.
6. Call `enqueue_message(envelope, 'smtp', idempotency_key?, source_fingerprint)` → **Postgres**.
7. On success, return **250 2.0.0 OK** (with message-id in reply). On policy/signature issues:

   * **550** permanent (reject).
   * **451** temporary (if DB down), so Postfix retries.

---

# 5) HTTP API (internal agents)

* Hosted as a separate container/service (behind your reverse proxy).
* Auth: **Bearer/JWT** or **HMAC** (`X-Agent-Id`, `X-Timestamp`, `X-Signature`).
* Endpoints: `send`, `inbox/pull`, `ack`, `nack?extend`, `reply`, `status`.
* On `send`, server **directly inserts** with `status='delivered'` (DB commit = delivered).

---

# 6) Unified datastore (PostgreSQL)

Key tables (minimal):

```sql
create type msg_status as enum ('queued','sent','delivered','leased','acked','failed','dead');

create table agent (
  id text primary key,
  org_domain text,
  token_hash text,
  created_at timestamptz default now()
);

create table message (
  id uuid primary key default gen_random_uuid(),
  channel text not null,                     -- 'smtp' | 'http'
  to_agent_id text not null references agent(id),
  from_agent text,
  subject text,
  type text,
  body jsonb not null,
  headers jsonb default '{}',
  correlation_id text,
  idempotency_key text,
  status msg_status default 'queued',
  lease_until timestamptz,
  attempts int default 0,
  ttl_sec int default 86400,
  created_at timestamptz default now(),
  delivered_at timestamptz,
  acked_at timestamptz,
  reply jsonb,
  delivery_log jsonb default '[]'::jsonb,    -- DSNs, decisions
  source_fingerprint text                    -- cross-channel dedupe
);

create unique index on message (to_agent_id, idempotency_key) where idempotency_key is not null;
create index on message (to_agent_id, status, lease_until);
create index on message (correlation_id);
create index on message (channel);
```

**Single `enqueue_message(...)`** function is called by both the HTTP API and SMTP Bridge.

---

# 7) DSN / Delivery status (optional but recommended)

* Enable provider DSNs or parse Postfix bounce/relay notifications.
* Map:

  * **2xx accept** → `sent`
  * **DSN 2.0.0** → `delivered`
  * **5.x.x** → `failed`
  * **timeout** → `failed: timeout`
* Append to `delivery_log` and update `status`.

---

# 8) Security model

* **TLS** inbound (Mailcow already enforces).
* **DKIM pass** required for `@agents.*`.
* **Ed25519 `X-Agent-Signature`** mandatory; keys discovered via JWKS/DNS.
* **Replay window**: ±5 minutes on `X-Agent-Timestamp`.
* **Policy**: allow from→to pairs, subject/type regex, quotas, size limit.
* **Rate limit** in Rspamd/Postfix for `@agents.*` to bound floods.

---

# 9) Monitoring & ops

**Mailcow**

* Rspamd UI: DKIM/SPF/DMARC pass rates.
* Postfix logs: bounces, queue depth.

**Bridge/API**

* Prometheus `/metrics`:

  * `admp_enqueue_total{channel=...}`
  * `admp_policy_denied_total`
  * `admp_signature_fail_total`
  * `admp_inbox_depth{agent=...}`
  * `admp_lease_expired_total`
* Structured logs with `message_id`, `correlation_id`, `channel`, `event`.
* OpenTelemetry tracing for `enqueue`/`pull`/`ack`.

**Alerting**

* DSN failure rate ↑, enqueue latency ↑, lease reclaim spikes, DB connection errors.

---

# 10) Backup & resilience

* Postgres PITR (WAL archiving), daily snapshots.
* Bridge/API stateless; scale out horizontally.
* Postfix queues give natural backpressure if DB is down (use **451** tempfail).
* Health checks on Bridge/API; readiness gates DB connectivity.

---

# 11) Scaling

* **Throughput**: Split Bridge and API onto separate nodes; LMTP is lightweight.
* **DB**: Partition `message` by time or `to_agent_id` at higher volumes; index carefully.
* **Sharding**: Use multiple Dispatch DB clusters by tenant or domain, keyed in policy.
* **Caching**: JWKS/DNS key cache with TTL; warm by allowlist.

---

# 12) Deployment steps (punch-list)

1. **DNS**: MX for `agents.example.com`; publish JWKS/keys.
2. **Mailcow**: add transport map, reload Postfix.
3. **Bridge**: deploy container; restrict LMTP to Mailcow network.
4. **DB**: run migrations.
5. **API**: deploy internal HTTPS; configure agent creds.
6. **Policy**: seed allowlists (from→to, type/subject).
7. **Test**: send signed email with JSON to `storage.pg@agents.example.com`; verify DB row + status.
8. **Agents**: point SDKs at HTTP API; verify `send/pull/ack/reply`.
9. **Observability**: wire Prometheus + alerts.

---

# 13) Failure modes & responses

| Symptom                     | Likely cause                | Action                                           |
| --------------------------- | --------------------------- | ------------------------------------------------ |
| Postfix tempfailing to LMTP | Bridge down / DB down       | Bring Bridge/API up; 451 lets mail retry         |
| Many policy denials         | Bad from→to or subject/type | Update policy; audit headers                     |
| Signature fail spike        | Wrong KID/rotated key       | Refresh JWKS/DNS; permit overlap window          |
| DSN rate failures           | Partner MX rejects          | Check SPF/DKIM/DMARC alignment; size limits      |
| Lease orphaning             | Agent crash                 | Ensure reclaim job runs; tune visibility timeout |

---

# 14) Optional: Rspamd postfilter path

If you prefer **no Postfix transport**, implement an Rspamd **Lua postfilter** that:

* Triggers only when RCPT matches `@agents.*`.
* Requires `dkim=pass`.
* Forwards raw or reconstructed MIME to your HTTP Bridge.
* If enqueue succeeds, set action `discard` (not delivered to mailbox) or accept and use Sieve to drop.

**Tradeoff:** fewer Postfix edits, but deeper Rspamd coupling.

---

# 15) Why this is “ideal”

* **Upgrade-safe**: Mailcow remains vanilla.
* **Auditable**: Every step logged (Mailcow + Bridge + DB).
* **Unified**: SMTP/HTTP treated identically after ingress.
* **Secure by default**: DKIM + Ed25519 + policy + TLS.
* **Scalable**: Stateless edge, durable core.
 