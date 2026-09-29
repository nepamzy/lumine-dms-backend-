const db = require("../../config/db");
const { sendEmail } = require("./providers/email.provider");
const { sendSMS } = require("./providers/sms.provider");
const { sendPushToUser, VAPID_PUBLIC_KEY } = require("./providers/push.provider");

// Used to build clickable links in email/push payloads — same origin the
// CORS config in app.js already trusts as the deployed frontend.
const APP_URL = process.env.CLIENT_URL || "http://localhost:5173";

// Records the notification first (so we always have a log, even if sending
// fails), then attempts delivery over every channel that makes sense: the
// requested email/SMS channel, AND a browser push (independent of that
// channel choice — a user with push enabled gets it regardless of whether
// this particular event is normally an email or an SMS one). A send
// failure never throws back to the caller — notifications are a side
// effect and must never break the order, payment, or delivery flow that
// triggered them.
async function notify({ userId, type, channel, message, title, ctaLabel, ctaUrl }) {
  const result = await db.query(
    `INSERT INTO notifications (user_id, type, channel, message)
     VALUES ($1, $2, $3, $4) RETURNING *`,
    [userId, type, channel, message]
  );
  const record = result.rows[0];
  const displayTitle = title || humanizeType(type);

  // Push is best-effort and independent of the email/SMS channel above —
  // never let it block or fail the primary send.
  sendPushToUser(userId, { title: displayTitle, body: message, url: ctaUrl, tag: type }).catch((err) =>
    console.error(`Push notification failed for user ${userId}:`, err.message)
  );

  try {
    const userResult = await db.query("SELECT email, phone FROM users WHERE id = $1", [userId]);
    const user = userResult.rows[0];
    if (!user) return record;

    // A sales-rep-registered customer may have no email (optional on that
    // signup path only) — fall back to SMS rather than attempt an email
    // send to a null address, or silently skip something they could still
    // actually receive.
    const effectiveChannel = channel === "email" && !user.email && user.phone ? "sms" : channel;

    if (effectiveChannel === "email" && user.email) {
      await sendEmail({ to: user.email, subject: displayTitle, message, title: displayTitle, ctaLabel, ctaUrl });
    } else if (effectiveChannel === "sms" && user.phone) {
      await sendSMS({ to: user.phone, message });
    } else {
      return record; // no usable channel for this user — skip cleanly
    }

    await db.query("UPDATE notifications SET sent_at = now() WHERE id = $1", [record.id]);
  } catch (err) {
    // Logged but swallowed deliberately — see comment above.
    console.error(`Notification ${record.id} failed to send:`, err.message);
  }

  return record;
}

function humanizeType(type) {
  return String(type)
    .replace(/_/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

// ---- Event-specific helpers, called from Orders/Payments/Deliveries ----

async function notifyOrderCreated(order, customerId) {
  return notify({
    userId: customerId,
    type: "order_created",
    channel: "email",
    title: "Order received",
    message: `Hi! Your Lumine order ${order.order_number} has been received. Total: ₦${Number(order.total_amount).toLocaleString()}. We'll notify you once it's on its way.`,
    ctaLabel: "View order",
    ctaUrl: `${APP_URL}/orders/${order.id}`,
  });
}

async function notifyPaymentSuccess(order, customerId) {
  const percent = order.payment?.percent ?? 0;
  const remaining = Math.max(0, Number(order.total_amount) - (order.payment?.totalPaid ?? 0));
  return notify({
    userId: customerId,
    type: "payment_success",
    channel: "email",
    title: "Payment received",
    message:
      `Payment received for order ${order.order_number}. You've now paid ${percent.toFixed(0)}% ` +
      `(₦${(order.payment?.totalPaid ?? 0).toLocaleString()} of ₦${Number(order.total_amount).toLocaleString()}), ` +
      `with ₦${remaining.toLocaleString()} remaining. You can view and download your receipt any time from your Lumine dashboard.`,
    ctaLabel: "View receipt",
    ctaUrl: `${APP_URL}/orders/${order.id}`,
  });
}

async function notifyOutForDelivery(order, customerId) {
  return notify({
    userId: customerId,
    type: "out_for_delivery",
    channel: "sms",
    title: "Out for delivery",
    message: `Your Lumine order ${order.order_number} is out for delivery. Track it in your dashboard.`,
    ctaUrl: `${APP_URL}/orders/${order.id}`,
  });
}

async function notifyDelivered(order, customerId) {
  return notify({
    userId: customerId,
    type: "delivered",
    channel: "email",
    title: "Order delivered",
    message: `Your Lumine order ${order.order_number} has been delivered. Enjoy, and thanks for ordering!`,
    ctaLabel: "View order",
    ctaUrl: `${APP_URL}/orders/${order.id}`,
  });
}

async function notifyDistributorAssigned(orderNumber, distributorUserId) {
  return notify({
    userId: distributorUserId,
    type: "new_assignment",
    channel: "sms",
    title: "New order assigned",
    message: `New order ${orderNumber} has been assigned to you on Lumine DMS.`,
    ctaUrl: `${APP_URL}/dashboard`,
  });
}
async function notifyDistributorApproved(distributorUserId) {
  return notify({
    userId: distributorUserId,
    type: "distributor_approved",
    channel: "email",
    title: "You're approved!",
    message: `Congratulations! Your Lumine distributor account has been approved. You can now log in and start managing deliveries.`,
    ctaLabel: "Go to dashboard",
    ctaUrl: `${APP_URL}/dashboard`,
  });
}

async function listForUser(userId) {
  const result = await db.query(
    "SELECT * FROM notifications WHERE user_id = $1 ORDER BY created_at DESC LIMIT 50",
    [userId]
  );
  return result.rows;
}

// ---- Browser push subscriptions ----
//
// Keyed by endpoint, not by user (see the migration's own comment) — this
// upsert is exactly what makes "allow notifications" survive logout/login:
// re-subscribing (which the frontend does silently whenever permission is
// already granted, no re-prompt) just rebinds the SAME row to whichever
// user is now logged in, rather than needing a fresh browser permission
// grant or leaving stale rows behind.
async function subscribeToPush(userId, { endpoint, keys, userAgent }) {
  if (!endpoint || !keys?.p256dh || !keys?.auth) {
    throw new Error("A push subscription needs endpoint and keys.p256dh/keys.auth");
  }
  await db.query(
    `INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth, user_agent)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (endpoint) DO UPDATE SET user_id = $1, p256dh = $3, auth = $4, user_agent = $5`,
    [userId, endpoint, keys.p256dh, keys.auth, userAgent || null]
  );
}

// Deliberately NOT called on logout anywhere in the app — see the frontend
// push hook. Only reached when the browser itself reports the
// subscription gone, or the person explicitly turns notifications off.
async function unsubscribeFromPush(endpoint) {
  if (!endpoint) return;
  await db.query("DELETE FROM push_subscriptions WHERE endpoint = $1", [endpoint]);
}

async function isPushSubscribed(userId, endpoint) {
  if (!endpoint) return false;
  const result = await db.query(
    "SELECT 1 FROM push_subscriptions WHERE user_id = $1 AND endpoint = $2",
    [userId, endpoint]
  );
  return result.rows.length > 0;
}

// ---- Admin fan-out — every admin account gets a copy ----

async function getAdminUserIds() {
  const result = await db.query("SELECT id FROM users WHERE role = 'admin' AND deleted_at IS NULL");
  return result.rows.map((r) => r.id);
}

// Generic admin broadcaster — every specific notifyAdmin* helper below is a
// thin wrapper over this. Fires in parallel, all failures swallowed by
// notify() itself, so one admin's bad email address never blocks another's.
async function notifyAdmins({ type, title, message, ctaLabel, ctaUrl }) {
  const adminIds = await getAdminUserIds();
  return Promise.all(
    adminIds.map((id) => notify({ userId: id, type, channel: "email", title, message, ctaLabel, ctaUrl }))
  );
}

async function notifyAdminNewSignup({ role, distributorType, fullName, autoApproved, registeredByName }) {
  const kind = role === "customer" ? "Customer" : distributorType === "distributor" ? "Distributor" : "Sales Rep";
  const status = role === "customer" || autoApproved ? "no approval needed" : "awaiting your approval";
  const context = registeredByName ? ` — onboarded by ${registeredByName}` : "";
  return notifyAdmins({
    type: "admin_new_signup",
    title: `New ${kind} signup`,
    message: `${fullName} just signed up on Lumine as a ${kind}${context} (${status}).`,
    ctaLabel: role === "customer" ? "View customers" : "Review in admin",
    ctaUrl: role === "customer" ? `${APP_URL}/admin/customers` : `${APP_URL}/admin/distributors`,
  });
}

async function notifyAdminOrderPlaced(order, buyerName) {
  return notifyAdmins({
    type: "admin_order_placed",
    title: "New order placed",
    message: `${buyerName} placed order ${order.order_number} for ₦${Number(order.total_amount).toLocaleString()}.`,
    ctaLabel: "View order",
    ctaUrl: `${APP_URL}/orders/${order.id}`,
  });
}

async function notifyAdminPaymentReceived(order, amount) {
  return notifyAdmins({
    type: "admin_payment_received",
    title: "Payment received",
    message: `A payment of ₦${Number(amount).toLocaleString()} came in for order ${order.order_number}.`,
    ctaLabel: "View order",
    ctaUrl: `${APP_URL}/orders/${order.id}`,
  });
}

module.exports = {
  notify,
  notifyOrderCreated,
  notifyPaymentSuccess,
  notifyOutForDelivery,
  notifyDelivered,
  notifyDistributorAssigned,
  notifyDistributorApproved,
  notifyAdmins,
  notifyAdminNewSignup,
  notifyAdminOrderPlaced,
  notifyAdminPaymentReceived,
  listForUser,
  subscribeToPush,
  unsubscribeFromPush,
  isPushSubscribed,
  VAPID_PUBLIC_KEY,
};
