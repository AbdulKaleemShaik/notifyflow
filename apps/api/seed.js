// seed.js — Creates a demo tenant and prints the raw API key for dashboard login.
// Run once: node seed.js

import mongoose from 'mongoose';
import crypto from 'crypto';
import bcrypt from 'bcrypt';

const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27018/notifyflow';

// ── Inline Tenant schema (avoid importing the full model which needs dotenv) ──
const tenantSchema = new mongoose.Schema(
  {
    name: String,
    apiKey: String,
    secret: String,
    webhookUrl: { type: String, default: null },
    emailConfig: { type: Object, default: null },
    rateLimit: { type: Number, default: 100 },
  },
  { timestamps: true }
);

const Tenant = mongoose.model('Tenant', tenantSchema);

async function seed() {
  await mongoose.connect(MONGO_URI);
  console.log('Connected to MongoDB:', MONGO_URI);

  // Check if a demo tenant already exists.
  const existing = await Tenant.findOne({ name: 'Demo Tenant' });
  if (existing) {
    console.log('\n⚠️  A "Demo Tenant" already exists.');
    console.log('If you forgot the API key, delete the tenant and re-run this script.');
    await mongoose.disconnect();
    return;
  }

  // Generate a secure random raw API key.
  const rawApiKey = crypto.randomBytes(32).toString('hex');

  // Hash it with bcrypt (same as Tenant.js pre-save hook).
  const hashedKey = await bcrypt.hash(rawApiKey, 12);

  // Random HMAC secret for webhook signing.
  const secret = crypto.randomBytes(32).toString('hex');

  await Tenant.create({
    name: 'Demo Tenant',
    apiKey: hashedKey,
    secret,
    rateLimit: 100,
  });

  console.log('\n✅ Demo tenant created successfully!\n');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('  Dashboard URL : http://localhost:8080');
  console.log('  API Key       :', rawApiKey);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('\nPaste the API Key into the dashboard login form.');
  console.log('Save it somewhere safe — it will not be shown again.\n');

  await mongoose.disconnect();
}

seed().catch((err) => {
  console.error('Seed failed:', err.message);
  process.exit(1);
});
