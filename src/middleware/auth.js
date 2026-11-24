'use strict';

const { query } = require('../db');
const { verifyAccessToken } = require('../services/sessions');
const { HttpError, asyncHandler } = require('../utils/errors');

/**
 * Require a valid "Authorization: Bearer <access token>" header.
 * Pass roles to restrict access, e.g. requireAuth('admin').
 * Sets req.user = { id, username, full_name, role, sessionId }.
 *
 * Besides checking the JWT signature, issuer, audience and expiry, we confirm in the database
 * that the session is still open and the user is still active. That is what makes "log out",
 * "turn off account" and "reset password" take effect at once instead of when the token expires.
 */
const requireAuth = (...allowedRoles) =>
  asyncHandler(async (req, res, next) => {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : '';

    let payload;
    try {
      payload = verifyAccessToken(token);
    } catch {
      throw new HttpError(401, 'Please sign in again');
    }

    const [user] = await query(
      `SELECT u.id, u.username, u.full_name, u.role, u.active, u.token_version
       FROM users u JOIN sessions s ON s.user_id = u.id
       WHERE u.id = $1 AND s.id = $2 AND s.expires_at > now()`,
      [Number(payload.sub), payload.sid],
    );
    if (!user || !user.active || user.token_version !== payload.tv) {
      throw new HttpError(401, 'Please sign in again');
    }

    if (allowedRoles.length && !allowedRoles.includes(user.role)) {
      throw new HttpError(403, 'Admin access required');
    }
    req.user = { ...user, sessionId: payload.sid };
    next();
  });

module.exports = { requireAuth };
