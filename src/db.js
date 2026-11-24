'use strict';

const pg = require('pg');
const config = require('./config');

// Return DATE columns (type 1082) as plain 'YYYY-MM-DD' strings, avoiding timezone shifts.
pg.types.setTypeParser(1082, (value) => value);

const useSsl = /sslmode=require|neon\.tech/.test(config.databaseUrl);

const pool = new pg.Pool({
  connectionString: config.databaseUrl,
  ssl: useSsl ? { rejectUnauthorized: false } : false,
  max: 10,
});

/** Run a parameterised query and return the rows. */
const query = (sql, params) => pool.query(sql, params).then((result) => result.rows);

/** Run several statements atomically. `run(sql, params)` returns rows like `query` does. */
async function transaction(work) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await work((sql, params) => client.query(sql, params).then((r) => r.rows));
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Create tables on first start and upgrade older databases (safe to run every time).
 * `adminId` owns any recipients / reminders that existed before accounts were introduced.
 */
async function initSchema(ensureAdmin) {
  await query(`
    CREATE TABLE IF NOT EXISTS users (
      id            SERIAL PRIMARY KEY,
      username      TEXT NOT NULL,
      full_name     TEXT NOT NULL DEFAULT '',
      password_hash TEXT NOT NULL,
      role          TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('admin', 'user')),
      active        BOOLEAN NOT NULL DEFAULT true,
      token_version INT NOT NULL DEFAULT 0,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE UNIQUE INDEX IF NOT EXISTS users_username_idx ON users (lower(username));

    CREATE TABLE IF NOT EXISTS events (
      id          SERIAL PRIMARY KEY,
      title       TEXT NOT NULL,
      date        DATE NOT NULL,
      time        TIME,
      location    TEXT DEFAULT '',
      description TEXT DEFAULT '',
      source      TEXT DEFAULT 'user',
      created_at  TIMESTAMPTZ DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS events_date_idx ON events(date);

    -- One row per uploaded Excel file; its events are deleted together with it.
    CREATE TABLE IF NOT EXISTS uploads (
      id          SERIAL PRIMARY KEY,
      filename    TEXT NOT NULL,
      uploaded_by INT REFERENCES users(id) ON DELETE SET NULL,
      row_count   INT NOT NULL DEFAULT 0,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    -- One row per signed-in device. Only a hash of the refresh secret is kept.
    CREATE TABLE IF NOT EXISTS sessions (
      id            UUID PRIMARY KEY,
      user_id       INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      refresh_hash  TEXT NOT NULL,
      prev_hash     TEXT,
      rotated_at    TIMESTAMPTZ,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
      last_used_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
      expires_at    TIMESTAMPTZ NOT NULL,
      user_agent    TEXT NOT NULL DEFAULT ''
    );
    CREATE INDEX IF NOT EXISTS sessions_user_idx ON sessions(user_id);

    -- Every user keeps their own list of people who receive that user's reminders.
    CREATE TABLE IF NOT EXISTS recipients (
      id      SERIAL PRIMARY KEY,
      user_id INT REFERENCES users(id) ON DELETE CASCADE,
      email   TEXT NOT NULL
    );

    -- One row per (event, date, time) slot, owned by the user who set it.
    CREATE TABLE IF NOT EXISTS reminders (
      id          SERIAL PRIMARY KEY,
      event_id    INT REFERENCES events(id) ON DELETE CASCADE,
      user_id     INT REFERENCES users(id) ON DELETE CASCADE,
      remind_date DATE NOT NULL,
      remind_time TIME,
      status      TEXT NOT NULL DEFAULT 'pending',
      sent_at     TIMESTAMPTZ
    );
  `);

  // Events used to be visible to everyone. Now each belongs to someone: admin events are shared
  // with all users, everything else is private to its owner. Remember whether this is the
  // upgrade run, so the existing events are handed to the admin exactly once.
  const [hadOwner] = await query(
    `SELECT 1 AS found FROM information_schema.columns
     WHERE table_name = 'events' AND column_name = 'owner_id' AND table_schema = current_schema()`,
  );
  await query(`
    ALTER TABLE events ADD COLUMN IF NOT EXISTS owner_id INT REFERENCES users(id) ON DELETE SET NULL;
    ALTER TABLE events ADD COLUMN IF NOT EXISTS shared BOOLEAN NOT NULL DEFAULT false;
    CREATE INDEX IF NOT EXISTS events_owner_idx ON events(owner_id);
    ALTER TABLE events ADD COLUMN IF NOT EXISTS upload_id INT REFERENCES uploads(id) ON DELETE CASCADE;
    CREATE INDEX IF NOT EXISTS events_upload_idx ON events(upload_id);
  `);

  // Older databases already have these tables without the new columns.
  await query(`
    ALTER TABLE recipients ADD COLUMN IF NOT EXISTS user_id INT REFERENCES users(id) ON DELETE CASCADE;
    ALTER TABLE reminders  ADD COLUMN IF NOT EXISTS user_id INT REFERENCES users(id) ON DELETE CASCADE;
    ALTER TABLE reminders  ADD COLUMN IF NOT EXISTS remind_time TIME;
    ALTER TABLE reminders  ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'pending';
    ALTER TABLE reminders  ADD COLUMN IF NOT EXISTS sent_at TIMESTAMPTZ;
  `);

  const adminId = await ensureAdmin();
  if (!hadOwner) {
    await query('UPDATE events SET owner_id = $1, shared = true WHERE owner_id IS NULL', [adminId]);
  }
  await upgradeLegacyData(adminId);

  await query(`
    ALTER TABLE recipients ALTER COLUMN user_id SET NOT NULL;
    ALTER TABLE reminders  ALTER COLUMN user_id SET NOT NULL;
    ALTER TABLE reminders  ALTER COLUMN remind_time SET NOT NULL;

    ALTER TABLE recipients DROP CONSTRAINT IF EXISTS recipients_email_key;
    CREATE UNIQUE INDEX IF NOT EXISTS recipients_user_email_idx ON recipients (user_id, email);

    CREATE UNIQUE INDEX IF NOT EXISTS reminders_slot_idx
      ON reminders (event_id, user_id, remind_date, remind_time);
    CREATE INDEX IF NOT EXISTS reminders_due_idx ON reminders (remind_date) WHERE status = 'pending';
    DROP INDEX IF EXISTS reminders_date_idx;
  `);
}

/**
 * Before accounts existed, recipients were shared and a reminder only stored "N emails per day".
 * Hand the old recipients to the admin and expand each old reminder into one row per time slot
 * (09:00 onwards, spread over 12 hours exactly like the old scheduler did).
 */
async function upgradeLegacyData(adminId) {
  await query('UPDATE recipients SET user_id = $1 WHERE user_id IS NULL', [adminId]);

  const [legacy] = await query(
    `SELECT 1 AS found FROM information_schema.columns
     WHERE table_name = 'reminders' AND column_name = 'times_per_day' AND table_schema = current_schema()`,
  );
  if (!legacy) return;

  await transaction(async (run) => {
    await run(
      `INSERT INTO reminders (event_id, user_id, remind_date, remind_time, status, sent_at)
       SELECT r.event_id, $1::int, r.remind_date,
              make_time(LEAST(23, 9 + g * GREATEST(1, 12 / r.times_per_day)), 0, 0),
              CASE WHEN g < r.sent_count THEN 'sent' ELSE 'pending' END,
              CASE WHEN g < r.sent_count THEN now() END
       FROM reminders r
       CROSS JOIN generate_series(0, 11) AS g
       WHERE r.remind_time IS NULL AND g < r.times_per_day`,
      [adminId],
    );
    await run('DELETE FROM reminders WHERE remind_time IS NULL');
    await run('ALTER TABLE reminders DROP COLUMN times_per_day, DROP COLUMN sent_count');
  });
}

module.exports = { query, transaction, initSchema, pool };
