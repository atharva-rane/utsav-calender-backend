'use strict';

const config = require('./src/config');
const { initSchema } = require('./src/db');
const { ensureAdmin } = require('./src/services/users');
const { createApp } = require('./src/app');
const { createMailer } = require('./src/services/mailer');
const { startReminderJob } = require('./src/services/reminderJob');

async function main() {
  await initSchema(ensureAdmin);

  const mailer = createMailer(config.smtp);
  if (mailer) {
    startReminderJob(mailer);
  } else {
    console.warn('[mail] SMTP is not configured - reminder emails are disabled.');
  }

  createApp().listen(config.port, () => {
    console.log(`Utsav API ready on http://localhost:${config.port}`);
  });
}

main().catch((err) => {
  console.error('Failed to start the server:', err.message);
  process.exit(1);
});
