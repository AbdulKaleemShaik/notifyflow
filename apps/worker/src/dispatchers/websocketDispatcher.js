// apps/worker/src/dispatchers/websocketDispatcher.js
// Delivers in-app notifications via Redis Pub/Sub.
// The worker PUBLISHES to a Redis channel; the WebSocket server SUBSCRIBES and pushes to browsers.
// They never communicate directly — decoupled via Redis.
// Messages are encoded with Protocol Buffers before publishing for compact, schema-safe transfer.

import IORedis from 'ioredis';
import { encodeWsMessage } from '@notifyflow/proto';

// Dedicated publisher client — cannot be in subscribe mode simultaneously.
const redisPublisher = new IORedis({
  host: process.env.REDIS_HOST || 'localhost',
  port: Number(process.env.REDIS_PORT) || 6379,
  lazyConnect: true,
});

redisPublisher.on('error', (err) => {
  console.error('[websocketDispatcher] Redis publisher error:', err.message);
});

/**
 * Publish a notification to the user's Redis channel using protobuf encoding.
 * The WebSocket server listens on notifications:* and forwards to active browser tabs.
 *
 * @param {object} payload
 * @param {string} payload.notificationLogId
 * @param {string} payload.userId
 * @param {string} payload.templateName
 * @param {string} payload.renderedBody
 * @param {object} payload.data
 */
export async function dispatch(payload) {
  // Encode the notification message as a protobuf binary buffer.
  const messageBuffer = await encodeWsMessage({
    type: 'notification',
    notificationId: payload.notificationLogId,
    templateName: payload.templateName,
    body: payload.renderedBody,
    data: payload.data,
    timestamp: new Date().toISOString(),
  });

  // Channel pattern: notifications:{userId}
  // The WebSocket server uses psubscribe('notifications:*') to catch all user channels.
  // ioredis accepts a Buffer directly for binary-safe publishing.
  await redisPublisher.publish(`notifications:${payload.userId}`, messageBuffer);
}

export default { dispatch };
