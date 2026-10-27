// apps/worker/tests/processor.test.js
// Unit tests for the job processor and dead-letter handler (src/processor.js).
// Models, dispatchers and Redis are injected as mocks; protobuf encoding and the
// template renderer are the real implementations.

import { jest } from '@jest/globals';
import { UnrecoverableError } from 'bullmq';
import { encodeJobPayload, decodeJobPayload } from '@notifyflow/proto';
import { createProcessor, createDeadLetterHandler } from '../src/processor.js';
import { render } from '../src/services/templateRenderer.js';

const silentLogger = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const basePayload = {
  notificationLogId: 'log-1',
  tenantId: 'tenant-1',
  userId: 'user-42',
  channel: 'in-app',
  templateName: 'order_confirmed',
  tenantSecret: '',
  webhookUrl: '',
  userEmail: '',
  data: { firstName: 'Bob', order: { id: 'ORD-7743' } },
};

async function makeJob(overrides = {}, jobFields = {}) {
  const proto = (await encodeJobPayload({ ...basePayload, ...overrides })).toString('base64');
  return { id: 'job-1', data: { proto }, attemptsMade: 0, opts: { attempts: 3 }, ...jobFields };
}

/** A NotificationLog document stand-in that records every save() snapshot. */
function makeLog(fields = {}) {
  const log = {
    _id: 'log-1',
    status: 'queued',
    attempts: 0,
    lastError: null,
    renderedBody: null,
    deliveredAt: null,
    ...fields,
    saves: [],
  };
  log.save = jest.fn(async () => {
    const { saves, save, ...snapshot } = log;
    log.saves.push(snapshot);
    return log;
  });
  return log;
}

function setup({ log = makeLog(), template, tenant } = {}) {
  const deps = {
    NotificationLog: { findById: jest.fn().mockResolvedValue(log) },
    Template: {
      findOne: jest.fn().mockResolvedValue(
        template === undefined
          ? { body: 'Hi {{firstName}}, order #{{order.id}} confirmed', subject: 'Order {{order.id}}' }
          : template
      ),
    },
    Tenant: {
      findById: jest.fn().mockResolvedValue(
        tenant ?? { _id: 'tenant-1', secret: 'tenant-secret', webhookUrl: 'https://hooks.example.com' }
      ),
    },
    render,
    decode: decodeJobPayload,
    dispatchers: {
      websocket: jest.fn().mockResolvedValue(undefined),
      email: jest.fn().mockResolvedValue({ messageId: '<m1>' }),
      webhook: jest.fn().mockResolvedValue({ statusCode: 200 }),
    },
    logger: silentLogger,
  };
  return { deps, log, processJob: createProcessor(deps) };
}

beforeEach(() => jest.clearAllMocks());

// ─── Idempotency ──────────────────────────────────────────────────────────────

describe('processJob — idempotency', () => {
  test('skips a job whose NotificationLog is already delivered (retry after success)', async () => {
    const { processJob, deps, log } = setup({ log: makeLog({ status: 'delivered', attempts: 1 }) });

    await expect(processJob(await makeJob({}, { attemptsMade: 1 }))).resolves.toBeUndefined();

    expect(deps.dispatchers.websocket).not.toHaveBeenCalled();
    expect(deps.Template.findOne).not.toHaveBeenCalled();
    expect(log.save).not.toHaveBeenCalled();
    expect(log.attempts).toBe(1);
  });

  test('processing the same job twice dispatches exactly once', async () => {
    const { processJob, deps } = setup();
    const job = await makeJob();

    await processJob(job);
    await processJob(job); // e.g. BullMQ redelivers after a stalled-job check

    expect(deps.dispatchers.websocket).toHaveBeenCalledTimes(1);
  });

  test('skips (without throwing) when the NotificationLog no longer exists', async () => {
    const { processJob, deps } = setup({ log: null });
    await expect(processJob(await makeJob())).resolves.toBeUndefined();
    expect(deps.dispatchers.websocket).not.toHaveBeenCalled();
  });

  test('a previously failed log is retried and its error cleared on success', async () => {
    const log = makeLog({ status: 'failed', attempts: 1, lastError: 'ECONNREFUSED' });
    const { processJob, deps } = setup({ log });

    await processJob(await makeJob());

    expect(deps.dispatchers.websocket).toHaveBeenCalledTimes(1);
    expect(log).toMatchObject({ status: 'delivered', attempts: 2, lastError: null });
  });
});

// ─── Happy paths per channel ──────────────────────────────────────────────────

describe('processJob — delivery', () => {
  test('in-app: renders the template, publishes, and marks the log delivered', async () => {
    const { processJob, deps, log } = setup();

    await processJob(await makeJob());

    expect(deps.NotificationLog.findById).toHaveBeenCalledWith('log-1');
    expect(deps.Template.findOne).toHaveBeenCalledWith({ tenantId: 'tenant-1', name: 'order_confirmed' });
    expect(deps.dispatchers.websocket).toHaveBeenCalledWith({
      notificationLogId: 'log-1',
      userId: 'user-42',
      templateName: 'order_confirmed',
      renderedBody: 'Hi Bob, order #ORD-7743 confirmed',
      data: basePayload.data,
    });

    // Status transitions: processing → delivered.
    expect(log.saves.map((s) => s.status)).toEqual(['processing', 'delivered']);
    expect(log.attempts).toBe(1);
    expect(log.deliveredAt).toBeInstanceOf(Date);
    expect(log.renderedBody).toBe('Hi Bob, order #ORD-7743 confirmed');
  });

  test('email: passes recipient, tenant, rendered body and subject to the dispatcher', async () => {
    const tenant = { _id: 'tenant-1', emailConfig: { smtpHost: 'smtp.tenant.com' } };
    const { processJob, deps, log } = setup({ tenant });

    await processJob(await makeJob({ channel: 'email', userEmail: 'bob@shop.com' }));

    const [payload, passedTenant, body, subject] = deps.dispatchers.email.mock.calls[0];
    expect(payload.userEmail).toBe('bob@shop.com');
    expect(passedTenant).toBe(tenant);
    expect(body).toBe('Hi Bob, order #ORD-7743 confirmed');
    expect(subject).toBe('Order ORD-7743');
    expect(log.status).toBe('delivered');
  });

  test('webhook: prefers webhookUrl/secret from the job, falls back to the tenant document', async () => {
    const { processJob, deps } = setup();

    await processJob(await makeJob({ channel: 'webhook' }));
    expect(deps.dispatchers.webhook).toHaveBeenLastCalledWith(
      expect.objectContaining({ webhookUrl: 'https://hooks.example.com', tenantSecret: 'tenant-secret' })
    );

    const second = setup();
    await second.processJob(
      await makeJob({ channel: 'webhook', webhookUrl: 'https://job.example.com', tenantSecret: 'job-secret' })
    );
    expect(second.deps.dispatchers.webhook).toHaveBeenLastCalledWith(
      expect.objectContaining({ webhookUrl: 'https://job.example.com', tenantSecret: 'job-secret' })
    );
  });

  test('missing subject renders to an empty string rather than "undefined"', async () => {
    const { processJob, deps } = setup({ template: { body: 'Hello' } });
    await processJob(await makeJob({ channel: 'email', userEmail: 'a@b.c' }));
    expect(deps.dispatchers.email.mock.calls[0][3]).toBe('');
  });
});

// ─── Failure handling ─────────────────────────────────────────────────────────

describe('processJob — failures', () => {
  test('missing template: marks failed and throws UnrecoverableError (no retries)', async () => {
    const { processJob, deps, log } = setup({ template: null });

    await expect(processJob(await makeJob())).rejects.toBeInstanceOf(UnrecoverableError);

    expect(log).toMatchObject({ status: 'failed', lastError: "Template 'order_confirmed' not found" });
    expect(deps.dispatchers.websocket).not.toHaveBeenCalled();
  });

  test('retryable dispatch error: records the error and re-throws so BullMQ backs off', async () => {
    const { processJob, deps, log } = setup();
    const boom = Object.assign(new Error('Webhook returned 503: unavailable'), { shouldRetry: true });
    deps.dispatchers.webhook.mockRejectedValue(boom);

    await expect(processJob(await makeJob({ channel: 'webhook' }))).rejects.toBe(boom);
    expect(log).toMatchObject({ status: 'failed', lastError: 'Webhook returned 503: unavailable' });
  });

  test('unclassified dispatch errors are treated as retryable', async () => {
    const { processJob, deps } = setup();
    deps.dispatchers.websocket.mockRejectedValue(new Error('Redis publish failed'));
    await expect(processJob(await makeJob())).rejects.toThrow('Redis publish failed');
  });

  test('non-retryable dispatch error: records failure and resolves (job completes, no retry)', async () => {
    const { processJob, deps, log } = setup();
    deps.dispatchers.webhook.mockRejectedValue(
      Object.assign(new Error('Webhook returned 404: not found'), { shouldRetry: false })
    );

    await expect(processJob(await makeJob({ channel: 'webhook' }))).resolves.toBeUndefined();
    expect(log).toMatchObject({ status: 'failed', lastError: 'Webhook returned 404: not found', attempts: 1 });
  });
});

// ─── Dead-letter handling ─────────────────────────────────────────────────────

describe('createDeadLetterHandler', () => {
  function dlSetup() {
    const deps = {
      NotificationLog: { findByIdAndUpdate: jest.fn().mockResolvedValue({}) },
      publisher: { publish: jest.fn().mockResolvedValue(1) },
      decode: decodeJobPayload,
      logger: silentLogger,
    };
    return { deps, onFailed: createDeadLetterHandler(deps) };
  }

  test('does nothing while retry attempts remain', async () => {
    const { deps, onFailed } = dlSetup();
    for (const attemptsMade of [1, 2]) {
      await expect(onFailed(await makeJob({}, { attemptsMade }), new Error('503'))).resolves.toBe(false);
    }
    expect(deps.NotificationLog.findByIdAndUpdate).not.toHaveBeenCalled();
    expect(deps.publisher.publish).not.toHaveBeenCalled();
  });

  test('after the final attempt: marks dead_letter and publishes to deadletter:{tenantId}', async () => {
    const { deps, onFailed } = dlSetup();
    const job = await makeJob({ channel: 'webhook' }, { id: 'job-9', attemptsMade: 3 });

    await expect(onFailed(job, new Error('Webhook returned 503'))).resolves.toBe(true);

    expect(deps.NotificationLog.findByIdAndUpdate).toHaveBeenCalledWith('log-1', {
      status: 'dead_letter',
      lastError: 'Webhook returned 503',
    });
    const [channel, message] = deps.publisher.publish.mock.calls[0];
    expect(channel).toBe('deadletter:tenant-1');
    expect(JSON.parse(message)).toEqual({
      jobId: 'job-9',
      notificationLogId: 'log-1',
      channel: 'webhook',
      error: 'Webhook returned 503',
      timestamp: expect.any(String),
    });
  });

  test('respects the job-level attempts option instead of a hard-coded 3', async () => {
    const { deps, onFailed } = dlSetup();
    await onFailed(await makeJob({}, { attemptsMade: 3, opts: { attempts: 5 } }), new Error('x'));
    expect(deps.publisher.publish).not.toHaveBeenCalled();

    await onFailed(await makeJob({}, { attemptsMade: 5, opts: { attempts: 5 } }), new Error('x'));
    expect(deps.publisher.publish).toHaveBeenCalledTimes(1);
  });

  test('an UnrecoverableError on the first attempt is not dead-lettered', async () => {
    const { deps, onFailed } = dlSetup();
    await onFailed(await makeJob({}, { attemptsMade: 1 }), new UnrecoverableError('Template missing'));
    expect(deps.NotificationLog.findByIdAndUpdate).not.toHaveBeenCalled();
  });

  test('tolerates an undefined job (BullMQ can emit failed without one)', async () => {
    const { onFailed } = dlSetup();
    await expect(onFailed(undefined, new Error('lock lost'))).resolves.toBe(false);
  });

  test('never throws if MongoDB/Redis fail while dead-lettering', async () => {
    const { deps, onFailed } = dlSetup();
    deps.NotificationLog.findByIdAndUpdate.mockRejectedValue(new Error('mongo down'));
    await expect(onFailed(await makeJob({}, { attemptsMade: 3 }), new Error('x'))).resolves.toBe(false);
    expect(silentLogger.error).toHaveBeenCalledWith('[worker] Failed to update dead-letter status:', 'mongo down');
  });
});
