'use strict';

const { Router } = require('express');
const multer = require('multer');
const { query, transaction } = require('../db');
const { requireAuth } = require('../middleware/auth');
const { duplicateKey } = require('../services/duplicates');
const { parseEventsWorkbook } = require('../services/excelParser');
const { HttpError, asyncHandler } = require('../utils/errors');
const { parseId } = require('../utils/validation');

const router = Router();
router.use(requireAuth('admin'));

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

// Browsers send file names as UTF-8 but multer reads them as latin1; undo that (e.g. Marathi names).
const fileName = (file) =>
  Buffer.from(file.originalname || 'upload', 'latin1').toString('utf8').slice(0, 200);

/**
 * POST /api/admin/upload   (multipart field "file": .xlsx / .xls / .csv)
 *
 * Events whose DATE and NAME already exist (in the calendar, or earlier in the same file) are not
 * added again; they are reported back in `duplicates`. Everything else is added as shared events
 * and remembered as one upload, so the whole file can be reviewed or deleted later.
 */
router.post(
  '/upload',
  upload.single('file'),
  asyncHandler(async (req, res) => {
    if (!req.file) throw new HttpError(400, 'Choose an Excel file');

    const { rows, skipped } = parseEventsWorkbook(req.file.buffer);
    if (!rows.length) {
      throw new HttpError(
        400,
        'No valid rows found. Use columns: title, date (YYYY-MM-DD), time, description, location',
      );
    }

    const dates = [...new Set(rows.map((row) => row.date))];
    const existing = await query(
      `SELECT date, title FROM events e
       WHERE e.date = ANY($2::date[]) AND (e.shared OR e.owner_id = $1)`,
      [req.user.id, dates],
    );
    const inCalendar = new Set(existing.map((e) => duplicateKey(e.date, e.title)));
    const inFile = new Set();

    const fresh = [];
    const duplicates = [];
    for (const row of rows) {
      const key = duplicateKey(row.date, row.title);
      if (inCalendar.has(key)) {
        duplicates.push({ title: row.title, date: row.date, reason: 'Already in the calendar' });
      } else if (inFile.has(key)) {
        duplicates.push({ title: row.title, date: row.date, reason: 'Repeated in this file' });
      } else {
        inFile.add(key);
        fresh.push(row);
      }
    }

    // Nothing new: do not keep an empty upload around.
    if (!fresh.length) return res.json({ imported: 0, skipped, duplicates, upload: null });

    const created = await transaction(async (run) => {
      const [batch] = await run(
        `INSERT INTO uploads (filename, uploaded_by, row_count) VALUES ($1, $2, $3)
         RETURNING id, filename, created_at`,
        [fileName(req.file), req.user.id, fresh.length],
      );
      await run(
        `INSERT INTO events (title, date, time, description, location, source, owner_id, shared, upload_id)
         SELECT title, date::date, NULLIF(time, '')::time, description, location,
                'admin', $2, true, $3
         FROM jsonb_to_recordset($1::jsonb)
           AS x(title text, date text, time text, description text, location text)`,
        [JSON.stringify(fresh), req.user.id, batch.id],
      );
      return batch;
    });

    res.json({ imported: fresh.length, skipped, duplicates, upload: created });
  }),
);

// GET /api/admin/uploads  ->  every uploaded file with the events it contains (as they are now)
router.get(
  '/uploads',
  asyncHandler(async (req, res) => {
    const uploads = await query(
      `SELECT u.id, u.filename, u.created_at, usr.username AS uploaded_by
       FROM uploads u LEFT JOIN users usr ON usr.id = u.uploaded_by
       ORDER BY u.created_at DESC, u.id DESC`,
    );
    const events = uploads.length
      ? await query(
          `SELECT id, upload_id, title, date, to_char(time, 'HH24:MI') AS time, location, description
           FROM events WHERE upload_id = ANY($1::int[])
           ORDER BY date, time NULLS FIRST, id`,
          [uploads.map((u) => u.id)],
        )
      : [];

    res.json(
      uploads.map((u) => ({ ...u, events: events.filter((e) => e.upload_id === u.id) })),
    );
  }),
);

// DELETE /api/admin/uploads/:id  - removes the file and every event that came from it
router.delete(
  '/uploads/:id',
  asyncHandler(async (req, res) => {
    await query('DELETE FROM uploads WHERE id = $1', [parseId(req.params.id)]); // events cascade
    res.sendStatus(204);
  }),
);

module.exports = router;
