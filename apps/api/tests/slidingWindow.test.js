// apps/api/tests/slidingWindow.test.js
// Behavioural tests for the sliding-window rate limiter.
// Instead of hard-coding ZCARD results, ioredis is replaced with a tiny in-memory
// sorted-set implementation so the real algorithm (ZREMRANGEBYSCORE → ZADD → ZCARD
// → EXPIRE in one pipeline) is exercised end to end with a controllable clock.

import { jest } from '@jest/globals';

// ─── In-memory sorted-set Redis ───────────────────────────────────────────────

const zsets = new Map(); // key -> Map(member -> score)
const ttls = new Map();
let failNextExec = false;

function makePipeline() {
  const ops = [];
  const pipeline = {
    zremrangebyscore(key, min, max) {
      ops.push(() => {
        const set = zsets.get(key) || new Map();
        let removed = 0;
        for (const [member, score] of set) {
          if (score >= min && score <= max) { set.delete(member); removed += 1; }
        }
        return removed;
      });
      return pipeline;
    },
    zadd(key, score, member) {
      ops.push(() => {
        if (!zsets.has(key)) zsets.set(key, new Map());
        zsets.get(key).set(member, score);
        return 1;
      });
      return pipeline;
    },
    zcard(key) {
      ops.push(() => (zsets.get(key)?.size ?? 0));
      return pipeline;
    },
    expire(key, seconds) {
      ops.push(() => { ttls.set(key, seconds); return 1; });
      return pipeline;
    },
    async exec() {
      if (failNextExec) { failNextExec = false; throw new Error('ECONNREFUSED'); }
      return ops.map((op) => [null, op()]);
    },
  };
  return pipeline;
}

jest.unstable_mockModule('ioredis', () => ({
  default: jest.fn(() => ({ pipeline: makePipeline, on: jest.fn(), quit: jest.fn() })),
}));

const { slidingWindowCheck, rateLimiter } = await import('../src/middleware/rateLimiter.js');

// ─── Helpers ──────────────────────────────────────────────────────────────────

let now = 1_700_000_000_000;
beforeEach(() => {
  zsets.clear();
  ttls.clear();
  failNextExec = false;
  now = 1_700_000_000_000;
  jest.spyOn(Date, 'now').mockImplementation(() => now);
});
afterEach(() => jest.restoreAllMocks());

const send = async (tenantId, limit, n) => {
  const results = [];
  for (let i = 0; i < n; i += 1) results.push(await slidingWindowCheck(tenantId, limit));
  return results;
};

function runMiddleware(req) {
  return new Promise((resolve) => {
    const headers = {};
    const res = {
      statusCode: 200,
      setHeader: (k, v) => { headers[k] = v; },
      status(code) { this.statusCode = code; return this; },
      json(body) { resolve({ nextCalled: false, status: this.statusCode, body, headers }); return this; },
    };
    rateLimiter(req, res, () => resolve({ nextCalled: true, status: res.statusCode, headers }));
  });
}

// ─── Algorithm ────────────────────────────────────────────────────────────────

describe('slidingWindowCheck — algorithm', () => {
  test('allows exactly `limit` requests per minute, then rejects', async () => {
    const results = await send('t1', 3, 4);
    expect(results.map((r) => r.allowed)).toEqual([true, true, true, false]);
    expect(results.map((r) => r.count)).toEqual([1, 2, 3, 4]);
  });

  test('the window slides: requests older than 60s stop counting', async () => {
    await send('t1', 2, 2);                // t=0s: 2 requests (window full)
    now += 30_000;
    expect((await slidingWindowCheck('t1', 2)).allowed).toBe(false); // t=30s: still full

    now += 30_001;                          // t=60.001s: the two t=0 entries expire
    const r = await slidingWindowCheck('t1', 2);
    // Only the t=30s entry (counted, though rejected) and this one remain.
    expect(r).toEqual({ allowed: true, count: 2, limit: 2 });
  });

  test('is a true sliding window, not a fixed window reset', async () => {
    // 1 request at t=0, 1 at t=50s. At t=61s only the t=0 request has aged out.
    await slidingWindowCheck('t1', 2);
    now += 50_000;
    await slidingWindowCheck('t1', 2);
    now += 11_000;
    expect((await slidingWindowCheck('t1', 2)).count).toBe(2);
  });

  test('rejected requests still occupy the window (a client that keeps hammering stays limited)', async () => {
    await send('t1', 1, 5);
    expect(zsets.get('ratelimit:t1').size).toBe(5);
  });

  test('isolates tenants from each other', async () => {
    await send('noisy', 2, 10);
    const quiet = await slidingWindowCheck('quiet', 2);
    expect(quiet).toEqual({ allowed: true, count: 1, limit: 2 });
  });

  test('stores unique members for requests in the same millisecond', async () => {
    await send('t1', 100, 3); // Date.now() is frozen — all share a timestamp
    expect(zsets.get('ratelimit:t1').size).toBe(3);
  });

  test('sets a TTL slightly longer than the window so idle keys expire', async () => {
    await slidingWindowCheck('t1', 10);
    expect(ttls.get('ratelimit:t1')).toBe(70);
  });
});

// ─── Express middleware ───────────────────────────────────────────────────────

describe('rateLimiter middleware', () => {
  test('calls next() and sets X-RateLimit-* headers while under the limit', async () => {
    const out = await runMiddleware({ tenant: { tenantId: 't1' }, tenantDoc: { rateLimit: 5 } });
    expect(out.nextCalled).toBe(true);
    expect(out.headers).toEqual({
      'X-RateLimit-Limit': 5,
      'X-RateLimit-Remaining': 4,
      'X-RateLimit-Reset': Math.ceil((now + 60_000) / 1000),
    });
  });

  test('defaults to 100 req/min when the tenant has no rateLimit', async () => {
    const out = await runMiddleware({ tenant: { tenantId: 't1' } });
    expect(out.headers['X-RateLimit-Limit']).toBe(100);
  });

  test('responds 429 RATE_LIMIT_EXCEEDED once the limit is exceeded', async () => {
    const req = { tenant: { tenantId: 't1' }, tenantDoc: { rateLimit: 1 } };
    await runMiddleware(req);
    const out = await runMiddleware(req);
    expect(out.nextCalled).toBe(false);
    expect(out.status).toBe(429);
    expect(out.body.code).toBe('RATE_LIMIT_EXCEEDED');
    expect(out.headers['X-RateLimit-Remaining']).toBe(0);
  });

  test('fails open (calls next) when Redis is unavailable', async () => {
    failNextExec = true;
    const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const out = await runMiddleware({ tenant: { tenantId: 't1' }, tenantDoc: { rateLimit: 1 } });
    expect(out.nextCalled).toBe(true);
    expect(errSpy).toHaveBeenCalled();
  });
});
