const webpush = require("web-push");
const db = require("../../../config/db");

const VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY;
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY;
const VAPID_SUBJECT = process.env.VAPID_SUBJECT || "mailto:support@lumine.app";

let configured = false;
if (VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY) {
  webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
  configured = true;
} else {
  console.error("Push notifications disabled — VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY not configured.");
}

// Sends one payload to every browser subscription on file for a user (they
// can have several — phone, laptop, etc., each subscribes separately).
// Best-effort per subscription: a 404/410 means the browser itself revoked
// it (uninstalled, cleared site data, permission withdrawn) — that
// subscription is deleted so it stops being retried, but nothing here ever
// throws back to the caller, same contract as the email/SMS providers.
async function sendPushToUser(userId, { title, body, url, tag }) {
  if (!configured) return;

  const result = await db.query(
    "SELECT id, endpoint, p256dh, auth FROM push_subscriptions WHERE user_id = $1",
    [userId]
  );
  if (result.rows.length === 0) return;

  const payload = JSON.stringify({
    title,
    body,
    url: url || "/",
    tag: tag || "lumine-notification",
  });

  await Promise.all(
    result.rows.map(async (sub) => {
      try {
        await webpush.sendNotification(
          { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
          payload
        );
      } catch (err) {
        if (err.statusCode === 404 || err.statusCode === 410) {
          await db.query("DELETE FROM push_subscriptions WHERE id = $1", [sub.id]).catch(() => {});
        } else {
          console.error(`Push send failed for subscription ${sub.id}:`, err.message);
        }
      }
    })
  );
}

module.exports = { sendPushToUser, isConfigured: () => configured, VAPID_PUBLIC_KEY };
