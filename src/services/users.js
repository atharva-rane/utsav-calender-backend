'use strict';

const config = require('../config');
const { query } = require('../db');
const { hashPassword } = require('./passwords');

const PUBLIC_COLUMNS = 'id, username, full_name, role, active, created_at';

/** Make sure at least one admin exists (created from the .env values on first start). */
async function ensureAdmin() {
  const [existing] = await query(
    `SELECT id FROM users WHERE role = 'admin' ORDER BY id LIMIT 1`,
  );
  if (existing) return existing.id;

  const { username, password } = config.admin;
  const [created] = await query(
    `INSERT INTO users (username, full_name, password_hash, role)
     VALUES ($1, 'Administrator', $2, 'admin')
     ON CONFLICT (lower(username)) DO UPDATE SET role = 'admin'
     RETURNING id`,
    [username, await hashPassword(password)],
  );
  console.log(`[auth] created the first admin account "${username}"`);
  return created.id;
}

module.exports = { ensureAdmin, PUBLIC_COLUMNS };
