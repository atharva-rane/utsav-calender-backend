'use strict';

const crypto = require('crypto');
const { promisify } = require('util');

const scrypt = promisify(crypto.scrypt);
const KEY_LENGTH = 64;

/** Hash a password with a random salt. Stored as "salt:hash" (both hex). */
async function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const key = await scrypt(String(password), salt, KEY_LENGTH);
  return `${salt}:${key.toString('hex')}`;
}

/** Constant-time check of a password against a stored "salt:hash". */
async function verifyPassword(password, stored) {
  const [salt, hash] = String(stored || '').split(':');
  if (!salt || !hash) return false;
  const expected = Buffer.from(hash, 'hex');
  const actual = await scrypt(String(password), salt, expected.length);
  return crypto.timingSafeEqual(actual, expected);
}

module.exports = { hashPassword, verifyPassword };
