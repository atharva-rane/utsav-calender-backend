'use strict';

require('dotenv').config();

const REQUIRED = ['DATABASE_URL', 'JWT_SECRET', 'ADMIN_EMAIL', 'ADMIN_PASSWORD'];
const missing = REQUIRED.filter((key) => !process.env[key]);

if (missing.length) {
  console.error(`Missing environment variables: ${missing.join(', ')}`);
  console.error('Copy .env.example to .env and fill in the values.');
  process.exit(1);
}

const env = process.env;
const isProduction = env.NODE_ENV === 'production';

// Tokens are signed with this secret, so a short or guessable one defeats the whole login system.
if (env.JWT_SECRET.length < 32) {
  const advice = 'JWT_SECRET should be at least 32 random characters (try: openssl rand -hex 32).';
  if (isProduction) {
    console.error(`[security] ${advice}`);
    process.exit(1);
  }
  console.warn(`[security] ${advice}`);
}

module.exports = {
  isProduction,
  // Set TRUST_PROXY=1 behind a reverse proxy / host (Render, Railway, nginx) so rate limits see real IPs.
  trustProxy: env.TRUST_PROXY ? Number(env.TRUST_PROXY) || env.TRUST_PROXY : false,
  port: Number(env.PORT) || 3000,
  // Comma-separated list of allowed frontend origins, or * to allow any (handy for phone testing).
  corsOrigins: (env.CORS_ORIGIN || 'http://localhost:4200')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean),
  databaseUrl: env.DATABASE_URL,
  jwtSecret: env.JWT_SECRET,
  // The first admin account is created from these values when the database has no admin yet.
  // The username defaults to ADMIN_EMAIL so the old "email + password" login keeps working.
  admin: {
    username: (env.ADMIN_USERNAME || env.ADMIN_EMAIL).trim().toLowerCase(),
    password: env.ADMIN_PASSWORD,
  },
  // Sign-in uses two tokens: a short-lived access token (JWT) sent with every request, and a
  // long-lived refresh token that quietly gets a new access token. People therefore stay signed
  // in until they log out, but a stolen access token stops working after a few minutes.
  accessTokenMinutes: Number(env.ACCESS_TOKEN_MINUTES) || 15,
  sessionDays: Number(env.SESSION_DAYS) || 365,
  smtp: {
    host: env.SMTP_HOST,
    port: Number(env.SMTP_PORT) || 587,
    user: env.SMTP_USER,
    pass: env.SMTP_PASS,
    from: env.MAIL_FROM || env.SMTP_USER,
  },
  reminders: {
    // Reminder dates and times are interpreted in this timezone (IANA name).
    timezone: env.TIMEZONE || 'Asia/Kolkata',
    maxTimesPerDate: 12,
    maxDatesPerRequest: 31,
    recipientsPerEmail: 50, // BCC batch size, keeps SMTP providers happy
  },
};
