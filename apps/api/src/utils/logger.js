// apps/api/src/utils/logger.js
// Minimal logger wrapper that suppresses output in test environment.
// Never use console.log directly in production code — use this instead.

import config from '../config/index.js';

const isTest = config.nodeEnv === 'test';

const logger = {
  info: (...args) => {
    if (!isTest) console.info('[INFO]', new Date().toISOString(), ...args);
  },
  warn: (...args) => {
    if (!isTest) console.warn('[WARN]', new Date().toISOString(), ...args);
  },
  error: (...args) => {
    // Always log errors, even in test — tests should see failures.
    console.error('[ERROR]', new Date().toISOString(), ...args);
  },
  debug: (...args) => {
    if (config.nodeEnv === 'development') {
      console.debug('[DEBUG]', new Date().toISOString(), ...args);
    }
  },
};

export default logger;
