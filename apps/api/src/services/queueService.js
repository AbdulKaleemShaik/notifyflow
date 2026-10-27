// apps/api/src/services/queueService.js
// Thin wrapper around BullMQ Queue — used by the API to enqueue notification jobs.
// The worker (separate process) consumes from this same queue.
// Job payloads are encoded with Protocol Buffers for compact, schema-enforced wire format.

import { Queue } from 'bullmq';
import config from '../config/index.js';
import { createRedisClient } from '../config/redis.js';
import logger from '../utils/logger.js';
import { encodeJobPayload } from '@notifyflow/proto';

const redisConnection = createRedisClient({
  maxRetriesPerRequest: null, // required by BullMQ
  lazyConnect: true,
});

redisConnection.on('error', (err) =>
  logger.error('QueueService Redis error:', err.message)
);

const notificationQueue = new Queue(config.bullQueueName, {
  connection: redisConnection,
  defaultJobOptions: {
    attempts: config.maxRetryAttempts,
    backoff: {
      type: 'exponential',
      delay: config.retryBackoffMs[0], // 30 000 ms base delay
    },
    removeOnComplete: { count: 100 },
    removeOnFail: false,
  },
});

/**
 * Enqueue a single notification job.
 * The payload is protobuf-encoded to a base64 string and stored in the `proto`
 * field so BullMQ (which uses JSON internally) can round-trip it without loss.
 *
 * @param {object} jobPayload - Must include notificationLogId, tenantId, userId,
 *                              channel, templateName, data, tenantSecret.
 * @returns {Promise<Job>} The BullMQ Job object.
 */
export async function enqueue(jobPayload) {
  try {
    // Encode the entire payload with protobuf.
    const protoBuffer = await encodeJobPayload(jobPayload);
    const protoBase64 = protoBuffer.toString('base64');

    const job = await notificationQueue.add(
      // Job name carries the channel for easier debugging in Bull Board.
      `dispatch:${jobPayload.channel}`,
      // BullMQ stores job.data as JSON; we wrap the binary in a base64 string.
      { proto: protoBase64 },
      {
        jobId: `${jobPayload.notificationLogId}-${jobPayload.channel}`,
      }
    );

    logger.info(`Job enqueued: ${job.id} | channel: ${jobPayload.channel} | encoding: protobuf`);
    return job;
  } catch (err) {
    logger.error('Failed to enqueue job:', err.message);
    throw err;
  }
}

/**
 * Get queue metrics — used by the analytics route.
 * @returns {Promise<object>}
 */
export async function getQueueMetrics() {
  const [waiting, active, completed, failed, delayed] = await Promise.all([
    notificationQueue.getWaitingCount(),
    notificationQueue.getActiveCount(),
    notificationQueue.getCompletedCount(),
    notificationQueue.getFailedCount(),
    notificationQueue.getDelayedCount(),
  ]);
  return { waiting, active, completed, failed, delayed };
}

export default notificationQueue;
