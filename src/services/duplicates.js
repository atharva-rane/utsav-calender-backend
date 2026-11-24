'use strict';

const { query } = require('../db');

/** "  Diwali   Puja " and "diwali puja" count as the same name. */
const normalizeTitle = (title) =>
  String(title ?? '')
    .trim()
    .replace(/\s+/g, ' ')
    .toLowerCase();

/** The key two events share when they are duplicates: same date AND same name. */
const duplicateKey = (date, title) => `${date}|${normalizeTitle(title)}`;

/** '2026-11-08' -> '8 Nov 2026' (for messages). */
const prettyDate = (date) =>
  new Date(`${date}T00:00:00Z`).toLocaleDateString('en-GB', {
    timeZone: 'UTC',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });

/**
 * Find an event this user can already see (shared, or their own) with the same date and name.
 * `excludeId` skips the event being edited, so saving an event never clashes with itself.
 */
async function findDuplicate({ userId, date, title, excludeId = null }) {
  const rows = await query(
    `SELECT id, title FROM events e
     WHERE e.date = $2 AND (e.shared OR e.owner_id = $1) AND ($3::int IS NULL OR e.id <> $3)`,
    [userId, date, excludeId],
  );
  const key = normalizeTitle(title);
  return rows.find((row) => normalizeTitle(row.title) === key) || null;
}

module.exports = { normalizeTitle, duplicateKey, prettyDate, findDuplicate };
