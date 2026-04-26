// apps/api/src/routes/notify.js
// POST /notify — validates, logs, and enqueues notification jobs per channel.
// Protected by authenticate + rateLimiter middleware (applied in app.js).

import { Router } from 'express';
import Template from '../models/Template.js';
import Tenant from '../models/Tenant.js';
import NotificationLog from '../models/NotificationLog.js';
import { enqueue } from '../services/queueService.js';
import { rateLimiter } from '../middleware/rateLimiter.js';
import logger from '../utils/logger.js';

const router = Router();

// ─── Validation ───────────────────────────────────────────────────────────────

const SLUG_RE = /^[a-z0-9_-]+$/;
const VALID_CHANNELS = ['in-app', 'email', 'webhook'];

function validateNotifyBody(body) {
  const errors = [];

  if (!body.userId || typeof body.userId !== 'string' || !body.userId.trim()) {
    errors.push({ field: 'userId', message: 'userId is required and must be a non-empty string' });
  }

  if (!body.templateName || typeof body.templateName !== 'string' || !SLUG_RE.test(body.templateName)) {
    errors.push({
      field: 'templateName',
      message: 'templateName is required and must be slug format (a-z, 0-9, _, -)',
    });
  }

  if (!Array.isArray(body.channels) || body.channels.length === 0) {
    errors.push({ field: 'channels', message: 'channels must be a non-empty array' });
  } else {
    const invalid = body.channels.filter((c) => !VALID_CHANNELS.includes(c));
    if (invalid.length > 0) {
      errors.push({
        field: 'channels',
        message: `Invalid channels: ${invalid.join(', ')}. Valid: ${VALID_CHANNELS.join(', ')}`,
      });
    }
  }

  if (body.data !== undefined && (typeof body.data !== 'object' || Array.isArray(body.data))) {
    errors.push({ field: 'data', message: 'data must be an object' });
  }

  return errors;
}

// ─── POST /notify ─────────────────────────────────────────────────────────────

// Apply rate limiter here (needs tenantDoc — we fetch the tenant in the handler).
router.post('/', rateLimiterWithTenant, async (req, res) => {
  try {
    const { tenantId } = req.tenant;

    // 1. Validate request body
    const errors = validateNotifyBody(req.body);
    if (errors.length > 0) {
      return res.status(400).json({
        error: 'Request validation failed',
        code: 'VALIDATION_ERROR',
        details: errors,
      });
    }

    const { userId, templateName, channels, data = {} } = req.body;

    // 2. Look up the template (scoped to tenant for multi-tenancy isolation)
    const template = await Template.findOne({
      tenantId,
      name: templateName,
      isActive: true,
    });

    if (!template) {
      return res.status(404).json({
        error: `Template '${templateName}' not found or inactive`,
        code: 'TEMPLATE_NOT_FOUND',
      });
    }

    // 3. Validate that all requested channels are declared on the template
    const unsupported = channels.filter((c) => !template.channels.includes(c));
    if (unsupported.length > 0) {
      return res.status(400).json({
        error: `Template '${templateName}' does not support channels: ${unsupported.join(', ')}`,
        code: 'UNSUPPORTED_CHANNEL',
        field: 'channels',
      });
    }

    // 4. Get tenant secret for webhook HMAC signing
    const tenant = await Tenant.findById(tenantId).select('secret webhookUrl').lean();

    // 5. Create a NotificationLog per channel and enqueue a BullMQ job for each
    const jobIds = [];

    await Promise.all(
      channels.map(async (channel) => {
        const log = await NotificationLog.create({
          tenantId,
          userId,
          templateName,
          channel,
          status: 'queued',
          payload: data,
        });

        const job = await enqueue({
          notificationLogId: log._id.toString(),
          tenantId,
          userId,
          channel,
          templateName,
          data,
          tenantSecret: tenant?.secret || '',
          webhookUrl: tenant?.webhookUrl || '',
          userEmail: data?.userEmail || data?.email || '',
        });

        jobIds.push(job.id);
      })
    );

    // 6. Return 202 immediately — the queue handles actual delivery asynchronously.
    return res.status(202).json({
      message: 'Notification queued',
      jobIds,
    });
  } catch (err) {
    logger.error('POST /notify error:', err.message, err.stack);
    return res.status(500).json({
      error: 'Internal server error',
      code: 'INTERNAL_ERROR',
    });
  }
});

// ─── Rate Limiter with Tenant Doc ─────────────────────────────────────────────
// Fetch the tenant document to get the per-tenant rateLimit value, then delegate
// to the standard sliding window checker.

async function rateLimiterWithTenant(req, res, next) {
  try {
    const { tenantId } = req.tenant;
    const tenant = await Tenant.findById(tenantId).select('rateLimit').lean();
    req.tenantDoc = tenant;
    rateLimiter(req, res, next);
  } catch {
    // Fail open if tenant fetch fails.
    next();
  }
}

export default router;
