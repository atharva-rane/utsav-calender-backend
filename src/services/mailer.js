'use strict';

const nodemailer = require('nodemailer');
const config = require('../config');

const escapeHtml = (value) =>
  String(value ?? '').replace(
    /[&<>"']/g,
    (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char],
  );

const chunk = (items, size) =>
  Array.from({ length: Math.ceil(items.length / size) }, (_, i) =>
    items.slice(i * size, i * size + size),
  );

const SIGNATURE = '|| Ambadnya || Nathsamvidh ||';
const NO_VENUE = 'To be announced';

/** '2026-11-08' + '18:30' -> 'Sunday, 8 November 2026, 6:30 pm' (no timezone shifting). */
function formatEventDate(date, time) {
  const day = new Date(`${date}T00:00:00Z`).toLocaleDateString('en-GB', {
    timeZone: 'UTC',
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  });
  if (!time) return day;

  const [hours, minutes] = time.split(':').map(Number);
  const hour12 = hours % 12 || 12;
  const clock = `${hour12}:${String(minutes).padStart(2, '0')} ${hours < 12 ? 'am' : 'pm'}`;
  return `${day}, ${clock}`;
}

/** The three values shown in the email, with sensible fallbacks. */
function reminderDetails(event) {
  return {
    title: String(event.title ?? '').trim(),
    date: formatEventDate(event.date, event.time),
    venue: String(event.location ?? '').trim() || NO_VENUE,
  };
}

function renderReminderText(event) {
  const { title, date, venue } = reminderDetails(event);
  return [
    'Hari Om,',
    '',
    `This is a gentle reminder regarding the upcoming ${title} scheduled as per the following details:`,
    '',
    `Event: ${title}`,
    `Date: ${date}`,
    `Venue: ${venue}`,
    '',
    'Kindly take note of the above details.',
    '',
    '',
    'Regards,',
    'Utsav Calendar',
    '',
    '',
    SIGNATURE,
  ].join('\n');
}

function renderReminderHtml(event) {
  const { title, date, venue } = reminderDetails(event);
  const row = (label, value) =>
    `<tr><td style="padding:4px 14px 4px 0;color:#6b6885;vertical-align:top">${label}</td>` +
    `<td style="padding:4px 0;font-weight:600">${escapeHtml(value)}</td></tr>`;

  return `
    <div style="font-family:Segoe UI,Arial,sans-serif;font-size:15px;line-height:1.6;color:#2a2745;max-width:520px">
      <p style="margin:0 0 14px">Hari Om,</p>
      <p style="margin:0 0 14px">This is a gentle reminder regarding the upcoming
        <b>${escapeHtml(title)}</b> scheduled as per the following details:</p>
      <table style="border-collapse:collapse;margin:0 0 14px">
        ${row('Event:', title)}${row('Date:', date)}${row('Venue:', venue)}
      </table>
      <p style="margin:0 0 22px">Kindly take note of the above details.</p>
      <p style="margin:0 0 22px">Regards,<br>Utsav Calendar</p>
      <p style="margin:0;color:#8a4b08;letter-spacing:.02em">${escapeHtml(SIGNATURE)}</p>
    </div>`;
}

/**
 * Create the email sender, or return null when SMTP is not configured.
 * `sendReminder(event, emails)` BCCs recipients in batches so nobody sees each other's address.
 */
function createMailer(smtp) {
  if (!smtp.host || !smtp.user || !smtp.pass) return null;

  const transport = nodemailer.createTransport({
    host: smtp.host,
    port: smtp.port,
    secure: smtp.port === 465, // 465 = implicit TLS, 587 = STARTTLS
    auth: { user: smtp.user, pass: smtp.pass },
  });

  return {
    async sendReminder(event, emails) {
      const text = renderReminderText(event);
      const html = renderReminderHtml(event);
      for (const batch of chunk(emails, config.reminders.recipientsPerEmail)) {
        await transport.sendMail({
          from: smtp.from,
          bcc: batch,
          subject: `Reminder: ${event.title}`,
          text,
          html,
        });
      }
    },
  };
}

module.exports = {
  createMailer,
  escapeHtml,
  formatEventDate,
  renderReminderText,
  renderReminderHtml,
};
