'use strict';

const { Router } = require('express');
const { query } = require('../db');
const { requireAuth } = require('../middleware/auth');
const { asyncHandler } = require('../utils/errors');
const { parseId } = require('../utils/validation');

const router = Router();
router.use(requireAuth());

// Every user has a private list: reminders a user sets are emailed only to that user's list.
const EMAIL_PATTERN = /^\S+@\S+\.\S+$/;
const listRecipients = (userId) =>
  query('SELECT id, email FROM recipients WHERE user_id = $1 ORDER BY id', [userId]);

router.get(
  '/',
  asyncHandler(async (req, res) => res.json(await listRecipients(req.user.id))),
);

// POST /api/recipients  { emails: ["a@x.com", "b@y.com"] }  - duplicates/invalid emails are ignored
router.post(
  '/',
  asyncHandler(async (req, res) => {
    const emails = [
      ...new Set(
        (Array.isArray(req.body.emails) ? req.body.emails : [])
          .map((email) => String(email).trim().toLowerCase())
          .filter((email) => EMAIL_PATTERN.test(email) && email.length <= 254),
      ),
    ];

    if (emails.length) {
      await query(
        `INSERT INTO recipients (user_id, email) SELECT $1, unnest($2::text[])
         ON CONFLICT DO NOTHING`,
        [req.user.id, emails],
      );
    }
    res.json(await listRecipients(req.user.id));
  }),
);

router.delete(
  '/:id',
  asyncHandler(async (req, res) => {
    await query('DELETE FROM recipients WHERE id = $1 AND user_id = $2', [
      parseId(req.params.id),
      req.user.id,
    ]);
    res.sendStatus(204);
  }),
);

module.exports = router;
