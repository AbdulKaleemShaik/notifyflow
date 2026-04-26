// apps/dashboard/src/components/DeliveryLog.jsx
// Paginated, filterable table of NotificationLog records.
// Clicking a row expands to show rendered body and last error.

import { useState, useEffect, useCallback } from 'react';
import { api } from '../services/api.js';

function timeAgo(dateStr) {
  const diff = Date.now() - new Date(dateStr).getTime();
  if (diff < 60000) return `${Math.floor(diff / 1000)}s ago`;
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
  return new Date(dateStr).toLocaleDateString();
}

function channelBadge(channel) {
  const map = { 'in-app': 'inapp', email: 'email', webhook: 'webhook' };
  return <span className={`badge badge-${map[channel] || 'inapp'}`}>{channel}</span>;
}

function statusBadge(status) {
  return <span className={`badge badge-${status}`}>{status.replace('_', ' ')}</span>;
}

export default function DeliveryLog() {
  const [logs, setLogs] = useState([]);
  const [pagination, setPagination] = useState({ page: 1, pages: 1, total: 0 });
  const [loading, setLoading] = useState(true);
  const [expandedRow, setExpandedRow] = useState(null);
  const [filters, setFilters] = useState({
    status: '', channel: '', from: '', to: '', page: 1, limit: 20,
  });

  const fetchLogs = useCallback(async () => {
    setLoading(true);
    try {
      const result = await api.getLogs(filters);
      setLogs(result.data || []);
      setPagination(result.pagination || { page: 1, pages: 1, total: 0 });
    } catch (err) {
      console.error('Failed to load logs:', err);
    } finally {
      setLoading(false);
    }
  }, [filters]);

  useEffect(() => { fetchLogs(); }, [fetchLogs]);

  const updateFilter = (key, value) => {
    setFilters((prev) => ({ ...prev, [key]: value, page: 1 }));
    setExpandedRow(null);
  };

  const goToPage = (p) => setFilters((prev) => ({ ...prev, page: p }));

  return (
    <div>
      {/* Filters */}
      <div className="filters-row">
        <select
          id="filter-status"
          className="filter-select"
          value={filters.status}
          onChange={(e) => updateFilter('status', e.target.value)}
        >
          <option value="">All Statuses</option>
          <option value="queued">Queued</option>
          <option value="processing">Processing</option>
          <option value="delivered">Delivered</option>
          <option value="failed">Failed</option>
          <option value="dead_letter">Dead Letter</option>
        </select>

        <select
          id="filter-channel"
          className="filter-select"
          value={filters.channel}
          onChange={(e) => updateFilter('channel', e.target.value)}
        >
          <option value="">All Channels</option>
          <option value="in-app">In-App</option>
          <option value="email">Email</option>
          <option value="webhook">Webhook</option>
        </select>

        <input
          id="filter-from"
          type="date"
          className="filter-input"
          value={filters.from}
          onChange={(e) => updateFilter('from', e.target.value)}
          title="From date"
        />

        <input
          id="filter-to"
          type="date"
          className="filter-input"
          value={filters.to}
          onChange={(e) => updateFilter('to', e.target.value)}
          title="To date"
        />

        <button id="refresh-logs-btn" className="btn btn-ghost btn-sm" onClick={fetchLogs}>
          ↻ Refresh
        </button>

        <span className="text-xs text-muted" style={{ marginLeft: 'auto' }}>
          {pagination.total} records
        </span>
      </div>

      {/* Table */}
      <div className="table-wrapper">
        <table>
          <thead>
            <tr>
              <th>Time</th>
              <th>User</th>
              <th>Template</th>
              <th>Channel</th>
              <th>Status</th>
              <th>Attempts</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr>
                <td colSpan={6} style={{ textAlign: 'center', padding: 32 }}>
                  <div className="spinner" />
                </td>
              </tr>
            ) : logs.length === 0 ? (
              <tr>
                <td colSpan={6}>
                  <div className="empty-state">
                    <div className="empty-state-icon">📭</div>
                    <div className="empty-state-text">No logs found</div>
                  </div>
                </td>
              </tr>
            ) : (
              logs.map((log) => (
                <>
                  <tr
                    key={log._id}
                    onClick={() => setExpandedRow(expandedRow === log._id ? null : log._id)}
                  >
                    <td className="text-xs text-muted text-mono">{timeAgo(log.createdAt)}</td>
                    <td className="text-mono text-sm">{log.userId}</td>
                    <td className="text-mono text-sm">{log.templateName}</td>
                    <td>{channelBadge(log.channel)}</td>
                    <td>{statusBadge(log.status)}</td>
                    <td style={{ textAlign: 'center' }}>{log.attempts}</td>
                  </tr>
                  {expandedRow === log._id && (
                    <tr key={`${log._id}-expanded`}>
                      <td colSpan={6} style={{ padding: 0 }}>
                        <div className="table-expanded">
                          {log.renderedBody && (
                            <div style={{ marginBottom: 12 }}>
                              <div className="card-title" style={{ marginBottom: 6 }}>Rendered Body</div>
                              <pre>{log.renderedBody}</pre>
                            </div>
                          )}
                          {log.lastError && (
                            <div>
                              <div className="card-title" style={{ marginBottom: 6, color: 'var(--color-failed)' }}>
                                Last Error
                              </div>
                              <pre style={{ color: 'var(--color-failed)' }}>{log.lastError}</pre>
                            </div>
                          )}
                          {log.deliveredAt && (
                            <div className="text-xs text-muted" style={{ marginTop: 8 }}>
                              Delivered at: {new Date(log.deliveredAt).toLocaleString()}
                            </div>
                          )}
                        </div>
                      </td>
                    </tr>
                  )}
                </>
              ))
            )}
          </tbody>
        </table>
      </div>

      {/* Pagination */}
      <div className="pagination">
        <button
          id="prev-page-btn"
          className="btn btn-ghost btn-sm"
          onClick={() => goToPage(pagination.page - 1)}
          disabled={pagination.page <= 1}
        >
          ← Prev
        </button>
        <span className="text-sm text-secondary">
          Page {pagination.page} of {pagination.pages}
        </span>
        <button
          id="next-page-btn"
          className="btn btn-ghost btn-sm"
          onClick={() => goToPage(pagination.page + 1)}
          disabled={pagination.page >= pagination.pages}
        >
          Next →
        </button>
      </div>
    </div>
  );
}
