'use strict';

const { Router } = require('express');
const config = require('../config');
const { query } = require('../db');
const { requireAuth } = require('../middleware/auth');
const { HttpError, asyncHandler } = require('../utils/errors');
const { isIsoDate, isTime, parseId } = require('../utils/validation');

const router = Router();
router.use(requireAuth());

const { maxDatesPerRequest, maxTimesPerDate, timezone } = config.reminders;
const COLUMNS = `id, event_id, remind_date, to_char(remind_time, 'HH24:MI') AS remind_time, status`;

/** "9:00" -> "09:00" so the same time is never stored twice. */
const normaliseTime = (value) => {
  const [hours, minutes] = String(value).split(':');
  return `${hours.padStart(2, '0')}:${minutes}`;
};

/** Each user only ever sees and changes their own reminders. */
router.get(
  '/',
  asyncHandler(async (req, res) => {
    res.json(
      await query(
        `SELECT ${COLUMNS} FROM reminders WHERE user_id = $1 ORDER BY remind_date, remind_time, id`,
        [req.user.id],
      ),
    );
  }),
);

/**
 * POST /api/reminders
 *   { event_id, reminders: [ { date: "2026-11-05", times: ["09:00", "18:00"] }, ... ] }
 * Creates one reminder per date + time. Slots that already exist are skipped.
 */
router.post(
  '/',
  asyncHandler(async (req, res) => {
    const eventId = parseId(req.body.event_id);
    const groups = Array.isArray(req.body.reminders) ? req.body.reminders : [];
    if (!groups.length) throw new HttpError(400, 'Add at least one reminder date');
    if (groups.length > maxDatesPerRequest) {
      throw new HttpError(400, `Too many dates (max ${maxDatesPerRequest} at a time)`);
    }

    const slots = new Map(); // "date|time" -> [date, time]  (also removes duplicates)
    for (const group of groups) {
      const date = String(group?.date ?? '');
      if (!isIsoDate(date)) throw new HttpError(400, 'Each reminder date must be YYYY-MM-DD');

      const times = Array.isArray(group.times) ? group.times : [];
      if (!times.length) throw new HttpError(400, `Pick at least one time for ${date}`);
      if (times.length > maxTimesPerDate) {
        throw new HttpError(400, `Too many times for ${date} (max ${maxTimesPerDate})`);
      }
      for (const time of times) {
        if (!isTime(String(time))) throw new HttpError(400, 'Each time must look like HH:MM');
        const clean = normaliseTime(time).slice(0, 5);
        slots.set(`${date}|${clean}`, [date, clean]);
      }
    }

    const dates = [...slots.values()].map(([date]) => date);
    const times = [...slots.values()].map(([, time]) => time);

    // A reminder in the past would fire immediately, so refuse it (clock = reminder timezone).
    const [late] = await query(
      `SELECT 1 AS found FROM unnest($1::date[], $2::time[]) AS s(d, t)
       WHERE (s.d + s.t) < (now() AT TIME ZONE $3) - interval '1 minute' LIMIT 1`,
      [dates, times, timezone],
    );
    if (late) throw new HttpError(400, 'Reminder times must be in the future');

    // INSERT ... SELECT only inserts when the event exists.
    const created = await query(
      `INSERT INTO reminders (event_id, user_id, remind_date, remind_time)
       SELECT e.id, $2, s.d, s.t
       FROM events e, unnest($3::date[], $4::time[]) AS s(d, t)
       WHERE e.id = $1 AND (e.shared OR e.owner_id = $2)
       ON CONFLICT DO NOTHING
       RETURNING ${COLUMNS}`,
      [eventId, req.user.id, dates, times],
    );

    if (!created.length) {
      const [event] = await query(
        'SELECT 1 AS found FROM events WHERE id = $1 AND (shared OR owner_id = $2)',
        [eventId, req.user.id],
      );
      if (!event) throw new HttpError(404, 'Event not found');
    }
    res.status(201).json(created);
  }),
);

// DELETE /api/reminders/:id  - remove one time slot
router.delete(
  '/:id',
  asyncHandler(async (req, res) => {
    await query('DELETE FROM reminders WHERE id = $1 AND user_id = $2', [
      parseId(req.params.id),
      req.user.id,
    ]);
    res.sendStatus(204);
  }),
);

// DELETE /api/reminders?event_id=5&date=2026-11-05  - remove a whole reminder date
router.delete(
  '/',
  asyncHandler(async (req, res) => {
    const eventId = parseId(req.query.event_id);
    const { date } = req.query;
    if (!isIsoDate(date)) throw new HttpError(400, 'date must be YYYY-MM-DD');
    await query(
      'DELETE FROM reminders WHERE event_id = $1 AND remind_date = $2 AND user_id = $3',
      [eventId, date, req.user.id],
    );
    res.sendStatus(204);
  }),
);

module.exports = router;
