// apps/api/src/metrics.js
// Prometheus instrumentation for the API, exposed at GET /metrics.
//   - default Node.js process metrics (CPU, memory, event-loop lag, GC)
//   - notifyflow_http_request_duration_seconds: latency histogram by method/route/status
//   - notifyflow_queue_jobs: BullMQ job counts by state, read on every scrape

import client from 'prom-client';
import { getQueueMetrics } from './services/queueService.js';
import logger from './utils/logger.js';

export const register = new client.Registry();
register.setDefaultLabels({ service: 'notifyflow-api' });
client.collectDefaultMetrics({ register });

const httpDuration = new client.Histogram({
  name: 'notifyflow_http_request_duration_seconds',
  help: 'HTTP request latency in seconds',
  labelNames: ['method', 'route', 'status'],
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5],
  registers: [register],
});

new client.Gauge({
  name: 'notifyflow_queue_jobs',
  help: 'BullMQ notification jobs by state',
  labelNames: ['state'],
  registers: [register],
  async collect() {
    try {
      const counts = await getQueueMetrics();
      for (const [state, value] of Object.entries(counts)) this.set({ state }, value);
    } catch (err) {
      // Keep /metrics available even when Redis is down; the gauge just goes stale.
      logger.error('Queue metrics collection failed:', err.message);
    }
  },
});

/**
 * Express middleware recording request latency. Uses the matched route pattern
 * (e.g. /templates/:name) rather than the raw URL to keep label cardinality bounded.
 */
export function metricsMiddleware(req, res, next) {
  if (req.path === '/metrics') return next();
  const end = httpDuration.startTimer();
  res.on('finish', () => {
    const route = req.route ? `${req.baseUrl}${req.route.path}` : 'unmatched';
    end({ method: req.method, route, status: res.statusCode });
  });
  next();
}

export async function metricsHandler(_req, res) {
  res.set('Content-Type', register.contentType);
  res.end(await register.metrics());
}
