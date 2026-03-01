# ADMP E2E Testing Checklist

Use this checklist to verify complete system functionality before deployment.

## Pre-Test Setup

- [ ] Mech Storage API accessible (or in-memory mode configured)
- [ ] ADMP server running (`npm run dev`)
- [ ] Worker process running (`npm run dev:worker`) - optional for basic tests
- [ ] Environment variables configured (`.env.test`)
- [ ] Test keypairs generated (`./tests/e2e/setup-e2e.sh`)

## Quick Smoke Test (5 minutes)

Run these tests to verify core functionality:

```bash
bun test tests/e2e/e2e.test.js --test-name-pattern "Suite 1"  # Registration
bun test tests/e2e/e2e.test.js --test-name-pattern "2.1"      # Send message
bun test tests/e2e/e2e.test.js --test-name-pattern "3.1"      # Pull message
bun test tests/e2e/e2e.test.js --test-name-pattern "4.1"      # Ack message
bun test tests/e2e/e2e.test.js --test-name-pattern "7.1"      # Full lifecycle
```

### Expected Results
- [ ] All 5 test suites pass
- [ ] No errors in server logs
- [ ] Total execution time < 5 seconds

## Full Automated Test Suite (10 minutes)

```bash
bun test tests/e2e/e2e.test.js
```

### Suite 1: Registration & Authentication
- [ ] 1.1: Register sender agent
- [ ] 1.2: Register recipient agent
- [ ] 1.3: Create inbox key for sender
- [ ] 1.4: Create inbox key for recipient
- [ ] 1.5: List inbox keys
- [ ] 1.6: Reject unauthenticated requests

### Suite 2: Message Sending
- [ ] 2.1: Send valid message
- [ ] 2.2: Send message with Ed25519 signature
- [ ] 2.3: Reject invalid signature
- [ ] 2.4: Enforce idempotency
- [ ] 2.5: Reject invalid identity format
- [ ] 2.6: Reject mismatched recipient

### Suite 3: Message Pull & Lease
- [ ] 3.1: Pull message from inbox
- [ ] 3.2: Verify leased message not returned
- [ ] 3.3: Pull with type filter

### Suite 4: Ack & Nack
- [ ] 4.1: Acknowledge message
- [ ] 4.2: Nack message (requeue)

### Suite 5: Message Reply
- [ ] 5.1: Send reply to original sender

### Suite 6: Error Handling
- [ ] 6.1: Reject message without required fields
- [ ] 6.2: Reject request with expired key
- [ ] 6.3: Handle non-existent message ID

### Suite 7: Full Lifecycle
- [ ] 7.1: Complete round-trip flow

### Expected Results
- [ ] 22/22 tests pass
- [ ] No errors in logs
- [ ] Total execution time < 10 seconds

## Manual SMTP Tests (15 minutes)

### Inbound SMTP (Cloudflare Worker)

**Prerequisites:**
- Cloudflare Email Worker deployed
- Test email account configured

**Steps:**
1. [ ] Send test email to `test@agents.yourdomain.com`
2. [ ] Verify Cloudflare Worker receives email
3. [ ] Check worker logs for DKIM verification
4. [ ] Verify webhook calls `/v1/inbound/smtp`
5. [ ] Check message appears in recipient inbox
6. [ ] Verify signature validated

**Test cases:**
- [ ] Valid DKIM email accepted
- [ ] Invalid DKIM email rejected
- [ ] Missing worker secret rejected
- [ ] Signature verification works
- [ ] Policy enforcement applied

### Outbound SMTP (Mailgun)

**Prerequisites:**
- Mailgun API key configured
- Test domain verified in Mailgun

**Steps:**
1. [ ] Send message that triggers SMTP delivery
2. [ ] Check `admp_jobs` table for `smtp_send` job
3. [ ] Verify worker picks up job
4. [ ] Check Mailgun dashboard for sent email
5. [ ] Verify email contains ADMP envelope as JSON
6. [ ] Check custom headers (`X-Agent-ID`, etc.)

**Test cases:**
- [ ] Email sent via Mailgun API
- [ ] Delivery webhook received
- [ ] Webhook signature verified
- [ ] Message status updated to "delivered"
- [ ] Failed delivery handled (retry/DLQ)

### Mailgun Webhook Security

**Steps:**
1. [ ] Send webhook with valid HMAC signature
   - Expected: 200 OK, status updated
2. [ ] Send webhook with invalid signature
   - Expected: 401 Unauthorized
3. [ ] Send webhook with old timestamp (> 5 min)
   - Expected: 401 Unauthorized (replay protection)
4. [ ] Send webhook without signature
   - Expected: 401 Unauthorized

## Worker Background Jobs (10 minutes)

### Lease Expiry Cleanup

**Steps:**
1. [ ] Pull message with 5s lease
2. [ ] Do NOT ack/nack (simulate crash)
3. [ ] Wait 6 seconds
4. [ ] Check worker logs for cleanup job
5. [ ] Verify message status: "queued"
6. [ ] Pull again, verify message available

### TTL Expiry Cleanup

**Steps:**
1. [ ] Send message with `ttl_sec: 10`
2. [ ] Wait 11 seconds
3. [ ] Check worker logs for TTL cleanup
4. [ ] Verify message status: "expired"
5. [ ] Pull inbox, verify message NOT returned

### Job Retry with Backoff

**Steps:**
1. [ ] Create job that will fail (e.g., invalid Mailgun key)
2. [ ] Verify job marked "failed"
3. [ ] Check `attempts` incremented
4. [ ] Check `run_at` updated with exponential backoff
5. [ ] Wait for backoff period
6. [ ] Verify worker retries
7. [ ] After max attempts, verify moved to dead letter

## Performance Tests (15 minutes)

### Concurrent Sends

**Test:** Send 100 messages concurrently

```bash
# TODO: Add load test script
npm run test:load:concurrent-send
```

**Expected:**
- [ ] All 100 messages accepted (201 Created)
- [ ] No duplicate message IDs
- [ ] All messages appear in inbox
- [ ] No errors in logs
- [ ] p95 latency < 500ms

### Large Inbox Pull

**Test:** Query inbox with 1000+ messages

```bash
# TODO: Add load test script
npm run test:load:large-inbox
```

**Expected:**
- [ ] Pull returns max_messages limit
- [ ] Server-side filtering works
- [ ] Pagination works correctly
- [ ] Response time < 1s
- [ ] No memory issues

### Worker Throughput

**Test:** Process 1000 background jobs

```bash
# TODO: Add load test script
npm run test:load:worker-throughput
```

**Expected:**
- [ ] All jobs processed
- [ ] No stuck jobs
- [ ] Failed jobs retry correctly
- [ ] Throughput > 50 jobs/sec
- [ ] Worker stable (no memory leaks)

## Security Validation (10 minutes)

### Authentication
- [ ] Invalid inbox key rejected (401)
- [ ] Expired inbox key rejected (401)
- [ ] Missing Authorization header rejected (401)
- [ ] Key from different agent rejected (403)

### Authorization (Scoped Permissions)
- [ ] Send with "pull" key only: rejected (403)
- [ ] Pull with "send" key only: rejected (403)
- [ ] Ack with limited scopes: rejected (403)

### Subject Pattern Enforcement
- [ ] Key with `invoice.*` pattern
- [ ] Send `invoice.create`: accepted
- [ ] Send `payment.process`: rejected (403)

### Signature Verification
- [ ] Valid Ed25519 signature: accepted
- [ ] Invalid signature: rejected (403)
- [ ] Tampered envelope: rejected (403)
- [ ] Missing kid: rejected (400)

### Policy Enforcement
- [ ] Untrusted sender: rejected (403)
- [ ] Subject not in allowed patterns: rejected (403)
- [ ] Message > max_message_size_kb: rejected (413/403)
- [ ] TTL > max_ttl_sec: rejected (403)

### Timestamp Validation
- [ ] Timestamp > 5 min in future: rejected (400)
- [ ] Timestamp > 5 min in past: rejected (400)
- [ ] Valid timestamp (±5 min): accepted

### SMTP Security
- [ ] Cloudflare Worker secret required (401 if missing)
- [ ] DKIM verification enforced (403 if failed)
- [ ] Mailgun webhook signature required (401 if invalid)
- [ ] Replay attack prevented (401 if timestamp old)

## Edge Cases & Error Handling (10 minutes)

### Malformed Requests
- [ ] Missing required fields: 400 Bad Request
- [ ] Invalid JSON: 400 Bad Request
- [ ] Invalid identity format: 400 Bad Request
- [ ] Invalid message ID: 404 Not Found

### Resource Limits
- [ ] Envelope > 256KB: 413 Payload Too Large
- [ ] Pull with max_messages > 1000: limited to 1000
- [ ] TTL > 7 days: rejected or clamped

### Concurrent Operations
- [ ] Two pulls same message: one gets lease, other gets empty
- [ ] Ack expired lease: rejected (lease already expired)
- [ ] Double ack: idempotent (no error)

### Network Failures
- [ ] Mech Storage timeout: 503 Service Unavailable
- [ ] Mailgun API failure: job retried
- [ ] Worker crash: jobs requeued after lease expiry

## Pre-Deployment Checklist

### Configuration
- [ ] Environment variables set for production
- [ ] Secrets stored securely (not in code)
- [ ] Mailgun API key valid and domain verified
- [ ] Cloudflare Worker deployed and secret set
- [ ] Mech Storage connection tested

### Deployment
- [ ] Fly.io app configured (`fly.toml`)
- [ ] Process groups defined (web + worker)
- [ ] Health checks configured
- [ ] Secrets set via `fly secrets set`
- [ ] Database tables provisioned

### Monitoring
- [ ] Health endpoint responding (`/health`)
- [ ] Logs streaming (`fly logs`)
- [ ] Metrics dashboard configured (optional)
- [ ] Alerting configured for errors (optional)

### Documentation
- [ ] README updated with deployment steps
- [ ] RUNBOOK.md covers common failures
- [ ] ARCHITECTURE.md reflects current system
- [ ] API docs up to date

## Sign-off

**Tested by:** _________________  
**Date:** _________________  
**Environment:** [ ] Staging [ ] Production  
**All tests passed:** [ ] Yes [ ] No  

**Notes:**
_________________________________________________________
_________________________________________________________
_________________________________________________________

**Approval for deployment:** [ ] Approved [ ] Not Approved

**Approver:** _________________  
**Date:** _________________
