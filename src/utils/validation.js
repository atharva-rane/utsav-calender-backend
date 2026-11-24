'use strict';

const { HttpError } = require('./errors');

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const TIME_PATTERN = /^([01]?\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/;

/** True for real calendar dates written as YYYY-MM-DD (rejects e.g. 2026-02-30). */
function isIsoDate(value) {
  if (typeof value !== 'string' || !DATE_PATTERN.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

/** True for H:MM, HH:MM or HH:MM:SS. */
const isTime = (value) => typeof value === 'string' && TIME_PATTERN.test(value);

/** Validate and normalise an event payload coming from the client. */
function parseEventBody(body = {}) {
  const title = String(body.title ?? '').trim();
  const date = String(body.date ?? '').trim();
  const time = String(body.time ?? '').trim();

  if (!title) throw new HttpError(400, 'Title is required');
  if (title.length > 200) throw new HttpError(400, 'Title is too long (max 200 characters)');
  if (!isIsoDate(date)) throw new HttpError(400, 'Date must be a valid YYYY-MM-DD date');
  if (time && !isTime(time)) throw new HttpError(400, 'Time must look like HH:MM');

  return {
    title,
    date,
    time, // '' means "all day"; SQL turns it into NULL
    location: String(body.location ?? '').trim(),
    description: String(body.description ?? '').trim(),
  };
}

const USERNAME_PATTERN = /^[a-z0-9._@+-]{3,64}$/;

/** Validate and normalise a username (stored lower-case, so logins are not case sensitive). */
function parseUsername(value) {
  const username = String(value ?? '')
    .trim()
    .toLowerCase();
  if (!USERNAME_PATTERN.test(username)) {
    throw new HttpError(
      400,
      'Username must be 3-64 characters: letters, numbers and . _ - @ + only',
    );
  }
  return username;
}

function parsePassword(value) {
  const password = String(value ?? '');
  if (password.length < 8) throw new HttpError(400, 'Password must be at least 8 characters');
  if (password.length > 200) throw new HttpError(400, 'Password is too long');
  return password;
}

function parseFullName(value) {
  const name = String(value ?? '').trim();
  if (name.length > 100) throw new HttpError(400, 'Name is too long (max 100 characters)');
  return name;
}

/** Parse a numeric route/body id or fail with 400. */
function parseId(value) {
  const id = Number.parseInt(value, 10);
  if (!Number.isInteger(id) || id < 1) throw new HttpError(400, 'Invalid id');
  return id;
}

module.exports = {
  isIsoDate,
  isTime,
  parseEventBody,
  parseId,
  parseUsername,
  parsePassword,
  parseFullName,
};
