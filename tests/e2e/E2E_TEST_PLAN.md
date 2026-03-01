# ADMP End-to-End Test Plan

## Overview

Comprehensive test plan covering the complete ADMP message lifecycle from agent registration through federated SMTP delivery.

**Test Coverage**:
- Agent registration and identity management
- Capability key (inbox key) issuance and authentication
- Message send with security validation
- Message pull with lease mechanism
- Message acknowledgment and requeue
- SMTP inbound (Cloudflare Worker webhook)
- SMTP outbound (Mailgun relay)
- Worker jobs (cleanup, retry, delivery)
- Error handling and edge cases

---

## Test Suite 1: Agent Registration & Authentication

### Test 1.1: Register New Agent
**Purpose**: Verify agent can register with canonical identity format

**Steps**:
1. POST `/v1/agents` with agent data:
   ```json
   {
     "agent_id": "billing@acme.com",
     "public_key": "<base64-ed25519-public-key>",
     "webhook_url": "https://acme.com/webhooks/admp",
     "trusted_agents": ["*@partner.com"],
     "allowed_subjects": ["invoice.*", "payment.*"]
   }
   ```
2. Verify response: `201 Created`
3. Verify response body contains:
   - `agent_id`: "billing@acme.com"
   - `created_at`: valid ISO timestamp
   - `inbox_count`: 0
4. Verify inbox created automatically

**Expected Outcome**: Agent registered, inbox created, policies stored

**Validation**:
- GET `/v1/agents/billing%40acme.com` returns agent data
- Agent ID follows `local@domain` format
- Public key stored correctly

---

### Test 1.2: Create Inbox Key (Capability Token)
**Purpose**: Issue capability token with scoped permissions

**Steps**:
1. POST `/v1/agents/billing%40acme.com/keys` with:
   ```json
   {
     "scopes": ["send", "pull", "ack", "nack", "reply"],
     "subject_patterns": ["invoice.*"],
     "expires_at": "2026-12-31T23:59:59Z",
     "description": "Billing service key"
   }
   ```
2. Verify response: `201 Created`
3. Verify response contains:
   - `key`: starts with `admp_k_billing_acme.com_`
   - `key_id`: UUID
   - `scopes`: matches request
   - `subject_patterns`: matches request
4. **Save key for subsequent tests**

**Expected Outcome**: Capability token issued with hashed storage

**Validation**:
- GET `/v1/agents/billing%40acme.com/keys` lists the key
- Key is only shown once (security)
- Key hash stored in database

---

### Test 1.3: Authenticate with Inbox Key
**Purpose**: Verify bearer token authentication works

**Steps**:
1. Make request to any protected endpoint with header:
   ```
   Authorization: Bearer admp_k_billing_acme.com_<random>
   ```
2. Verify middleware validates key
3. Verify scopes enforced (try operation outside scope, should fail)

**Expected Outcome**: Valid key authenticates, invalid/expired key rejects

**Validation**:
- Valid key: 200/201 response
- Invalid key: 401 Unauthorized
- Expired key: 401 Unauthorized
- Missing key: 401 Unauthorized

---

## Test Suite 2: Message Sending (HTTP API)

### Test 2.1: Send Valid Message
**Purpose**: Send message with proper authentication and validation

**Steps**:
1. POST `/v1/agents/storage%40partner.com/messages` with:
   ```json
   {
     "version": "1.0",
     "id": "msg-001",
     "type": "task.request",
     "from": "billing@acme.com",
     "to": "storage@partner.com",
     "subject": "create_invoice",
     "body": {
       "invoice_id": "INV-12345",
       "amount": 100.00
     },
     "timestamp": "2026-01-28T12:00:00Z",
     "ttl_sec": 86400
   }
   ```
   Headers:
   ```
   Authorization: Bearer <inbox-key>
   Content-Type: application/json
   Idempotency-Key: create-invoice-12345
   ```
2. Verify response: `201 Created`
3. Verify response body:
   - `message_id`: UUID
   - `status`: "queued"
   - `idempotency_key`: matches header

**Expected Outcome**: Message stored in recipient's inbox

**Validation**:
- Message appears in recipient inbox
- Status is "queued"
- Idempotency key prevents duplicates

---

### Test 2.2: Send Message with Signature
**Purpose**: Verify Ed25519 signature validation

**Prerequisites**:
- Generate Ed25519 keypair
- Register agent with public key

**Steps**:
1. Create message envelope (Test 2.1)
2. Build signature base string (canonical format)
3. Sign with Ed25519 private key
4. Add signature to envelope:
   ```json
   {
     "signature": {
       "alg": "ed25519",
       "kid": "acme.com/key-2026-01",
       "sig": "<base64-signature>"
     }
   }
   ```
5. POST message to endpoint
6. Verify response: `201 Created`

**Expected Outcome**: Signature verified, message accepted

**Validation**:
- Valid signature: accepted
- Invalid signature: 403 Forbidden
- Missing kid: 400 Bad Request
- Tampered envelope: 403 Forbidden

---

### Test 2.3: Policy Enforcement - Trusted Agents
**Purpose**: Verify sender must be in recipient's trust list

**Steps**:
1. Register recipient with `trusted_agents: ["*@partner.com"]`
2. Send message FROM `billing@acme.com` TO recipient
3. Verify response: `403 Forbidden`
4. Verify error: `policy_violation`

**Expected Outcome**: Untrusted sender rejected

**Validation**:
- Trusted sender: accepted
- Untrusted sender: rejected
- Wildcard patterns work (`*@domain`, `prefix.*`)

---

### Test 2.4: Policy Enforcement - Subject Patterns
**Purpose**: Verify subject must match allowed patterns

**Steps**:
1. Register recipient with `allowed_subjects: ["invoice.*"]`
2. Send message with `subject: "payment.process"` (not allowed)
3. Verify response: `403 Forbidden`
4. Send message with `subject: "invoice.create"` (allowed)
5. Verify response: `201 Created`

**Expected Outcome**: Subject patterns enforced

---

### Test 2.5: Policy Enforcement - Message Size Limits
**Purpose**: Verify message size constraints

**Steps**:
1. Create message with body > 256KB
2. POST to endpoint
3. Verify response: `413 Payload Too Large` OR `403 Forbidden`

**Expected Outcome**: Oversized messages rejected

---

### Test 2.6: Idempotency
**Purpose**: Prevent duplicate message processing

**Steps**:
1. Send message with `Idempotency-Key: test-123`
2. Verify response: `201 Created`, save message ID
3. Send SAME message with SAME idempotency key
4. Verify response: `200 OK` (not 201)
5. Verify same message ID returned (not new message)

**Expected Outcome**: Duplicate messages prevented

---

## Test Suite 3: Message Pull & Lease Mechanism

### Test 3.1: Pull Message from Inbox
**Purpose**: Retrieve and lease a message

**Prerequisites**:
- Message exists in inbox (from Test 2.1)

**Steps**:
1. POST `/v1/agents/storage%40partner.com/inbox/pull` with:
   ```json
   {
     "lease_seconds": 30,
     "max_messages": 1
   }
   ```
   Headers: `Authorization: Bearer <storage-inbox-key>`
2. Verify response: `200 OK`
3. Verify response body:
   ```json
   {
     "messages": [
       {
         "message_id": "...",
         "envelope": { ... },
         "status": "leased",
         "lease_until": "2026-01-28T12:00:30Z"
       }
     ]
   }
   ```
4. **Save message_id and lease_until**

**Expected Outcome**: Message leased, invisible to other pulls

**Validation**:
- Status changes from "queued" to "leased"
- `lease_until` set correctly (now + 30s)
- Second pull returns empty (message leased)
- Message reappears after lease expires

---

### Test 3.2: Pull with Filters
**Purpose**: Query inbox with type/subject filters

**Steps**:
1. Send 3 messages:
   - Type: "task.request", Subject: "create_invoice"
   - Type: "task.response", Subject: "invoice_created"
   - Type: "notification", Subject: "alert"
2. Pull with filter: `type: "task.request"`
3. Verify only matching message returned

**Expected Outcome**: Server-side filtering works

---

### Test 3.3: Lease Expiry
**Purpose**: Verify expired leases requeue messages

**Steps**:
1. Pull message with `lease_seconds: 5`
2. Wait 6 seconds
3. Pull again (without ack/nack)
4. Verify same message returned (lease expired)

**Expected Outcome**: Message requeued automatically after lease expires

---

## Test Suite 4: Message Acknowledgment & Requeue

### Test 4.1: Acknowledge Message
**Purpose**: Finalize message processing

**Prerequisites**:
- Message leased (from Test 3.1)

**Steps**:
1. POST `/v1/agents/storage%40partner.com/messages/{message_id}/ack`
   Headers: `Authorization: Bearer <storage-inbox-key>`
2. Verify response: `200 OK`
3. Verify message status: "acked"
4. Pull inbox again
5. Verify message NOT returned (removed from inbox)

**Expected Outcome**: Message finalized and removed

---

### Test 4.2: Negative Acknowledge (Requeue)
**Purpose**: Reject message and return to inbox

**Steps**:
1. Pull message (lease it)
2. POST `/v1/agents/storage%40partner.com/messages/{message_id}/nack` with:
   ```json
   {
     "reason": "temporary_error",
     "retry_after": 60
   }
   ```
3. Verify response: `200 OK`
4. Verify message status: "queued" (back in inbox)
5. Pull immediately
6. Verify message NOT returned yet (retry_after)
7. Wait 61 seconds, pull again
8. Verify message returned

**Expected Outcome**: Message requeued with delay

---

### Test 4.3: Nack with Visibility Extension
**Purpose**: Extend lease without requeuing

**Steps**:
1. Pull message with 30s lease
2. After 20s, NACK with `extend_lease: 30`
3. Verify lease extended (not requeued)
4. Verify message still invisible to other pulls

**Expected Outcome**: Lease extended for long-running processing

---

## Test Suite 5: Message Reply

### Test 5.1: Send Reply to Correlated Message
**Purpose**: Send response linked to original request

**Steps**:
1. Send message with `correlation_id: "req-123"`
2. Pull message as recipient
3. POST `/v1/agents/storage%40partner.com/messages/{message_id}/reply` with:
   ```json
   {
     "type": "task.response",
     "subject": "invoice_created",
     "body": {
       "invoice_id": "INV-12345",
       "status": "created"
     }
   }
   ```
4. Verify response: `201 Created`
5. Verify reply appears in ORIGINAL SENDER's inbox
6. Verify reply has:
   - `correlation_id: "req-123"` (from original)
   - `from`: storage@partner.com (reply sender)
   - `to`: billing@acme.com (original sender)

**Expected Outcome**: Reply delivered to original sender with correlation

---

## Test Suite 6: Message Status & Monitoring

### Test 6.1: Check Message Status
**Purpose**: Track message lifecycle

**Steps**:
1. Send message, save message_id
2. GET `/v1/messages/{message_id}/status`
3. Verify response includes:
   - `status`: current state
   - `created_at`, `updated_at`: timestamps
   - `lease_until`: if leased
   - `attempts`: retry count
4. Pull message (lease)
5. Check status again, verify `status: "leased"`
6. Ack message
7. Check status, verify `status: "acked"`

**Expected Outcome**: Status tracks full lifecycle

**States to test**:
- queued → leased → acked
- queued → leased → nacked → queued
- queued → (TTL expires) → expired

---

## Test Suite 7: SMTP Inbound (Cloudflare Worker)

### Test 7.1: Receive SMTP Message via Webhook
**Purpose**: Process inbound email from Cloudflare Worker

**Prerequisites**:
- Cloudflare Worker configured with shared secret
- Agent registered with target identity

**Steps**:
1. POST `/v1/inbound/smtp` with:
   ```json
   {
     "from": "payments@agents.stripe.com",
     "to": "billing@agents.acme.com",
     "dkim_verified": true,
     "subject": "[ADMP] task.request payment_webhook",
     "body": {
       "version": "1.0",
       "id": "msg-smtp-001",
       "type": "task.request",
       "from": "payments@stripe.com",
       "to": "billing@acme.com",
       "subject": "payment_webhook",
       "body": { "event": "payment.succeeded" },
       "timestamp": "2026-01-28T12:00:00Z",
       "signature": {
         "alg": "ed25519",
         "kid": "stripe.com/key-2026",
         "sig": "<base64-sig>"
       }
     }
   }
   ```
   Headers: `X-Worker-Secret: <shared-secret>`
2. Verify response: `201 Created`
3. Verify message appears in `billing@acme.com` inbox
4. Verify signature verified against JWKS/DNS

**Expected Outcome**: SMTP message converted to ADMP format and delivered

**Validation**:
- DKIM check enforced (if dkim_verified: false, reject)
- Worker secret required (401 if missing/invalid)
- SMTP To maps to identity (billing@agents.acme.com → billing@acme.com)
- Signature verified
- Policy checks applied

---

### Test 7.2: Reject SMTP without DKIM
**Purpose**: Enforce email authentication

**Steps**:
1. POST `/v1/inbound/smtp` with `dkim_verified: false`
2. Verify response: `403 Forbidden`
3. Verify error: `dkim_verification_failed`

**Expected Outcome**: Unauthenticated email rejected

---

### Test 7.3: Reject SMTP without Worker Secret
**Purpose**: Prevent unauthorized webhook calls

**Steps**:
1. POST `/v1/inbound/smtp` WITHOUT `X-Worker-Secret` header
2. Verify response: `401 Unauthorized`

**Expected Outcome**: Webhook authentication required

---

## Test Suite 8: SMTP Outbound (Mailgun)

### Test 8.1: Trigger Outbound SMTP Job
**Purpose**: Queue outbound email delivery

**Steps**:
1. Send message FROM `billing@acme.com` TO `storage@partner.com`
2. Verify message queued in inbox
3. Check `admp_jobs` table for `smtp_send` job
4. Verify job payload contains:
   - Message envelope
   - SMTP routing address: `storage@agents.partner.com`
   - Target domain: `partner.com`

**Expected Outcome**: Job created for outbound SMTP

---

### Test 8.2: Worker Processes SMTP Job
**Purpose**: Verify worker sends via Mailgun

**Prerequisites**:
- Worker running (`npm run worker`)
- Mailgun API key configured

**Steps**:
1. Trigger SMTP job (Test 8.1)
2. Wait for worker to process (check worker logs)
3. Verify Mailgun API called:
   - Endpoint: POST `/v3/{domain}/messages.mime`
   - Email contains ADMP envelope as JSON body
   - Custom headers: `X-Agent-ID`, `X-Agent-Signature`
4. Verify job status: "completed"

**Expected Outcome**: Email sent via Mailgun

---

### Test 8.3: Handle Mailgun Delivery Webhook
**Purpose**: Update message status from delivery notification

**Steps**:
1. Send SMTP message (Test 8.2)
2. Simulate Mailgun webhook:
   POST `/v1/webhooks/mailgun/delivery` with:
   ```json
   {
     "signature": {
       "timestamp": "1706444400",
       "token": "abc123",
       "signature": "<hmac-sha256>"
     },
     "event-data": {
       "event": "delivered",
       "message": {
         "headers": {
           "x-admp-message-id": "msg-smtp-001"
         }
       }
     }
   }
   ```
3. Verify response: `200 OK`
4. Verify message status updated to "delivered"

**Expected Outcome**: Delivery status tracked

---

### Test 8.4: Verify Mailgun Webhook Signature
**Purpose**: Prevent webhook forgery

**Steps**:
1. POST webhook with INVALID signature
2. Verify response: `401 Unauthorized`
3. Verify error: `invalid_signature`
4. POST webhook with VALID signature
5. Verify response: `200 OK`

**Expected Outcome**: Only authenticated webhooks accepted

---

### Test 8.5: Reject Expired Mailgun Webhook
**Purpose**: Prevent replay attacks

**Steps**:
1. POST webhook with timestamp > 5 minutes old
2. Verify response: `401 Unauthorized`
3. Verify error: `signature_expired`

**Expected Outcome**: Old webhooks rejected

---

## Test Suite 9: Worker Background Jobs

### Test 9.1: Lease Expiry Cleanup
**Purpose**: Requeue messages with expired leases

**Steps**:
1. Pull message with 5s lease
2. Do NOT ack/nack (simulate agent crash)
3. Wait 6 seconds
4. Verify worker runs cleanup job
5. Verify message status: "queued" (lease expired)
6. Pull again, verify message available

**Expected Outcome**: Orphaned leases cleaned up

---

### Test 9.2: TTL Expiry Cleanup
**Purpose**: Remove expired messages

**Steps**:
1. Send message with `ttl_sec: 10`
2. Wait 11 seconds
3. Verify worker runs TTL cleanup
4. Verify message status: "expired"
5. Pull inbox, verify message NOT returned

**Expected Outcome**: Expired messages removed

---

### Test 9.3: Job Retry with Exponential Backoff
**Purpose**: Retry failed jobs with backoff

**Steps**:
1. Create job that will fail (e.g., invalid Mailgun API key)
2. Verify job marked "failed"
3. Verify `attempts` incremented
4. Verify `run_at` updated with backoff (2^attempts seconds)
5. After backoff, verify worker retries
6. After max attempts (5), verify moved to dead letter

**Expected Outcome**: Jobs retry with increasing delays

---

## Test Suite 10: Error Handling & Edge Cases

### Test 10.1: Invalid Identity Format
**Purpose**: Reject malformed agent IDs

**Steps**:
1. POST `/v1/agents` with `agent_id: "invalid-format"`
2. Verify response: `400 Bad Request`
3. Try sending message with invalid `from` address
4. Verify response: `400 Bad Request`

**Expected Outcome**: Only `local@domain` format accepted

---

### Test 10.2: Missing Required Fields
**Purpose**: Validate envelope completeness

**Steps**:
1. Send message WITHOUT `from` field
2. Verify response: `400 Bad Request`
3. Send message WITHOUT `to` field
4. Verify response: `400 Bad Request`
5. Send message WITHOUT `timestamp`
6. Verify response: `400 Bad Request`

**Expected Outcome**: Required fields enforced

---

### Test 10.3: Timestamp Validation
**Purpose**: Reject messages with invalid timestamps

**Steps**:
1. Send message with timestamp in future (> 5 minutes)
2. Verify response: `400 Bad Request`
3. Send message with old timestamp (> 5 minutes ago)
4. Verify response: `400 Bad Request`

**Expected Outcome**: Timestamp window enforced (±5 minutes)

---

### Test 10.4: Envelope Size Limit
**Purpose**: Prevent oversized envelopes

**Steps**:
1. Create message with body > 256KB
2. POST to endpoint
3. Verify response: `413 Payload Too Large`

**Expected Outcome**: Size limit enforced

---

### Test 10.5: Inbox Key Permission Violation
**Purpose**: Verify scoped permissions

**Steps**:
1. Create key with scopes: `["send"]` (no "pull")
2. Try to pull inbox with this key
3. Verify response: `403 Forbidden`
4. Verify error: `insufficient_permissions`

**Expected Outcome**: Operations outside scope rejected

---

### Test 10.6: Subject Pattern Mismatch
**Purpose**: Enforce subject-scoped keys

**Steps**:
1. Create key with `subject_patterns: ["invoice.*"]`
2. Try to send message with `subject: "payment.process"`
3. Verify response: `403 Forbidden`

**Expected Outcome**: Subject patterns enforced on keys

---

### Test 10.7: Pull Non-Existent Message
**Purpose**: Handle missing message IDs

**Steps**:
1. Try to ACK non-existent message ID
2. Verify response: `404 Not Found`

**Expected Outcome**: Graceful error handling

---

### Test 10.8: URL Encoding for Special Characters
**Purpose**: Handle @ symbols in agent IDs

**Steps**:
1. Create agent: `billing@acme.com`
2. Access via: `/v1/agents/billing%40acme.com` (URL-encoded)
3. Verify response: `200 OK`
4. Try without encoding: `/v1/agents/billing@acme.com`
5. Verify: works OR returns proper error

**Expected Outcome**: @ symbols handled correctly

---

## Test Suite 11: Integration & Performance

### Test 11.1: Full Message Lifecycle
**Purpose**: End-to-end happy path

**Steps**:
1. Register sender agent: `billing@acme.com`
2. Register recipient agent: `storage@partner.com`
3. Create inbox keys for both
4. Send message from billing to storage
5. Pull message as storage
6. Process and reply
7. Pull reply as billing
8. Ack both messages
9. Verify both inboxes empty

**Expected Outcome**: Complete round-trip successful

**Duration**: < 5 seconds

---

### Test 11.2: Concurrent Message Sends
**Purpose**: Verify system handles load

**Steps**:
1. Send 100 messages concurrently
2. Verify all return 201 Created
3. Verify all appear in inbox
4. Verify no duplicates (idempotency)

**Expected Outcome**: No lost messages, no errors

---

### Test 11.3: Federated SMTP Flow
**Purpose**: Complete SMTP send and receive

**Steps**:
1. Send message: `billing@acme.com` → `storage@partner.com`
2. Worker picks up SMTP job
3. Mailgun sends email to `storage@agents.partner.com`
4. Cloudflare Worker receives email
5. Worker calls `/v1/inbound/smtp`
6. Message appears in storage's inbox
7. Storage pulls and acks
8. Mailgun webhook confirms delivery
9. Message status: "delivered"

**Expected Outcome**: Complete federated delivery

**Duration**: < 30 seconds (including external services)

---

## Test Execution Strategy

### Quick Smoke Test (5 minutes)
Run these tests to verify basic functionality:
- Test 1.1, 1.2, 1.3 (Registration & Auth)
- Test 2.1 (Send Message)
- Test 3.1 (Pull Message)
- Test 4.1 (Ack Message)
- Test 11.1 (Full Lifecycle)

### Full Test Suite (30 minutes)
Run all tests sequentially for comprehensive validation.

### Continuous Integration
Run full suite on every PR:
- Use Docker Compose for mech-storage mock
- Mock Mailgun API calls
- Use in-memory job queue

### Load Testing (separate)
- 1000 concurrent sends
- 10,000 messages in inbox
- Worker processing throughput

---

## Test Data Requirements

### Keypairs (Ed25519)
Generate test keypairs for signature verification:
```bash
# Generate keypair
openssl genpkey -algorithm Ed25519 -out private.pem
openssl pkey -in private.pem -pubout -out public.pem
```

### Test Agents
- `billing@acme.com` (sender)
- `storage@partner.com` (recipient)
- `payments@stripe.com` (SMTP sender)

### Test Messages
- Invoice creation request
- Payment webhook notification
- User data sync request

---

## Success Criteria

✅ All tests pass
✅ No timeout errors (< 5s per test)
✅ No validation errors in logs
✅ Coverage: > 90% of codebase
✅ Idempotency verified
✅ Security checks enforced
✅ Worker jobs complete successfully
✅ SMTP integration works end-to-end

---

## Next Steps

1. Implement test harness (Bun test framework)
2. Create test fixtures and helpers
3. Set up CI/CD integration
4. Add performance benchmarks
5. Create load testing suite
