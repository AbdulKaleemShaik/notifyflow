// apps/worker/src/worker.js
// BullMQ worker — consumes notification jobs with concurrency=5.
// Implements: idempotency check, template rendering, channel dispatch, dead-letter publishing.

import 'dotenv/config';
import mongoose from 'mongoose';
import { Worker } from 'bullmq';
import { createRedisClient } from './utils/redis.js';

// ─── DB Models (shared schemas, re-imported here) ─────────────────────────────
// In Docker: models are copied to /app/api-models/ by the Dockerfile (flat layout).
// In local dev: resolve relative to this file → ../../api/src/models
import { fileURLToPath } from 'url';
import path from 'path';
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// API_MODELS_PATH env var is set in the Dockerfile for Docker builds.
// In local dev it falls back to the relative monorepo path.
const apiModelsPath = process.env.API_MODELS_PATH
  || path.resolve(__dirname, '../../api/src/models');
const apiConfigPath = process.env.API_CONFIG_PATH
  || path.resolve(__dirname, '../../api/src/config');

const { default: NotificationLog } = await import(`${apiModelsPath}/NotificationLog.js`);
const { default: Template } = await import(`${apiModelsPath}/Template.js`);
const { default: Tenant } = await import(`${apiModelsPath}/Tenant.js`);

// ─── Dispatchers ───────────────────────────────────────────────────────────────
import { render } from './services/templateRenderer.js';
import { dispatch as dispatchWebSocket } from './dispatchers/websocketDispatcher.js';
import { dispatch as dispatchEmail } from './dispatchers/emailDispatcher.js';
import { dispatch as dispatchWebhook } from './dispatchers/webhookDispatcher.js';
import { decodeJobPayload } from '@notifyflow/proto';
import { createProcessor, createDeadLetterHandler } from './processor.js';

// ─── Redis Connections ────────────────────────────────────────────────────────
// Two separate clients: one for BullMQ (queue commands), one for Pub/Sub publishing.

const redisConnection = createRedisClient({
  maxRetriesPerRequest: null, // Required for BullMQ blocking commands.
});

// Separate publisher for dead-letter pub/sub notifications.
const redisPublisher = createRedisClient();

redisConnection.on('error', (err) => console.error('[worker] Redis error:', err.message));
redisPublisher.on('error', (err) => console.error('[worker] Publisher Redis error:', err.message));

// ─── MongoDB Connection ───────────────────────────────────────────────────────

async function connectMongo() {
  const uri = process.env.MONGO_URI;
  if (!uri) throw new Error('MONGO_URI is not set');
  await mongoose.connect(uri, { serverSelectionTimeoutMS: 5000 });
  console.info('[worker] MongoDB connected');
}

// ─── Job Processor + Dead-Letter Handler ─────────────────────────────────────
// Logic lives in processor.js (dependency-injected so it can be unit-tested).

const processJob = createProcessor({
  NotificationLog,
  Template,
  Tenant,
  render,
  decode: decodeJobPayload,
  dispatchers: {
    websocket: dispatchWebSocket,
    email: dispatchEmail,
    webhook: dispatchWebhook,
  },
});

const handleFailed = createDeadLetterHandler({
  NotificationLog,
  publisher: redisPublisher,
  decode: decodeJobPayload,
});

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

  // Dead-letter handler: fires after every failed attempt; dead-letters the job
  // only once all retry attempts are exhausted (see processor.js).
  worker.on('failed', handleFailed);

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
