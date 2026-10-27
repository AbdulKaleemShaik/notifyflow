// apps/worker/src/processor.js
// Pure job-processing logic, extracted from worker.js so it can be unit-tested
// without a live Redis/MongoDB. worker.js wires in the real models, dispatchers
// and Redis publisher; tests inject mocks.
//
// Implements: protobuf decode, idempotency check, template rendering,
// channel dispatch, and dead-letter handling.

import { UnrecoverableError } from 'bullmq';

// Must match the API's queue default (apps/api/src/config: maxRetryAttempts).
export const DEFAULT_MAX_ATTEMPTS = 3;

/**
 * Build the BullMQ processor function.
 *
 * @param {object} deps
 * @param {object} deps.NotificationLog - Mongoose model (findById)
 * @param {object} deps.Template        - Mongoose model (findOne)
 * @param {object} deps.Tenant          - Mongoose model (findById)
 * @param {Function} deps.render        - Template renderer: (template, data) => string
 * @param {Function} deps.decode        - Protobuf decoder: (Buffer) => Promise<object>
 * @param {object} deps.dispatchers     - { websocket, email, webhook } dispatch functions
 * @param {object} [deps.logger]        - console-compatible logger
 * @returns {(job: import('bullmq').Job) => Promise<void>}
 */
export function createProcessor({
  NotificationLog,
  Template,
  Tenant,
  render,
  decode,
  dispatchers,
  logger = console,
}) {
  return async function processJob(job) {
    // ── Step 0: Decode protobuf payload ───────────────────────────────────────
    // The API encodes the payload as a base64 protobuf string in job.data.proto.
    const protoBuffer = Buffer.from(job.data.proto, 'base64');
    const jobData = await decode(protoBuffer);

    const {
      notificationLogId,
      tenantId,
      userId,
      channel,
      templateName,
      data,
      tenantSecret,
      webhookUrl,
      userEmail,
    } = jobData;

    // ── Step 1: Idempotency check ───────────────────────────────────────────
    // If this job is being retried and was already delivered, skip it.
    const log = await NotificationLog.findById(notificationLogId);
    if (!log) {
      logger.warn(`[worker] Job ${job.id}: NotificationLog ${notificationLogId} not found — skipping`);
      return;
    }
    if (log.status === 'delivered') {
      logger.info(`[worker] Job ${job.id}: already delivered — idempotent skip`);
      return;
    }

    // ── Step 2: Mark as processing ──────────────────────────────────────────
    log.status = 'processing';
    log.attempts += 1;
    await log.save();

    // ── Step 3: Fetch template ──────────────────────────────────────────────
    const template = await Template.findOne({ tenantId, name: templateName });
    if (!template) {
      log.status = 'failed';
      log.lastError = `Template '${templateName}' not found`;
      await log.save();
      // A missing template will not appear on retry — fail the job immediately
      // instead of burning retries (BullMQ skips remaining attempts).
      throw new UnrecoverableError(log.lastError);
    }

    // ── Step 4: Fetch tenant (for SMTP config and webhook secret) ───────────
    const tenant = await Tenant.findById(tenantId);

    // ── Step 5: Render template ─────────────────────────────────────────────
    const renderedBody = render(template.body, data);
    const renderedSubject = render(template.subject || '', data);

    // ── Step 6: Dispatch by channel ─────────────────────────────────────────
    try {
      if (channel === 'in-app') {
        await dispatchers.websocket({
          notificationLogId,
          userId,
          templateName,
          renderedBody,
          data,
        });
      } else if (channel === 'email') {
        await dispatchers.email(
          { ...job.data, userEmail },
          tenant,
          renderedBody,
          renderedSubject
        );
      } else if (channel === 'webhook') {
        await dispatchers.webhook({
          notificationLogId,
          userId,
          templateName,
          data,
          webhookUrl: webhookUrl || tenant?.webhookUrl,
          tenantSecret: tenantSecret || tenant?.secret,
        });
      }

      // ── Step 7: Mark delivered ────────────────────────────────────────────
      log.status = 'delivered';
      log.deliveredAt = new Date();
      log.renderedBody = renderedBody;
      log.lastError = null;
      await log.save();
      logger.info(`[worker] Job ${job.id} delivered via ${channel}`);
    } catch (dispatchErr) {
      // ── Step 7 (failure path): Update log with error ─────────────────────
      log.lastError = dispatchErr.message || 'Unknown dispatch error';
      log.status = 'failed';
      await log.save();

      // If the dispatcher flagged this as non-retryable, resolve instead of
      // throwing — this prevents BullMQ from re-queuing the job.
      if (dispatchErr.shouldRetry === false) {
        logger.warn(`[worker] Job ${job.id} failed (non-retryable): ${log.lastError}`);
        return; // Job resolves as "completed" to avoid wasted retries.
      }

      // For retryable errors, throw so BullMQ applies exponential backoff.
      throw dispatchErr;
    }
  };
}

/**
 * Build the handler for BullMQ's `failed` event.
 * BullMQ emits `failed` after EVERY failed attempt; only once all attempts are
 * exhausted is the job moved to `dead_letter` and an alert published to the
 * tenant's `deadletter:{tenantId}` Redis channel.
 *
 * @param {object} deps
 * @param {object} deps.NotificationLog - Mongoose model (findByIdAndUpdate)
 * @param {object} deps.publisher       - Redis client with publish(channel, message)
 * @param {Function} deps.decode        - Protobuf decoder
 * @param {object} [deps.logger]
 * @returns {(job: import('bullmq').Job|undefined, err: Error) => Promise<boolean>}
 *          Resolves true when the job was dead-lettered.
 */
export function createDeadLetterHandler({ NotificationLog, publisher, decode, logger = console }) {
  return async function onFailed(job, err) {
    const maxAttempts = job?.opts?.attempts ?? DEFAULT_MAX_ATTEMPTS;

    if (!job || job.attemptsMade < maxAttempts) {
      logger.warn(
        `[worker] Job ${job?.id} attempt ${job?.attemptsMade ?? '?'}/${maxAttempts} failed: ${err.message}`
      );
      return false;
    }

    logger.error(`[worker] Job ${job.id} permanently failed: ${err.message}`);

    try {
      // Decode the protobuf payload to recover notificationLogId, tenantId, channel.
      let dlData = {};
      if (job.data?.proto) {
        try {
          dlData = await decode(Buffer.from(job.data.proto, 'base64'));
        } catch {
          // Fallback: treat job.data as plain object (handles legacy or test jobs).
          dlData = job.data ?? {};
        }
      }

      // Move to dead_letter status in MongoDB.
      await NotificationLog.findByIdAndUpdate(dlData.notificationLogId, {
        status: 'dead_letter',
        lastError: err.message,
      });

      // Publish to tenant's dead-letter Redis channel so the dashboard can alert in real time.
      await publisher.publish(
        `deadletter:${dlData.tenantId}`,
        JSON.stringify({
          jobId: job.id,
          notificationLogId: dlData.notificationLogId,
          channel: dlData.channel,
          error: err.message,
          timestamp: new Date().toISOString(),
        })
      );
      return true;
    } catch (innerErr) {
      logger.error('[worker] Failed to update dead-letter status:', innerErr.message);
      return false;
    }
  };
}
