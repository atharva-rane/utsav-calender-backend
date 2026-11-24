'use strict';

/**
 * Sign-in sessions.
 *
 *  - Access token: a signed JWT (HS256, 15 minutes) with issuer/audience checks. It names the
 *    session it belongs to, and the server confirms that session still exists on every request,
 *    so logging out (or an admin turning an account off) works immediately.
 *  - Refresh token: "<session id>.<random secret>". Only a SHA-256 hash of the secret is stored.
 *    Every refresh replaces the secret (rotation). If an OLD secret shows up again after the
 *    grace window it was probably stolen, so the whole session is revoked.
 */

const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const config = require('../config');
const { query } = require('../db');

const ISSUER = 'utsav-calendar';
const AUDIENCE = 'utsav-web';
const GRACE_SECONDS = 60; // two tabs refreshing at the same moment must not look like theft
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');
const sameHash = (a, b) => {
  if (!a || !b || a.length !== b.length) return false;
  return crypto.timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
};

function signAccessToken(user, sessionId) {
  return jwt.sign({ role: user.role, tv: user.token_version, sid: sessionId }, config.jwtSecret, {
    algorithm: 'HS256',
    expiresIn: `${config.accessTokenMinutes}m`,
    issuer: ISSUER,
    audience: AUDIENCE,
    subject: String(user.id),
  });
}

/** Throws if the token is forged, expired, for another audience, or not an access token. */
function verifyAccessToken(token) {
  const payload = jwt.verify(token, config.jwtSecret, {
    algorithms: ['HS256'],
    issuer: ISSUER,
    audience: AUDIENCE,
  });
  if (!UUID.test(String(payload.sid)) || !Number.isInteger(Number(payload.sub))) {
    throw new Error('Malformed token');
  }
  return payload;
}

const splitRefreshToken = (token) => {
  const [id, secret, extra] = String(token || '').split('.');
  return UUID.test(id || '') && secret && !extra ? { id, secret } : null;
};

/** Start a session for a user who has just proven who they are. */
async function createSession(user, userAgent = '') {
  await query('DELETE FROM sessions WHERE expires_at < now()'); // tidy up while we are here

  const id = crypto.randomUUID();
  const secret = crypto.randomBytes(32).toString('base64url');
  await query(
    `INSERT INTO sessions (id, user_id, refresh_hash, expires_at, user_agent)
     VALUES ($1, $2, $3, now() + make_interval(days => $4), $5)`,
    [id, user.id, sha256(secret), config.sessionDays, String(userAgent).slice(0, 200)],
  );
  return { token: signAccessToken(user, id), refresh_token: `${id}.${secret}` };
}

/**
 * Swap a refresh token for a new access token (and a new refresh token).
 * Returns null when the token is unknown, expired, reused, or the user is turned off.
 * `refresh_token` is omitted inside the grace window - the client's saved one is still right.
 */
async function refreshSession(refreshToken) {
  const parts = splitRefreshToken(refreshToken);
  if (!parts) return null;

  const [row] = await query(
    `SELECT s.id, s.refresh_hash, s.prev_hash,
            (s.rotated_at > now() - make_interval(secs => $2)) AS in_grace,
            (s.expires_at > now()) AS alive,
            u.id AS user_id, u.username, u.full_name, u.role, u.active, u.token_version
     FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.id = $1`,
    [parts.id, GRACE_SECONDS],
  );
  if (!row || !row.alive || !row.active) return null;

  const user = {
    id: row.user_id,
    username: row.username,
    full_name: row.full_name,
    role: row.role,
    token_version: row.token_version,
  };
  const presented = sha256(parts.secret);

  if (sameHash(presented, row.refresh_hash)) {
    const secret = crypto.randomBytes(32).toString('base64url');
    const [rotated] = await query(
      `UPDATE sessions
       SET prev_hash = refresh_hash, refresh_hash = $2, rotated_at = now(), last_used_at = now(),
           expires_at = now() + make_interval(days => $3)
       WHERE id = $1 AND refresh_hash = $4
       RETURNING id`,
      [row.id, sha256(secret), config.sessionDays, row.refresh_hash],
    );
    if (rotated) {
      return { user, token: signAccessToken(user, row.id), refresh_token: `${row.id}.${secret}` };
    }
    // Another request rotated it a split second ago: treat like the grace case below.
    return { user, token: signAccessToken(user, row.id) };
  }

  if (sameHash(presented, row.prev_hash)) {
    if (row.in_grace) return { user, token: signAccessToken(user, row.id) };
    await query('DELETE FROM sessions WHERE id = $1', [row.id]); // old secret reused: revoke
  }
  return null;
}

/** End one session, if the refresh token is genuine. */
async function endSession(refreshToken) {
  const parts = splitRefreshToken(refreshToken);
  if (!parts) return;
  const [row] = await query('SELECT refresh_hash, prev_hash FROM sessions WHERE id = $1', [parts.id]);
  const presented = sha256(parts.secret);
  if (row && (sameHash(presented, row.refresh_hash) || sameHash(presented, row.prev_hash))) {
    await query('DELETE FROM sessions WHERE id = $1', [parts.id]);
  }
}

/** End every session of a user (password change, account turned off, "sign out everywhere"). */
const endAllSessions = (userId) => query('DELETE FROM sessions WHERE user_id = $1', [userId]);

module.exports = {
  signAccessToken,
  verifyAccessToken,
  createSession,
  refreshSession,
  endSession,
  endAllSessions,
};
