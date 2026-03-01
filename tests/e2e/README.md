# ADMP End-to-End Test Suite

Comprehensive test suite covering the complete ADMP message lifecycle from agent registration through message delivery and acknowledgment.

## Prerequisites

### 1. Required Services

- **Mech Storage**: PostgreSQL-compatible API (or use in-memory mock)
- **ADMP Server**: Running on `http://localhost:3008`
- **Worker Process**: Background job processor (optional for most tests)

### 2. Environment Setup

Create `.env.test` file:

```bash
# Test Environment Configuration
PORT=3008
NODE_ENV=test

# Mech Storage (use test database)
MECH_STORAGE_BASE_URL=https://storage.mechdna.net
MECH_STORAGE_API_KEY=key_test_xxx...
MECH_STORAGE_APP_ID=app_test_xxx...

# Use in-memory storage for faster tests (optional)
# STORAGE_BACKEND=memory

# Mailgun (use test domain)
MAILGUN_API_KEY=test-xxx...
MAILGUN_DOMAIN=agents.test.yourdomain.com
MAILGUN_SIGNING_KEY=test-signing-key

# Cloudflare Worker
CLOUDFLARE_WORKER_SECRET=test-shared-secret

# Worker Configuration
WORKER_POLL_INTERVAL=1000
```

## Quick Start

### Run Full E2E Suite

```bash
# Start ADMP server
npm run dev

# In another terminal, run tests
bun test tests/e2e/e2e.test.js
```

### Run Specific Test Suites

```bash
# Only registration tests
bun test tests/e2e/e2e.test.js --test-name-pattern "Suite 1"

# Only message sending tests
bun test tests/e2e/e2e.test.js --test-name-pattern "Suite 2"

# Full lifecycle test
bun test tests/e2e/e2e.test.js --test-name-pattern "7.1"
```

## Test Coverage

### Suite 1: Agent Registration & Authentication (6 tests)
- ✅ Register sender agent
- ✅ Register recipient agent
- ✅ Create inbox keys (capability tokens)
- ✅ List inbox keys
- ✅ Authenticate with bearer token
- ✅ Reject unauthenticated requests

### Suite 2: Message Sending (6 tests)
- ✅ Send valid message
- ✅ Send message with Ed25519 signature
- ✅ Reject invalid signature
- ✅ Enforce idempotency
- ✅ Validate identity format
- ✅ Validate recipient match

### Suite 3: Message Pull & Lease (3 tests)
- ✅ Pull message from inbox
- ✅ Verify lease prevents duplicate pulls
- ✅ Filter by message type

### Suite 4: Message Ack & Nack (2 tests)
- ✅ Acknowledge message (finalize)
- ✅ Negative acknowledge (requeue)

### Suite 5: Message Reply (1 test)
- ✅ Send correlated reply to original sender

### Suite 6: Error Handling (3 tests)
- ✅ Reject malformed requests
- ✅ Reject expired keys
- ✅ Handle non-existent message IDs

### Suite 7: Full Lifecycle (1 test)
- ✅ Complete round-trip message flow (request → process → reply → ack)

**Total: 22 automated tests**

## Test Execution Flow

### Test Suite 1-7 (Automated)

```
┌─────────────────────────────────────────────────────────────┐
│ 1. Setup                                                     │
│    ├─ Generate Ed25519 keypairs for test agents            │
│    └─ Initialize test context                              │
├─────────────────────────────────────────────────────────────┤
│ 2. Register Agents                                          │
│    ├─ POST /v1/agents (billing@acme.com)                   │
│    ├─ POST /v1/agents (storage@partner.com)                │
│    ├─ POST /v1/agents/:id/keys (create inbox keys)         │
│    └─ Verify authentication                                 │
├─────────────────────────────────────────────────────────────┤
│ 3. Send Messages                                            │
│    ├─ POST /v1/agents/:id/messages (with auth)             │
│    ├─ Verify signature validation                          │
│    ├─ Verify policy enforcement                            │
│    └─ Test idempotency                                      │
├─────────────────────────────────────────────────────────────┤
│ 4. Pull & Lease                                             │
│    ├─ POST /v1/agents/:id/inbox/pull                       │
│    ├─ Verify lease mechanism                               │
│    └─ Test filtering                                        │
├─────────────────────────────────────────────────────────────┤
│ 5. Ack & Nack                                               │
│    ├─ POST /v1/agents/:id/messages/:mid/ack                │
│    └─ POST /v1/agents/:id/messages/:mid/nack               │
├─────────────────────────────────────────────────────────────┤
│ 6. Reply                                                     │
│    ├─ POST /v1/agents/:id/messages/:mid/reply              │
│    └─ Verify correlation_id preserved                       │
├─────────────────────────────────────────────────────────────┤
│ 7. Error Cases                                              │
│    ├─ Test invalid requests                                │
│    ├─ Test expired keys                                    │
│    └─ Test missing resources                               │
├─────────────────────────────────────────────────────────────┤
│ 8. Full Lifecycle                                           │
│    └─ Complete round-trip: send → pull → reply → ack       │
└─────────────────────────────────────────────────────────────┘
```

## Manual Tests (SMTP Integration)

For complete SMTP testing, see `E2E_TEST_PLAN.md`:

### Test Suite 8: SMTP Inbound
- Cloudflare Worker webhook delivery
- DKIM verification
- Worker secret authentication

### Test Suite 9: SMTP Outbound
- Mailgun API integration
- Delivery webhook handling
- Webhook signature verification

### Test Suite 10: Worker Jobs
- Lease expiry cleanup
- TTL expiry cleanup
- Job retry with exponential backoff

## Success Criteria

✅ All automated tests pass (22/22)  
✅ Full lifecycle completes in < 5 seconds  
✅ No validation errors in logs  
✅ No memory leaks (run with `bun --smol`)  
✅ Concurrent sends (100+) work without errors  

## Troubleshooting

### Tests Fail with "Connection Refused"

**Problem**: ADMP server not running

**Solution**:
```bash
# Terminal 1: Start server
npm run dev

# Terminal 2: Run tests
bun test tests/e2e/e2e.test.js
```

### Tests Fail with "401 Unauthorized"

**Problem**: Inbox keys not created or invalid

**Solution**:
- Verify agents registered successfully
- Check inbox key creation responses
- Ensure bearer token format correct

### Tests Fail with "Mech Storage Error"

**Problem**: Database not available or misconfigured

**Solution**:
```bash
# Use in-memory storage for testing
export STORAGE_BACKEND=memory
npm run dev
```

### Tests Timeout

**Problem**: Server or database slow

**Solution**:
- Increase test timeout
- Use in-memory backend
- Check network connectivity to mech-storage

## Performance Benchmarks

Expected performance on modern hardware:

| Test | Duration | Notes |
|------|----------|-------|
| Suite 1 | < 1s | Agent registration |
| Suite 2 | < 2s | Message sending |
| Suite 3 | < 1s | Pull & lease |
| Suite 4 | < 1s | Ack & nack |
| Suite 5 | < 1s | Reply |
| Suite 6 | < 1s | Error cases |
| Suite 7 | < 3s | Full lifecycle |
| **Total** | **< 10s** | Complete suite |

## CI/CD Integration

### GitHub Actions

```yaml
name: E2E Tests

on: [push, pull_request]

jobs:
  e2e:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3
      - uses: oven-sh/setup-bun@v1
      - run: bun install
      - run: npm run setup  # Setup database tables
      - run: npm run dev &  # Start server in background
      - run: sleep 5        # Wait for server to start
      - run: bun test tests/e2e/e2e.test.js
    env:
      STORAGE_BACKEND: memory
      NODE_ENV: test
```

## Load Testing

For load testing, see `tests/load/`:

```bash
# 100 concurrent message sends
npm run test:load:send

# 1000 messages in inbox, measure pull performance
npm run test:load:pull

# Worker throughput test
npm run test:load:worker
```

## Next Steps

1. ✅ Run smoke test: `bun test tests/e2e/e2e.test.js --test-name-pattern "7.1"`
2. ✅ Run full suite: `bun test tests/e2e/e2e.test.js`
3. 📋 Add SMTP integration tests (Test Suite 8-10)
4. 📋 Add load testing suite
5. 📋 Add chaos/failure testing

## Contributing

When adding new features, add corresponding E2E tests:

1. Add test case to appropriate suite in `e2e.test.js`
2. Update `E2E_TEST_PLAN.md` with new test details
3. Update this README with new test count
4. Ensure all tests pass before committing

## Support

For questions or issues:
- Check logs: `tail -f logs/admp-server.log`
- Review test plan: `cat tests/e2e/E2E_TEST_PLAN.md`
- Review architecture: `cat ARCHITECTURE.md`
