awesome—here’s exactly what you asked for: a clean **OpenAPI 3.1 spec** for the HTTP layer, plus a **sample inbound email webhook handler** for SES/Mailgun/Relayapp that (1) verifies **DKIM**, (2) validates the **X-Agent-*** headers and signature, and (3) calls a shared `enqueue_message` routine. I’ve included **Node (Express)** and **Python (FastAPI)** implementations.

---

# OpenAPI (v3.1) — ADMP HTTP Inbox

```yaml
openapi: 3.1.0
info:
  title: Agent Dispatch Messaging Protocol (ADMP) — HTTP Inbox API
  version: 1.0-draft
  description: >
    Core HTTP binding for ADMP. Provides per-agent inboxes and at-least-once delivery semantics.
    Supports Bearer (JWT) or HMAC (X-Agent-* headers) authentication.

servers:
  - url: https://dispatch.example.com

security:
  - BearerAuth: []
  - HmacAuth: []

paths:
  /v1/agents/{agentId}/messages:
    post:
      summary: SEND — enqueue a message into the target agent's inbox
      operationId: sendMessage
      parameters:
        - $ref: '#/components/parameters/AgentId'
      requestBody:
        required: true
        content:
          application/json:
            schema: { $ref: '#/components/schemas/MessageEnvelope' }
      responses:
        '201':
          description: Created
          content:
            application/json:
              schema: { $ref: '#/components/schemas/SendResponse' }
        '403': { $ref: '#/components/responses/Forbidden' }
        '409': { $ref: '#/components/responses/Conflict' }
        '413': { $ref: '#/components/responses/PayloadTooLarge' }
        '422': { $ref: '#/components/responses/Unprocessable' }

  /v1/agents/{agentId}/inbox/pull:
    post:
      summary: PULL — lease one available message
      operationId: pullMessage
      parameters:
        - $ref: '#/components/parameters/AgentId'
        - name: visibility_timeout
          in: query
          required: false
          schema: { type: integer, default: 60, minimum: 1, maximum: 3600 }
      responses:
        '200':
          description: Message leased
          content:
            application/json:
              schema: { $ref: '#/components/schemas/MessageRecord' }
        '204':
          description: No content (inbox empty)
        '403': { $ref: '#/components/responses/Forbidden' }

  /v1/agents/{agentId}/messages/{messageId}/ack:
    post:
      summary: ACK — acknowledge successful processing (deletes from inbox)
      operationId: ackMessage
      parameters:
        - $ref: '#/components/parameters/AgentId'
        - $ref: '#/components/parameters/MessageId'
      responses:
        '200': { description: Acked }
        '404': { $ref: '#/components/responses/NotFound' }

  /v1/agents/{agentId}/messages/{messageId}/nack:
    post:
      summary: NACK — reject or extend lease
      operationId: nackMessage
      parameters:
        - $ref: '#/components/parameters/AgentId'
        - $ref: '#/components/parameters/MessageId'
        - name: extend
          in: query
          required: false
          description: Seconds to extend the current lease (if provided)
          schema: { type: integer, minimum: 1, maximum: 3600 }
      responses:
        '200': { description: Nacked or lease extended }
        '404': { $ref: '#/components/responses/NotFound' }

  /v1/agents/{agentId}/messages/{messageId}/reply:
    post:
      summary: REPLY — send a correlated response to the original sender
      operationId: replyMessage
      parameters:
        - $ref: '#/components/parameters/AgentId'
        - $ref: '#/components/parameters/MessageId'
      requestBody:
        required: true
        content:
          application/json:
            schema:
              oneOf:
                - $ref: '#/components/schemas/ReplySuccess'
                - $ref: '#/components/schemas/ReplyError'
      responses:
        '200': { description: Reply accepted }
        '404': { $ref: '#/components/responses/NotFound' }

  /v1/messages/{messageId}/status:
    get:
      summary: Query message delivery/processing status
      operationId: getMessageStatus
      parameters:
        - $ref: '#/components/parameters/MessageId'
      responses:
        '200':
          description: Status
          content:
            application/json:
              schema: { $ref: '#/components/schemas/Status' }
        '404': { $ref: '#/components/responses/NotFound' }

  /v1/agents/{agentId}/inbox/stats:
    get:
      summary: Inbox statistics
      operationId: inboxStats
      parameters:
        - $ref: '#/components/parameters/AgentId'
      responses:
        '200':
          description: Stats
          content:
            application/json:
              schema: { $ref: '#/components/schemas/InboxStats' }

  /v1/agents/{agentId}/inbox/reclaim:
    post:
      summary: Reclaim expired leases back to ready queue
      operationId: reclaimLeases
      parameters:
        - $ref: '#/components/parameters/AgentId'
      responses:
        '200': { description: Reclaim complete }

components:
  securitySchemes:
    BearerAuth:
      type: http
      scheme: bearer
      bearerFormat: JWT
    HmacAuth:
      type: apiKey
      in: header
      name: X-Agent-Id
      description: >
        HMAC auth via headers:
        - X-Agent-Id
        - X-Timestamp (ISO8601)
        - X-Signature (base64 HMAC-SHA256 over canonical body)
        Server enforces ±5m clock skew; shared secret per agent.

  parameters:
    AgentId:
      name: agentId
      in: path
      required: true
      schema: { type: string, pattern: '^[a-zA-Z0-9._-]+$' }
    MessageId:
      name: messageId
      in: path
      required: true
      schema: { type: string, format: uuid }

  schemas:
    MessageEnvelope:
      type: object
      required: [version, id, type, from, to, subject, body, timestamp]
      properties:
        version: { type: string, enum: ['1.0'] }
        id: { type: string, format: uuid }
        type: { type: string, enum: ['task.request','task.result','task.error','event'] }
        from: { type: string, example: 'agent://auth.backend' }
        to: { type: string, example: 'agent://storage.pg' }
        subject: { type: string, example: 'create_user' }
        correlation_id: { type: string }
        headers: { type: object, additionalProperties: true }
        body: { type: object, additionalProperties: true }
        ttl_sec: { type: integer, default: 86400 }
        timestamp: { type: string, format: date-time }
        signature:
          type: object
          required: [alg, kid, sig]
          properties:
            alg: { type: string, enum: ['ed25519','hmac-sha256'] }
            kid: { type: string }
            sig: { type: string, description: 'base64 signature' }
    MessageRecord:
      allOf:
        - $ref: '#/components/schemas/MessageEnvelope'
        - type: object
          properties:
            status:
              type: string
              enum: ['queued','sent','delivered','leased','acked','failed','dead']
            lease_until: { type: string, format: date-time, nullable: true }
            attempts: { type: integer }
            delivered_at: { type: string, format: date-time, nullable: true }
            acked_at: { type: string, format: date-time, nullable: true }
            reply: { type: object, nullable: true, additionalProperties: true }
    ReplySuccess:
      type: object
      required: [result]
      properties:
        result: { type: object, additionalProperties: true }
        error: { type: 'null' }
    ReplyError:
      type: object
      required: [error]
      properties:
        result: { type: 'null' }
        error:
          type: object
          required: [code, message]
          properties:
            code: { type: string }
            message: { type: string }
            details: { type: object, additionalProperties: true }
    SendResponse:
      type: object
      properties:
        message_id: { type: string, format: uuid }
    Status:
      type: object
      properties:
        status:
          type: string
          enum: ['queued','sent','delivered','leased','acked','failed','dead']
        delivered_at: { type: string, format: date-time, nullable: true }
        acked_at: { type: string, format: date-time, nullable: true }
    InboxStats:
      type: object
      properties:
        ready: { type: integer }
        leased: { type: integer }
        dead: { type: integer }
        oldest_age_sec: { type: integer }

  responses:
    Forbidden:
      description: Forbidden (policy/auth)
      content:
        application/json: { schema: { $ref: '#/components/schemas/Error' } }
    Conflict:
      description: Duplicate idempotency key
      content:
        application/json: { schema: { $ref: '#/components/schemas/Error' } }
    PayloadTooLarge:
      description: Payload too large
      content:
        application/json: { schema: { $ref: '#/components/schemas/Error' } }
    Unprocessable:
      description: Unprocessable (schema)
      content:
        application/json: { schema: { $ref: '#/components/schemas/Error' } }
    NotFound:
      description: Not found
      content:
        application/json: { schema: { $ref: '#/components/schemas/Error' } }

    Error:
      type: object
      properties:
        error: { type: string }
        message: { type: string }
```

---

# Inbound Email Webhook → enqueue_message

Below are two fully worked handlers:

* **Node (Express)**: expects raw MIME from SES/Mailgun/Relayapp webhook; verifies **DKIM**, validates **X-Agent-*** signature (Ed25519/HMAC), and inserts via a shared `enqueueMessage()`.

* **Python (FastAPI)**: equivalent flow, using `dkim` lib.

> Implementation notes:
>
> * Providers can deliver either the **raw MIME** or a parsed JSON payload. To **verify DKIM**, you must have the **raw MIME** (headers + body) that the recipient server received.
> * For Ed25519 verification of `X-Agent-Signature`, you’ll resolve the public key via **JWKS** or **DNS TXT** (your `fetchAgentPublicKey()` stub shows both options).
> * The DB insert shown uses PostgreSQL; swap for your datastore as needed.

---

## Node.js (Express)

```ts
// package.json deps (suggested):
// "express", "body-parser", "tweetnacl", "node-fetch", "mailparser", "dkim-verifier", "pg", "pino"

// Run server with: node server.js (or ts-node if TS)

import express from 'express';
import { simpleParser } from 'mailparser';
import { verify as verifyDKIM } from 'dkim-verifier'; // verifies raw MIME DKIM signatures
import nacl from 'tweetnacl';
import { createHash } from 'crypto';
import fetch from 'node-fetch';
import { Pool } from 'pg';
import pino from 'pino';

const app = express();
const log = pino();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

// 1) Get raw body for DKIM verification
app.use('/webhooks/inbound-email', express.raw({ type: '*/*', limit: '10mb' }));

// Shared: canonical hash + enqueue
function sha256Base64(buf: Buffer | string) {
  return createHash('sha256').update(buf).digest('base64');
}

async function enqueueMessage(envelope, channel, idempotencyKey, sourceFingerprint) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // De-dupe by idempotency_key if present
    if (idempotencyKey) {
      const dupe = await client.query(
        `select id from message where to_agent_id = $1 and idempotency_key = $2 limit 1`,
        [envelope.to.replace('agent://',''), idempotencyKey]
      );
      if (dupe.rowCount) {
        await client.query('COMMIT');
        return dupe.rows[0].id;
      }
    }

    // Optional dedupe by fingerprint within short window
    if (!idempotencyKey && sourceFingerprint) {
      const dupe2 = await client.query(
        `select id from message
         where to_agent_id = $1 and source_fingerprint = $2
           and created_at > now() - interval '10 minutes'
         limit 1`,
        [envelope.to.replace('agent://',''), sourceFingerprint]
      );
      if (dupe2.rowCount) {
        await client.query('COMMIT');
        return dupe2.rows[0].id;
      }
    }

    const status = (channel === 'http') ? 'delivered' : 'sent';
    const insert = await client.query(
      `insert into message
        (channel, to_agent_id, from_agent, subject, type, body, headers,
         correlation_id, status, idempotency_key, ttl_sec, source_fingerprint, delivered_at)
       values
        ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12, case when $9='delivered' then now() else null end)
       returning id`,
      [
        channel,
        envelope.to.replace('agent://',''),
        envelope.from.replace('agent://',''),
        envelope.subject,
        envelope.type,
        envelope.body,
        envelope.headers ?? {},
        envelope.correlation_id ?? null,
        status,
        idempotencyKey ?? null,
        envelope.ttl_sec ?? 86400,
        sourceFingerprint ?? null
      ]
    );

    await client.query('COMMIT');
    return insert.rows[0].id;
  } catch (e) {
    await pool.query('ROLLBACK');
    log.error(e, 'enqueue failed');
    throw e;
  } finally {
    client.release();
  }
}

// Resolve an agent public key (ed25519) via JWKS or DNS TXT
async function fetchAgentPublicKey(kid: string): Promise<Uint8Array> {
  // kid example: "partner.com/key-2025-10-01"
  const [domain] = kid.split('/');
  // Try HTTPS JWKS
  try {
    const jwksUrl = `https://${domain}/.well-known/agent-keys.json`;
    const res = await fetch(jwksUrl, { timeout: 5000 });
    if (res.ok) {
      const data = await res.json();
      const entry = data.keys?.find((k: any) => k.kid === kid && k.kty === 'OKP' && k.crv === 'Ed25519');
      if (entry && entry.x) {
        return Buffer.from(entry.x, 'base64'); // raw 32-byte pubkey (RFC8037)
      }
    }
  } catch {}
  // TODO: fallback DNS TXT _agentkeys.domain (parse to locate kid + base64 key)
  throw new Error('Public key not found for KID: ' + kid);
}

function verifyAgentSignature({ timestamp, bodyHashB64, from, to, correlationId, sigB64, pubKey }) {
  const base = `${timestamp}\n${bodyHashB64}\n${from}\n${to}\n${correlationId ?? ''}`;
  const msg = Buffer.from(base);
  const sig = Buffer.from(sigB64, 'base64');
  return nacl.sign.detached.verify(new Uint8Array(msg), new Uint8Array(sig), pubKey);
}

app.post('/webhooks/inbound-email', async (req, res) => {
  try {
    const rawMime = req.body; // Buffer

    // 1) Verify DKIM over the raw MIME
    const dkimResult = await verifyDKIM(rawMime);
    if (!dkimResult?.signatures?.some(s => s.verified)) {
      return res.status(400).json({ error: 'DKIM verification failed' });
    }

    // 2) Parse the email to extract JSON body + headers
    const parsed = await simpleParser(rawMime);
    const hdr = (name: string) => parsed.headers.get(name.toLowerCase()) as string | undefined;

    // Required custom headers
    const xAgentId = hdr('x-agent-id');
    const xKid = hdr('x-agent-kid');
    const xSig = hdr('x-agent-signature');
    const xTs = hdr('x-agent-timestamp');
    const xCorrelation = hdr('x-agent-correlation');
    if (!xAgentId || !xKid || !xSig || !xTs) {
      return res.status(400).json({ error: 'Missing X-Agent-* headers' });
    }

    // Clock skew check (±5 minutes)
    const now = Date.now();
    const ts = Date.parse(xTs);
    if (!Number.isFinite(ts) || Math.abs(now - ts) > 5 * 60 * 1000) {
      return res.status(400).json({ error: 'Timestamp outside allowed window' });
    }

    // 3) Extract the JSON ADMP envelope from body
    // Prefer application/json part; otherwise try text
    let envelope: any;
    const jsonPart = parsed.attachments?.find(a => a.contentType === 'application/json');
    if (jsonPart) {
      envelope = JSON.parse(jsonPart.content.toString('utf8'));
    } else if (parsed.text) {
      envelope = JSON.parse(parsed.text);
    } else if (parsed.html) {
      // As a last resort, strip tags or use a comment block; better to require JSON part
      return res.status(400).json({ error: 'No JSON body found' });
    }

    // 4) Verify X-Agent-Signature (Ed25519) over canonical base string
    const bodyHashB64 = sha256Base64(Buffer.from(JSON.stringify(envelope.body ?? {})));
    const pubKey = await fetchAgentPublicKey(envelope.signature?.kid || xKid);
    const ok = verifyAgentSignature({
      timestamp: xTs,
      bodyHashB64,
      from: envelope.from,
      to: envelope.to,
      correlationId: envelope.correlation_id,
      sigB64: envelope.signature?.sig || xSig,
      pubKey
    });
    if (!ok) {
      return res.status(400).json({ error: 'X-Agent-Signature invalid' });
    }

    // 5) Compute fingerprint for cross-channel dedupe
    const sourceFingerprint = sha256Base64(Buffer.from(JSON.stringify(envelope)));

    // 6) Policy checks (example placeholder)
    // TODO: verify allow(from -> to), subject/type regex, max size, quotas
    // if (!policyAllows(envelope)) return res.status(403).json({ error: 'Policy denied' });

    // 7) Enqueue (channel='smtp')
    const id = await enqueueMessage(envelope, 'smtp', /*idempotencyKey*/ null, sourceFingerprint);

    // 8) Respond OK to provider (so they don't retry); DSN updates will come later
    return res.status(200).json({ ok: true, message_id: id });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'server_error' });
  }
});

app.listen(process.env.PORT || 8080, () => {
  log.info('Inbound email webhook listening');
});
```

---

## Python (FastAPI)

```python
# deps (suggested):
# fastapi, uvicorn, dkim, pydantic, psycopg[binary], httpx, python-dateutil

from fastapi import FastAPI, Request, Response, HTTPException
from pydantic import BaseModel, Field
from typing import Optional, Dict, Any
import base64, hashlib, json, os, asyncpg
import dkim
import httpx
from datetime import datetime, timezone
from dateutil.parser import isoparse

app = FastAPI()
DB_URL = os.getenv("DATABASE_URL")

async def db():
  return await asyncpg.create_pool(dsn=DB_URL, min_size=1, max_size=5)

async def enqueue_message(conn, envelope: Dict[str, Any], channel: str, idempotency_key: Optional[str], source_fingerprint: Optional[str]):
  # idempotency by (to_agent_id, idempotency_key)
  to_agent_id = envelope["to"].replace("agent://","")
  if idempotency_key:
    r = await conn.fetchrow("select id from message where to_agent_id=$1 and idempotency_key=$2 limit 1", to_agent_id, idempotency_key)
    if r:
      return r["id"]

  if source_fingerprint:
    r2 = await conn.fetchrow("""
      select id from message
       where to_agent_id=$1 and source_fingerprint=$2
         and created_at > now() - interval '10 minutes'
       limit 1
    """, to_agent_id, source_fingerprint)
    if r2:
      return r2["id"]

  status = 'delivered' if channel=='http' else 'sent'
  row = await conn.fetchrow("""
    insert into message
      (channel, to_agent_id, from_agent, subject, type, body, headers,
       correlation_id, status, idempotency_key, ttl_sec, source_fingerprint, delivered_at)
    values
      ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12, case when $9='delivered' then now() else null end)
    returning id
  """,
    channel,
    to_agent_id,
    envelope["from"].replace("agent://",""),
    envelope["subject"],
    envelope["type"],
    json.dumps(envelope.get("body", {})),
    json.dumps(envelope.get("headers", {})),
    envelope.get("correlation_id"),
    status,
    idempotency_key,
    envelope.get("ttl_sec", 86400),
    source_fingerprint
  )
  return row["id"]

def sha256_b64(buf: bytes) -> str:
  return base64.b64encode(hashlib.sha256(buf).digest()).decode()

async def fetch_agent_public_key(kid: str) -> bytes:
  # kid like "partner.com/key-2025-10-01"
  domain = kid.split('/')[0]
  # Try JWKS-ish JSON
  url = f"https://{domain}/.well-known/agent-keys.json"
  try:
    async with httpx.AsyncClient(timeout=5.0) as client:
      r = await client.get(url)
      if r.status_code == 200:
        data = r.json()
        for k in data.get("keys", []):
          if k.get("kid")==kid and k.get("kty")=="OKP" and k.get("crv")=="Ed25519":
            return base64.b64decode(k["x"])
  except Exception:
    pass
  # TODO: fallback to DNS TXT _agentkeys.domain
  raise HTTPException(400, detail="public_key_not_found")

def verify_ed25519_signature(base: bytes, sig_b64: str, pubkey_raw: bytes) -> bool:
  # pynacl is ideal; here we use cryptography fallback
  from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey
  from cryptography.exceptions import InvalidSignature
  pub = Ed25519PublicKey.from_public_bytes(pubkey_raw)
  try:
    pub.verify(base64.b64decode(sig_b64), base)
    return True
  except InvalidSignature:
    return False

@app.post("/webhooks/inbound-email")
async def inbound_email(request: Request):
  raw = await request.body()  # raw MIME bytes required for DKIM

  # 1) DKIM verify
  try:
    if not dkim.verify(raw):
      raise HTTPException(400, "dkim_failed")
  except Exception:
    raise HTTPException(400, "dkim_error")

  # 2) Parse MIME to get headers + JSON body
  # Using Python's email lib for basic parse (fast), or use 'mailparser' if preferred
  from email import message_from_bytes
  msg = message_from_bytes(raw)

  def h(name: str) -> Optional[str]:
    return msg.get(name)

  x_agent_id = h("X-Agent-ID")
  x_kid = h("X-Agent-KID")
  x_sig = h("X-Agent-Signature")
  x_ts = h("X-Agent-Timestamp")
  x_corr = h("X-Agent-Correlation")

  if not (x_agent_id and x_kid and x_sig and x_ts):
    raise HTTPException(400, "missing_agent_headers")

  # Clock skew
  try:
    ts = isoparse(x_ts)
  except Exception:
    raise HTTPException(400, "bad_timestamp")
  if abs((datetime.now(timezone.utc) - ts).total_seconds()) > 300:
    raise HTTPException(400, "timestamp_window_exceeded")

  # Locate JSON part
  envelope = None
  if msg.get_content_type()=="application/json":
    envelope = json.loads(msg.get_payload(decode=True))
  else:
    # multipart: iterate parts
    if msg.is_multipart():
      for part in msg.walk():
        if part.get_content_type()=="application/json":
          envelope = json.loads(part.get_payload(decode=True))
          break
  if envelope is None:
    # fallback: try text/plain
    if msg.get_content_type()=="text/plain":
      envelope = json.loads(msg.get_payload(decode=True))
    else:
      raise HTTPException(400, "no_json_body")

  # 3) Verify X-Agent-Signature (Ed25519) over canonical base
  body_hash_b64 = sha256_b64(json.dumps(envelope.get("body", {})).encode())
  base = f"{x_ts}\n{body_hash_b64}\n{envelope['from']}\n{envelope['to']}\n{envelope.get('correlation_id','')}".encode()
  pubkey = await fetch_agent_public_key(envelope.get("signature", {}).get("kid") or x_kid)
  if not verify_ed25519_signature(base, envelope.get("signature", {}).get("sig") or x_sig, pubkey):
    raise HTTPException(400, "signature_invalid")

  # 4) Policy checks (placeholder)
  # if not policy_allows(envelope): raise HTTPException(403, "policy_denied")

  # 5) Fingerprint and enqueue
  fingerprint = sha256_b64(json.dumps(envelope, separators=(',',':')).encode())
  pool = await db()
  async with pool.acquire() as conn:
    try:
      async with conn.transaction():
        msg_id = await enqueue_message(conn, envelope, 'smtp', None, fingerprint)
    finally:
      await pool.release(conn)

  return {"ok": True, "message_id": str(msg_id)}
```

---

## Notes for SES / Mailgun / Relayapp specifics

* **AWS SES (Inbound/SMTP → Lambda/Webhook)**

  * If using **SES Inbound + S3**, the webhook receives an S3 object key; fetch the raw MIME bytes from S3, then run the exact DKIM + header verification above.
  * If using **SES SMTP → Lambda**, configure the function to receive the **raw message**.

* **Mailgun**

  * Enable **Routes** with “Store and Notify” to receive **raw MIME** (or use the MIME URL Mailgun provides to fetch the raw).
  * Mailgun also includes its own webhook HMAC signature (separate from DKIM); you can verify it too, but **DKIM must be performed on raw MIME**.

* **Relay.app**

  * Relay can POST JSON or forward raw MIME; ask for raw MIME passthrough if you need to verify DKIM yourself. If not possible, you can rely on Relay’s DKIM verification signal plus your own X-Agent-* verification.

---

## Quick test checklist

1. Send a test email with JSON body + `X-Agent-*` headers to your inbound address.
2. Ensure DKIM passes for the sender domain.
3. Confirm the webhook:

   * Rejects missing/invalid `X-Agent-*`.
   * Rejects timestamp outside ±5 minutes.
   * Rejects invalid Ed25519 signature.
   * Inserts a single row on duplicate deliveries (idempotency).
4. Verify that `/v1/messages/{id}/status` shows `sent` initially and moves to `delivered` when your provider emits a DSN 2.0.0 (if you process DSNs).
5. Run an internal agent pulling from `/inbox/pull` and acking with `/ack`.

---

if you want, I can package these into a **repo skeleton** (`openapi.yaml`, `server/`, `bridge/`, `docker-compose.yml`, `Makefile`) so you can boot the full path (HTTP + SMTP → Postgres) locally in one command.
