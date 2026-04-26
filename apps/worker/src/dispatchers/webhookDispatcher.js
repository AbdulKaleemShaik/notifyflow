// apps/worker/src/dispatchers/webhookDispatcher.js
// Sends outbound webhook POSTs to tenant-configured URLs.
// Uses native https module (no axios), HMAC-signs every request, enforces 5s timeout.

import https from 'https';
import http from 'http';
import crypto from 'crypto';
import { classifyError } from '../utils/retry.js';

const TIMEOUT_MS = 5000;

/**
 * Make an outbound HTTP/HTTPS POST request.
 * @returns {Promise<{ statusCode: number, body: string }>}
 */
function httpPost(url, body, headers) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const isHttps = parsed.protocol === 'https:';
    const transport = isHttps ? https : http;

    const bodyStr = typeof body === 'string' ? body : JSON.stringify(body);
    const options = {
      hostname: parsed.hostname,
      port: parsed.port || (isHttps ? 443 : 80),
      path: parsed.pathname + parsed.search,
      method: 'POST',
      headers: {
        ...headers,
        'Content-Length': Buffer.byteLength(bodyStr),
      },
    };

    const req = transport.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => resolve({ statusCode: res.statusCode, body: data }));
    });

    req.setTimeout(TIMEOUT_MS, () => {
      req.destroy();
      reject(Object.assign(new Error(`Webhook POST timed out after ${TIMEOUT_MS}ms`), { timeout: true }));
    });

    req.on('error', reject);
    req.write(bodyStr);
    req.end();
  });
}

/**
 * Dispatch a webhook notification.
 *
 * @param {object} payload
 * @param {string} payload.notificationLogId
 * @param {string} payload.userId
 * @param {string} payload.templateName
 * @param {object} payload.data
 * @param {string} payload.webhookUrl
 * @param {string} payload.tenantSecret  - Used for HMAC signing
 * @returns {Promise<{ statusCode: number, body: string }>}
 */
export async function dispatch(payload) {
  if (!payload.webhookUrl) {
    throw Object.assign(
      new Error('Tenant has no webhookUrl configured'),
      { shouldRetry: false, statusCode: 400 }
    );
  }

  const webhookPayload = {
    event: payload.templateName,
    userId: payload.userId,
    data: payload.data,
    timestamp: new Date().toISOString(),
  };

  const bodyStr = JSON.stringify(webhookPayload);
  const unixTimestamp = Math.floor(Date.now() / 1000);

  // Compute HMAC-SHA256 signature for payload verification on the tenant's end.
  const hmac = crypto
    .createHmac('sha256', payload.tenantSecret || '')
    .update(bodyStr)
    .digest('hex');

  const headers = {
    'Content-Type': 'application/json',
    'X-NotifyFlow-Signature': `sha256=${hmac}`,
    'X-NotifyFlow-Timestamp': String(unixTimestamp),
    'X-NotifyFlow-DeliveryId': payload.notificationLogId,
  };

  try {
    const response = await httpPost(payload.webhookUrl, bodyStr, headers);
    const { statusCode, body } = response;

    // 4xx — client config error, don't retry.
    if (statusCode >= 400 && statusCode < 500) {
      const err = Object.assign(
        new Error(`Webhook returned ${statusCode}: ${body.slice(0, 200)}`),
        { shouldRetry: false, statusCode, responseBody: body }
      );
      throw err;
    }

    // 5xx — server error, allow retry.
    if (statusCode >= 500) {
      const err = Object.assign(
        new Error(`Webhook returned ${statusCode}: ${body.slice(0, 200)}`),
        { shouldRetry: true, statusCode, responseBody: body }
      );
      throw err;
    }

    // 2xx — success.
    return { statusCode, body };
  } catch (err) {
    if (err.shouldRetry === undefined) {
      const { shouldRetry, reason } = classifyError(err, 'webhook');
      err.shouldRetry = shouldRetry;
      err.reason = reason;
    }
    throw err;
  }
}

export default { dispatch };
