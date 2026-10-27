// apps/worker/tests/webhookDispatcher.test.js
// Exercises the webhook dispatcher against a real local HTTP server:
// HMAC-SHA256 signing, headers, and 2xx/4xx/5xx/timeout classification.

import http from 'http';
import crypto from 'crypto';
import { dispatch } from '../src/dispatchers/webhookDispatcher.js';

let server;
let baseUrl;
let nextResponse = { status: 200, body: 'ok' };
let received = [];

beforeAll(async () => {
  server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      received.push({ method: req.method, url: req.url, headers: req.headers, body });
      if (nextResponse.hang) return; // never respond → triggers client timeout
      res.writeHead(nextResponse.status, { 'Content-Type': 'text/plain' });
      res.end(nextResponse.body);
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

afterAll(async () => {
  server.closeAllConnections?.();
  await new Promise((resolve) => server.close(resolve));
});

beforeEach(() => {
  received = [];
  nextResponse = { status: 200, body: 'ok' };
});

const SECRET = 'whsec_test_123';
const payload = (overrides = {}) => ({
  notificationLogId: 'log-1',
  userId: 'user-42',
  templateName: 'order_confirmed',
  data: { orderId: 'ORD-1' },
  webhookUrl: `${baseUrl}/hooks/notify?src=nf`,
  tenantSecret: SECRET,
  ...overrides,
});

/** How a tenant would verify a delivery on their side. */
function verify(rawBody, signatureHeader, secret) {
  const expected = `sha256=${crypto.createHmac('sha256', secret).update(rawBody).digest('hex')}`;
  return (
    expected.length === signatureHeader.length &&
    crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signatureHeader))
  );
}

describe('webhookDispatcher — HMAC signing', () => {
  test('POSTs JSON with a valid sha256 HMAC of the exact raw body', async () => {
    await expect(dispatch(payload())).resolves.toEqual({ statusCode: 200, body: 'ok' });

    const [req] = received;
    expect(req.method).toBe('POST');
    expect(req.url).toBe('/hooks/notify?src=nf'); // path + query preserved
    expect(req.headers['content-type']).toBe('application/json');
    expect(req.headers['x-notifyflow-signature']).toMatch(/^sha256=[0-9a-f]{64}$/);
    expect(verify(req.body, req.headers['x-notifyflow-signature'], SECRET)).toBe(true);
  });

  test('signature does not verify with a different secret or a tampered body', async () => {
    await dispatch(payload());
    const [req] = received;
    const sig = req.headers['x-notifyflow-signature'];

    expect(verify(req.body, sig, 'wrong-secret')).toBe(false);
    expect(verify(req.body.replace('ORD-1', 'ORD-2'), sig, SECRET)).toBe(false);
  });

  test('body carries event, userId, data and ISO timestamp; delivery headers are set', async () => {
    await dispatch(payload());
    const [req] = received;

    expect(JSON.parse(req.body)).toEqual({
      event: 'order_confirmed',
      userId: 'user-42',
      data: { orderId: 'ORD-1' },
      timestamp: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
    });
    expect(req.headers['x-notifyflow-deliveryid']).toBe('log-1');
    const ts = Number(req.headers['x-notifyflow-timestamp']);
    expect(Math.abs(ts - Date.now() / 1000)).toBeLessThan(5);
    expect(Number(req.headers['content-length'])).toBe(Buffer.byteLength(req.body));
  });

  test('each tenant gets a different signature for the same payload', async () => {
    await dispatch(payload({ tenantSecret: 'tenant-a' }));
    await dispatch(payload({ tenantSecret: 'tenant-b' }));
    expect(verify(received[0].body, received[0].headers['x-notifyflow-signature'], 'tenant-a')).toBe(true);
    expect(verify(received[1].body, received[1].headers['x-notifyflow-signature'], 'tenant-b')).toBe(true);
    expect(verify(received[1].body, received[1].headers['x-notifyflow-signature'], 'tenant-a')).toBe(false);
  });
});

describe('webhookDispatcher — response classification', () => {
  test('4xx → non-retryable error with status and response body attached', async () => {
    nextResponse = { status: 410, body: 'endpoint gone' };
    await expect(dispatch(payload())).rejects.toMatchObject({
      message: 'Webhook returned 410: endpoint gone',
      shouldRetry: false,
      statusCode: 410,
      responseBody: 'endpoint gone',
    });
  });

  test('5xx → retryable error', async () => {
    nextResponse = { status: 503, body: 'try later' };
    await expect(dispatch(payload())).rejects.toMatchObject({ shouldRetry: true, statusCode: 503 });
  });

  test('error message truncates huge response bodies to 200 chars', async () => {
    nextResponse = { status: 500, body: 'x'.repeat(5000) };
    const err = await dispatch(payload()).catch((e) => e);
    expect(err.message).toBe(`Webhook returned 500: ${'x'.repeat(200)}`);
  });

  test('missing webhookUrl → non-retryable, no request made', async () => {
    await expect(dispatch(payload({ webhookUrl: '' }))).rejects.toMatchObject({
      message: 'Tenant has no webhookUrl configured',
      shouldRetry: false,
    });
    expect(received).toHaveLength(0);
  });

  test('connection refused → retryable (classified by retry.js)', async () => {
    const closed = http.createServer();
    await new Promise((r) => closed.listen(0, '127.0.0.1', r));
    const { port } = closed.address();
    await new Promise((r) => closed.close(r));

    await expect(dispatch(payload({ webhookUrl: `http://127.0.0.1:${port}/` }))).rejects.toMatchObject({
      shouldRetry: true,
      reason: 'UNKNOWN_ERROR',
    });
  });

  test('times out after 5s → retryable WEBHOOK_TIMEOUT', async () => {
    nextResponse = { hang: true };
    const started = Date.now();
    await expect(dispatch(payload())).rejects.toMatchObject({
      message: 'Webhook POST timed out after 5000ms',
      shouldRetry: true,
      reason: 'WEBHOOK_TIMEOUT',
    });
    expect(Date.now() - started).toBeGreaterThanOrEqual(4900);
  }, 10_000);
});
