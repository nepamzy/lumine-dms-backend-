const db = require("../../config/db");
const { sendEmail } = require("./providers/email.provider");
const { sendSMS } = require("./providers/sms.provider");

// Records the notification first (so we always have a log, even if sending
// fails), then attempts delivery. A send failure never throws back to the
// caller — notifications are a side-effect and must never break the order,
// payment, or delivery flow that triggered them.
async function notify({ userId, type, channel, message }) {
  const result = await db.query(
    `INSERT INTO notifications (user_id, type, channel, message)
     VALUES ($1, $2, $3, $4) RETURNING *`,
    [userId, type, channel, message]
  );
  const record = result.rows[0];

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
      await sendEmail({ to: user.email, subject: type, message });
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

// ---- Event-specific helpers, called from Orders/Payments/Deliveries ----

async function notifyOrderCreated(order, customerId) {
  return notify({
    userId: customerId,
    type: "order_created",
    channel: "email",
    message: `Hi! Your Lumine order ${order.order_number} has been received. Total: ₦${order.total_amount}. We'll notify you once it's on its way.`,
  });
}

async function notifyPaymentSuccess(order, customerId) {
  const percent = order.payment?.percent ?? 0;
  const remaining = Math.max(0, Number(order.total_amount) - (order.payment?.totalPaid ?? 0));
  return notify({
    userId: customerId,
    type: "payment_success",
    channel: "email",
    message:
      `Payment received for order ${order.order_number}. You've now paid ${percent.toFixed(0)}% ` +
      `(₦${(order.payment?.totalPaid ?? 0).toLocaleString()} of ₦${Number(order.total_amount).toLocaleString()}), ` +
      `with ₦${remaining.toLocaleString()} remaining. You can view and download your receipt any time from your Lumine dashboard.`,
  });
}

async function notifyOutForDelivery(order, customerId) {
  return notify({
    userId: customerId,
    type: "out_for_delivery",
    channel: "sms",
    message: `Your Lumine order ${order.order_number} is out for delivery. Track it in your dashboard.`,
  });
}

async function notifyDelivered(order, customerId) {
  return notify({
    userId: customerId,
    type: "delivered",
    channel: "email",
    message: `Your Lumine order ${order.order_number} has been delivered. Enjoy, and thanks for ordering!`,
  });
}

async function notifyDistributorAssigned(orderNumber, distributorUserId) {
  return notify({
    userId: distributorUserId,
    type: "new_assignment",
    channel: "sms",
    message: `New order ${orderNumber} has been assigned to you on Lumine DMS.`,
  });
}
async function notifyDistributorApproved(distributorUserId) {
  return notify({
    userId: distributorUserId,
    type: "distributor_approved",
    channel: "email",
    message: `Congratulations! Your Lumine distributor account has been approved. You can now log in and start managing deliveries.`,
  });
}

async function listForUser(userId) {
  const result = await db.query(
    "SELECT * FROM notifications WHERE user_id = $1 ORDER BY created_at DESC LIMIT 50",
    [userId]
  );
  return result.rows;
}

module.exports = {
  notify,
  notifyOrderCreated,
  notifyPaymentSuccess,
  notifyOutForDelivery,
  notifyDelivered,
  notifyDistributorAssigned,
  notifyDistributorApproved,
  listForUser,
};
