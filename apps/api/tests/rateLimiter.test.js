// apps/api/tests/rateLimiter.test.js
// Unit tests for the Redis sliding window rate limiter.
// Mocks the Redis client to simulate window behavior.

import { jest } from '@jest/globals';

// ─── Mock ioredis ─────────────────────────────────────────────────────────────

let mockCardValue = 1; // Controlled per test.

jest.unstable_mockModule('ioredis', () => {
  return {
    default: jest.fn().mockImplementation(() => ({
      pipeline: jest.fn(() => ({
        zremrangebyscore: jest.fn().mockReturnThis(),
        zadd: jest.fn().mockReturnThis(),
        zcard: jest.fn().mockReturnThis(),
        expire: jest.fn().mockReturnThis(),
        exec: jest.fn(() =>
          Promise.resolve([
            [null, 1],      // ZREMRANGEBYSCORE result
            [null, 1],      // ZADD result
            [null, mockCardValue], // ZCARD result — controlled per test
            [null, 1],      // EXPIRE result
          ])
        ),
      })),
      on: jest.fn(),
      quit: jest.fn().mockResolvedValue(undefined),
    })),
  };
});

const { slidingWindowCheck } = await import('../src/middleware/rateLimiter.js');

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('slidingWindowCheck — Redis sliding window rate limiter', () => {
  const TENANT_ID = 'tenant_test_001';
  const LIMIT = 100;

  test('allows requests within the limit', async () => {
    mockCardValue = 50; // 50 requests in the window — well under limit
    const result = await slidingWindowCheck(TENANT_ID, LIMIT);
    expect(result.allowed).toBe(true);
    expect(result.count).toBe(50);
  });

  test('allows requests at exactly the limit', async () => {
    mockCardValue = 100; // exactly at the limit — should be allowed
    const result = await slidingWindowCheck(TENANT_ID, LIMIT);
    expect(result.allowed).toBe(true);
    expect(result.count).toBe(100);
  });

  test('rejects requests over the limit', async () => {
    mockCardValue = 101; // one over the limit
    const result = await slidingWindowCheck(TENANT_ID, LIMIT);
    expect(result.allowed).toBe(false);
    expect(result.count).toBe(101);
    expect(result.limit).toBe(LIMIT);
  });

  test('returns correct limit in the result object', async () => {
    mockCardValue = 5;
    const result = await slidingWindowCheck(TENANT_ID, LIMIT);
    expect(result.limit).toBe(LIMIT);
  });

  test('allows requests again after the window resets', async () => {
    // Simulate that the window has reset (old entries were removed by ZREMRANGEBYSCORE).
    // Post-reset, count drops back to 1 (just the current request).
    mockCardValue = 1;
    const result = await slidingWindowCheck(TENANT_ID, LIMIT);
    expect(result.allowed).toBe(true);
    expect(result.count).toBe(1);
  });
});
