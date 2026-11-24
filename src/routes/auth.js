'use strict';

const { Router } = require('express');
const rateLimit = require('express-rate-limit');
const { query } = require('../db');
const { requireAuth } = require('../middleware/auth');
const { createCaptcha, checkCaptcha } = require('../services/captcha');
const { hashPassword, verifyPassword } = require('../services/passwords');
const {
  createSession,
  refreshSession,
  endSession,
  endAllSessions,
} = require('../services/sessions');
const { HttpError, asyncHandler } = require('../utils/errors');

const router = Router();

// Slow down brute-force attempts on sign-in; refreshing is cheap and happens often.
const loginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 40, standardHeaders: true });
const captchaLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 150, standardHeaders: true });
const refreshLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 300, standardHeaders: true });

const publicUser = (user) => ({
  id: user.id,
  username: user.username,
  full_name: user.full_name,
  role: user.role,
});

// A real hash to compare against when the username does not exist, so timing does not reveal it.
const DUMMY_HASH_PROMISE = hashPassword('not-a-real-password');

// GET /api/auth/captcha  ->  { token, image }   (image is an SVG data: URL showing "7 + 4 = ?")
router.get('/captcha', captchaLimiter, (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json(createCaptcha());
});

// POST /api/auth/login  { username, password, captcha_token, captcha_answer }
//   ->  { token, refresh_token, user }
router.post(
  '/login',
  loginLimiter,
  asyncHandler(async (req, res) => {
    const body = req.body || {};
    const username = String(body.username ?? '')
      .trim()
      .toLowerCase();
    const password = String(body.password ?? '');

    if (!username || !password) throw new HttpError(400, 'Enter your username and password');
    if (!checkCaptcha(body.captcha_token, body.captcha_answer)) {
      throw new HttpError(400, 'The sum is not correct. Try the new one.');
    }

    const [user] = await query(
      `SELECT id, username, full_name, role, active, token_version, password_hash
       FROM users WHERE lower(username) = $1`,
      [username],
    );
    const passwordOk = await verifyPassword(
      password,
      user ? user.password_hash : await DUMMY_HASH_PROMISE,
    );

    if (!user || !passwordOk) throw new HttpError(401, 'Wrong username or password');
    if (!user.active) throw new HttpError(403, 'This account is turned off. Ask the admin.');

    const tokens = await createSession(user, req.get('user-agent'));
    res.json({ ...tokens, user: publicUser(user) });
  }),
);

// POST /api/auth/refresh  { refresh_token }  ->  { token, refresh_token?, user }
// The app calls this when the access token is about to expire, and when it opens.
router.post(
  '/refresh',
  refreshLimiter,
  asyncHandler(async (req, res) => {
    const result = await refreshSession(req.body?.refresh_token);
    if (!result) throw new HttpError(401, 'Please sign in again');

    res.set('Cache-Control', 'no-store');
    const { user, ...tokens } = result;
    res.json({ ...tokens, user: publicUser(user) });
  }),
);

// POST /api/auth/logout  { refresh_token }  - ends this device's session for good
router.post(
  '/logout',
  refreshLimiter,
  asyncHandler(async (req, res) => {
    await endSession(req.body?.refresh_token);
    res.sendStatus(204);
  }),
);

// POST /api/auth/logout-all  - "sign out everywhere", including this device
router.post(
  '/logout-all',
  requireAuth(),
  asyncHandler(async (req, res) => {
    await endAllSessions(req.user.id);
    res.sendStatus(204);
  }),
);

// GET /api/auth/me  ->  { user }
router.get('/me', requireAuth(), (req, res) => {
  res.json({ user: publicUser(req.user) });
});

// POST /api/auth/password  { current_password, new_password }  - change your own password.
// Every session (all devices) is ended, and this device gets a fresh one.
router.post(
  '/password',
  loginLimiter,
  requireAuth(),
  asyncHandler(async (req, res) => {
    const { current_password: current = '', new_password: next = '' } = req.body || {};
    if (String(next).length < 8) throw new HttpError(400, 'New password must be at least 8 characters');

    const [row] = await query('SELECT password_hash FROM users WHERE id = $1', [req.user.id]);
    if (!(await verifyPassword(current, row.password_hash))) {
      throw new HttpError(400, 'Current password is not correct');
    }

    const [updated] = await query(
      `UPDATE users SET password_hash = $1, token_version = token_version + 1
       WHERE id = $2 RETURNING id, username, full_name, role, token_version`,
      [await hashPassword(next), req.user.id],
    );
    await endAllSessions(updated.id);
    const tokens = await createSession(updated, req.get('user-agent'));
    res.json({ ...tokens, user: publicUser(updated) });
  }),
);

module.exports = router;
