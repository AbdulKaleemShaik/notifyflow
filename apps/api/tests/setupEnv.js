// apps/api/tests/setupEnv.js
// Runs before every test file (jest "setupFiles"). Provides deterministic config
// so tests never depend on a developer's local .env.

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-for-testing-only';
process.env.JWT_REFRESH_SECRET = process.env.JWT_REFRESH_SECRET || 'test-refresh-secret-for-testing-only';
