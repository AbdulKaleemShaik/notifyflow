// apps/api/src/app.js
// Express application entry point.
// Connects to MongoDB, registers middleware and routes, then starts listening.

import 'dotenv/config';
import express from 'express';
import mongoose from 'mongoose';
import config from './config/index.js';
import logger from './utils/logger.js';
import { authenticate } from './middleware/auth.js';
import authRouter from './routes/auth.js';
import notifyRouter from './routes/notify.js';
import templatesRouter from './routes/templates.js';
import analyticsRouter from './routes/analytics.js';
import { metricsMiddleware, metricsHandler } from './metrics.js';
import { spec, serveDocs, setupDocs } from './docs/index.js';

const app = express();

// ─── Global Middleware ────────────────────────────────────────────────────────

// Record request latency for Prometheus.
app.use(metricsMiddleware);

// Parse JSON request bodies.
app.use(express.json());

// Security: remove X-Powered-By header to avoid fingerprinting.
app.disable('x-powered-by');

// CORS — in production, lock this down to your dashboard origin.
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// ─── Routes ───────────────────────────────────────────────────────────────────

// Health check — no auth required.
app.get('/health', (_req, res) => {
  res.json({
    status: 'ok',
    service: 'notifyflow-api',
    timestamp: new Date().toISOString(),
    mongoState: mongoose.connection.readyState === 1 ? 'connected' : 'disconnected',
  });
});

// Prometheus scrape endpoint and API docs — no auth required.
app.get('/metrics', metricsHandler);
app.get('/docs.json', (_req, res) => res.json(spec));
app.use('/docs', serveDocs, setupDocs);

app.use('/auth', authRouter);
app.use('/notify', authenticate, notifyRouter);
app.use('/templates', authenticate, templatesRouter);
app.use('/analytics', authenticate, analyticsRouter);

// ─── 404 Handler ──────────────────────────────────────────────────────────────

app.use((_req, res) => {
  res.status(404).json({
    error: 'Not Found',
    code: 'ROUTE_NOT_FOUND',
  });
});

// ─── Global Error Handler ─────────────────────────────────────────────────────

// eslint-disable-next-line no-unused-vars
app.use((err, _req, res, _next) => {
  logger.error('Unhandled error:', err.message, err.stack);
  res.status(err.status || 500).json({
    error: err.message || 'Internal Server Error',
    code: err.code || 'INTERNAL_ERROR',
  });
});

// ─── MongoDB Connection + Server Start ────────────────────────────────────────

async function start() {
  try {
    if (!config.mongoUri) {
      throw new Error('MONGO_URI environment variable is not set');
    }

    await mongoose.connect(config.mongoUri, {
      serverSelectionTimeoutMS: 5000,
    });
    logger.info(`MongoDB connected: ${config.mongoUri}`);

    const server = app.listen(config.port, () => {
      logger.info(`NotifyFlow API running on port ${config.port} [${config.nodeEnv}]`);
    });

    // Graceful shutdown: finish in-flight requests before closing.
    const shutdown = (signal) => {
      logger.info(`${signal} received — shutting down gracefully`);
      server.close(async () => {
        await mongoose.connection.close();
        logger.info('MongoDB connection closed');
        process.exit(0);
      });
    };

    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));
  } catch (err) {
    logger.error('Failed to start API server:', err.message);
    process.exit(1);
  }
}

start();

// Export app for Supertest integration tests (tests call this before start()).
export default app;
