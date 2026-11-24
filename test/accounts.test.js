'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

// config.js needs these - dummy values are fine for unit tests.
Object.assign(process.env, {
  DATABASE_URL: 'postgresql://test:test@localhost:5432/test',
  JWT_SECRET: 'test-secret',
  ADMIN_EMAIL: 'admin@test.com',
  ADMIN_PASSWORD: 'test',
});

const jwt = require('jsonwebtoken');
const { hashPassword, verifyPassword } = require('../src/services/passwords');
const { createCaptcha, checkCaptcha } = require('../src/services/captcha');
const { renderReminderText, renderReminderHtml, formatEventDate } = require('../src/services/mailer');
const { parseUsername, parsePassword } = require('../src/utils/validation');

/** The captcha hides its answer inside a keyed hash; brute-force it so tests can answer it. */
function solve(token) {
  const crypto = require('node:crypto');
  const { n, h } = jwt.decode(token);
  for (let sum = 0; sum < 200; sum += 1) {
    const hash = crypto
      .createHmac('sha256', 'test-secret')
      .update(`captcha:${n}:${sum}`)
      .digest('hex');
    if (hash === h) return sum;
  }
  throw new Error('could not solve');
}

test('passwords: right one passes, wrong one fails, hashes are salted', async () => {
  const a = await hashPassword('correct horse');
  const b = await hashPassword('correct horse');
  assert.notEqual(a, b);
  assert.equal(await verifyPassword('correct horse', a), true);
  assert.equal(await verifyPassword('wrong', a), false);
  assert.equal(await verifyPassword('x', ''), false);
});

test('captcha: correct sum passes once, then the token is spent', () => {
  const { token, image } = createCaptcha();
  assert.match(image, /^data:image\/svg\+xml;base64,/);
  const svg = Buffer.from(image.split(',')[1], 'base64').toString();
  assert.ok(svg.includes('<svg') && svg.includes('?'));
  assert.ok(!jwt.decode(token).answer, 'the answer must never be in the token');

  const answer = solve(token);
  assert.equal(checkCaptcha(token, answer), true);
  assert.equal(checkCaptcha(token, answer), false); // replay is refused
});

test('captcha: wrong answer, junk and forged tokens fail', () => {
  const { token } = createCaptcha();
  const answer = solve(token);
  assert.equal(checkCaptcha(token, answer + 1), false);
  assert.equal(checkCaptcha(token, answer), false); // already spent by the wrong try

  const fresh = createCaptcha().token;
  assert.equal(checkCaptcha(fresh, 'abc'), false);
  assert.equal(checkCaptcha('not-a-token', 5), false);
  const forged = jwt.sign({ n: 'x', h: 'aa' }, 'another-secret');
  assert.equal(checkCaptcha(forged, 5), false);
});

test('usernames are normalised and validated', () => {
  assert.equal(parseUsername('  Hari.Om  '), 'hari.om');
  assert.equal(parseUsername('a@b.com'), 'a@b.com');
  assert.throws(() => parseUsername('ab'));
  assert.throws(() => parseUsername('has space'));
  assert.throws(() => parsePassword('short'));
  assert.equal(parsePassword('longenough'), 'longenough');
});

test('reminder email follows the agreed template', () => {
  const text = renderReminderText({
    title: 'Diwali Puja',
    date: '2026-11-08',
    time: '18:30',
    location: 'Juhu Beach',
  });
  assert.equal(
    text,
    [
      'Hari Om,',
      '',
      'This is a gentle reminder regarding the upcoming Diwali Puja scheduled as per the following details:',
      '',
      'Event: Diwali Puja',
      'Date: Sunday, 8 November 2026, 6:30 pm',
      'Venue: Juhu Beach',
      '',
      'Kindly take note of the above details.',
      '',
      '',
      'Regards,',
      'Utsav Calendar',
      '',
      '',
      '|| Ambadnya || Nathsamvidh ||',
    ].join('\n'),
  );
});

test('reminder email handles missing venue/time and escapes HTML', () => {
  assert.equal(formatEventDate('2026-11-08', null), 'Sunday, 8 November 2026');
  const html = renderReminderHtml({ title: '<b>Hack</b>', date: '2026-11-08', time: '', location: '' });
  assert.ok(!html.includes('<b>Hack</b>'));
  assert.ok(html.includes('&lt;b&gt;Hack&lt;/b&gt;'));
  assert.ok(html.includes('To be announced'));
});
