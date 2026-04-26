// apps/api/src/models/Tenant.js
// Represents an API consumer (organisation/app) that uses NotifyFlow.
// The apiKey is stored as a bcrypt hash — the raw key is only returned at creation time.

import mongoose from 'mongoose';
import bcrypt from 'bcrypt';

const SALT_ROUNDS = 12;

const emailConfigSchema = new mongoose.Schema(
  {
    fromAddress: { type: String },
    smtpHost: { type: String },
    smtpPort: { type: Number },
    smtpUser: { type: String },
    smtpPass: { type: String },
  },
  { _id: false }
);

const tenantSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: [true, 'Tenant name is required'],
      trim: true,
    },
    // Stored as a bcrypt hash — never store or log the raw key.
    apiKey: {
      type: String,
      required: true,
      unique: true,
    },
    // HMAC secret used to sign outbound webhook payloads.
    secret: {
      type: String,
      required: true,
    },
    webhookUrl: {
      type: String,
      default: null,
    },
    emailConfig: {
      type: emailConfigSchema,
      default: null,
    },
    // Maximum notifications per minute for sliding-window rate limiter.
    rateLimit: {
      type: Number,
      default: 100,
    },
  },
  {
    timestamps: true, // adds createdAt and updatedAt automatically
  }
);

/**
 * Hash the raw apiKey before saving.
 * This pre-save hook fires on both `create` and `save`.
 */
tenantSchema.pre('save', async function (next) {
  // Only rehash if the key was actually modified (avoids double-hashing on re-save).
  if (!this.isModified('apiKey')) return next();
  try {
    this.apiKey = await bcrypt.hash(this.apiKey, SALT_ROUNDS);
    next();
  } catch (err) {
    next(err);
  }
});

/**
 * Static method: find a tenant whose stored apiKey hash matches the provided raw key.
 * Returns the Tenant document or null if not found / key mismatch.
 *
 * @param {string} rawKey - The plaintext API key supplied by the caller.
 * @returns {Promise<Tenant|null>}
 */
tenantSchema.statics.verifyApiKey = async function (rawKey) {
  // We cannot query by the hash directly (hash is not deterministic across bcrypt rounds),
  // so we fetch all tenants and compare. For production scale, consider a separate
  // SHA-256 lookup index alongside the bcrypt hash.
  // A practical improvement: store a non-secret SHA-256 prefix as an indexed lookup field.
  const tenants = await this.find({}).select('+apiKey').lean(false);
  for (const tenant of tenants) {
    const match = await bcrypt.compare(rawKey, tenant.apiKey);
    if (match) return tenant;
  }
  return null;
};

const Tenant = mongoose.model('Tenant', tenantSchema);
export default Tenant;
