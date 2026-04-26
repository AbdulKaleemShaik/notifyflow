// apps/api/src/routes/analytics.js
// Analytics routes for the dashboard.
//
//   GET /analytics/summary — aggregated metrics (single $facet pipeline)
//   GET /analytics/logs    — paginated + filtered notification log

import { Router } from 'express';
import mongoose from 'mongoose';
import NotificationLog from '../models/NotificationLog.js';
import logger from '../utils/logger.js';

const router = Router();

// ─── GET /analytics/summary ───────────────────────────────────────────────────
router.get('/summary', async (req, res) => {
  try {
    const { tenantId } = req.tenant;
    const startOfToday = new Date();
    startOfToday.setHours(0, 0, 0, 0);

    // Single aggregation pipeline with $facet — avoids multiple round-trips.
    // We match by both ObjectId and String formats to be resilient to environment differences.
    const matchQuery = {
      $or: [
        { tenantId: tenantId },
        { tenantId: mongoose.isValidObjectId(tenantId) ? new mongoose.Types.ObjectId(tenantId) : null }
      ]
    };

    const resultArr = await NotificationLog.aggregate([
      { $match: matchQuery },
      {
        $facet: {
          today: [
            { $match: { createdAt: { $gte: startOfToday } } },
            {
              $group: {
                _id: null,
                total: { $sum: 1 },
                delivered: { $sum: { $cond: [{ $eq: ['$status', 'delivered'] }, 1, 0] } },
                failed: { $sum: { $cond: [{ $eq: ['$status', 'failed'] }, 1, 0] } },
              },
            },
          ],
          byChannel: [
            {
              $group: {
                _id: '$channel',
                count: { $sum: 1 },
              },
            },
          ],
          deadLetter: [
            { $match: { status: 'dead_letter' } },
            { $count: 'count' },
          ],
          avgLatency: [
            {
              $match: {
                status: 'delivered',
                deliveredAt: { $exists: true, $ne: null },
              },
            },
            {
              $project: {
                latencyMs: {
                  $subtract: ['$deliveredAt', '$createdAt'],
                },
              },
            },
            {
              $group: {
                _id: null,
                avg: { $avg: '$latencyMs' },
              },
            },
          ],
        },
      },
    ]);

    const result = resultArr[0] || { today: [], byChannel: [], deadLetter: [], avgLatency: [] };
    
    const todayData = result.today[0] || { total: 0, delivered: 0, failed: 0 };
    const deliveryRate = todayData.total > 0
      ? Math.round((todayData.delivered / todayData.total) * 100)
      : 0;

    const byChannel = { 'in-app': 0, email: 0, webhook: 0 };
    if (result.byChannel) {
      for (const { _id, count } of result.byChannel) {
        if (_id) byChannel[_id] = count;
      }
    }

    return res.json({
      today: {
        total: todayData.total,
        delivered: todayData.delivered,
        failed: todayData.failed,
        deliveryRate,
      },
      byChannel,
      avgLatencyMs: result.avgLatency?.[0]?.avg ? Math.round(result.avgLatency[0].avg) : 0,
      deadLetterCount: result.deadLetter?.[0]?.count ?? 0,
    });
  } catch (err) {
    logger.error('GET /analytics/summary error:', err.message);
    return res.status(500).json({ error: 'Internal server error', code: 'INTERNAL_ERROR' });
  }
});

// ─── GET /analytics/logs ──────────────────────────────────────────────────────
router.get('/logs', async (req, res) => {
  try {
    const { tenantId } = req.tenant;
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 50));
    const skip = (page - 1) * limit;

    // Build dynamic filter object.
    const filter = { tenantId };

    if (req.query.status) filter.status = req.query.status;
    if (req.query.channel) filter.channel = req.query.channel;
    if (req.query.from || req.query.to) {
      filter.createdAt = {};
      if (req.query.from) filter.createdAt.$gte = new Date(req.query.from);
      if (req.query.to) filter.createdAt.$lte = new Date(req.query.to);
    }

    const [logs, total] = await Promise.all([
      NotificationLog.find(filter)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      NotificationLog.countDocuments(filter),
    ]);

    return res.json({
      data: logs,
      pagination: { page, limit, total, pages: Math.ceil(total / limit) },
    });
  } catch (err) {
    logger.error('GET /analytics/logs error:', err.message);
    return res.status(500).json({ error: 'Internal server error', code: 'INTERNAL_ERROR' });
  }
});

export default router;
