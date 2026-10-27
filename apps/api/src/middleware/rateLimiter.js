// apps/api/src/middleware/rateLimiter.js
// Redis sliding window rate limiter — no external library, uses sorted sets.
//
// Algorithm:
//   Key: ratelimit:{tenantId}
//   On each request:
//     1. ZREMRANGEBYSCORE — remove entries older than 1 minute
//     2. ZADD — add current timestamp (with random suffix for uniqueness)
//     3. ZCARD — count entries in the window
//   If count > tenant.rateLimit → 429

import { createRedisClient } from '../config/redis.js';
import logger from '../utils/logger.js';

const redis = createRedisClient({ lazyConnect: true });

redis.on('error', (err) => logger.error('RateLimiter Redis error:', err.message));

const WINDOW_MS = 60_000; // 1 minute sliding window
const KEY_TTL_SECONDS = 70; // TTL slightly longer than the window

/**
 * Express middleware factory.
 * Call after `authenticate` so `req.tenant` is populated.
 */
export function rateLimiter(req, res, next) {
  const { tenantId } = req.tenant;
  const tenantRateLimit = req.tenantDoc?.rateLimit ?? 100; // populated by auth or route handler

  slidingWindowCheck(tenantId, tenantRateLimit)
    .then(({ allowed, count, limit }) => {
      const remaining = Math.max(0, limit - count);
      const resetTimestamp = Math.ceil((Date.now() + WINDOW_MS) / 1000);

      res.setHeader('X-RateLimit-Limit', limit);
      res.setHeader('X-RateLimit-Remaining', remaining);
      res.setHeader('X-RateLimit-Reset', resetTimestamp);

      if (!allowed) {
        return res.status(429).json({
          error: 'Rate limit exceeded. Try again later.',
          code: 'RATE_LIMIT_EXCEEDED',
          retryAfter: resetTimestamp,
        });
      }
      next();
    })
    .catch((err) => {
      // Fail open: if Redis is down, don't block legitimate traffic.
      logger.error('Rate limiter error (failing open):', err.message);
      next();
    });
}

/**
 * Core sliding window logic — exported separately for unit testing.
 * @param {string} tenantId
 * @param {number} limit
 * @returns {{ allowed: boolean, count: number, limit: number }}
 */
export async function slidingWindowCheck(tenantId, limit) {
  const key = `ratelimit:${tenantId}`;
  const now = Date.now();
  const windowStart = now - WINDOW_MS;

  // Use a pipeline to send all commands in one round-trip.
  const pipeline = redis.pipeline();

  // 1. Remove timestamps older than the window boundary.
  pipeline.zremrangebyscore(key, 0, windowStart);

  // 2. Add current timestamp. Member must be unique — use now + random suffix.
  const member = `${now}:${Math.random()}`;
  pipeline.zadd(key, now, member);

  // 3. Count all entries in the window.
  pipeline.zcard(key);

  // 4. Set TTL so keys don't accumulate for inactive tenants.
  pipeline.expire(key, KEY_TTL_SECONDS);

  const results = await pipeline.exec();

  // results[2] is [error, cardValue] for ZCARD.
  const count = results[2][1];

  return {
    allowed: count <= limit,
    count,
    limit,
  };
}
