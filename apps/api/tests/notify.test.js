// apps/api/tests/notify.test.js
// Supertest integration tests for POST /notify.
// Mocks Redis and MongoDB so no real infrastructure is needed to run tests.

import { jest } from '@jest/globals';

// ─── Mock ioredis before any imports ─────────────────────────────────────────

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
      exec: jest.fn().mockResolvedValue([[null, 1], [null, 1], [null, 1], [null, 1]]),
    })),
    on: jest.fn(),
    quit: jest.fn().mockResolvedValue(undefined),
  };
  return { default: jest.fn(() => mockRedis) };
});

// ─── Mock mongoose ────────────────────────────────────────────────────────────

jest.unstable_mockModule('mongoose', () => {
  const mongoose = {
    connect: jest.fn().mockResolvedValue(undefined),
    connection: {
      readyState: 1,
      close: jest.fn().mockResolvedValue(undefined),
    },
    Schema: class {
      constructor() { return {}; }
      index() { return this; }
      pre() { return this; }
    },
    model: jest.fn(() => mockModel),
    Types: { ObjectId: String },
  };
  const mockModel = {
    findOne: jest.fn(),
    findById: jest.fn(),
    create: jest.fn(),
    find: jest.fn().mockReturnThis(),
    lean: jest.fn().mockResolvedValue([]),
  };
  return { default: mongoose };
});

// ─── Mock BullMQ ──────────────────────────────────────────────────────────────

const mockJob = { id: 'test-job-id' };
jest.unstable_mockModule('bullmq', () => ({
  Queue: jest.fn().mockImplementation(() => ({
    add: jest.fn().mockResolvedValue(mockJob),
    on: jest.fn(),
  })),
  Worker: jest.fn(),
}));

// ─── Import app after mocks are in place ─────────────────────────────────────

const { default: supertest } = await import('supertest');
const { default: express } = await import('express');
const { default: jwt } = await import('jsonwebtoken');

// Build a minimal app instance for testing (not the full server with DB connect).
const { authenticate } = await import('../src/middleware/auth.js');
const { default: notifyRouter } = await import('../src/routes/notify.js');

const app = express();
app.use(express.json());
app.use('/notify', authenticate, notifyRouter);

// ─── Helpers ──────────────────────────────────────────────────────────────────

const TEST_TENANT_ID = 'test-tenant-123';
const JWT_SECRET = process.env.JWT_SECRET || 'test-secret-for-testing-only';

function makeToken(tenantId = TEST_TENANT_ID) {
  return jwt.sign({ tenantId, userId: 'system', role: 'tenant' }, JWT_SECRET, { expiresIn: '1h' });
}

const validBody = {
  userId: 'user_abc',
  templateName: 'order_confirmed',
  channels: ['in-app'],
  data: { order: { id: 'ORD-001' } },
};

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('POST /notify', () => {
  test('returns 401 when no token is provided', async () => {
    const res = await supertest(app).post('/notify').send(validBody);
    expect(res.status).toBe(401);
    expect(res.body.code).toMatch(/MISSING_TOKEN|INVALID_TOKEN/);
  });

  test('returns 400 when userId is missing', async () => {
    const token = makeToken();
    const res = await supertest(app)
      .post('/notify')
      .set('Authorization', `Bearer ${token}`)
      .send({ templateName: 'order_confirmed', channels: ['in-app'] });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
    expect(res.body.details).toEqual(
      expect.arrayContaining([expect.objectContaining({ field: 'userId' })])
    );
  });

  test('returns 400 when templateName is invalid slug', async () => {
    const token = makeToken();
    const res = await supertest(app)
      .post('/notify')
      .set('Authorization', `Bearer ${token}`)
      .send({ userId: 'u1', templateName: 'Invalid Name!', channels: ['in-app'] });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
  });

  test('returns 404 when template does not exist', async () => {
    const { default: Template } = await import('../src/models/Template.js');
    Template.findOne = jest.fn().mockResolvedValue(null);

    const { default: Tenant } = await import('../src/models/Tenant.js');
    Tenant.findById = jest.fn().mockResolvedValue({ _id: TEST_TENANT_ID, secret: 'sec', rateLimit: 100 });

    const token = makeToken();
    const res = await supertest(app)
      .post('/notify')
      .set('Authorization', `Bearer ${token}`)
      .send(validBody);

    expect(res.status).toBe(404);
    expect(res.body.code).toBe('TEMPLATE_NOT_FOUND');
  });

  test('returns 202 and enqueues jobs with valid body', async () => {
    const { default: Template } = await import('../src/models/Template.js');
    Template.findOne = jest.fn().mockResolvedValue({
      _id: 'tmpl1',
      name: 'order_confirmed',
      channels: ['in-app'],
      isActive: true,
    });

    const { default: NotificationLog } = await import('../src/models/NotificationLog.js');
    NotificationLog.create = jest.fn().mockResolvedValue({ _id: 'log1' });

    const { default: Tenant } = await import('../src/models/Tenant.js');
    Tenant.findById = jest.fn().mockResolvedValue({ _id: TEST_TENANT_ID, secret: 'sec', rateLimit: 100 });

    const token = makeToken();
    const res = await supertest(app)
      .post('/notify')
      .set('Authorization', `Bearer ${token}`)
      .send(validBody);

    expect(res.status).toBe(202);
    expect(res.body.message).toBe('Notification queued');
    expect(Array.isArray(res.body.jobIds)).toBe(true);
  });

  test('returns 400 when requested channel is not in template.channels', async () => {
    const { default: Template } = await import('../src/models/Template.js');
    Template.findOne = jest.fn().mockResolvedValue({
      _id: 'tmpl1',
      name: 'order_confirmed',
      channels: ['in-app'], // email not supported
      isActive: true,
    });

    const { default: Tenant } = await import('../src/models/Tenant.js');
    Tenant.findById = jest.fn().mockResolvedValue({ _id: TEST_TENANT_ID, secret: 'sec', rateLimit: 100 });

    const token = makeToken();
    const res = await supertest(app)
      .post('/notify')
      .set('Authorization', `Bearer ${token}`)
      .send({ ...validBody, channels: ['email'] }); // email not in template

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('UNSUPPORTED_CHANNEL');
  });
});
