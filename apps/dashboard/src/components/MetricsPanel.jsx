// apps/dashboard/src/components/MetricsPanel.jsx
// Displays the summary stats panel: 4 stat cards + channel delivery bars.

import { useMetrics } from '../hooks/useMetrics.js';

const CHANNEL_COLORS = {
  'in-app': '#6366f1',
  email: '#f59e0b',
  webhook: '#14b8a6',
};

export default function MetricsPanel() {
  const { metrics, loading } = useMetrics();

  const stats = metrics?.today || { total: 0, delivered: 0, failed: 0, deliveryRate: 0 };
  const byChannel = metrics?.byChannel || { 'in-app': 0, email: 0, webhook: 0 };
  const maxChannel = Math.max(...Object.values(byChannel), 1);

  return (
    <div>
      {/* Stat Cards */}
      <div className="stats-grid" style={{ marginBottom: 20 }}>
        <div className="stat-card" style={{ '--stat-color': '#6366f1' }}>
          <div className="stat-label">Total Today</div>
          <div className="stat-value">{loading ? '—' : stats.total.toLocaleString()}</div>
          <div className="stat-icon">📨</div>
        </div>
        <div className="stat-card" style={{ '--stat-color': '#22c55e' }}>
          <div className="stat-label">Delivered</div>
          <div className="stat-value" style={{ color: '#22c55e' }}>
            {loading ? '—' : stats.delivered.toLocaleString()}
          </div>
          <div className="stat-icon">✅</div>
        </div>
        <div className="stat-card" style={{ '--stat-color': '#ef4444' }}>
          <div className="stat-label">Failed</div>
          <div className="stat-value" style={{ color: '#ef4444' }}>
            {loading ? '—' : stats.failed.toLocaleString()}
          </div>
          <div className="stat-icon">❌</div>
        </div>
        <div className="stat-card" style={{ '--stat-color': '#ec4899' }}>
          <div className="stat-label">Dead Letter</div>
          <div className="stat-value" style={{ color: '#ec4899' }}>
            {loading ? '—' : (metrics?.deadLetterCount ?? 0).toLocaleString()}
          </div>
          <div className="stat-icon">💀</div>
        </div>
      </div>

      {/* Delivery Rate */}
      <div className="card">
        <div className="card-header">
          <span className="card-title">Delivery Rate (today)</span>
          <span style={{ fontWeight: 700, color: '#22c55e', fontSize: '1.25rem' }}>
            {stats.deliveryRate}%
          </span>
        </div>
        <div className="delivery-rate-bar">
          <div
            className="delivery-rate-fill"
            style={{ width: `${stats.deliveryRate}%` }}
          />
        </div>

        {/* Per-channel bars */}
        <div className="channel-bars" style={{ marginTop: 20 }}>
          {Object.entries(byChannel).map(([channel, count]) => (
            <div className="channel-bar-row" key={channel}>
              <div className="channel-bar-label">
                {channel === 'in-app' ? 'In-App' : channel.charAt(0).toUpperCase() + channel.slice(1)}
              </div>
              <div className="channel-bar-track">
                <div
                  className="channel-bar-fill"
                  style={{
                    width: `${(count / maxChannel) * 100}%`,
                    background: CHANNEL_COLORS[channel] || '#6366f1',
                  }}
                />
              </div>
              <div className="channel-bar-count">{count}</div>
            </div>
          ))}
        </div>

        {/* Avg latency */}
        <div style={{ marginTop: 16, fontSize: '0.8rem', color: 'var(--text-secondary)' }}>
          Avg delivery latency:{' '}
          <span style={{ color: 'var(--text-primary)', fontWeight: 600 }}>
            {metrics?.avgLatencyMs ? `${metrics.avgLatencyMs}ms` : '—'}
          </span>
        </div>
      </div>
    </div>
  );
}
