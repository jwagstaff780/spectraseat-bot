// Immediate owner alerts for things that shouldn't wait for the daily
// briefing: ad stop-loss, orders needing a human, chargebacks, failed jobs.
// De-duplicated per key for ALERT_COOLDOWN_HOURS so a stuck condition
// doesn't email you every 15 minutes.

const config = require("./config");
const db = require("./db");
const email = require("./email");

const ALERT_COOLDOWN_HOURS = 12;

async function notifyOwner(key, subject, text) {
  const to = process.env.OWNER_EMAIL;
  if (!to) return false;
  const { rowCount } = await db.query(
    `INSERT INTO kv (key, value, expires_at) VALUES ($1, $2, now() + make_interval(hours => $3))
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, expires_at = EXCLUDED.expires_at
     WHERE kv.expires_at IS NULL OR kv.expires_at < now()`,
    [`alert:${key}`, { subject }, ALERT_COOLDOWN_HOURS]
  );
  if (!rowCount) return false; // alerted recently
  await email.send(to, {
    subject: `[${config.BRAND.name}] ${subject}`,
    html: `<pre style="font:14px/1.5 system-ui,sans-serif;white-space:pre-wrap">${email.escapeHtml(text)}</pre>
      <p><a href="${email.escapeHtml((process.env.APP_URL || "") + "/admin.html")}">Open the admin dashboard</a></p>`,
  });
  return true;
}

module.exports = { notifyOwner };
