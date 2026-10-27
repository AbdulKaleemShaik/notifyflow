// apps/api/src/middleware/auth.js
// JWT dual-token authentication middleware.
// Access tokens: 15m TTL, signed with JWT_SECRET.
// Refresh tokens: 7d TTL, signed with JWT_REFRESH_SECRET, stored in Redis.

import jwt from 'jsonwebtoken';
import config from '../config/index.js';
import { createRedisClient } from '../config/redis.js';
import logger from '../utils/logger.js';

// Single Redis client for token storage (not in subscribe mode).
const redis = createRedisClient({ lazyConnect: true });

redis.on('error', (err) => logger.error('Auth Redis client error:', err.message));

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Build the Redis key for storing a refresh token.
 * @param {string} tenantId
 * @param {string} userId
 */
const refreshKey = (tenantId, userId) => `refresh:${tenantId}:${userId}`;

/**
 * Issue a new access + refresh token pair and persist the refresh token in Redis.
 * @param {{ tenantId: string, userId: string, role: string }} payload
 * @returns {{ accessToken: string, refreshToken: string }}
 */
export async function issueTokens(payload) {
  const { tenantId, userId, role } = payload;

  const accessToken = jwt.sign(
    { tenantId, userId, role },
    config.jwtSecret,
    { expiresIn: config.jwtExpiresIn }
  );

  const refreshToken = jwt.sign(
    { tenantId, userId, role },
    config.jwtRefreshSecret,
    { expiresIn: config.jwtRefreshExpiresIn }
  );

  // Store refresh token in Redis with a 7-day TTL (in seconds).
  const ttlSeconds = 7 * 24 * 60 * 60;
  await redis.set(refreshKey(tenantId, userId), refreshToken, 'EX', ttlSeconds);

  return { accessToken, refreshToken };
}

/**
 * Rotate refresh token: verify the old one, revoke it, issue a fresh pair.
 * @param {string} token - The raw refresh token from the client.
 * @returns {{ accessToken: string, refreshToken: string }}
 */
export async function rotateRefreshToken(token) {
  let decoded;
  try {
    decoded = jwt.verify(token, config.jwtRefreshSecret);
  } catch {
    throw Object.assign(new Error('Invalid refresh token'), { status: 401, code: 'INVALID_REFRESH_TOKEN' });
  }

  const { tenantId, userId, role } = decoded;
  const stored = await redis.get(refreshKey(tenantId, userId));

  if (!stored || stored !== token) {
    throw Object.assign(new Error('Refresh token revoked or not found'), {
      status: 401,
      code: 'REFRESH_TOKEN_REVOKED',
    });
  }

  // Invalidate the old token before issuing a new one (rotation).
  await redis.del(refreshKey(tenantId, userId));

  return issueTokens({ tenantId, userId, role });
}

/**
 * Revoke a refresh token (logout).
 * @param {string} tenantId
 * @param {string} userId
 */
export async function revokeRefreshToken(tenantId, userId) {
  await redis.del(refreshKey(tenantId, userId));
}

// ─── Authenticate Middleware ──────────────────────────────────────────────────

/**
 * Express middleware — verifies the Bearer access token on protected routes.
 * Attaches `req.tenant` = { tenantId, userId, role } on success.
 */
export function authenticate(req, res, next) {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({
      error: 'Missing or malformed Authorization header',
      code: 'MISSING_TOKEN',
    });
  }

  const token = authHeader.slice(7);

  try {
    const decoded = jwt.verify(token, config.jwtSecret);
    req.tenant = {
      tenantId: decoded.tenantId,
      userId: decoded.userId,
      role: decoded.role,
    };
    next();
  } catch (err) {
    if (err.name === 'TokenExpiredError') {
      return res.status(401).json({
        error: 'Access token has expired',
        code: 'TOKEN_EXPIRED',
      });
    }
    return res.status(401).json({
      error: 'Invalid access token',
      code: 'INVALID_TOKEN',
    });
  }
}

export { redis as authRedis };
