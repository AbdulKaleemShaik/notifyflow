// apps/worker/src/worker.js
// BullMQ worker — consumes notification jobs with concurrency=5.
// Implements: idempotency check, template rendering, channel dispatch, dead-letter publishing.

import 'dotenv/config';
import mongoose from 'mongoose';
import { Worker } from 'bullmq';
import IORedis from 'ioredis';

// ─── DB Models (shared schemas, re-imported here) ─────────────────────────────
// In Docker: models are copied to /app/api-models/ by the Dockerfile (flat layout).
// In local dev: resolve relative to this file → ../../api/src/models
import { fileURLToPath } from 'url';
import path from 'path';
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// API_MODELS_PATH env var is set in the Dockerfile for Docker builds.
// In local dev it falls back to the relative monorepo path.
const apiModelsPath = process.env.API_MODELS_PATH
  || path.resolve(__dirname, '../../../api/src/models');
const apiConfigPath = process.env.API_CONFIG_PATH
  || path.resolve(__dirname, '../../../api/src/config');

const { default: NotificationLog } = await import(`${apiModelsPath}/NotificationLog.js`);
const { default: Template } = await import(`${apiModelsPath}/Template.js`);
const { default: Tenant } = await import(`${apiModelsPath}/Tenant.js`);

// ─── Dispatchers ───────────────────────────────────────────────────────────────
import { render } from './services/templateRenderer.js';
import { dispatch as dispatchWebSocket } from './dispatchers/websocketDispatcher.js';
import { dispatch as dispatchEmail } from './dispatchers/emailDispatcher.js';
import { dispatch as dispatchWebhook } from './dispatchers/webhookDispatcher.js';
import { decodeJobPayload } from '@notifyflow/proto';

// ─── Redis Connections ────────────────────────────────────────────────────────
// Two separate clients: one for BullMQ (queue commands), one for Pub/Sub publishing.

const redisConnection = new IORedis({
  host: process.env.REDIS_HOST || 'localhost',
  port: Number(process.env.REDIS_PORT) || 6379,
  maxRetriesPerRequest: null, // Required for BullMQ blocking commands.
});

// Separate publisher for dead-letter pub/sub notifications.
const redisPublisher = new IORedis({
  host: process.env.REDIS_HOST || 'localhost',
  port: Number(process.env.REDIS_PORT) || 6379,
});

redisConnection.on('error', (err) => console.error('[worker] Redis error:', err.message));
redisPublisher.on('error', (err) => console.error('[worker] Publisher Redis error:', err.message));

// ─── MongoDB Connection ───────────────────────────────────────────────────────

async function connectMongo() {
  const uri = process.env.MONGO_URI;
  if (!uri) throw new Error('MONGO_URI is not set');
  await mongoose.connect(uri, { serverSelectionTimeoutMS: 5000 });
  console.info('[worker] MongoDB connected');
}

// ─── Job Processor ────────────────────────────────────────────────────────────

async function processJob(job) {
  // ── Step 0: Decode protobuf payload ─────────────────────────────────────────
  // The API encodes the payload as a base64 protobuf string in job.data.proto.
  // Decode it back to a plain object so all downstream code is unchanged.
  const protoBuffer = Buffer.from(job.data.proto, 'base64');
  const jobData = await decodeJobPayload(protoBuffer);

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

  // ── Step 1: Idempotency check ─────────────────────────────────────────────
  // If this job is being retried and was already delivered, skip it.
  const log = await NotificationLog.findById(notificationLogId);
  if (!log) {
    console.warn(`[worker] Job ${job.id}: NotificationLog ${notificationLogId} not found — skipping`);
    return;
  }
  if (log.status === 'delivered') {
    console.info(`[worker] Job ${job.id}: already delivered — idempotent skip`);
    return;
  }

  // ── Step 2: Mark as processing ────────────────────────────────────────────
  log.status = 'processing';
  log.attempts += 1;
  await log.save();

  // ── Step 3: Fetch template ────────────────────────────────────────────────
  const template = await Template.findOne({ tenantId, name: templateName });
  if (!template) {
    log.status = 'failed';
    log.lastError = `Template '${templateName}' not found`;
    await log.save();
    throw new Error(log.lastError);
  }

  // ── Step 4: Fetch tenant (for SMTP config and webhook secret) ─────────────
  const tenant = await Tenant.findById(tenantId);

  // ── Step 5: Render template ───────────────────────────────────────────────
  const renderedBody = render(template.body, data);
  const renderedSubject = render(template.subject || '', data);

  // ── Step 6: Dispatch by channel ───────────────────────────────────────────
  try {
    if (channel === 'in-app') {
      await dispatchWebSocket({
        notificationLogId,
        userId,
        templateName,
        renderedBody,
        data,
      });
    } else if (channel === 'email') {
      const result = await dispatchEmail(
        { ...job.data, userEmail },
        tenant,
        renderedBody,
        renderedSubject
      );
      log.lastError = null; // clear previous errors on success
      if (result?.messageId) {
        log.renderedBody = renderedBody;
      }
    } else if (channel === 'webhook') {
      await dispatchWebhook({
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
    console.info(`[worker] Job ${job.id} delivered via ${channel}`);
  } catch (dispatchErr) {
    // ── Step 7 (failure path): Update log with error ───────────────────────
    log.lastError = dispatchErr.message || 'Unknown dispatch error';
    log.status = 'failed';
    await log.save();

    // If the dispatcher flagged this as non-retryable, resolve instead of
    // throwing — this prevents BullMQ from re-queuing the job.
    if (dispatchErr.shouldRetry === false) {
      console.warn(`[worker] Job ${job.id} failed (non-retryable): ${log.lastError}`);
      return; // Do not throw — job resolves as "completed" to avoid wasted retries.
    }

    // For retryable errors, throw so BullMQ applies exponential backoff.
    throw dispatchErr;
  }
}

// ─── Worker Setup ─────────────────────────────────────────────────────────────

const QUEUE_NAME = 'notifications';

let worker;

async function start() {
  await connectMongo();

  worker = new Worker(QUEUE_NAME, processJob, {
    connection: redisConnection,
    concurrency: 5,
    removeOnComplete: { count: 100 },
    removeOnFail: false,
  });

  worker.on('completed', (job) => {
    console.info(`[worker] Job ${job.id} completed`);
  });

  // Dead-letter handler: when all retry attempts are exhausted.
  worker.on('failed', async (job, err) => {
    console.error(`[worker] Job ${job?.id} permanently failed: ${err.message}`);

    if (job && job.attemptsMade >= 3) {
      try {
        // Decode the protobuf payload to recover notificationLogId, tenantId, channel.
        let dlData = {};
        if (job.data?.proto) {
          try {
            dlData = await decodeJobPayload(Buffer.from(job.data.proto, 'base64'));
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
        await redisPublisher.publish(
          `deadletter:${dlData.tenantId}`,
          JSON.stringify({
            jobId: job.id,
            notificationLogId: dlData.notificationLogId,
            channel: dlData.channel,
            error: err.message,
            timestamp: new Date().toISOString(),
          })
        );
      } catch (innerErr) {
        console.error('[worker] Failed to update dead-letter status:', innerErr.message);
      }
    }
  });

  worker.on('error', (err) => {
    console.error('[worker] Worker-level error:', err.message);
  });

  console.info(`[worker] NotifyFlow worker started — queue: ${QUEUE_NAME} | concurrency: 5`);
}

// ─── Graceful Shutdown ────────────────────────────────────────────────────────

const shutdown = async (signal) => {
  console.info(`[worker] ${signal} received — draining queue`);
  if (worker) await worker.close();
  await redisConnection.quit();
  await redisPublisher.quit();
  await mongoose.connection.close();
  console.info('[worker] Shutdown complete');
  process.exit(0);
};

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

start().catch((err) => {
  console.error('[worker] Failed to start:', err.message);
  process.exit(1);
});
