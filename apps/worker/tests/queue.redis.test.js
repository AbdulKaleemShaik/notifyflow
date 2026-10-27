// apps/worker/tests/queue.redis.test.js
// Integration test: real BullMQ queue + worker on a REAL Redis server, with the
// production processor/dead-letter handler and in-memory model stand-ins.
// Verifies the retry → dead-letter path and idempotent re-processing end to end.
//
// Opt-in — set REDIS_INTEGRATION=1 (CI does this with a Redis service container):
//   REDIS_INTEGRATION=1 REDIS_HOST=localhost REDIS_PORT=6379 npm test

import { jest } from '@jest/globals';
import { randomUUID } from 'crypto';

const enabled = process.env.REDIS_INTEGRATION === '1';
const describeIfRedis = enabled ? describe : describe.skip;

const connectionOpts = {
  host: process.env.REDIS_HOST || 'localhost',
  port: Number(process.env.REDIS_PORT) || 6379,
  maxRetriesPerRequest: null,
};

describeIfRedis('BullMQ worker — real Redis', () => {
  jest.setTimeout(30_000);

  let Queue, Worker, IORedis, encodeJobPayload, decodeJobPayload, createProcessor, createDeadLetterHandler, render;
  let queue, worker, connection, publisher, subscriber;
  let logs, dispatchers, deadLetters;
  const queueName = `it-notifications-${randomUUID()}`;
  const silent = { info() {}, warn() {}, error() {} };

  /** In-memory NotificationLog with the subset of the Mongoose API the worker uses. */
  function makeLogModel() {
    const docs = new Map();
    return {
      docs,
      add(id) {
        const doc = { _id: id, status: 'queued', attempts: 0, lastError: null, save: async () => doc };
        docs.set(id, doc);
        return doc;
      },
      findById: async (id) => docs.get(id) ?? null,
      findByIdAndUpdate: async (id, update) => Object.assign(docs.get(id), update),
    };
  }

  beforeAll(async () => {
    ({ Queue, Worker } = await import('bullmq'));
    ({ default: IORedis } = await import('ioredis'));
    ({ encodeJobPayload, decodeJobPayload } = await import('@notifyflow/proto'));
    ({ createProcessor, createDeadLetterHandler } = await import('../src/processor.js'));
    ({ render } = await import('../src/services/templateRenderer.js'));

    connection = new IORedis(connectionOpts);
    publisher = new IORedis(connectionOpts);
    subscriber = new IORedis(connectionOpts);

    deadLetters = [];
    await subscriber.psubscribe('deadletter:*');
    subscriber.on('pmessage', (_p, channel, message) => deadLetters.push({ channel, message: JSON.parse(message) }));

    logs = makeLogModel();
    dispatchers = { websocket: jest.fn(), email: jest.fn(), webhook: jest.fn() };

    const deps = {
      NotificationLog: logs,
      Template: { findOne: async ({ name }) => (name === 'missing' ? null : { body: 'Hi {{name}}', subject: '' }) },
      Tenant: { findById: async () => ({ secret: 's', webhookUrl: 'http://example.invalid' }) },
      render,
      decode: decodeJobPayload,
      dispatchers,
      logger: silent,
    };

    queue = new Queue(queueName, { connection });
    worker = new Worker(queueName, createProcessor(deps), { connection, concurrency: 5 });
    worker.on('failed', createDeadLetterHandler({ NotificationLog: logs, publisher, decode: decodeJobPayload, logger: silent }));
    await worker.waitUntilReady();
  });

  afterAll(async () => {
    await worker?.close();
    await queue?.obliterate({ force: true }).catch(() => {});
    await queue?.close();
    await Promise.all([connection, publisher, subscriber].map((c) => c?.quit()));
  });

  async function enqueue(logId, overrides = {}, opts = {}) {
    logs.add(logId);
    const proto = (await encodeJobPayload({
      notificationLogId: logId,
      tenantId: 'tenant-it',
      userId: 'user-1',
      channel: 'in-app',
      templateName: 'welcome',
      data: { name: 'Ada' },
      ...overrides,
    })).toString('base64');
    return queue.add('dispatch:in-app', { proto }, {
      jobId: `${logId}-in-app`,
      attempts: 3,
      backoff: { type: 'fixed', delay: 50 },
      ...opts,
    });
  }

  const waitFor = async (predicate, timeoutMs = 15_000) => {
    const started = Date.now();
    while (!(await predicate())) {
      if (Date.now() - started > timeoutMs) throw new Error('waitFor timed out');
      await new Promise((r) => setTimeout(r, 50));
    }
  };

  test('delivers a job and marks the log delivered', async () => {
    dispatchers.websocket.mockResolvedValueOnce(undefined);
    const job = await enqueue('log-ok');

    await waitFor(async () => (await job.getState()) === 'completed');
    expect(logs.docs.get('log-ok')).toMatchObject({ status: 'delivered', attempts: 1 });
  });

  test('retries a transient failure, then dead-letters after 3 attempts', async () => {
    dispatchers.websocket.mockRejectedValue(new Error('Redis publish failed'));
    const job = await enqueue('log-dl');

    await waitFor(() => deadLetters.some((d) => d.message.notificationLogId === 'log-dl'));
    dispatchers.websocket.mockReset();

    const finished = await queue.getJob(job.id);
    expect(finished.attemptsMade).toBe(3);
    expect(await finished.getState()).toBe('failed');
    expect(logs.docs.get('log-dl')).toMatchObject({ status: 'dead_letter', attempts: 3, lastError: 'Redis publish failed' });

    const alert = deadLetters.find((d) => d.message.notificationLogId === 'log-dl');
    expect(alert.channel).toBe('deadletter:tenant-it');
    expect(alert.message).toMatchObject({ jobId: job.id, channel: 'in-app', error: 'Redis publish failed' });
  });

  test('a transient failure that recovers on retry is delivered once, not dead-lettered', async () => {
    dispatchers.websocket.mockReset();
    dispatchers.websocket.mockRejectedValueOnce(new Error('blip')).mockResolvedValue(undefined);
    const job = await enqueue('log-recover');

    await waitFor(async () => (await job.getState()) === 'completed');
    expect(logs.docs.get('log-recover')).toMatchObject({ status: 'delivered', attempts: 2 });
    expect(deadLetters.some((d) => d.message.notificationLogId === 'log-recover')).toBe(false);
  });

  test('re-enqueueing an already-delivered notification does not dispatch again (idempotency)', async () => {
    dispatchers.websocket.mockReset();
    dispatchers.websocket.mockResolvedValue(undefined);
    const first = await enqueue('log-idem');
    await waitFor(async () => (await first.getState()) === 'completed');
    expect(dispatchers.websocket).toHaveBeenCalledTimes(1);

    // Same notification re-queued under a new job id (e.g. a manual replay).
    logs.docs.get('log-idem').status = 'delivered';
    const proto = first.data.proto;
    const replay = await queue.add('dispatch:in-app', { proto }, { jobId: 'log-idem-replay', attempts: 3 });
    await waitFor(async () => (await replay.getState()) === 'completed');

    expect(dispatchers.websocket).toHaveBeenCalledTimes(1);
  });

  test('a missing template fails immediately without consuming retries', async () => {
    const job = await enqueue('log-missing', { templateName: 'missing' });

    await waitFor(async () => (await job.getState()) === 'failed');
    const finished = await queue.getJob(job.id);
    expect(finished.attemptsMade).toBe(1);
    expect(logs.docs.get('log-missing')).toMatchObject({ status: 'failed' });
    expect(deadLetters.some((d) => d.message.notificationLogId === 'log-missing')).toBe(false);
  });
});
