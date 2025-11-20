# Mech Storage Performance Optimization Roadmap

**Status:** 📋 Planned (not yet implemented)
**Created:** 2025-11-20
**Priority:** Post-production optimization
**Current Performance:** 35x slower than memory (acceptable for v1)

---

## Executive Summary

This document tracks performance optimizations for the Mech storage backend. These are **NOT blocking issues** for production deployment - Mech storage is functional and tested. However, implementing these optimizations will improve test execution time from 25s to ~6s (75% improvement).

**Decision:** Ship functional code now, optimize performance in future sprint.

---

## Performance Baseline

```
Current State (as of PR #5):
├─ Memory Storage:  700ms for 8 tests   (87ms/test)
└─ Mech Storage:    25,000ms for 11 tests (2,270ms/test)

   Performance Ratio: 35x slower
   Verdict: Acceptable for v1 (network storage always slower)
```

---

## Optimization Phases

### Phase 1: Quick Wins (2 hours) 🟡 HIGH PRIORITY

**Target:** 75% performance improvement
**Effort:** 2 hours
**ROI:** High - simple HTTP best practices

#### 1.1 Add HTTP Connection Pooling
**File:** `src/storage/mech.js`
**Lines:** 23-64 (request method)
**Effort:** 30 minutes
**Impact:** 60% faster

**Current Issue:**
```javascript
// Line 38: Creates new connection every time
async request(path, options) {
  const res = await fetch(url, init);  // New TCP + TLS handshake (250ms overhead)
}
```

**Solution:**
```javascript
// Add to constructor
import { Agent } from 'undici';

constructor({ baseUrl, appId, apiKey }) {
  this.baseUrl = baseUrl || 'https://storage.mechdna.net';
  this.appId = appId;
  this.apiKey = apiKey;

  // HTTP connection pool
  this.agent = new Agent({
    keepAliveTimeout: 60000,
    keepAliveMaxTimeout: 600000,
    connections: 10
  });
}

// Update request method
async request(path, options) {
  const res = await fetch(url, {
    ...options,
    dispatcher: this.agent  // Reuse connections
  });
}
```

**Dependencies:**
```bash
npm install undici
```

**Expected Result:**
- Before: 400ms per request
- After: 150ms per request
- Savings: 250ms × 50 requests/test = 12.5 seconds

---

#### 1.2 Add Client-Side Caching
**File:** `src/storage/mech.js`
**Lines:** 100-113 (getAgent), 174-187 (getMessage)
**Effort:** 1 hour
**Impact:** 50-70% reduction in read operations

**Current Issue:**
```javascript
// Line 100: Always hits network
async getAgent(agentId) {
  const { json } = await this.request(...);  // No cache check
  return this.extractDocument(json);
}
```

**Solution:**
```javascript
class MechStorage {
  constructor({ baseUrl, appId, apiKey }) {
    // ... existing code
    this.cache = new Map();
    this.cacheTTL = {
      agents: 60000,    // 1 minute (agents rarely change)
      messages: 5000    // 5 seconds (messages change frequently)
    };
  }

  getCacheKey(type, id) {
    return `${type}:${id}`;
  }

  getCached(type, id) {
    const key = this.getCacheKey(type, id);
    const cached = this.cache.get(key);

    if (!cached) return null;

    const age = Date.now() - cached.timestamp;
    const ttl = this.cacheTTL[type] || 5000;

    if (age > ttl) {
      this.cache.delete(key);
      return null;
    }

    return cached.data;
  }

  setCache(type, id, data) {
    const key = this.getCacheKey(type, id);
    this.cache.set(key, {
      data,
      timestamp: Date.now()
    });
  }

  invalidateCache(type, id) {
    const key = this.getCacheKey(type, id);
    this.cache.delete(key);
  }

  async getAgent(agentId) {
    // Check cache first
    const cached = this.getCached('agents', agentId);
    if (cached) return cached;

    // Fetch from API
    const { json } = await this.request(
      `/nosql/documents/key/${encodeURIComponent(agentId)}?collection_name=admp_agents`,
      { allow404: true }
    );

    if (json?.status === 404) return null;

    const agent = this.extractDocument(json?.data);

    // Store in cache
    if (agent) {
      this.setCache('agents', agentId, agent);
    }

    return agent;
  }

  async updateAgent(agentId, updates) {
    this.invalidateCache('agents', agentId);  // Invalidate before update
    // ... rest of update logic
  }
}
```

**Expected Result:**
- Message flow with repeated agent lookups:
  - Before: 3 × 400ms = 1,200ms
  - After: 400ms + 0ms + 0ms = 400ms
  - Savings: 800ms per flow

---

#### 1.3 Parallelize Sequential Loops
**File:** `src/storage/mech.js`
**Lines:** 247-255 (expireLeases), 267-277 (expireMessages), 288-298 (cleanupExpiredMessages)
**Effort:** 30 minutes
**Impact:** 95% faster bulk operations

**Current Issue:**
```javascript
// Line 247: Sequential updates
async expireLeases() {
  // ...
  for (const message of messages) {
    if (message.status === 'leased' && message.lease_until < now) {
      await this.updateMessage(message.id, { ... });  // Blocks loop
      expired++;
    }
  }
  return expired;
}
```

**Solution:**
```javascript
async expireLeases() {
  const now = Date.now();
  const { json } = await this.request('/nosql/documents?collection_name=admp_messages&limit=1000');
  const messages = this.extractDocuments(json);

  // Find expired messages
  const expiredMessages = messages.filter(
    m => m.status === 'leased' && m.lease_until && m.lease_until < now
  );

  if (expiredMessages.length === 0) return 0;

  // Update in parallel with concurrency limit
  const CONCURRENCY = 10;
  const chunks = [];
  for (let i = 0; i < expiredMessages.length; i += CONCURRENCY) {
    chunks.push(expiredMessages.slice(i, i + CONCURRENCY));
  }

  let expired = 0;
  for (const chunk of chunks) {
    const updates = chunk.map(message =>
      this.updateMessage(message.id, {
        status: 'queued',
        lease_until: null
      }).then(() => expired++)
    );
    await Promise.all(updates);
  }

  return expired;
}
```

**Apply same pattern to:**
- `expireMessages()` (Line 260)
- `cleanupExpiredMessages()` (Line 282)

**Expected Result:**
- Cleanup with 50 messages:
  - Before: 50 × 400ms = 20 seconds
  - After: 5 × 400ms = 2 seconds (10 concurrent)
  - Savings: 18 seconds per cleanup

---

**Phase 1 Total Impact:**
```
Test suite execution:
- Before: 25,000ms
- After Phase 1: ~6,000ms
- Improvement: 76% faster
```

**Dependencies to Add:**
```json
{
  "dependencies": {
    "undici": "^6.0.0"
  }
}
```

---

### Phase 2: API Optimization (3 hours) 🟢 MEDIUM PRIORITY

**Prerequisite:** Investigate Mech API capabilities

#### 2.1 Eliminate Double-Fetch Pattern
**File:** `src/storage/mech.js`
**Lines:** 115-130 (updateAgent), 189-204 (updateMessage)
**Effort:** 30 min (if supported) or 2 hours (workaround)
**Impact:** 50% faster updates

**Investigation Needed:**
1. Test if Mech PUT returns updated document:
   ```bash
   curl -X PUT https://storage.mechdna.net/api/apps/$APP_ID/nosql/documents/collection/key \
     -H "X-API-Key: $API_KEY" \
     -d '{"data": {...}}' \
     -v
   ```

2. Check response body - does it include updated document?

**If YES (Mech returns document):**
```javascript
async updateAgent(agentId, updates) {
  const { json } = await this.request(..., { method: 'PUT' });
  return this.extractDocument(json?.data);  // No second fetch needed
}
```

**If NO (Mech doesn't return document):**
- Keep current behavior OR
- Maintain optimistic cache of pending updates

**Expected Savings:** 400ms per update operation

---

#### 2.2 Server-Side Filtering
**File:** `src/storage/mech.js`
**Lines:** 215-224 (getInbox), 141-150 (listAgents)
**Effort:** 1-2 hours (depends on API support)
**Impact:** 70% faster inbox queries

**Investigation Needed:**
Check Mech API documentation for query filter support:
- Does it support `?filter[field]=value`?
- Does it support `?where=field:value`?
- Does it support JSON query objects?

**If Supported:**
```javascript
async getInbox(agentId, status = null) {
  let query = `collection_name=admp_messages&limit=1000`;

  // Server-side filter (if Mech supports it)
  query += `&filter[to_agent_id]=${encodeURIComponent(agentId)}`;

  if (status) {
    query += `&filter[status]=${status}`;
  }

  const { json } = await this.request(`/nosql/documents?${query}`);
  return this.extractDocuments(json);  // Already filtered
}
```

**If NOT Supported:**
- Consider per-agent collections: `admp_inbox_{agentId}`
- Or accept client-side filtering as necessary

**Expected Savings:**
- Data transfer: 500KB → 1.5KB (333x less)
- Query time: 600ms → 150ms

---

#### 2.3 Add Request Timeout
**File:** `src/storage/mech.js`
**Lines:** 23-64 (request method)
**Effort:** 30 minutes
**Impact:** Better error handling, prevent hangs

**Current Issue:** No timeout - requests can hang indefinitely

**Solution:**
```javascript
async request(path, { method = 'GET', body, allow404 = false, timeout = 30000 } = {}) {
  this.ensureConfigured();

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeout);

  try {
    const res = await fetch(url, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
      dispatcher: this.agent
    });

    clearTimeout(timeoutId);

    // ... rest of logic
  } catch (error) {
    clearTimeout(timeoutId);

    if (error.name === 'AbortError') {
      throw new Error(`Mech request timeout after ${timeout}ms`);
    }
    throw error;
  }
}
```

**Configuration:**
```javascript
constructor({ baseUrl, appId, apiKey, requestTimeout = 30000 }) {
  this.requestTimeout = requestTimeout;
}
```

---

### Phase 3: Advanced Features (4-6 hours) 🔵 LOW PRIORITY

#### 3.1 Implement Circuit Breaker
**Effort:** 2 hours
**Impact:** Prevent cascading failures

**Use Case:** When Mech API is down, fail fast instead of waiting for timeouts

**Solution:** Use `opossum` circuit breaker library

```javascript
import CircuitBreaker from 'opossum';

constructor({ baseUrl, appId, apiKey }) {
  // ... existing code

  this.breaker = new CircuitBreaker(this._rawRequest.bind(this), {
    timeout: 30000,
    errorThresholdPercentage: 50,
    resetTimeout: 30000
  });
}

async request(path, options) {
  return this.breaker.fire(path, options);
}
```

---

#### 3.2 Add Retry Logic with Exponential Backoff
**Effort:** 1 hour
**Impact:** Graceful handling of transient failures

**Solution:**
```javascript
async requestWithRetry(path, options, maxRetries = 3) {
  let lastError;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      return await this.request(path, options);
    } catch (error) {
      lastError = error;

      // Don't retry on 4xx errors (client errors)
      if (error.status >= 400 && error.status < 500) {
        throw error;
      }

      // Exponential backoff
      const delay = Math.min(1000 * Math.pow(2, attempt), 10000);
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }

  throw lastError;
}
```

---

#### 3.3 Request Batching
**Effort:** 2-3 hours
**Impact:** 90% faster bulk operations (if Mech supports it)

**Investigation Needed:** Check if Mech provides batch endpoints

**If Supported:**
```javascript
async createAgents(agents) {
  const operations = agents.map(agent => ({
    collection_name: 'admp_agents',
    document_key: agent.agent_id,
    data: agent
  }));

  await this.request('/nosql/batch', {
    method: 'POST',
    body: { operations }
  });
}
```

**Fallback:** Use `Promise.all()` for parallel individual requests

---

## Implementation Priority

```
┌─────────────┬──────────┬────────┬─────────────┬──────────┐
│ Optimization│ Effort   │ Impact │ Dependencies│ Priority │
├─────────────┼──────────┼────────┼─────────────┼──────────┤
│ Connection  │ 30 min   │ 60%    │ undici      │ 🔴 High  │
│ Caching     │ 1 hour   │ 50-70% │ None        │ 🔴 High  │
│ Parallel    │ 30 min   │ 95%*   │ None        │ 🟡 High  │
│ Double-fetch│ 30 min   │ 50%    │ API research│ 🟡 Med   │
│ Filtering   │ 1-2 hrs  │ 70%    │ API support │ 🟢 Med   │
│ Timeout     │ 30 min   │ Quality│ None        │ 🟢 Med   │
│ Circuit Br. │ 2 hours  │ Quality│ opossum     │ 🔵 Low   │
│ Retry       │ 1 hour   │ Quality│ None        │ 🔵 Low   │
│ Batching    │ 2-3 hrs  │ 90%*   │ API support │ 🔵 Low   │
└─────────────┴──────────┴────────┴─────────────┴──────────┘

* Impact on specific operations (cleanup, bulk creates)
```

---

## Recommended Implementation Order

### Sprint 1: Core Performance (Post-Production)
**Timeline:** 2 hours
**Goal:** Make Mech usable for production workloads

1. Add connection pooling (30 min)
2. Add caching (1 hour)
3. Parallelize loops (30 min)

**Result:** 25s → 6s test execution (76% improvement)

---

### Sprint 2: API Optimization (Future)
**Timeline:** 3 hours
**Goal:** Optimize API usage patterns

1. Investigate Mech API capabilities (30 min)
2. Remove double-fetch if possible (30 min - 2 hours)
3. Add server-side filtering if supported (1-2 hours)
4. Add request timeout (30 min)

**Result:** Additional 10-20% improvement + better stability

---

### Sprint 3: Production Hardening (Future)
**Timeline:** 4 hours
**Goal:** Enterprise-grade reliability

1. Circuit breaker pattern (2 hours)
2. Retry with exponential backoff (1 hour)
3. Request batching if supported (2 hours)

**Result:** Graceful degradation, better error handling

---

## Testing Strategy

### Performance Benchmarks
Create benchmark suite to track improvements:

```javascript
// bench/mech-storage.bench.js
import { createMechStorage } from '../src/storage/mech.js';

const storage = createMechStorage();

console.time('Create 100 agents');
await Promise.all(
  Array.from({ length: 100 }, (_, i) =>
    storage.createAgent({ agent_id: `bench-${i}`, ... })
  )
);
console.timeEnd('Create 100 agents');

console.time('Read 100 agents (cold)');
await Promise.all(
  Array.from({ length: 100 }, (_, i) =>
    storage.getAgent(`bench-${i}`)
  )
);
console.timeEnd('Read 100 agents (cold)');

console.time('Read 100 agents (cached)');
await Promise.all(
  Array.from({ length: 100 }, (_, i) =>
    storage.getAgent(`bench-${i}`)
  )
);
console.timeEnd('Read 100 agents (cached)');
```

**Expected Results:**

```
BEFORE Optimization:
Create 100 agents: 40,000ms (sequential) or 4,000ms (parallel)
Read 100 agents (cold): 40,000ms
Read 100 agents (cached): 40,000ms (no cache)

AFTER Phase 1:
Create 100 agents: 1,500ms (parallel + connection reuse)
Read 100 agents (cold): 1,500ms (connection reuse)
Read 100 agents (cached): 50ms (cache hits)
```

---

## Monitoring & Metrics

**Add performance tracking:**

```javascript
class MechStorage {
  constructor({ baseUrl, appId, apiKey }) {
    // ... existing code
    this.metrics = {
      requests: { total: 0, errors: 0, timeouts: 0 },
      cache: { hits: 0, misses: 0 },
      latency: { min: Infinity, max: 0, avg: 0, samples: [] }
    };
  }

  recordLatency(duration) {
    this.metrics.latency.samples.push(duration);
    this.metrics.latency.min = Math.min(this.metrics.latency.min, duration);
    this.metrics.latency.max = Math.max(this.metrics.latency.max, duration);

    // Keep last 100 samples for avg
    if (this.metrics.latency.samples.length > 100) {
      this.metrics.latency.samples.shift();
    }

    const sum = this.metrics.latency.samples.reduce((a, b) => a + b, 0);
    this.metrics.latency.avg = sum / this.metrics.latency.samples.length;
  }

  getMetrics() {
    return {
      ...this.metrics,
      cache_hit_rate: this.metrics.cache.hits /
        (this.metrics.cache.hits + this.metrics.cache.misses)
    };
  }
}
```

**Expose via endpoint:**
```javascript
app.get('/api/storage/metrics', (req, res) => {
  res.json(storage.getMetrics());
});
```

---

## Migration Notes

### Switching to Optimized Version

**Before deployment:**
1. Update `package.json` to include `undici`
2. Run benchmark suite to confirm improvements
3. Update monitoring to track cache hit rates

**Environment variables (add to `.env`):**
```bash
# Mech Storage Performance
MECH_CONNECTION_POOL_SIZE=10
MECH_CACHE_TTL_AGENTS=60000
MECH_CACHE_TTL_MESSAGES=5000
MECH_REQUEST_TIMEOUT=30000
```

**Backwards compatible:** All optimizations are internal - no API changes

---

## Success Criteria

**Phase 1 Complete When:**
- [ ] Test suite runs in <7 seconds with Mech storage
- [ ] Connection reuse visible in logs
- [ ] Cache hit rate >60% for repeated reads
- [ ] Cleanup operations <2 seconds for 50 messages

**Phase 2 Complete When:**
- [ ] API investigation documented
- [ ] Double-fetch eliminated (if supported)
- [ ] Server-side filtering implemented (if supported)
- [ ] Request timeouts prevent hangs

**Phase 3 Complete When:**
- [ ] Circuit breaker prevents cascading failures
- [ ] Transient errors auto-retry
- [ ] Batch operations implemented (if supported)
- [ ] Performance metrics dashboard available

---

## References

- **Performance Analysis:** `MECH-PERFORMANCE-ANALYSIS.md`
- **Gap Analysis:** `PR-5-GAP-ANALYSIS.md`
- **Mech API Docs:** https://storage.mechdna.net/docs (TBD)
- **Related Issue:** Track as Issue #6 after PR #5 merges

---

## Decision Log

**2025-11-20:** Decision to ship functional code first, optimize later
- Rationale: Mech storage is tested and functional
- 35x slowdown is acceptable for v1 (network storage expected to be slower)
- Performance optimizations are straightforward but not critical path
- Total optimization effort: ~5 hours for 76% improvement

**Priority:** Ship working ADMP with Mech storage, optimize in follow-up sprint

---

**Document Status:** 📋 ACTIVE - Track as post-production tech debt
**Owner:** Engineering Team
**Next Review:** After PR #5 merges
