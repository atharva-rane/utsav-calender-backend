'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const XLSX = require('xlsx');

// The reminder module loads config.js, which needs these - dummy values are fine for unit tests.
Object.assign(process.env, {
  DATABASE_URL: 'postgresql://test:test@localhost:5432/test',
  JWT_SECRET: 'test-secret',
  ADMIN_EMAIL: 'admin@test.com',
  ADMIN_PASSWORD: 'test',
});

const { parseEventsWorkbook, toIsoDate, toTime } = require('../src/services/excelParser');
const { isIsoDate } = require('../src/utils/validation');

const SAMPLE = path.join(__dirname, '../../sample-data/utsav-sample-events.xlsx');

/** Build an in-memory .xlsx from an array of rows (first row = headers). */
const workbookFrom = (rows) => {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), 'Sheet1');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
};

test('sample file imports every row', () => {
  const { rows, skipped } = parseEventsWorkbook(fs.readFileSync(SAMPLE));
  assert.equal(rows.length, 16);
  assert.equal(skipped, 0);
  assert.ok(rows.every((r) => isIsoDate(r.date)));
});

test('sample file: dates and times are converted correctly', () => {
  const { rows } = parseEventsWorkbook(fs.readFileSync(SAMPLE));
  const diwali = rows.find((r) => r.title.startsWith('Diwali'));
  assert.equal(diwali.date, '2026-11-08');
  assert.equal(diwali.time, '18:30');

  const allDay = rows.find((r) => r.title === 'Govardhan Puja');
  assert.equal(allDay.time, '');
});

test('Excel serial numbers convert to ISO dates and HH:MM', () => {
  assert.equal(toIsoDate(46334), '2026-11-08');
  assert.equal(toTime(0.5), '12:00');
  assert.equal(toTime(0.99999), '00:00'); // must never produce "24:00"
});

test('text dates/times and any header capitalisation are accepted', () => {
  const buffer = workbookFrom([
    ['Title', ' DATE ', 'Time', 'Description', 'Location'],
    ['Lohri', '2027-01-13', '19:00', 'Bonfire', 'Garden'],
  ]);
  const { rows } = parseEventsWorkbook(buffer);
  assert.deepEqual(rows, [
    {
      title: 'Lohri',
      date: '2027-01-13',
      time: '19:00',
      description: 'Bonfire',
      location: 'Garden',
    },
  ]);
});

test('invalid rows are skipped, not imported', () => {
  const buffer = workbookFrom([
    ['title', 'date', 'time', 'description', 'location'],
    ['', '2026-11-08', '', '', ''], // no title
    ['Bad date', '2026-02-30', '', '', ''], // impossible date
    ['Bad time', '2026-11-08', '25:99', '', ''], // impossible time
    ['Good', '2026-11-08', '', '', ''],
  ]);
  const { rows, skipped } = parseEventsWorkbook(buffer);
  assert.equal(rows.length, 1);
  assert.equal(skipped, 3);
});
