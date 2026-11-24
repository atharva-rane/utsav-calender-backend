'use strict';

const { Router } = require('express');
const { query } = require('../db');
const { requireAuth } = require('../middleware/auth');
const { hashPassword } = require('../services/passwords');
const { endAllSessions } = require('../services/sessions');
const { PUBLIC_COLUMNS } = require('../services/users');
const { HttpError, asyncHandler } = require('../utils/errors');
const { parseId, parseUsername, parsePassword, parseFullName } = require('../utils/validation');

const router = Router();
router.use(requireAuth('admin'));

const ROLES = ['admin', 'user'];
const parseRole = (value) => {
  if (!ROLES.includes(value)) throw new HttpError(400, 'Role must be admin or user');
  return value;
};

/** True when changing this admin (demote / turn off / delete) would leave no active admin. */
async function isLastActiveAdmin(id) {
  const [row] = await query(
    `SELECT count(*)::int AS others FROM users WHERE role = 'admin' AND active AND id <> $1`,
    [id],
  );
  return row.others === 0;
}

// GET /api/users
router.get(
  '/',
  asyncHandler(async (req, res) => {
    res.json(await query(`SELECT ${PUBLIC_COLUMNS} FROM users ORDER BY lower(username)`));
  }),
);

// POST /api/users  { username, password, full_name?, role? }
router.post(
  '/',
  asyncHandler(async (req, res) => {
    const body = req.body || {};
    const username = parseUsername(body.username);
    const password = parsePassword(body.password);
    const role = body.role === undefined ? 'user' : parseRole(body.role);

    const [exists] = await query('SELECT 1 AS found FROM users WHERE lower(username) = $1', [
      username,
    ]);
    if (exists) throw new HttpError(409, 'That username is already taken');

    const [created] = await query(
      `INSERT INTO users (username, full_name, password_hash, role)
       VALUES ($1, $2, $3, $4) RETURNING ${PUBLIC_COLUMNS}`,
      [username, parseFullName(body.full_name), await hashPassword(password), role],
    );
    res.status(201).json(created);
  }),
);

// PUT /api/users/:id  { username?, full_name?, role?, active?, password? }
// Sending a password resets it and signs that user out everywhere.
router.put(
  '/:id',
  asyncHandler(async (req, res) => {
    const id = parseId(req.params.id);
    const body = req.body || {};

    const [current] = await query('SELECT id, role, active FROM users WHERE id = $1', [id]);
    if (!current) throw new HttpError(404, 'User not found');

    const username = body.username === undefined ? null : parseUsername(body.username);
    const fullName = body.full_name === undefined ? null : parseFullName(body.full_name);
    const role = body.role === undefined ? null : parseRole(body.role);
    const active = body.active === undefined ? null : Boolean(body.active);
    const passwordHash = body.password ? await hashPassword(parsePassword(body.password)) : null;

    const losesAdmin = (role && role !== 'admin' && current.role === 'admin') || active === false;
    if (current.role === 'admin' && losesAdmin) {
      if (id === req.user.id) {
        throw new HttpError(400, 'You cannot turn off or demote your own account');
      }
      if (await isLastActiveAdmin(id)) {
        throw new HttpError(400, 'There must be at least one active admin');
      }
    }

    if (username) {
      const [clash] = await query(
        'SELECT 1 AS found FROM users WHERE lower(username) = $1 AND id <> $2',
        [username, id],
      );
      if (clash) throw new HttpError(409, 'That username is already taken');
    }

    const [updated] = await query(
      `UPDATE users SET
         username      = COALESCE($2, username),
         full_name     = COALESCE($3, full_name),
         role          = COALESCE($4, role),
         active        = COALESCE($5, active),
         password_hash = COALESCE($6, password_hash),
         -- sign the user out everywhere when the password changes or the account is turned off
         token_version = token_version + CASE WHEN $6::text IS NOT NULL OR $5 = false THEN 1 ELSE 0 END
       WHERE id = $1
       RETURNING ${PUBLIC_COLUMNS}`,
      [id, username, fullName, role, active, passwordHash],
    );
    // A new password or a turned-off account signs that user out of every device.
    if (passwordHash || active === false) await endAllSessions(id);
    res.json(updated);
  }),
);

// DELETE /api/users/:id  - also removes that user's private events, recipients and reminders
router.delete(
  '/:id',
  asyncHandler(async (req, res) => {
    const id = parseId(req.params.id);
    if (id === req.user.id) throw new HttpError(400, 'You cannot delete your own account');

    const [target] = await query('SELECT role FROM users WHERE id = $1', [id]);
    if (!target) return res.sendStatus(204);
    if (target.role === 'admin' && (await isLastActiveAdmin(id))) {
      throw new HttpError(400, 'There must be at least one active admin');
    }

    // Their private events go with them; shared (admin) events stay for everyone.
    await query('DELETE FROM events WHERE owner_id = $1 AND NOT shared', [id]);
    await query('DELETE FROM users WHERE id = $1', [id]);
    res.sendStatus(204);
  }),
);

module.exports = router;
