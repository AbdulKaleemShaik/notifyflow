// apps/dashboard/src/hooks/useWebSocket.js
// Maintains a WebSocket connection to the ws-server.
// Sends heartbeat pings every 30s to prevent proxy timeouts.

import { useState, useEffect, useRef } from 'react';
import { storage } from '../services/api.js';

const WS_HOST = import.meta.env.VITE_WS_HOST || 'localhost';
const MAX_NOTIFICATIONS = 50;

/**
 * @returns {{ notifications: object[], isConnected: boolean }}
 */
export function useWebSocket() {
  const [notifications, setNotifications] = useState([]);
  const [isConnected, setIsConnected] = useState(false);
  const wsRef = useRef(null);
  const heartbeatRef = useRef(null);

  useEffect(() => {
    const token = storage.getAccessToken();
    if (!token) return;

    const wsUrl = `ws://${WS_HOST}:3001?token=${token}`;
    const ws = new WebSocket(wsUrl);
    wsRef.current = ws;

    ws.onopen = () => {
      setIsConnected(true);
      // Send heartbeat ping every 30s to prevent proxy/load-balancer timeouts.
      heartbeatRef.current = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'ping' }));
        }
      }, 30_000);
    };

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        if (msg.type === 'notification') {
          setNotifications((prev) => [msg, ...prev].slice(0, MAX_NOTIFICATIONS));
        }
        // Ignore 'pong' and 'connected' messages.
      } catch {
        // Ignore malformed messages.
      }
    };

    ws.onclose = () => {
      setIsConnected(false);
      clearInterval(heartbeatRef.current);
    };

    ws.onerror = () => {
      setIsConnected(false);
    };

    return () => {
      clearInterval(heartbeatRef.current);
      ws.close();
    };
  }, []); // Connect once on mount — token won't change during a session.

  return { notifications, isConnected };
}
