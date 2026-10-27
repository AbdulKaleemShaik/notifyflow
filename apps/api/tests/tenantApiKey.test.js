// apps/api/tests/tenantApiKey.test.js
// Tenant API-key verification with real bcrypt hashes and the real Mongoose model.
// No database connection is opened: Tenant.find() is stubbed to return documents.

import { jest } from '@jest/globals';
import bcrypt from 'bcrypt';
import mongoose from 'mongoose';

// Capture the schema's pre('save') hook as Tenant.js registers it, so the
// hashing logic can be executed without a database connection.
const preSpy = jest.spyOn(mongoose.Schema.prototype, 'pre');
const { default: Tenant } = await import('../src/models/Tenant.js');
const preSaveHook = preSpy.mock.calls
  .map(([event, fn]) => (event === 'save' && typeof fn === 'function' ? fn : null))
  .find((fn) => fn && fn.toString().includes("isModified('apiKey')"));
preSpy.mockRestore();

// Low cost factor keeps the test fast; verifyApiKey reads the cost from the hash.
const hash = (key) => bcrypt.hash(key, 4);

function stubTenants(docs) {
  const lean = jest.fn().mockResolvedValue(docs);
  const select = jest.fn(() => ({ lean }));
  jest.spyOn(Tenant, 'find').mockReturnValue({ select });
  return { select, lean };
}

afterEach(() => jest.restoreAllMocks());

describe('Tenant.verifyApiKey', () => {
  test('returns the tenant whose bcrypt hash matches the raw key', async () => {
    const acme = { _id: 't1', name: 'Acme', apiKey: await hash('acme-key') };
    const globex = { _id: 't2', name: 'Globex', apiKey: await hash('globex-key') };
    stubTenants([acme, globex]);

    await expect(Tenant.verifyApiKey('globex-key')).resolves.toBe(globex);
    await expect(Tenant.verifyApiKey('acme-key')).resolves.toBe(acme);
  });

  test('returns null for a key that matches no tenant', async () => {
    stubTenants([{ _id: 't1', apiKey: await hash('acme-key') }]);
    await expect(Tenant.verifyApiKey('acme-key ')).resolves.toBeNull();
    await expect(Tenant.verifyApiKey('')).resolves.toBeNull();
  });

  test('returns null when there are no tenants', async () => {
    stubTenants([]);
    await expect(Tenant.verifyApiKey('anything')).resolves.toBeNull();
  });

  test('pre-save hook replaces the raw apiKey with a bcrypt hash', async () => {
    expect(typeof preSaveHook).toBe('function');
    const doc = new Tenant({ name: 'Acme', apiKey: 'raw-secret-key', secret: 'hmac' });

    await new Promise((resolve, reject) => {
      preSaveHook.call(doc, (err) => (err ? reject(err) : resolve()));
    });

    expect(doc.apiKey).not.toBe('raw-secret-key');
    expect(doc.apiKey).toMatch(/^\$2[aby]\$12\$/); // bcrypt, cost 12
    await expect(bcrypt.compare('raw-secret-key', doc.apiKey)).resolves.toBe(true);
  });

  test('pre-save hook does not re-hash an unmodified apiKey', async () => {
    const doc = new Tenant({ name: 'Acme', apiKey: 'already-hashed', secret: 'hmac' });
    jest.spyOn(doc, 'isModified').mockReturnValue(false);
    await new Promise((resolve) => preSaveHook.call(doc, resolve));
    expect(doc.apiKey).toBe('already-hashed');
  });
});
