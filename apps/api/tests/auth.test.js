// apps/api/tests/auth.test.js
// Tenant authentication: API key → JWT exchange, the `authenticate` middleware,
// and refresh-token rotation/revocation backed by Redis.
// Redis is replaced with an in-memory Map; the Tenant model is mocked for the route
// tests, while Tenant.verifyApiKey is exercised against real bcrypt hashes.

import { jest } from '@jest/globals';

// ─── In-memory Redis mock ─────────────────────────────────────────────────────

const store = new Map();
const mockRedis = {
  set: jest.fn(async (key, value) => { store.set(key, value); return 'OK'; }),
  get: jest.fn(async (key) => store.get(key) ?? null),
  del: jest.fn(async (key) => (store.delete(key) ? 1 : 0)),
  on: jest.fn(),
  quit: jest.fn(),
};
jest.unstable_mockModule('ioredis', () => ({ default: jest.fn(() => mockRedis) }));

// ─── Mock Tenant model (route tests) ──────────────────────────────────────────

const Tenant = { verifyApiKey: jest.fn() };
jest.unstable_mockModule('../src/models/Tenant.js', () => ({ default: Tenant }));

const { default: supertest } = await import('supertest');
const { default: express } = await import('express');
const { default: jwt } = await import('jsonwebtoken');
const { authenticate, issueTokens, rotateRefreshToken, revokeRefreshToken } =
  await import('../src/middleware/auth.js');
const { default: authRouter } = await import('../src/routes/auth.js');

const JWT_SECRET = process.env.JWT_SECRET;
const JWT_REFRESH_SECRET = process.env.JWT_REFRESH_SECRET;
const TENANT_ID = '6632ab0000000000000000aa';

// A protected app: /auth routes + one route behind `authenticate`.
const app = express();
app.use(express.json());
app.use('/auth', authRouter);
app.get('/protected', authenticate, (req, res) => res.json({ tenant: req.tenant }));

afterEach(() => jest.restoreAllMocks());

beforeEach(() => {
  store.clear();
  jest.clearAllMocks();
});

// ─── authenticate middleware ──────────────────────────────────────────────────

describe('authenticate middleware', () => {
  test('rejects a request with no Authorization header', async () => {
    const res = await supertest(app).get('/protected');
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('MISSING_TOKEN');
  });

  test('rejects a non-Bearer Authorization scheme', async () => {
    const res = await supertest(app).get('/protected').set('Authorization', 'Basic abc123');
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('MISSING_TOKEN');
  });

  test('rejects a raw API key passed as a Bearer token (must be exchanged for a JWT first)', async () => {
    const res = await supertest(app).get('/protected').set('Authorization', 'Bearer nf_raw_api_key');
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('INVALID_TOKEN');
  });

  test('rejects a refresh token used as an access token (different signing secret)', async () => {
    const refresh = jwt.sign({ tenantId: TENANT_ID, userId: 'system' }, JWT_REFRESH_SECRET);
    const res = await supertest(app).get('/protected').set('Authorization', `Bearer ${refresh}`);
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('INVALID_TOKEN');
  });

  test('returns TOKEN_EXPIRED for an expired access token', async () => {
    const expired = jwt.sign(
      { tenantId: TENANT_ID, userId: 'system', role: 'tenant', exp: Math.floor(Date.now() / 1000) - 10 },
      JWT_SECRET
    );
    const res = await supertest(app).get('/protected').set('Authorization', `Bearer ${expired}`);
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('TOKEN_EXPIRED');
  });

  test('attaches req.tenant for a valid access token', async () => {
    const token = jwt.sign({ tenantId: TENANT_ID, userId: 'system', role: 'tenant' }, JWT_SECRET);
    const res = await supertest(app).get('/protected').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.tenant).toEqual({ tenantId: TENANT_ID, userId: 'system', role: 'tenant' });
  });
});

// ─── POST /auth/token ─────────────────────────────────────────────────────────

describe('POST /auth/token — API key exchange', () => {
  test('returns 400 when apiKey is missing', async () => {
    const res = await supertest(app).post('/auth/token').send({});
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('MISSING_API_KEY');
  });

  test('returns 401 with a generic message for an unknown API key', async () => {
    Tenant.verifyApiKey.mockResolvedValue(null);
    const res = await supertest(app).post('/auth/token').send({ apiKey: 'wrong' });
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: 'Invalid API key', code: 'INVALID_API_KEY' });
  });

  test('issues an access + refresh pair scoped to the tenant for a valid API key', async () => {
    Tenant.verifyApiKey.mockResolvedValue({ _id: TENANT_ID, name: 'Acme Corp' });

    const res = await supertest(app).post('/auth/token').send({ apiKey: 'good-key' });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ expiresIn: 900, tenantId: TENANT_ID, tenantName: 'Acme Corp' });

    const access = jwt.verify(res.body.accessToken, JWT_SECRET);
    expect(access).toMatchObject({ tenantId: TENANT_ID, userId: 'system', role: 'tenant' });
    expect(access.exp - access.iat).toBe(15 * 60);

    // The access token works on a protected route.
    const protectedRes = await supertest(app)
      .get('/protected')
      .set('Authorization', `Bearer ${res.body.accessToken}`);
    expect(protectedRes.status).toBe(200);
  });

  test('returns 500 when the tenant lookup throws', async () => {
    jest.spyOn(console, 'error').mockImplementation(() => {});
    Tenant.verifyApiKey.mockRejectedValue(new Error('mongo down'));
    const res = await supertest(app).post('/auth/token').send({ apiKey: 'k' });
    expect(res.status).toBe(500);
  });
});

// ─── Refresh-token rotation ───────────────────────────────────────────────────

describe('refresh tokens', () => {
  const claims = { tenantId: TENANT_ID, userId: 'system', role: 'tenant' };

  test('issueTokens stores the refresh token in Redis with a 7-day TTL', async () => {
    const { refreshToken } = await issueTokens(claims);
    expect(mockRedis.set).toHaveBeenCalledWith(
      `refresh:${TENANT_ID}:system`, refreshToken, 'EX', 7 * 24 * 60 * 60
    );
  });

  test('rotation revokes the old refresh token (replay is rejected)', async () => {
    const first = await issueTokens(claims);
    // jwt iat has 1s resolution; make sure the rotated token differs.
    await new Promise((r) => setTimeout(r, 1100));

    const second = await rotateRefreshToken(first.refreshToken);
    expect(second.refreshToken).not.toBe(first.refreshToken);
    expect(store.get(`refresh:${TENANT_ID}:system`)).toBe(second.refreshToken);

    await expect(rotateRefreshToken(first.refreshToken)).rejects.toMatchObject({
      status: 401,
      code: 'REFRESH_TOKEN_REVOKED',
    });
  });

  test('rejects a refresh token with a bad signature', async () => {
    const forged = jwt.sign(claims, 'attacker-secret');
    await expect(rotateRefreshToken(forged)).rejects.toMatchObject({ code: 'INVALID_REFRESH_TOKEN' });
  });

  test('revokeRefreshToken (logout) makes the refresh token unusable', async () => {
    const { refreshToken } = await issueTokens(claims);
    await revokeRefreshToken(TENANT_ID, 'system');
    await expect(rotateRefreshToken(refreshToken)).rejects.toMatchObject({ code: 'REFRESH_TOKEN_REVOKED' });
  });

  test('POST /auth/refresh returns a new pair, POST /auth/logout requires auth', async () => {
    const { refreshToken } = await issueTokens(claims);
    const res = await supertest(app).post('/auth/refresh').send({ refreshToken });
    expect(res.status).toBe(200);
    expect(res.body.accessToken).toEqual(expect.any(String));

    const logout = await supertest(app).post('/auth/logout');
    expect(logout.status).toBe(401);
  });
});
