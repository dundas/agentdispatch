# Security Fixes — Agent Trust Model

Source: Security audit + adversarial review of `feat/agent-trust-model` branch (2026-02-24)

## Task 1: Reject invalid signatures instead of falling through to API key [P0]

- **Status**: completed (commit 89592d8)
- **Fix**: If `Signature` header is present but verification fails, return 401 immediately.

## Task 2: Add replay protection — validate Date header freshness [P0]

- **Status**: completed (commit 89592d8)
- **Fix**: Call `validateTimestamp()` in shared `_verifySignatureCore`. Require `date` in signed headers.

## Task 3: Add authorization check to verifyHttpSignatureOnly [P0]

- **Status**: completed (commit 89592d8)
- **Fix**: Parse target agent from URL path and verify it matches the signing agent.

## Task 4: Validate algorithm is ed25519 [P1]

- **Status**: completed (this commit)
- **Fix**: Reject if `params.algorithm` is present and not `ed25519` in shared `_verifySignatureCore`.

## Task 5: Require (request-target) in signed headers [P1]

- **Status**: completed (this commit)
- **Fix**: Reject if `(request-target)` is not in the signed headers list in shared `_verifySignatureCore`.

## Task 6: Extract shared verification logic to eliminate duplication [P1]

- **Status**: completed (this commit)
- **Fix**: Extracted `_verifySignatureCore(req, sigHeader)` — both `verifyHttpSignatureOnly` and `authenticateHttpSignature` call through to it.

## Task 7: DID:web open policy startup warning [P1]

- **Status**: completed (this commit)
- **Fix**: Added startup warning when `REGISTRATION_POLICY=open` and `DID_WEB_ALLOWED_DOMAINS` is unset.

## Task 8: Reject duplicate Signature header parameters [P2]

- **Status**: deferred (advisory, not blocking merge)

## Task 9: Add rate limiting [P2]

- **Status**: deferred (advisory, not blocking merge)
