// apps/dashboard/src/hooks/useMetrics.js
// Polls the /analytics/summary endpoint every 30 seconds.

import { useState, useEffect, useCallback } from 'react';
import { api } from '../services/api.js';

const POLL_INTERVAL_MS = 30_000;

/**
 * @returns {{ metrics: object|null, loading: boolean, error: string|null, refresh: Function }}
 */
export function useMetrics() {
  const [metrics, setMetrics] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const fetch = useCallback(async () => {
    try {
      const data = await api.getSummary();
      setMetrics(data);
      setError(null);
    } catch (err) {
      setError(err.message || 'Failed to load metrics');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetch();
    const interval = setInterval(fetch, POLL_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [fetch]);

  return { metrics, loading, error, refresh: fetch };
}
