// apps/api/tests/rateLimiter.redis.test.js
// Integration test: runs the sliding-window limiter against a REAL Redis server.
// Opt-in — set REDIS_INTEGRATION=1 (CI does this with a Redis service container):
//
//   REDIS_INTEGRATION=1 REDIS_HOST=localhost REDIS_PORT=6379 npm test
//
// Without the flag the suite is skipped so `npm test` needs no infrastructure.

import { randomUUID } from 'crypto';

const enabled = process.env.REDIS_INTEGRATION === '1';
const describeIfRedis = enabled ? describe : describe.skip;

describeIfRedis('slidingWindowCheck — real Redis', () => {
  let slidingWindowCheck;
  let redis;
  const tenantId = `it-${randomUUID()}`;
  const key = `ratelimit:${tenantId}`;

  beforeAll(async () => {
    const { default: IORedis } = await import('ioredis');
    ({ slidingWindowCheck } = await import('../src/middleware/rateLimiter.js'));
    redis = new IORedis({
      host: process.env.REDIS_HOST || 'localhost',
      port: Number(process.env.REDIS_PORT) || 6379,
    });
  });

  afterAll(async () => {
    if (redis) {
      await redis.del(key);
      await redis.quit();
    }
  });

  test('allows `limit` requests then rejects, using a sorted set with a TTL', async () => {
    const results = [];
    for (let i = 0; i < 6; i += 1) results.push(await slidingWindowCheck(tenantId, 5));

    expect(results.map((r) => r.allowed)).toEqual([true, true, true, true, true, false]);
    expect(await redis.type(key)).toBe('zset');
    expect(await redis.zcard(key)).toBe(6);

    const ttl = await redis.ttl(key);
    expect(ttl).toBeGreaterThan(60);
    expect(ttl).toBeLessThanOrEqual(70);
  });

  test('entries older than the 60s window are trimmed on the next request', async () => {
    // Back-date every entry by 61 seconds, then make one more request.
    const members = await redis.zrange(key, 0, -1, 'WITHSCORES');
    const pipeline = redis.pipeline();
    for (let i = 0; i < members.length; i += 2) {
      pipeline.zadd(key, Number(members[i + 1]) - 61_000, members[i]);
    }
    await pipeline.exec();

    const result = await slidingWindowCheck(tenantId, 5);
    expect(result).toEqual({ allowed: true, count: 1, limit: 5 });
  });
});
