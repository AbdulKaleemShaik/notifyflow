// apps/ws-server/src/server.js
// WebSocket server — authenticates via JWT query param, manages connections,
// subscribes to Redis Pub/Sub with a single psubscribe('notifications:*') pattern.
// Protobuf messages received from Redis are decoded and forwarded as JSON to browser clients.

import 'dotenv/config';
import { WebSocketServer } from 'ws';
import { parse as parseUrl } from 'url';
import jwt from 'jsonwebtoken';
import IORedis from 'ioredis';
import { register, unregister, broadcast, totalConnections } from './connectionManager.js';
import { decodeWsMessage } from '@notifyflow/proto';

const PORT = Number(process.env.WS_PORT) || 3001;
const JWT_SECRET = process.env.JWT_SECRET;

// ─── Redis Pub/Sub ───────────────────────────────────────────────────────────
// Single subscriber instance — psubscribe handles ALL user channels efficiently.
// Creating a new subscription per user would cause Redis connection explosion at scale.

// REDIS_URL (redis:// or rediss:// for Upstash) takes precedence over REDIS_HOST/REDIS_PORT.
const redisSubscriber = process.env.REDIS_URL
  ? new IORedis(process.env.REDIS_URL)
  : new IORedis({
    host: process.env.REDIS_HOST || 'localhost',
    port: Number(process.env.REDIS_PORT) || 6379,
  });

redisSubscriber.on('error', (err) => {
  console.error('[ws-server] Redis subscriber error:', err.message);
});

// Subscribe to pattern — matches notifications:{any-userId}
redisSubscriber.psubscribe('notifications:*', (err) => {
  if (err) {
    console.error('[ws-server] psubscribe failed:', err.message);
  } else {
    console.info('[ws-server] Subscribed to Redis pattern: notifications:*');
  }
});

// When a message arrives from the worker, decode the protobuf binary, then
// broadcast as JSON to the target user's WS connections.
// This keeps the WS→Browser wire format as JSON (no browser-side protobuf needed).
redisSubscriber.on('pmessage', async (_pattern, channel, rawMessage) => {
  // channel = "notifications:{userId}"
  const userId = channel.split(':').slice(1).join(':');
  if (!userId) return;

  try {
    // rawMessage is a Buffer when protobuf binary was published; ioredis may also
    // deliver it as a string — handle both defensively.
    const buf = Buffer.isBuffer(rawMessage)
      ? rawMessage
      : Buffer.from(rawMessage, 'binary');

    const decoded = await decodeWsMessage(buf);

    // Re-serialise as JSON for the browser (dashboard clients use JSON).
    broadcast(userId, JSON.stringify(decoded));
  } catch (err) {
    console.error('[ws-server] Failed to decode protobuf message:', err.message);
  }
});

// ─── WebSocket Server ─────────────────────────────────────────────────────────

const wss = new WebSocketServer({ port: PORT });

wss.on('listening', () => {
  console.info(`[ws-server] WebSocket server listening on port ${PORT}`);
});

wss.on('error', (err) => {
  console.error('[ws-server] Server error:', err.message);
});

wss.on('connection', (ws, req) => {
  // ── Step 1: Extract and verify JWT from ?token= query param ──────────────
  const { query } = parseUrl(req.url, true);
  const token = query.token;

  if (!token) {
    ws.close(4001, 'Unauthorized: missing token');
    return;
  }

  let decoded;
  try {
    decoded = jwt.verify(token, JWT_SECRET);
  } catch {
    ws.close(4001, 'Unauthorized: invalid token');
    return;
  }

  const { userId, tenantId } = decoded;

  if (!userId || !tenantId) {
    ws.close(4001, 'Unauthorized: token missing userId or tenantId');
    return;
  }

  // ── Step 2: Register the connection ──────────────────────────────────────
  register(userId, ws);
  console.info(`[ws-server] New connection | user: ${userId} | tenant: ${tenantId} | total: ${totalConnections()}`);

  // Send a welcome message so the client knows the connection is live.
  ws.send(JSON.stringify({ type: 'connected', userId, timestamp: new Date().toISOString() }));

  // ── Step 3: Handle messages from client ───────────────────────────────────
  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw.toString());
      if (msg.type === 'ping') {
        ws.send(JSON.stringify({ type: 'pong', timestamp: new Date().toISOString() }));
      }
    } catch {
      // Ignore malformed messages.
    }
  });

  // ── Step 4: Cleanup on disconnect ─────────────────────────────────────────
  ws.on('close', () => {
    unregister(userId, ws);
    console.info(`[ws-server] Connection closed | user: ${userId} | total: ${totalConnections()}`);
  });

  ws.on('error', (err) => {
    console.error(`[ws-server] Socket error for user ${userId}:`, err.message);
    unregister(userId, ws);
  });
});

// ─── Graceful Shutdown ────────────────────────────────────────────────────────

const shutdown = async (signal) => {
  console.info(`[ws-server] ${signal} received — shutting down`);
  wss.close(() => {
    console.info('[ws-server] WebSocket server closed');
  });
  await redisSubscriber.quit();
  process.exit(0);
};

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
