// apps/api/src/config/index.js
// Central configuration object — all values sourced from environment variables.
// Never hardcode secrets or connection strings here.

import 'dotenv/config';

const config = {
  port: process.env.PORT || 3000,
  mongoUri: process.env.MONGO_URI,
  // REDIS_URL (redis:// or rediss://) overrides host/port — needed for managed Redis (Upstash).
  redisUrl: process.env.REDIS_URL,
  redisHost: process.env.REDIS_HOST || 'localhost',
  redisPort: Number(process.env.REDIS_PORT) || 6379,
  jwtSecret: process.env.JWT_SECRET,
  jwtRefreshSecret: process.env.JWT_REFRESH_SECRET,
  jwtExpiresIn: '15m',
  jwtRefreshExpiresIn: '7d',
  bullQueueName: 'notifications',
  deadLetterQueueName: 'notifications:dead',
  maxRetryAttempts: 3,
  // Exponential backoff delays: 30s → 5min → 1hr
  retryBackoffMs: [30000, 300000, 3600000],
  s3Bucket: process.env.S3_BUCKET,
  nodeEnv: process.env.NODE_ENV || 'development',
  // Global fallback SMTP settings (tenants can override with their own)
  smtp: {
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT) || 587,
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
    from: process.env.SMTP_FROM || 'notifications@notifyflow.local',
  },
};

export default config;
