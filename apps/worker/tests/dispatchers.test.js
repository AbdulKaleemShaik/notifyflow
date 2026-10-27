// apps/worker/tests/dispatchers.test.js
// Email (Nodemailer) and in-app (Redis Pub/Sub + protobuf) dispatchers.
// nodemailer and ioredis are mocked; protobuf encoding is real.

import { jest } from '@jest/globals';

// ─── Mocks ────────────────────────────────────────────────────────────────────

const sendMail = jest.fn();
const createTransport = jest.fn(() => ({ sendMail }));
jest.unstable_mockModule('nodemailer', () => ({ default: { createTransport } }));

const publish = jest.fn().mockResolvedValue(1);
jest.unstable_mockModule('ioredis', () => ({
  default: jest.fn(() => ({ publish, on: jest.fn() })),
}));

const { dispatch: dispatchEmail } = await import('../src/dispatchers/emailDispatcher.js');
const { dispatch: dispatchWebSocket } = await import('../src/dispatchers/websocketDispatcher.js');
const { decodeWsMessage } = await import('@notifyflow/proto');

const ENV_KEYS = ['SMTP_HOST', 'SMTP_PORT', 'SMTP_USER', 'SMTP_PASS', 'SMTP_FROM'];
const savedEnv = {};

beforeEach(() => {
  jest.clearAllMocks();
  sendMail.mockResolvedValue({ messageId: '<abc@notifyflow>' });
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
  Object.assign(process.env, {
    SMTP_HOST: 'smtp.global.test',
    SMTP_PORT: '2525',
    SMTP_USER: 'global-user',
    SMTP_PASS: 'global-pass',
    SMTP_FROM: 'global@notifyflow.test',
  });
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

// ─── Email ────────────────────────────────────────────────────────────────────

describe('emailDispatcher', () => {
  test('falls back to global SMTP env vars when the tenant has no emailConfig', async () => {
    const result = await dispatchEmail({ userEmail: 'bob@shop.com' }, { emailConfig: null }, '<p>Hi</p>', 'Hello');

    expect(result).toEqual({ messageId: '<abc@notifyflow>' });
    expect(createTransport).toHaveBeenCalledWith({
      host: 'smtp.global.test',
      port: 2525,
      secure: false,
      auth: { user: 'global-user', pass: 'global-pass' },
    });
    expect(sendMail).toHaveBeenCalledWith({
      from: 'global@notifyflow.test',
      to: 'bob@shop.com',
      subject: 'Hello',
      html: '<p>Hi</p>',
    });
  });

  test('prefers the tenant’s own SMTP config and from-address (multi-tenancy)', async () => {
    const tenant = {
      emailConfig: {
        smtpHost: 'smtp.acme.com',
        smtpPort: 465,
        smtpUser: 'acme',
        smtpPass: 'acme-pass',
        fromAddress: 'no-reply@acme.com',
      },
    };
    await dispatchEmail({ userEmail: 'bob@shop.com' }, tenant, 'body', 'subj');

    expect(createTransport).toHaveBeenCalledWith(
      expect.objectContaining({ host: 'smtp.acme.com', port: 465, auth: { user: 'acme', pass: 'acme-pass' } })
    );
    expect(sendMail.mock.calls[0][0].from).toBe('no-reply@acme.com');
  });

  test('defaults the subject when the rendered subject is empty', async () => {
    await dispatchEmail({ userEmail: 'a@b.c' }, null, 'body', '');
    expect(sendMail.mock.calls[0][0].subject).toBe('(No Subject)');
  });

  test('missing recipient → non-retryable, nothing sent', async () => {
    await expect(dispatchEmail({ userEmail: '' }, null, 'b', 's')).rejects.toMatchObject({ shouldRetry: false });
    expect(sendMail).not.toHaveBeenCalled();
  });

  test('SMTP auth failure (535) → non-retryable', async () => {
    sendMail.mockRejectedValue(new Error('Invalid login: 535 5.7.8 Authentication failed'));
    await expect(dispatchEmail({ userEmail: 'a@b.c' }, null, 'b', 's')).rejects.toMatchObject({
      shouldRetry: false,
      reason: 'SMTP_AUTH_FAILURE',
    });
  });

  test('SMTP connection timeout → retryable', async () => {
    sendMail.mockRejectedValue(new Error('Connection timeout'));
    await expect(dispatchEmail({ userEmail: 'a@b.c' }, null, 'b', 's')).rejects.toMatchObject({
      shouldRetry: true,
      reason: 'NETWORK_TIMEOUT',
    });
  });
});

// ─── In-app (WebSocket via Redis Pub/Sub) ─────────────────────────────────────

describe('websocketDispatcher', () => {
  test('publishes a protobuf WsMessage to notifications:{userId}', async () => {
    await dispatchWebSocket({
      notificationLogId: 'log-1',
      userId: 'user-42',
      templateName: 'order_confirmed',
      renderedBody: 'Hi Bob, your order #ORD-7743 has been confirmed!',
      data: { firstName: 'Bob', order: { id: 'ORD-7743' } },
    });

    expect(publish).toHaveBeenCalledTimes(1);
    const [channel, message] = publish.mock.calls[0];
    expect(channel).toBe('notifications:user-42');
    expect(Buffer.isBuffer(message)).toBe(true);

    // The ws-server decodes exactly this buffer.
    const decoded = await decodeWsMessage(message);
    expect(decoded).toEqual({
      type: 'notification',
      notificationId: 'log-1',
      templateName: 'order_confirmed',
      body: 'Hi Bob, your order #ORD-7743 has been confirmed!',
      timestamp: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
      data: { firstName: 'Bob', order: { id: 'ORD-7743' } },
    });
  });

  test('protobuf frame is smaller than the equivalent JSON', async () => {
    const payload = {
      notificationLogId: '6632ab0000000000000000aa',
      userId: 'user-42',
      templateName: 'order_confirmed',
      renderedBody: 'Hi Bob, your order #ORD-7743 has been confirmed!',
      data: { firstName: 'Bob', orderId: 'ORD-7743' },
    };
    await dispatchWebSocket(payload);
    const [, buf] = publish.mock.calls[0];
    const decoded = await decodeWsMessage(buf);
    expect(buf.length).toBeLessThan(Buffer.byteLength(JSON.stringify(decoded)));
  });

  test('propagates Redis publish errors so the job is retried', async () => {
    publish.mockRejectedValueOnce(new Error('Connection is closed.'));
    await expect(
      dispatchWebSocket({ notificationLogId: 'l', userId: 'u', templateName: 't', renderedBody: 'b', data: {} })
    ).rejects.toThrow('Connection is closed.');
  });
});
