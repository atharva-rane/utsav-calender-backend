'use strict';

const config = require('../src/config');
const { initSchema } = require('../src/db');
const { ensureAdmin } = require('../src/services/users');
const { createApp } = require('../src/app');

let initializationPromise;

async function initialize() {
  await initSchema(ensureAdmin);
  return createApp();
}

module.exports = async (req, res) => {
  try {
    if (!initializationPromise) {
      initializationPromise = initialize().catch((err) => {
        initializationPromise = null;
        throw err;
      });
    }

    const app = await initializationPromise;
    return app(req, res);
  } catch (err) {
    console.error('[startup] Failed to initialize API:', err);
    return res.status(500).json({
      error: 'Internal server error',
    });
  }
};
