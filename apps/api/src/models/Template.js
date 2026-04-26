// apps/api/src/models/Template.js
// Defines a notification template belonging to a tenant.
// Templates use {{variable}} and {{nested.variable}} placeholders rendered at dispatch time.

import mongoose from 'mongoose';

const VALID_CHANNELS = ['in-app', 'email', 'webhook'];

const templateSchema = new mongoose.Schema(
  {
    tenantId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Tenant',
      required: [true, 'tenantId is required'],
      index: true,
    },
    // Slug format: lowercase letters, digits, underscores, hyphens only.
    // Example: "order_confirmed", "password-reset"
    name: {
      type: String,
      required: [true, 'Template name is required'],
      trim: true,
      match: [/^[a-z0-9_-]+$/, 'Template name must be slug format (a-z, 0-9, _, -)'],
    },
    // Used as the email Subject line when dispatching via email channel.
    subject: {
      type: String,
      default: '',
    },
    // HTML body with {{variable}} placeholders.
    body: {
      type: String,
      required: [true, 'Template body is required'],
    },
    // Which delivery channels are enabled for this template.
    channels: {
      type: [String],
      enum: {
        values: VALID_CHANNELS,
        message: '{VALUE} is not a valid channel. Must be one of: in-app, email, webhook',
      },
      default: ['in-app'],
      validate: {
        validator: (arr) => arr.length > 0,
        message: 'At least one channel must be specified',
      },
    },
    // Auto-incremented on each PUT — tracked for audit purposes.
    version: {
      type: Number,
      default: 1,
      min: 1,
    },
    isActive: {
      type: Boolean,
      default: true,
    },
  },
  {
    timestamps: true,
  }
);

// Compound unique index: each tenant can only have one template with a given name.
templateSchema.index({ tenantId: 1, name: 1 }, { unique: true });

const Template = mongoose.model('Template', templateSchema);
export default Template;
