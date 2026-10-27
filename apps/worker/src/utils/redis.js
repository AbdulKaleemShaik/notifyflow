// apps/worker/src/utils/redis.js
// Single place to construct ioredis clients.
// REDIS_URL (e.g. rediss://default:<password>@<host>.upstash.io:6379 for Upstash, TLS
// implied by the rediss:// scheme) takes precedence over REDIS_HOST/REDIS_PORT.

import IORedis from 'ioredis';

/**
 * @param {import('ioredis').RedisOptions} [options] - Extra ioredis options.
 * @returns {import('ioredis').Redis}
 */
export function createRedisClient(options = {}) {
  if (process.env.REDIS_URL) return new IORedis(process.env.REDIS_URL, options);
  return new IORedis({
    host: process.env.REDIS_HOST || 'localhost',
    port: Number(process.env.REDIS_PORT) || 6379,
    ...options,
  });
}
