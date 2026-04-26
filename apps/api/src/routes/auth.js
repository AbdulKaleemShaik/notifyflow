// apps/api/src/routes/auth.js
// Authentication routes:
//   POST /auth/token   — exchange apiKey for JWT pair
//   POST /auth/refresh — rotate refresh token
//   POST /auth/logout  — revoke refresh token

import { Router } from 'express';
import Tenant from '../models/Tenant.js';
import { issueTokens, rotateRefreshToken, revokeRefreshToken, authenticate } from '../middleware/auth.js';
import logger from '../utils/logger.js';

const router = Router();

// ─── POST /auth/token ─────────────────────────────────────────────────────────
// Exchange a raw API key for an access + refresh token pair.
router.post('/token', async (req, res) => {
  try {
    const { apiKey } = req.body;

    if (!apiKey || typeof apiKey !== 'string') {
      return res.status(400).json({
        error: 'apiKey is required',
        code: 'MISSING_API_KEY',
        field: 'apiKey',
      });
    }

    const tenant = await Tenant.verifyApiKey(apiKey);

    if (!tenant) {
      // Deliberate vague message — don't reveal whether the tenant exists.
      return res.status(401).json({
        error: 'Invalid API key',
        code: 'INVALID_API_KEY',
      });
    }

    const tokens = await issueTokens({
      tenantId: tenant._id.toString(),
      userId: 'system', // API key auth is tenant-level; userId is 'system'
      role: 'tenant',
    });

    logger.info(`Token issued for tenant: ${tenant._id}`);

    return res.status(200).json({
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      expiresIn: 900, // 15 minutes in seconds
      tenantId: tenant._id,
      tenantName: tenant.name,
    });
  } catch (err) {
    logger.error('POST /auth/token error:', err.message);
    return res.status(500).json({
      error: 'Internal server error',
      code: 'INTERNAL_ERROR',
    });
  }
});

// ─── POST /auth/refresh ───────────────────────────────────────────────────────
// Rotate refresh token — invalidates old token, issues a fresh pair.
router.post('/refresh', async (req, res) => {
  try {
    const { refreshToken } = req.body;

    if (!refreshToken || typeof refreshToken !== 'string') {
      return res.status(400).json({
        error: 'refreshToken is required',
        code: 'MISSING_REFRESH_TOKEN',
        field: 'refreshToken',
      });
    }

    const tokens = await rotateRefreshToken(refreshToken);

    return res.status(200).json({
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      expiresIn: 900,
    });
  } catch (err) {
    return res.status(err.status || 500).json({
      error: err.message,
      code: err.code || 'INTERNAL_ERROR',
    });
  }
});

// ─── POST /auth/logout ────────────────────────────────────────────────────────
// Revoke the refresh token — client must discard both tokens locally.
router.post('/logout', authenticate, async (req, res) => {
  try {
    const { tenantId, userId } = req.tenant;
    await revokeRefreshToken(tenantId, userId);

    return res.status(200).json({ message: 'Logged out successfully' });
  } catch (err) {
    logger.error('POST /auth/logout error:', err.message);
    return res.status(500).json({
      error: 'Internal server error',
      code: 'INTERNAL_ERROR',
    });
  }
});

export default router;
