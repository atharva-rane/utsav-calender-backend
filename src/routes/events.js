'use strict';

const { Router } = require('express');
const { query } = require('../db');
const { requireAuth } = require('../middleware/auth');
const { HttpError, asyncHandler } = require('../utils/errors');
const { findDuplicate, prettyDate } = require('../services/duplicates');
const { isIsoDate, parseEventBody, parseId } = require('../utils/validation');

const router = Router();
router.use(requireAuth());

/*
 * Who sees what:
 *   - An admin's events are SHARED: every user sees them (read-only) next to their own.
 *   - A user's events are PRIVATE: only that user sees them - not other users, not the admin.
 * Who can change what:
 *   - Private events: only their owner.
 *   - Shared events: admins only.
 * Every query below starts with $1 = my id and $2 = am I an admin.
 */
const COLUMNS = `e.id, e.title, e.date, to_char(e.time, 'HH24:MI') AS time, e.location,
  e.description, e.source, e.shared,
  (e.owner_id = $1 OR (e.shared AND $2::boolean)) AS editable`;
const VISIBLE = '(e.shared OR e.owner_id = $1)';
const EDITABLE = '(e.owner_id = $1 OR (e.shared AND $2::boolean))';

const me = (req) => [req.user.id, req.user.role === 'admin'];

/** The same name on the same date must not be added twice (checked among events you can see). */
async function rejectDuplicate(req, event, excludeId = null) {
  const clash = await findDuplicate({
    userId: req.user.id,
    date: event.date,
    title: event.title,
    excludeId,
  });
  if (clash) {
    throw new HttpError(409, `"${clash.title}" already exists on ${prettyDate(event.date)}.`);
  }
}

// GET /api/events?from=YYYY-MM-DD&to=YYYY-MM-DD
router.get(
  '/',
  asyncHandler(async (req, res) => {
    const { from = '1900-01-01', to = '2999-12-31' } = req.query;
    if (!isIsoDate(from) || !isIsoDate(to)) {
      throw new HttpError(400, 'from/to must be YYYY-MM-DD dates');
    }
    const rows = await query(
      `SELECT ${COLUMNS} FROM events e
       WHERE e.date BETWEEN $3 AND $4 AND ${VISIBLE}
       ORDER BY e.date, e.time NULLS FIRST, e.id`,
      [...me(req), from, to],
    );
    res.json(rows);
  }),
);

// GET /api/events/search?q=diwali  - title search across all dates (upcoming first, then past)
router.get(
  '/search',
  asyncHandler(async (req, res) => {
    const term = String(req.query.q ?? '')
      .trim()
      .slice(0, 100);
    if (!term) return res.json([]);

    // strpos() avoids LIKE wildcards (%, _) in the search text being interpreted.
    const rows = await query(
      `SELECT ${COLUMNS} FROM events e
       WHERE strpos(lower(e.title), lower($3)) > 0 AND ${VISIBLE}
       ORDER BY (e.date < CURRENT_DATE),
                CASE WHEN e.date >= CURRENT_DATE THEN e.date END ASC,
                CASE WHEN e.date < CURRENT_DATE THEN e.date END DESC,
                e.time NULLS FIRST
       LIMIT 100`,
      [...me(req), term],
    );
    res.json(rows);
  }),
);

// POST /api/events  - admins' events are shared with everyone (unless "shared": false),
// users' events are always private.
router.post(
  '/',
  asyncHandler(async (req, res) => {
    const e = parseEventBody(req.body);
    await rejectDuplicate(req, e);
    const isAdmin = req.user.role === 'admin';
    const shared = isAdmin && req.body.shared !== false;

    const [created] = await query(
      `WITH e AS (
         INSERT INTO events (title, date, time, location, description, source, owner_id, shared)
         VALUES ($3, $4, NULLIF($5, '')::time, $6, $7, $8, $1, $9)
         RETURNING *
       )
       SELECT ${COLUMNS} FROM e`,
      [...me(req), e.title, e.date, e.time, e.location, e.description, isAdmin ? 'admin' : 'user', shared],
    );
    res.status(201).json(created);
  }),
);

router.put(
  '/:id',
  asyncHandler(async (req, res) => {
    const id = parseId(req.params.id);
    const e = parseEventBody(req.body);
    if (!(await isVisible(req, id))) await explainRefusal(req, id);
    await rejectDuplicate(req, e, id);
    // Only an admin may switch an event between shared and private.
    const shared =
      req.user.role === 'admin' && typeof req.body.shared === 'boolean' ? req.body.shared : null;

    const [updated] = await query(
      `WITH e AS (
         UPDATE events e
         SET title = $4, date = $5, time = NULLIF($6, '')::time, location = $7, description = $8,
             shared = COALESCE($9::boolean, e.shared)
         WHERE e.id = $3 AND ${EDITABLE}
         RETURNING e.*
       )
       SELECT ${COLUMNS} FROM e`,
      [...me(req), id, e.title, e.date, e.time, e.location, e.description, shared],
    );
    if (!updated) await explainRefusal(req, id);
    res.json(updated);
  }),
);

router.delete(
  '/:id',
  asyncHandler(async (req, res) => {
    const id = parseId(req.params.id);
    const deleted = await query(`DELETE FROM events e WHERE e.id = $3 AND ${EDITABLE} RETURNING e.id`, [
      ...me(req),
      id,
    ]);
    if (!deleted.length) {
      // Deleting something already gone is fine; deleting a read-only shared event is not.
      if (await isVisible(req, id)) throw new HttpError(403, 'Only the admin can change this utsav');
    }
    res.sendStatus(204);
  }),
);

/** The event was not changed: say whether it is missing, or visible but read-only. */
async function explainRefusal(req, id) {
  if (await isVisible(req, id)) throw new HttpError(403, 'Only the admin can change this utsav');
  throw new HttpError(404, 'Event not found');
}

/** Can this user see the event at all (shared, or their own)? */
async function isVisible(req, id) {
  const [row] = await query(
    'SELECT 1 AS found FROM events WHERE id = $2 AND (shared OR owner_id = $1)',
    [req.user.id, id],
  );
  return Boolean(row);
}

module.exports = router;
