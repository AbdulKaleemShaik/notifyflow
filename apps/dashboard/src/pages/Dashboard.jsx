// apps/dashboard/src/pages/Dashboard.jsx
// Main dashboard — metrics panel, live notification feed, delivery log table.

import MetricsPanel from '../components/MetricsPanel.jsx';
import DeliveryLog from '../components/DeliveryLog.jsx';
import { useWebSocket } from '../hooks/useWebSocket.js';
import { showToast } from '../components/NotificationToast.jsx';
import { useEffect, useRef } from 'react';

function timeAgo(ts) {
  const diff = Date.now() - new Date(ts).getTime();
  if (diff < 60000) return `${Math.floor(diff / 1000)}s ago`;
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
  return `${Math.floor(diff / 3600000)}h ago`;
}

function channelClass(channel) {
  const map = { 'in-app': 'inapp', email: 'email', webhook: 'webhook' };
  return map[channel] || 'inapp';
}

export default function Dashboard() {
  const { notifications, isConnected } = useWebSocket();
  const prevLenRef = useRef(0);

  // Trigger toast for every new incoming notification.
  useEffect(() => {
    if (notifications.length > prevLenRef.current) {
      const newest = notifications[0];
      showToast(newest);
    }
    prevLenRef.current = notifications.length;
  }, [notifications]);

  return (
    <div>
      {/* Two-column metrics + live feed */}
      <div className="dashboard-grid">
        {/* Left — Metrics */}
        <div>
          <h2 className="dashboard-section-title">📊 Metrics</h2>
          <MetricsPanel />
        </div>

        {/* Right — Live Feed */}
        <div>
          <h2 className="dashboard-section-title">
            ⚡ Live Feed
            <span
              className={`ws-dot ${isConnected ? 'connected' : ''}`}
              title={isConnected ? 'WebSocket connected' : 'WebSocket disconnected'}
              style={{ display: 'inline-block', marginLeft: 4 }}
            />
            <span className="text-xs text-muted" style={{ marginLeft: 4 }}>
              {isConnected ? 'live' : 'disconnected'}
            </span>
          </h2>

          <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
            <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--color-border)' }}>
              <span className="text-xs text-muted">Last {notifications.length} notifications</span>
            </div>
            <div className="live-feed" style={{ padding: 12 }}>
              {notifications.length === 0 ? (
                <div className="feed-empty">
                  <div style={{ fontSize: '2rem', marginBottom: 8 }}>📭</div>
                  Waiting for notifications…
                </div>
              ) : (
                notifications.slice(0, 20).map((n, i) => (
                  <div className="feed-item" key={n.notificationId || i}>
                    <div className="feed-item-header">
                      <span className="feed-item-user">{n.userId || '—'}</span>
                      <span className="feed-item-time">{n.timestamp ? timeAgo(n.timestamp) : ''}</span>
                    </div>
                    <div className="feed-item-template">{n.templateName}</div>
                    <div className="feed-item-badges">
                      {n.channel && (
                        <span className={`badge badge-${channelClass(n.channel)}`}>{n.channel}</span>
                      )}
                      <span className="badge badge-delivered">delivered</span>
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
      </div>

      {/* Full-width delivery log */}
      <div>
        <h2 className="dashboard-section-title">📋 Delivery Log</h2>
        <div className="card" style={{ padding: 20 }}>
          <DeliveryLog />
        </div>
      </div>
    </div>
  );
}
