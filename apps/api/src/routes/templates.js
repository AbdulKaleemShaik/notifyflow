// apps/api/src/routes/templates.js
// Template CRUD routes — all scoped to the authenticated tenant.
//
//   GET    /templates              — list (paginated)
//   GET    /templates/:name        — get single
//   POST   /templates              — create
//   PUT    /templates/:name        — update (increments version)
//   DELETE /templates/:name        — soft delete (isActive: false)
//   GET    /templates/:name/preview — render with test data

import { Router } from 'express';
import Template from '../models/Template.js';
import logger from '../utils/logger.js';

const router = Router();
const SLUG_RE = /^[a-z0-9_-]+$/;

// ─── GET /templates ───────────────────────────────────────────────────────────
router.get('/', async (req, res) => {
  try {
    const { tenantId } = req.tenant;
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 20));
    const skip = (page - 1) * limit;

    const [templates, total] = await Promise.all([
      Template.find({ tenantId }).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
      Template.countDocuments({ tenantId }),
    ]);

    return res.json({
      data: templates,
      pagination: { page, limit, total, pages: Math.ceil(total / limit) },
    });
  } catch (err) {
    logger.error('GET /templates error:', err.message);
    return res.status(500).json({ error: 'Internal server error', code: 'INTERNAL_ERROR' });
  }
});

// ─── GET /templates/:name ─────────────────────────────────────────────────────
router.get('/:name', async (req, res) => {
  try {
    const { tenantId } = req.tenant;
    const template = await Template.findOne({ tenantId, name: req.params.name }).lean();

    if (!template) {
      return res.status(404).json({
        error: `Template '${req.params.name}' not found`,
        code: 'TEMPLATE_NOT_FOUND',
      });
    }
    return res.json(template);
  } catch (err) {
    logger.error('GET /templates/:name error:', err.message);
    return res.status(500).json({ error: 'Internal server error', code: 'INTERNAL_ERROR' });
  }
});

// ─── POST /templates ──────────────────────────────────────────────────────────
router.post('/', async (req, res) => {
  try {
    const { tenantId } = req.tenant;
    const { name, subject, body, channels } = req.body;

    if (!name || !SLUG_RE.test(name)) {
      return res.status(400).json({
        error: 'name must be slug format (a-z, 0-9, _, -)',
        code: 'VALIDATION_ERROR',
        field: 'name',
      });
    }
    if (!body) {
      return res.status(400).json({ error: 'body is required', code: 'VALIDATION_ERROR', field: 'body' });
    }

    const template = await Template.create({ tenantId, name, subject, body, channels });
    return res.status(201).json(template);
  } catch (err) {
    if (err.code === 11000) {
      return res.status(409).json({
        error: 'A template with that name already exists for this tenant',
        code: 'DUPLICATE_TEMPLATE',
      });
    }
    logger.error('POST /templates error:', err.message);
    return res.status(500).json({ error: 'Internal server error', code: 'INTERNAL_ERROR' });
  }
});

// ─── PUT /templates/:name ─────────────────────────────────────────────────────
router.put('/:name', async (req, res) => {
  try {
    const { tenantId } = req.tenant;
    const { subject, body, channels, isActive } = req.body;

    const template = await Template.findOne({ tenantId, name: req.params.name });
    if (!template) {
      return res.status(404).json({ error: 'Template not found', code: 'TEMPLATE_NOT_FOUND' });
    }

    if (subject !== undefined) template.subject = subject;
    if (body !== undefined) template.body = body;
    if (channels !== undefined) template.channels = channels;
    if (isActive !== undefined) template.isActive = isActive;

    // Increment version on each update — tracks revision history.
    template.version += 1;

    await template.save();
    return res.json(template);
  } catch (err) {
    logger.error('PUT /templates/:name error:', err.message);
    return res.status(500).json({ error: 'Internal server error', code: 'INTERNAL_ERROR' });
  }
});

// ─── DELETE /templates/:name ──────────────────────────────────────────────────
router.delete('/:name', async (req, res) => {
  try {
    const { tenantId } = req.tenant;
    const template = await Template.findOne({ tenantId, name: req.params.name });

    if (!template) {
      return res.status(404).json({ error: 'Template not found', code: 'TEMPLATE_NOT_FOUND' });
    }

    // Soft delete — set isActive: false. Hard deletes could invalidate notification logs.
    template.isActive = false;
    await template.save();

    return res.json({ message: `Template '${req.params.name}' deactivated` });
  } catch (err) {
    logger.error('DELETE /templates/:name error:', err.message);
    return res.status(500).json({ error: 'Internal server error', code: 'INTERNAL_ERROR' });
  }
});

// ─── GET /templates/:name/preview ─────────────────────────────────────────────
router.get('/:name/preview', async (req, res) => {
  try {
    const { tenantId } = req.tenant;
    const template = await Template.findOne({ tenantId, name: req.params.name }).lean();

    if (!template) {
      return res.status(404).json({ error: 'Template not found', code: 'TEMPLATE_NOT_FOUND' });
    }

    let data = {};
    if (req.query.data) {
      try {
        data = JSON.parse(req.query.data);
      } catch {
        return res.status(400).json({
          error: 'data query param must be valid JSON',
          code: 'INVALID_JSON',
          field: 'data',
        });
      }
    }

    // Inline render for preview — uses the same algorithm as templateRenderer.js
    const renderedBody = template.body.replace(/\{\{([\w.]+)\}\}/g, (match, key) => {
      const value = key.split('.').reduce((obj, k) => obj?.[k], data);
      return value !== undefined ? String(value) : match;
    });

    const renderedSubject = template.subject.replace(/\{\{([\w.]+)\}\}/g, (match, key) => {
      const value = key.split('.').reduce((obj, k) => obj?.[k], data);
      return value !== undefined ? String(value) : match;
    });

    return res.json({
      name: template.name,
      subject: renderedSubject,
      body: renderedBody,
      channels: template.channels,
    });
  } catch (err) {
    logger.error('GET /templates/:name/preview error:', err.message);
    return res.status(500).json({ error: 'Internal server error', code: 'INTERNAL_ERROR' });
  }
});

export default router;
