'use strict';

const XLSX = require('xlsx');
const { isIsoDate, isTime } = require('../utils/validation');

const EXCEL_EPOCH_OFFSET_DAYS = 25569; // days from 1899-12-30 (Excel) to 1970-01-01 (Unix)
const MS_PER_DAY = 86_400_000;
const MINUTES_PER_DAY = 1440;

/**
 * Excel stores real date cells as numbers (days since 1899-12-30).
 * Text cells (e.g. "2026-11-08") are passed through unchanged.
 */
function toIsoDate(value) {
  if (typeof value === 'number') {
    const ms = Math.round((Math.floor(value) - EXCEL_EPOCH_OFFSET_DAYS) * MS_PER_DAY);
    return new Date(ms).toISOString().slice(0, 10);
  }
  return String(value ?? '')
    .trim()
    .slice(0, 10);
}

/** Excel stores time cells as a fraction of a day (0.5 = 12:00). Text is passed through. */
function toTime(value) {
  if (typeof value === 'number') {
    const totalMinutes = Math.round((value % 1) * MINUTES_PER_DAY) % MINUTES_PER_DAY;
    const hours = String(Math.floor(totalMinutes / 60)).padStart(2, '0');
    const minutes = String(totalMinutes % 60).padStart(2, '0');
    return `${hours}:${minutes}`;
  }
  return String(value ?? '').trim();
}

/** Turn one spreadsheet row into an event, or null if it is not usable. */
function toEvent(rawRow) {
  // Headers are matched case-insensitively: "Title", " DATE " ... all work.
  const row = {};
  for (const [header, value] of Object.entries(rawRow)) {
    row[header.trim().toLowerCase()] = value;
  }

  const event = {
    title: String(row.title ?? '').trim(),
    date: toIsoDate(row.date),
    time: toTime(row.time),
    description: String(row.description ?? '').trim(),
    location: String(row.location ?? '').trim(),
  };

  const hasValidTime = event.time === '' || isTime(event.time);
  return event.title && isIsoDate(event.date) && hasValidTime ? event : null;
}

/**
 * Read the first sheet of an .xlsx / .xls / .csv file.
 * Expected columns: title | date | time | description | location
 * @returns {{ rows: object[], skipped: number }}
 */
function parseEventsWorkbook(buffer) {
  const workbook = XLSX.read(buffer);
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  const rawRows = sheet ? XLSX.utils.sheet_to_json(sheet, { defval: '' }) : [];

  const rows = rawRows.map(toEvent).filter(Boolean);
  return { rows, skipped: rawRows.length - rows.length };
}

module.exports = { parseEventsWorkbook, toIsoDate, toTime };
