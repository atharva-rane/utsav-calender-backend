'use strict';

const express = require('express');
const cors = require('cors');
const config = require('./config');
const { errorHandler } = require('./utils/errors');

function createApp() {
  const app = express();
  app.disable('x-powered-by');
  if (config.trustProxy) app.set('trust proxy', config.trustProxy);

  // Basic security headers for an API: no sniffing, no framing, no referrers, no caching of
  // private data, and HTTPS-only in production.
  app.use((req, res, next) => {
    res.set({
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'no-referrer',
      'Cache-Control': 'no-store',
      'Cross-Origin-Resource-Policy': 'cross-origin',
    });
    if (config.isProduction) {
      res.set('Strict-Transport-Security', 'max-age=15552000; includeSubDomains');
    }
    next();
  });
  app.use(cors({ origin: config.corsOrigins.includes('*') ? true : config.corsOrigins }));
  app.use(express.json({ limit: '1mb' }));
  // Root endpoint
  app.get('/', (req, res) => {
    res.status(200).json({
      status: 'OK',
      message: 'Utsav Calendar API is running',
    });
  });

  // Health check endpoint
  app.get('/api/health', (req, res) => {
    res.status(200).json({
      status: 'OK',
      message: 'Health check successful',
      timestamp: new Date().toISOString(),
    });
  });

  app.use('/api/auth', require('./routes/auth'));
  app.use('/api/events', require('./routes/events'));
  app.use('/api/recipients', require('./routes/recipients'));
  app.use('/api/reminders', require('./routes/reminders'));
  app.use('/api/admin', require('./routes/admin'));
  app.use('/api/users', require('./routes/users'));

  app.use(errorHandler);
  return app;
}

module.exports = { createApp };
