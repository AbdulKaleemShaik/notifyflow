// apps/ws-server/src/connectionManager.js
// Manages active WebSocket connections — one user can have multiple open tabs.
// Uses Map<userId, Set<WebSocket>> so we can broadcast to all tabs simultaneously.

import { WebSocket } from 'ws';

const connections = new Map(); // userId → Set<ws>

/**
 * Register a new WebSocket connection for a user.
 * @param {string} userId
 * @param {WebSocket} ws
 */
export function register(userId, ws) {
  if (!connections.has(userId)) {
    connections.set(userId, new Set());
  }
  connections.get(userId).add(ws);
  console.info(`[connectionManager] Registered connection for user ${userId} | total tabs: ${connections.get(userId).size}`);
}

/**
 * Unregister a WebSocket connection. Cleans up the Map entry when the user has no more tabs.
 * @param {string} userId
 * @param {WebSocket} ws
 */
export function unregister(userId, ws) {
  const sockets = connections.get(userId);
  if (!sockets) return;
  sockets.delete(ws);
  if (sockets.size === 0) {
    connections.delete(userId);
    console.info(`[connectionManager] All connections closed for user ${userId}`);
  }
}

/**
 * Send a message to all active WebSocket connections for a user.
 * Silently skips sockets that are not in OPEN state.
 * @param {string} userId
 * @param {string} message - Pre-serialised JSON string
 */
export function broadcast(userId, message) {
  const sockets = connections.get(userId);
  if (!sockets || sockets.size === 0) return;

  for (const ws of sockets) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(message);
    }
  }
}

/**
 * Return the total number of currently active connections across all users.
 * Useful for monitoring.
 */
export function totalConnections() {
  let count = 0;
  for (const sockets of connections.values()) {
    count += sockets.size;
  }
  return count;
}

export default { register, unregister, broadcast, totalConnections };
