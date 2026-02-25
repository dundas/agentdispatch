# Security P0 Fixes — Agent Trust Model

Source: Security audit + adversarial review of `feat/agent-trust-model` branch (2026-02-24)

## Task 1: Reject invalid signatures instead of falling through to API key [P0]

- **Status**: pending
- **Files**: `src/server.js` (lines 86-96)
- **Problem**: If a `Signature` header is present but invalid, the request falls through to `requireApiKey`. This is a downgrade attack — an attacker with only an API key can bypass the stronger crypto auth.
- **Fix**: If `Signature` header is present but verification fails, return 401 immediately. Do not fall through to API key auth.
- **Testing**: Add test for "bad signature + valid API key = rejected"

## Task 2: Add replay protection — validate Date header freshness [P0]

- **Status**: pending
- **Files**: `src/middleware/auth.js` (verifyHttpSignatureOnly + authenticateHttpSignature), `src/utils/crypto.js` (validateTimestamp already exists)
- **Problem**: `validateTimestamp()` exists in `utils/crypto.js` (±5 min window) but is never called in the HTTP Signature path. Captured signatures can be replayed indefinitely.
- **Fix**: Import and call `validateTimestamp(req.headers['date'])` in both `verifyHttpSignatureOnly` and `authenticateHttpSignature`. Require `date` to be in the signed headers list.
- **Testing**: Add test for expired Date header rejection

## Task 3: Add authorization check to verifyHttpSignatureOnly [P0]

- **Status**: pending
- **Files**: `src/middleware/auth.js` (lines 45-111), `src/server.js`
- **Problem**: `authenticateHttpSignature` checks `agent.agent_id !== targetAgentId` (line 198-204), but `verifyHttpSignatureOnly` does NOT. Agent A can sign a request to access Agent B's resources through the global gate.
- **Fix**: Parse target agent from URL path in `verifyHttpSignatureOnly` and verify it matches the signing agent.
- **Testing**: Add test for cross-agent impersonation blocked

## Task 4: Validate algorithm is ed25519 [P1]

- **Status**: pending
- **Files**: `src/middleware/auth.js`
- **Problem**: `algorithm` param is parsed from Signature header but never validated. Future algorithm confusion risk.
- **Fix**: Reject if `params.algorithm` is present and not `ed25519`.

## Task 5: Require (request-target) in signed headers [P1]

- **Status**: pending
- **Files**: `src/middleware/auth.js`
- **Problem**: Client can specify `headers=""` or omit `(request-target)`, creating trivially replayable signatures.
- **Fix**: Reject if `(request-target)` is not in the signed headers list.

## Task 6: Extract shared verification logic to eliminate duplication [P1]

- **Status**: pending
- **Files**: `src/middleware/auth.js`
- **Problem**: `verifyHttpSignatureOnly` (lines 45-111) and `authenticateHttpSignature` (lines 156-263) are 95% duplicated. A bug fixed in one won't be fixed in the other.
- **Fix**: Extract shared `verifySignature(req, sigHeader)` function that both call. Route middleware adds authorization on top.

## Task 7: Default DID:web registration policy to approval_required [P1]

- **Status**: pending
- **Files**: `src/middleware/auth.js` (line 582)
- **Problem**: Under default `REGISTRATION_POLICY=open`, any internet domain serving a DID document gets auto-approved shadow agent creation.
- **Fix**: Change default from `'open'` to `'approval_required'` for DID:web federation.

## Task 8: Reject duplicate Signature header parameters [P2]

- **Status**: pending
- **Files**: `src/middleware/auth.js` (parseSignatureHeader)

## Task 9: Add rate limiting [P2]

- **Status**: pending
- **Files**: `src/server.js`, `src/routes/agents.js`
