'use strict';

const cron = require('node-cron');
const config = require('../config');
const { query } = require('../db');

const { timezone } = config.reminders;
const MAX_PER_RUN = 200;
const STALE_AFTER = '2 days'; // a reminder this overdue is dropped instead of sent late

async function sendDueReminders(mailer) {
  // Drop reminders that were due long ago (e.g. the server was off, or the owner had no recipients).
  await query(
    `UPDATE reminders SET status = 'skipped'
     WHERE status = 'pending'
       AND (remind_date + remind_time) < (now() AT TIME ZONE $1) - $2::interval`,
    [timezone, STALE_AFTER],
  );

  // Reminder dates and times are wall-clock values in the configured timezone.
  const due = await query(
    `SELECT r.id, r.user_id,
            e.title, e.date, to_char(e.time, 'HH24:MI') AS time, e.location
     FROM reminders r
     JOIN events e ON e.id = r.event_id
     WHERE r.status = 'pending'
       AND (r.remind_date + r.remind_time) <= (now() AT TIME ZONE $1)
     ORDER BY r.remind_date, r.remind_time, r.id
     LIMIT ${MAX_PER_RUN}`,
    [timezone],
  );
  if (!due.length) return;

  // Each reminder goes only to the recipients of the user who set it.
  const recipientsByUser = new Map();
  const recipientsOf = async (userId) => {
    if (!recipientsByUser.has(userId)) {
      const rows = await query('SELECT email FROM recipients WHERE user_id = $1', [userId]);
      recipientsByUser.set(
        userId,
        rows.map((row) => row.email),
      );
    }
    return recipientsByUser.get(userId);
  };

  for (const reminder of due) {
    const emails = await recipientsOf(reminder.user_id);
    if (!emails.length) continue; // stays pending until the user adds someone (or it goes stale)

    try {
      await mailer.sendReminder(reminder, emails);
      // Only count a send after the email really went out, so failures are retried next minute.
      await query(`UPDATE reminders SET status = 'sent', sent_at = now() WHERE id = $1`, [
        reminder.id,
      ]);
    } catch (err) {
      console.error(`[reminders] could not send "${reminder.title}":`, err.message);
    }
  }
}

/** Check every minute. Anything missed while the server was down is sent one minute at a time. */
function startReminderJob(mailer) {
  let running = false; // never let two runs overlap

  cron.schedule('* * * * *', async () => {
    if (running) return;
    running = true;
    try {
      await sendDueReminders(mailer);
    } catch (err) {
      console.error('[reminders] job failed:', err.message);
    } finally {
      running = false;
    }
  });
}

module.exports = { startReminderJob, sendDueReminders };
