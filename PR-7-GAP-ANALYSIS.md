# PR #7 Gap Analysis: Merge Readiness Assessment

**PR:** `https://github.com/dundas/agentdispatch/pull/7`  
**Title:** `feat(groups): Add ADMP Groups extension for multi-party messaging`  
**Branch:** `feat/admp-groups-extension` → **Base:** `main`  
**Status:** Open, **Mergeable:** ✅ `MERGEABLE`  
**Checks:** ✅ `claude-review` passing (no test job in CI)

---

## Executive Summary

PR #7 adds a **Groups** feature set (hub API + storage + brain client helpers) and the Groups extension whitepaper.

**What’s solid already**
- ✅ Core groups surface area is implemented (create/get/update/delete, membership, post, history, agent group listing)
- ✅ Automated review check (`claude-review`) is green
- ✅ Local tests run clean once dependencies are installed (`npm install && npm test` → 20 tests passing; 2 Mech tests skipped when unconfigured)

**What’s missing for “ready to merge”**
- 🔴 **Runtime bug** in `GroupService.hashKey()` (uses `require()` inside an ESM project)
- 🔴 **OpenAPI spec is not updated** to include the new Groups endpoints, despite `/docs` serving `openapi.yaml`
- 🟡 **No tests for Groups** (existing suite does not exercise `/api/groups/*` or `/api/agents/:id/groups`)
- 🟡 **CI does not run tests** on PRs (only a review workflow runs)
- 🟡 `brain/lib/admp.ts` appears **not build-validated** (TS file in a JS repo; likely missing dependencies and contains non-existent “channels” API calls)

**Merge Readiness Score (current):** **70/100**

---

## What Changed (Diff Summary)

**Files added/modified (12):**
- **Hub API**
  - `src/routes/groups.js` (new)
  - `src/services/group.service.js` (new)
  - `src/routes/agents.js` (modified: add `GET /api/agents/:agentId/groups`)
  - `src/middleware/auth.js` (modified: support `X-Agent-ID` header)
  - `src/storage/memory.js` (modified: groups + group messages history)
  - `src/storage/mech.js` (modified: groups + group messages history)
  - `src/server.js` (modified: mount groups routes)
- **Brain**
  - `brain/lib/admp.ts` (new)
  - `brain/lib/process-manager.ts` (new)
- **Docs/Tasks**
  - `whitepaper/groups-extension.md` (new)
  - `tasks/0001-prd-brain-process-manager.md` (new)
  - `tasks/tasks-0001-prd-brain-process-manager.md` (new)

---

## Review Feedback Status (Automated)

Two Codex review comments were raised and appear **addressed** in current code:

- ✅ **Fanout message ID collisions**: addressed by generating a unique `id` per recipient delivery.
- ✅ **Group history dedupe / stable group message identity**: addressed by introducing `group_message_id` and deduping history on that field.

**Remaining issue**: the current implementation still has a **merge-blocking runtime problem** (below).

---

## 🔴 Blocking Gaps (Must Fix Before Merge)

### 1) ESM runtime error in `GroupService.hashKey()`

**Where:** `src/services/group.service.js`  
**Problem:** repo is `"type": "module"` (ESM), but `hashKey()` uses `require('crypto')`. In Node ESM, `require` is not defined; **key-protected groups** will crash when hashing join keys.

**Ready-to-merge expectation:** key-protected groups do not crash; hashing works in production runtimes.

**Fix:** use ESM import (`import crypto from 'node:crypto'`) or `import { createHash } from 'node:crypto'`.

---

### 2) OpenAPI (`openapi.yaml`) not updated for Groups

**Where:** `openapi.yaml`, served by `src/server.js` at `/docs` and `/openapi.json`  
**Problem:** new endpoints are not documented in the OpenAPI spec:

- `/api/groups` (create)
- `/api/groups/{groupId}` (get/update/delete)
- `/api/groups/{groupId}/members` (list/add)
- `/api/groups/{groupId}/members/{agentId}` (remove)
- `/api/groups/{groupId}/join`, `/leave`
- `/api/groups/{groupId}/messages` (post + history)
- `/api/agents/{agentId}/groups` (list agent’s groups)

**Ready-to-merge expectation:** the API docs reflect the actual surface area shipped.

---

## 🟡 High Priority Gaps (Should Fix Before Merge, or Track Explicitly)

### 3) No automated tests for Groups

**Current:** `src/server.test.js` covers health/stats, agents, inbox flows, trust lists, API key middleware, webhook delivery.  
**Missing:** any coverage for groups operations and group message fanout semantics.

**Ready-to-merge expectation:** at least basic coverage for:
- create group (invite-only/open/key-protected)
- membership (add/remove/join/leave) + role enforcement
- post message fanout delivers unique per-recipient messages
- history endpoint dedupes on `group_message_id`

---

### 4) CI does not run tests on PRs

**Current:** `.github/workflows/claude-code-review.yml` runs only the Claude review action.  
**Impact:** PR can be “green” without actually executing `npm test` in CI.

**Ready-to-merge expectation:** a PR check that runs `npm ci` + `npm test` (and ideally lint, if configured).

---

### 5) Brain TS client appears out-of-sync / unvalidated

**File:** `brain/lib/admp.ts`  
**Observations:**
- Contains `subscribeToChannel` / `postToChannel` calls to `/api/channels/...` which do not exist in the hub.
- Imports `tweetnacl-util` types/helpers, which are not listed in repo dependencies.
- Repo has no TS build/test pipeline; this file may be “library stub” but is not validated.

**Ready-to-merge expectation:** either:
- the brain client compiles and matches server endpoints, or
- it is explicitly documented as **example / non-shipping reference**, or moved to a package with its own build tooling.

---

## 🟢 Medium / Nice-to-Have (Post-Merge)

- **Group ID ergonomics**: IDs are `group://...` which require URL encoding in path params. Works if clients encode, but is a common footgun; document clearly or adjust routing/ID format.
- **Security hardening**: consider rate limiting for group endpoints; consider whether returning `join_key_hash` is desirable.
- **Error mapping**: `src/routes/groups.js` maps status codes by substring matching error messages; consider structured error types/codes to avoid brittle coupling.
- **Dependencies**: local `npm install` surfaced **3 high severity vulnerabilities** (`npm audit`). Whether this blocks merge depends on policy, but it should be triaged.

---

## Recommended “Ready to Merge” Target State

### Required (for merge)
- [ ] Fix ESM crypto import in `GroupService.hashKey()`
- [ ] Update `openapi.yaml` with all new groups endpoints + request/response schemas
- [ ] Add basic groups tests to `src/server.test.js` (or split into `src/groups.test.js` if preferred)
- [ ] Add CI workflow to run `npm ci` + `npm test` on PRs

### Optional (track as follow-up issues)
- [ ] Decide how `brain/lib/*.ts` is shipped/validated (package it, or mark as examples)
- [ ] Rate limit group endpoints
- [ ] Improve error handling to use structured error codes
- [ ] Address `npm audit` findings

---

## Conclusion

PR #7 is close, but it’s **not merge-ready yet** due to:
1) a **real runtime bug** in key hashing for key-protected groups, and  
2) the **API contract not being reflected** in the served OpenAPI spec.

If those are fixed and we add minimal groups tests + a CI test job, this PR becomes a confident “ready to merge.”

