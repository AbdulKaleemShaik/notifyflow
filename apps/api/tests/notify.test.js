// apps/api/tests/notify.test.js
// Supertest integration tests for POST /notify.
// Mocks Redis, BullMQ and the Mongoose models so no real infrastructure is needed.
// The protobuf encoding is real, so the tests also verify the job wire format.

import { jest } from '@jest/globals';

// ─── Mock ioredis before any imports ─────────────────────────────────────────

let mockZcard = 1; // Number of requests in the rate-limit window, controlled per test.

jest.unstable_mockModule('ioredis', () => {
  const mockRedis = {
    set: jest.fn().mockResolvedValue('OK'),
    get: jest.fn().mockResolvedValue(null),
    del: jest.fn().mockResolvedValue(1),
    pipeline: jest.fn(() => ({
      zremrangebyscore: jest.fn().mockReturnThis(),
      zadd: jest.fn().mockReturnThis(),
      zcard: jest.fn().mockReturnThis(),
      expire: jest.fn().mockReturnThis(),
      exec: jest.fn(() => Promise.resolve([[null, 0], [null, 1], [null, mockZcard], [null, 1]])),
    })),
    on: jest.fn(),
    quit: jest.fn().mockResolvedValue(undefined),
  };
  return { default: jest.fn(() => mockRedis) };
});

// ─── Mock models ──────────────────────────────────────────────────────────────

const Template = { findOne: jest.fn() };
const Tenant = { findById: jest.fn() };
const NotificationLog = { create: jest.fn() };

jest.unstable_mockModule('../src/models/Template.js', () => ({ default: Template }));
jest.unstable_mockModule('../src/models/Tenant.js', () => ({ default: Tenant }));
jest.unstable_mockModule('../src/models/NotificationLog.js', () => ({ default: NotificationLog }));

// ─── Mock BullMQ ──────────────────────────────────────────────────────────────

const mockQueueAdd = jest.fn((name, data, opts) => Promise.resolve({ id: opts.jobId, name, data }));
jest.unstable_mockModule('bullmq', () => ({
  Queue: jest.fn().mockImplementation(() => ({ add: mockQueueAdd, on: jest.fn() })),
  Worker: jest.fn(),
}));

// ─── Import app after mocks are in place ─────────────────────────────────────

const { default: supertest } = await import('supertest');
const { default: express } = await import('express');
const { default: jwt } = await import('jsonwebtoken');
const { decodeJobPayload } = await import('@notifyflow/proto');

// Build a minimal app instance for testing (not the full server with DB connect).
const { authenticate } = await import('../src/middleware/auth.js');
const { default: notifyRouter } = await import('../src/routes/notify.js');

const app = express();
app.use(express.json());
app.use('/notify', authenticate, notifyRouter);

// ─── Helpers ──────────────────────────────────────────────────────────────────

const TEST_TENANT_ID = '6632ab0000000000000000aa';
const JWT_SECRET = process.env.JWT_SECRET;

function makeToken(tenantId = TEST_TENANT_ID) {
  return jwt.sign({ tenantId, userId: 'system', role: 'tenant' }, JWT_SECRET, { expiresIn: '1h' });
}

/** Mongoose-style chain: Tenant.findById(id).select(...).lean() */
function leanChain(value) {
  return { select: () => ({ lean: () => Promise.resolve(value) }) };
}

const tenantDoc = {
  _id: TEST_TENANT_ID,
  secret: 'tenant-hmac-secret',
  webhookUrl: 'https://hooks.example.com/notify',
  rateLimit: 100,
};

const validBody = {
  userId: 'user_abc',
  templateName: 'order_confirmed',
  channels: ['in-app'],
  data: { order: { id: 'ORD-001' } },
};

function post(body, token = makeToken()) {
  return supertest(app).post('/notify').set('Authorization', `Bearer ${token}`).send(body);
}

let logCounter = 0;

afterEach(() => jest.restoreAllMocks());

beforeEach(() => {
  jest.clearAllMocks();
  mockZcard = 1;
  logCounter = 0;
  Tenant.findById.mockImplementation(() => leanChain(tenantDoc));
  Template.findOne.mockResolvedValue({
    _id: 'tmpl1',
    name: 'order_confirmed',
    channels: ['in-app', 'email', 'webhook'],
    isActive: true,
  });
  NotificationLog.create.mockImplementation(async (doc) => ({ _id: `log${++logCounter}`, ...doc }));
});

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('POST /notify — auth & validation', () => {
  test('returns 401 when no token is provided', async () => {
    const res = await supertest(app).post('/notify').send(validBody);
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('MISSING_TOKEN');
  });

  test('returns 401 for a token signed with the wrong secret', async () => {
    const forged = jwt.sign({ tenantId: TEST_TENANT_ID, userId: 'system' }, 'not-the-secret');
    const res = await post(validBody, forged);
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('INVALID_TOKEN');
    expect(mockQueueAdd).not.toHaveBeenCalled();
  });

  test('returns 400 when userId is missing', async () => {
    const res = await post({ templateName: 'order_confirmed', channels: ['in-app'] });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
    expect(res.body.details).toEqual(
      expect.arrayContaining([expect.objectContaining({ field: 'userId' })])
    );
  });

  test('returns 400 when templateName is invalid slug', async () => {
    const res = await post({ userId: 'u1', templateName: 'Invalid Name!', channels: ['in-app'] });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
  });

  test('returns 400 for an unknown channel and an empty channels array', async () => {
    const bad = await post({ ...validBody, channels: ['sms'] });
    expect(bad.status).toBe(400);
    expect(bad.body.details[0].message).toMatch(/Invalid channels: sms/);

    const empty = await post({ ...validBody, channels: [] });
    expect(empty.status).toBe(400);
    expect(empty.body.details[0].field).toBe('channels');
  });

  test('returns 400 when data is an array instead of an object', async () => {
    const res = await post({ ...validBody, data: ['not', 'an', 'object'] });
    expect(res.status).toBe(400);
    expect(res.body.details).toEqual([expect.objectContaining({ field: 'data' })]);
  });

  test('reports every validation error at once', async () => {
    const res = await post({});
    expect(res.status).toBe(400);
    expect(res.body.details.map((d) => d.field).sort()).toEqual(['channels', 'templateName', 'userId']);
  });
});

describe('POST /notify — template lookup', () => {
  test('returns 404 when template does not exist', async () => {
    Template.findOne.mockResolvedValue(null);
    const res = await post(validBody);

    expect(res.status).toBe(404);
    expect(res.body.code).toBe('TEMPLATE_NOT_FOUND');
  });

  test('scopes the template lookup to the tenant from the JWT (multi-tenant isolation)', async () => {
    await post(validBody, makeToken('6632ab0000000000000000bb'));
    expect(Template.findOne).toHaveBeenCalledWith({
      tenantId: '6632ab0000000000000000bb',
      name: 'order_confirmed',
      isActive: true,
    });
  });

  test('returns 400 when requested channel is not in template.channels', async () => {
    Template.findOne.mockResolvedValue({
      _id: 'tmpl1',
      name: 'order_confirmed',
      channels: ['in-app'], // email not supported
      isActive: true,
    });

    const res = await post({ ...validBody, channels: ['email'] });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('UNSUPPORTED_CHANNEL');
    expect(mockQueueAdd).not.toHaveBeenCalled();
  });
});

describe('POST /notify — enqueueing', () => {
  test('returns 202 and enqueues jobs with valid body', async () => {
    const res = await post(validBody);

    expect(res.status).toBe(202);
    expect(res.body.message).toBe('Notification queued');
    expect(res.body.jobIds).toEqual(['log1-in-app']);
  });

  test('creates one NotificationLog and one job per channel', async () => {
    const res = await post({ ...validBody, channels: ['in-app', 'email', 'webhook'] });

    expect(res.status).toBe(202);
    expect(NotificationLog.create).toHaveBeenCalledTimes(3);
    expect(mockQueueAdd).toHaveBeenCalledTimes(3);
    expect(res.body.jobIds.sort()).toEqual(['log1-in-app', 'log2-email', 'log3-webhook'].sort());

    for (const call of NotificationLog.create.mock.calls) {
      expect(call[0]).toMatchObject({ tenantId: TEST_TENANT_ID, userId: 'user_abc', status: 'queued' });
    }
  });

  test('uses a deterministic jobId ({logId}-{channel}) so BullMQ de-duplicates re-adds', async () => {
    await post(validBody);
    const [name, , opts] = mockQueueAdd.mock.calls[0];
    expect(name).toBe('dispatch:in-app');
    expect(opts.jobId).toBe('log1-in-app');
  });

  test('job data is a base64 protobuf JobPayload carrying tenant secret and webhook URL', async () => {
    await post({ ...validBody, data: { firstName: 'Alice', email: 'alice@example.com' } });

    const [, jobData] = mockQueueAdd.mock.calls[0];
    expect(Object.keys(jobData)).toEqual(['proto']);

    const decoded = await decodeJobPayload(Buffer.from(jobData.proto, 'base64'));
    expect(decoded).toMatchObject({
      notificationLogId: 'log1',
      tenantId: TEST_TENANT_ID,
      userId: 'user_abc',
      channel: 'in-app',
      templateName: 'order_confirmed',
      tenantSecret: 'tenant-hmac-secret',
      webhookUrl: 'https://hooks.example.com/notify',
      userEmail: 'alice@example.com', // falls back to data.email
      data: { firstName: 'Alice', email: 'alice@example.com' },
    });
  });

  test('returns 500 (not a crash) when the queue is unavailable', async () => {
    jest.spyOn(console, 'error').mockImplementation(() => {});
    mockQueueAdd.mockRejectedValueOnce(new Error('Redis connection lost'));
    const res = await post(validBody);
    expect(res.status).toBe(500);
    expect(res.body.code).toBe('INTERNAL_ERROR');
  });
});

describe('POST /notify — per-tenant rate limiting', () => {
  test('sets X-RateLimit-* headers from the tenant rateLimit', async () => {
    Tenant.findById.mockImplementation(() => leanChain({ ...tenantDoc, rateLimit: 10 }));
    mockZcard = 4;

    const res = await post(validBody);

    expect(res.status).toBe(202);
    expect(res.headers['x-ratelimit-limit']).toBe('10');
    expect(res.headers['x-ratelimit-remaining']).toBe('6');
    expect(Number(res.headers['x-ratelimit-reset'])).toBeGreaterThan(Date.now() / 1000);
  });

  test('returns 429 and does not enqueue once the tenant exceeds its limit', async () => {
    Tenant.findById.mockImplementation(() => leanChain({ ...tenantDoc, rateLimit: 10 }));
    mockZcard = 11;

    const res = await post(validBody);

    expect(res.status).toBe(429);
    expect(res.body.code).toBe('RATE_LIMIT_EXCEEDED');
    expect(res.headers['x-ratelimit-remaining']).toBe('0');
    expect(mockQueueAdd).not.toHaveBeenCalled();
    expect(NotificationLog.create).not.toHaveBeenCalled();
  });
});
