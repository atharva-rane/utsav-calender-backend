'use strict';

/**
 * Stateless "add two numbers" captcha.
 *
 * The server draws the sum as a slightly distorted SVG picture and hands the browser a signed
 * token that only contains a keyed hash of the answer - the answer itself is never sent.
 * Each token works for one attempt (right or wrong) and expires after a few minutes.
 */

const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const config = require('../config');

const LIFETIME_SECONDS = 5 * 60;
const used = new Map(); // nonce -> expiry (ms); stops a token being tried twice

const answerHash = (nonce, answer) =>
  crypto
    .createHmac('sha256', config.jwtSecret)
    .update(`captcha:${nonce}:${answer}`)
    .digest('hex');

const pick = (list) => list[crypto.randomInt(list.length)];
const between = (min, max) => min + crypto.randomInt(max - min + 1);
const jitter = (range) => (crypto.randomInt(2001) / 1000 - 1) * range; // -range .. +range

function forgetExpired() {
  const now = Date.now();
  for (const [nonce, expiry] of used) if (expiry < now) used.delete(nonce);
}

/** Draw "17 + 8 = ?" with wobbling glyphs, a few strike-through lines and dots. */
function drawSvg(a, b) {
  const width = 190;
  const height = 60;
  const colors = ['#2a2745', '#4b43b8', '#8a4b08', '#1f6f68'];
  const glyphs = `${a} + ${b} = ?`.split('');

  let x = 22;
  const text = glyphs
    .map((glyph) => {
      const y = 42 + jitter(3);
      const rotate = jitter(10).toFixed(1);
      const size = 34 + between(0, 4);
      const out = `<text x="${x}" y="${y.toFixed(1)}" font-size="${size}" font-weight="700" fill="${pick(colors)}" transform="rotate(${rotate} ${x} ${y.toFixed(1)})">${glyph}</text>`;
      x += glyph === ' ' ? 8 : 25;
      return out;
    })
    .join('');

  const lines = Array.from({ length: 3 }, () => {
    const [x1, y1, x2, y2] = [between(0, 40), between(6, 54), between(130, width), between(6, 54)];
    return `<path d="M${x1} ${y1} Q${between(50, 120)} ${between(0, height)} ${x2} ${y2}" stroke="${pick(colors)}" stroke-opacity="0.25" stroke-width="1.2" fill="none"/>`;
  }).join('');

  const dots = Array.from({ length: 22 }, () => {
    return `<circle cx="${between(2, width - 2)}" cy="${between(2, height - 2)}" r="${(between(5, 14) / 10).toFixed(1)}" fill="${pick(colors)}" fill-opacity="0.35"/>`;
  }).join('');

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" font-family="Verdana, Arial, sans-serif">` +
    `<rect width="${width}" height="${height}" rx="10" fill="#fdf6ea"/>${dots}${text}${lines}</svg>`
  );
}

/** Create a new challenge: { token, image } where image is a data: URL. */
function createCaptcha() {
  const a = between(1, 9); // two single digits, so the sum is never above 18
  const b = between(1, 9);
  const nonce = crypto.randomBytes(12).toString('hex');
  const token = jwt.sign({ n: nonce, h: answerHash(nonce, a + b) }, config.jwtSecret, {
    expiresIn: LIFETIME_SECONDS,
    audience: 'captcha', // never accepted as a sign-in token (those use another audience)
  });
  const image = `data:image/svg+xml;base64,${Buffer.from(drawSvg(a, b)).toString('base64')}`;
  return { token, image };
}

/** True only for a fresh, unused token whose answer matches. The token is spent either way. */
function checkCaptcha(token, answer) {
  forgetExpired();
  let payload;
  try {
    payload = jwt.verify(String(token || ''), config.jwtSecret, { audience: 'captcha' });
  } catch {
    return false;
  }
  if (!payload.n || !payload.h || used.has(payload.n)) return false;
  used.set(payload.n, Date.now() + (LIFETIME_SECONDS + 5) * 1000);

  const given = String(answer ?? '').trim();
  if (!/^\d{1,2}$/.test(given)) return false;

  const expected = Buffer.from(payload.h, 'hex');
  const actual = Buffer.from(answerHash(payload.n, Number(given)), 'hex');
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}

module.exports = { createCaptcha, checkCaptcha };
