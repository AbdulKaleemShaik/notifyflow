// apps/worker/src/utils/retry.js
// Retry utility helpers used by dispatchers to classify errors.

/**
 * Determine whether a given error should be retried.
 * Some errors are terminal — retrying won't help (e.g., invalid SMTP credentials,
 * invalid recipient, 4xx webhook responses). Others are transient (network timeout,
 * 5xx webhook responses) and should be retried.
 *
 * @param {Error} err        - The error thrown by a dispatcher.
 * @param {string} channel   - 'email' | 'webhook' | 'in-app'
 * @returns {{ shouldRetry: boolean, reason: string }}
 */
export function classifyError(err, channel) {
  const msg = (err.message || '').toLowerCase();
  // Matches "timeout", "timed out" (our webhook timeout message) and ETIMEDOUT socket errors.
  const isTimeout = err.timeout === true
    || msg.includes('timeout')
    || msg.includes('timed out')
    || msg.includes('etimedout');

  if (channel === 'email') {
    // SMTP auth failures — retrying will not help.
    if (msg.includes('auth') || msg.includes('535') || msg.includes('534')) {
      return { shouldRetry: false, reason: 'SMTP_AUTH_FAILURE' };
    }
    // Invalid recipient — retrying will not help.
    if (msg.includes('550') || msg.includes('551') || msg.includes('invalid recipient')) {
      return { shouldRetry: false, reason: 'INVALID_RECIPIENT' };
    }
    // Network timeouts — transient, should retry.
    if (isTimeout || msg.includes('econnrefused') || msg.includes('enotfound')) {
      return { shouldRetry: true, reason: 'NETWORK_TIMEOUT' };
    }
  }

  if (channel === 'webhook') {
    // 4xx client errors — tenant config problem, don't retry.
    const status = err.statusCode || err.status || 0;
    if (status >= 400 && status < 500) {
      return { shouldRetry: false, reason: `HTTP_${status}_CLIENT_ERROR` };
    }
    // 5xx server errors — transient, retry.
    if (status >= 500) {
      return { shouldRetry: true, reason: `HTTP_${status}_SERVER_ERROR` };
    }
    // Timeout
    if (isTimeout) {
      return { shouldRetry: true, reason: 'WEBHOOK_TIMEOUT' };
    }
  }

  // Default: allow retry for unknown errors.
  return { shouldRetry: true, reason: 'UNKNOWN_ERROR' };
}

/**
 * Sleep for a given number of milliseconds.
 * @param {number} ms
 */
export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
