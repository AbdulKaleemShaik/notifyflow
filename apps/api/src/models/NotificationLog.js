// apps/api/src/models/NotificationLog.js
// Immutable audit trail of every notification dispatched by NotifyFlow.
// Documents transition from "queued" → "processing" → "delivered" | "failed" | "dead_letter".

import mongoose from 'mongoose';

const VALID_CHANNELS = ['in-app', 'email', 'webhook'];
const VALID_STATUSES = ['queued', 'processing', 'delivered', 'failed', 'dead_letter'];

const notificationLogSchema = new mongoose.Schema(
  {
    tenantId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Tenant',
      required: [true, 'tenantId is required'],
    },
    // The end-user who should receive this notification (opaque string, not a MongoDB ref).
    userId: {
      type: String,
      required: [true, 'userId is required'],
    },
    templateName: {
      type: String,
      required: [true, 'templateName is required'],
    },
    channel: {
      type: String,
      enum: {
        values: VALID_CHANNELS,
        message: '{VALUE} is not a valid channel',
      },
      required: [true, 'channel is required'],
    },
    status: {
      type: String,
      enum: {
        values: VALID_STATUSES,
        message: '{VALUE} is not a valid status',
      },
      default: 'queued',
    },
    // Raw data object merged into the template at render time.
    payload: {
      type: mongoose.Schema.Types.Mixed,
      default: {},
    },
    // Final rendered output (HTML string) after template variable substitution.
    renderedBody: {
      type: String,
      default: null,
    },
    // Total number of dispatch attempts (0 = not yet tried).
    attempts: {
      type: Number,
      default: 0,
      min: 0,
    },
    // Last error message or HTTP response body — useful for debugging failed deliveries.
    lastError: {
      type: String,
      default: null,
    },
    deliveredAt: {
      type: Date,
      default: null,
    },
  },
  {
    // createdAt is used for TTL expiry and as the default sort key.
    timestamps: { createdAt: true, updatedAt: false },
  }
);

// TTL index: documents are automatically deleted 90 days after creation.
// This keeps the collection from growing unbounded in production.
notificationLogSchema.index(
  { createdAt: 1 },
  { expireAfterSeconds: 90 * 24 * 60 * 60 }
);

// Compound index optimised for the dashboard query pattern:
// "fetch logs for this tenant, filtered by status, sorted newest-first"
notificationLogSchema.index({ tenantId: 1, status: 1, createdAt: -1 });

const NotificationLog = mongoose.model('NotificationLog', notificationLogSchema);
export default NotificationLog;
