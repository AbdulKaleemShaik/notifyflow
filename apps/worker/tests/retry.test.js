// apps/worker/tests/retry.test.js
// Unit tests for error classification (retryable vs. permanent) and sleep().

import { jest } from '@jest/globals';
import { classifyError, sleep } from '../src/utils/retry.js';

const err = (message, extra = {}) => Object.assign(new Error(message), extra);

describe('classifyError — email channel', () => {
  test.each([
    ['Invalid login: 535 Authentication failed', 'SMTP_AUTH_FAILURE'],
    ['534-5.7.9 Application-specific password required', 'SMTP_AUTH_FAILURE'],
    ['AUTH PLAIN not supported', 'SMTP_AUTH_FAILURE'],
  ])('%s → permanent (%s)', (message, reason) => {
    expect(classifyError(err(message), 'email')).toEqual({ shouldRetry: false, reason });
  });

  test.each([
    ['550 5.1.1 Mailbox does not exist'],
    ['551 User not local'],
    ['Invalid recipient address'],
  ])('%s → permanent (INVALID_RECIPIENT)', (message) => {
    expect(classifyError(err(message), 'email')).toEqual({ shouldRetry: false, reason: 'INVALID_RECIPIENT' });
  });

  test.each([
    ['Connection timeout'],
    ['connect ECONNREFUSED 127.0.0.1:587'],
    ['getaddrinfo ENOTFOUND smtp.example.com'],
    ['connect ETIMEDOUT 10.0.0.1:587'],
  ])('%s → retryable (NETWORK_TIMEOUT)', (message) => {
    expect(classifyError(err(message), 'email')).toEqual({ shouldRetry: true, reason: 'NETWORK_TIMEOUT' });
  });

  test('matching is case-insensitive', () => {
    expect(classifyError(err('CONNECTION TIMEOUT'), 'email').shouldRetry).toBe(true);
    expect(classifyError(err('INVALID RECIPIENT'), 'email').shouldRetry).toBe(false);
  });
});

describe('classifyError — webhook channel', () => {
  test.each([400, 401, 404, 410, 422, 499])('HTTP %i → permanent client error', (status) => {
    expect(classifyError(err('bad', { statusCode: status }), 'webhook')).toEqual({
      shouldRetry: false,
      reason: `HTTP_${status}_CLIENT_ERROR`,
    });
  });

  test.each([500, 502, 503, 504])('HTTP %i → retryable server error', (status) => {
    expect(classifyError(err('oops', { statusCode: status }), 'webhook')).toEqual({
      shouldRetry: true,
      reason: `HTTP_${status}_SERVER_ERROR`,
    });
  });

  test('reads `status` when `statusCode` is absent', () => {
    expect(classifyError(err('x', { status: 403 }), 'webhook').shouldRetry).toBe(false);
  });

  test.each([
    ['Webhook POST timed out after 5000ms', {}],   // the dispatcher's own timeout error
    ['socket hang up', { timeout: true }],          // flagged via err.timeout
    ['Request timeout', {}],
    ['connect ETIMEDOUT 10.0.0.1:443', {}],
  ])('%s → retryable WEBHOOK_TIMEOUT', (message, extra) => {
    expect(classifyError(err(message, extra), 'webhook')).toEqual({
      shouldRetry: true,
      reason: 'WEBHOOK_TIMEOUT',
    });
  });
});

describe('classifyError — defaults', () => {
  test('unknown errors are retried (safe default)', () => {
    expect(classifyError(err('socket hang up'), 'webhook')).toEqual({ shouldRetry: true, reason: 'UNKNOWN_ERROR' });
    expect(classifyError(err('something odd'), 'email')).toEqual({ shouldRetry: true, reason: 'UNKNOWN_ERROR' });
    expect(classifyError(err('redis down'), 'in-app')).toEqual({ shouldRetry: true, reason: 'UNKNOWN_ERROR' });
  });

  test('channel rules do not leak across channels (535 on a webhook is not an auth failure)', () => {
    expect(classifyError(err('535 auth'), 'webhook').reason).toBe('UNKNOWN_ERROR');
  });

  test('handles errors without a message', () => {
    expect(classifyError({}, 'email')).toEqual({ shouldRetry: true, reason: 'UNKNOWN_ERROR' });
  });
});

describe('sleep', () => {
  test('resolves after the given delay', async () => {
    jest.useFakeTimers();
    const done = jest.fn();
    const p = sleep(1000).then(done);

    await jest.advanceTimersByTimeAsync(999);
    expect(done).not.toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(1);
    await p;
    expect(done).toHaveBeenCalledTimes(1);
    jest.useRealTimers();
  });
});
