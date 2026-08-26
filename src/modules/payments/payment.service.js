const axios = require("axios");
const crypto = require("crypto");
const db = require("../../config/db");
const ApiError = require("../../utils/ApiError");
const { getOrderById, validatePaymentAmount } = require("../orders/order.service");
const { notifyPaymentSuccess } = require("../notifications/notification.service");

const PAYSTACK_BASE_URL = "https://api.paystack.co";

function paystackClient() {
  return axios.create({
    baseURL: PAYSTACK_BASE_URL,
    headers: {
      Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}`,
      "Content-Type": "application/json",
    },
  });
}

function generateReference() {
  return `LUM-PAY-${Date.now()}-${Math.floor(Math.random() * 10000)}`;
}

// Starts a real Paystack transaction for a specific installment amount (not
// necessarily the full order) and returns the checkout URL the buyer is
// redirected to. Nothing counts as paid until confirmPaystackPayment
// confirms it — this just opens the attempt.
async function initializePaystackPayment(orderId, amount, buyer) {
  if (!process.env.PAYSTACK_SECRET_KEY) {
    throw new ApiError(503, "Payments aren't connected yet — Paystack isn't configured. Contact support.");
  }

  const order = await getOrderById(orderId);
  if (order.customer_id !== buyer.id) {
    throw new ApiError(403, "This isn't your order");
  }
  validatePaymentAmount(order, amount);

  const reference = generateReference();
  const amountInKobo = Math.round(Number(amount) * 100);

  let response;
  try {
    response = await paystackClient().post("/transaction/initialize", {
      email: buyer.email,
      amount: amountInKobo,
      reference,
      callback_url: `${process.env.CLIENT_URL}/orders/${orderId}?paystack_ref=${reference}`,
      metadata: { orderId, buyerId: buyer.id },
    });
  } catch (err) {
    throw new ApiError(502, "Could not start payment with Paystack. Please try again.");
  }

  // Recorded as 'pending' immediately, before the buyer even reaches
  // Paystack's page — this way an abandoned/failed checkout is still
  // traceable, and confirmPaystackPayment has a row to update against.
  await db.query(
    `INSERT INTO order_payments (order_id, amount, recorded_by, status, paystack_reference)
     VALUES ($1, $2, $3, 'pending', $4)`,
    [orderId, amount, buyer.id, reference]
  );

  return { authorizationUrl: response.data.data.authorization_url, reference };
}

// Verifies signature header against raw request body, per Paystack's
// documented webhook security method (HMAC SHA512 with the secret key).
function isValidWebhookSignature(rawBody, signatureHeader) {
  if (!signatureHeader || !process.env.PAYSTACK_SECRET_KEY) return false;
  const hash = crypto
    .createHmac("sha512", process.env.PAYSTACK_SECRET_KEY)
    .update(rawBody)
    .digest("hex");
  return hash === signatureHeader;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// How many times — and how far apart — we re-ask Paystack about a single
// transaction within one confirm attempt before giving up for now.
// Card payments usually settle instantly, but bank transfer/USSD (very
// common in Nigeria) and even a slow mobile connection can mean the money
// has already moved while Paystack's own API still briefly reports
// something other than "success". Checking once and immediately writing
// "failed" is exactly what was causing confirmed Paystack payments to show
// as failed on the site.
const VERIFY_MAX_ATTEMPTS = 4;
const VERIFY_RETRY_DELAY_MS = 3000;

// Only if a checkout has sat "abandoned" for this long do we treat it as a
// genuine failure rather than a payment that's still settling.
const ABANDONED_GRACE_MINUTES = 30;

// Talks to Paystack's verify endpoint, retrying a few times a few seconds
// apart. Returns as soon as we get a conclusive answer ("success" or
// "failed"); if every attempt comes back inconclusive (still processing,
// or we couldn't even reach Paystack), returns the last thing we saw (or
// null) so the caller can decide to leave the payment pending rather than
// guessing that it failed.
async function fetchPaystackTransaction(reference, attempts = VERIFY_MAX_ATTEMPTS) {
  let latest = null;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const response = await paystackClient().get(`/transaction/verify/${reference}`);
      latest = response.data.data;
      if (latest.status === "success" || latest.status === "failed") {
        return latest; // conclusive — no point waiting any further
      }
    } catch (err) {
      // Network hiccup talking to Paystack — worth another try, not proof
      // the payment itself failed.
    }
    if (attempt < attempts) await sleep(VERIFY_RETRY_DELAY_MS);
  }
  return latest;
}

// Confirms a transaction directly with Paystack (used by the webhook, the
// frontend's post-redirect verify call, a manual "recheck" button, and the
// background reconciliation job) — we never trust a client-reported "it
// worked", only Paystack's own verify response. Only once this confirms
// 'success' does the payment count toward the order's paid percentage.
//
// Crucially: this never marks a payment "failed" just because one check
// came back inconclusive. It only does that for a hard decline from
// Paystack, or a checkout abandoned long enough ago that it's genuinely
// not coming back. Everything else stays "pending" so it gets re-checked —
// by the buyer hitting "Recheck", by a delayed webhook, or by the
// reconciliation job — instead of being permanently and wrongly marked failed.
async function confirmPaystackPayment(reference, { attempts = VERIFY_MAX_ATTEMPTS } = {}) {
  const paymentResult = await db.query("SELECT * FROM order_payments WHERE paystack_reference = $1", [
    reference,
  ]);
  if (paymentResult.rows.length === 0) {
    throw new ApiError(404, "Payment record not found for this reference");
  }
  const payment = paymentResult.rows[0];

  if (payment.status === "successful") {
    return { order: await getOrderById(payment.order_id), paymentStatus: "successful" };
  }

  const transaction = await fetchPaystackTransaction(reference, attempts);

  await db.query(
    `UPDATE order_payments SET last_checked_at = now(), check_attempts = check_attempts + 1 WHERE id = $1`,
    [payment.id]
  );

  if (!transaction) {
    // Couldn't get a usable answer out of Paystack after several tries
    // (e.g. Paystack's API itself was briefly unreachable). Leave it
    // pending — the reconciliation job will pick it back up shortly.
    return { order: await getOrderById(payment.order_id), paymentStatus: "pending" };
  }

  // Paystack's "Pay via bank transfer" flow (the channel almost all of
  // these payments use) adds Paystack's own transaction fee on top of the
  // amount we ask for, and passes it to the customer — so the amount
  // actually charged is routinely a little MORE than what we requested
  // (e.g. we ask for ₦500, the customer is charged ₦507.62). That's normal
  // and still counts as this installment being paid in full. What we
  // actually need to guard against is being charged LESS than we asked
  // for, which would be a real problem, not a false alarm.
  const amountMatches = transaction.amount >= Math.round(Number(payment.amount) * 100);

  if (transaction.status === "success" && amountMatches) {
    await db.query(`UPDATE order_payments SET status = 'successful' WHERE id = $1`, [payment.id]);
    const order = await getOrderById(payment.order_id);
    notifyPaymentSuccess(order, order.customer_id).catch(() => {});
    return { order, paymentStatus: "successful" };
  }

  if (transaction.status === "success" && !amountMatches) {
    // Paystack says money moved, but LESS than we expected — a genuine
    // underpayment, which needs a human to look at rather than an
    // automatic "failed". Leave it pending and flag it.
    await db.query(`UPDATE order_payments SET status = 'pending' WHERE id = $1`, [payment.id]);
    return {
      order: await getOrderById(payment.order_id),
      paymentStatus: "pending",
      flagged: "underpaid",
    };
  }

  const isHardDecline = transaction.status === "failed";
  const ageMinutes = (Date.now() - new Date(payment.recorded_at).getTime()) / 60000;
  const isStaleAbandon = transaction.status === "abandoned" && ageMinutes > ABANDONED_GRACE_MINUTES;

  if (isHardDecline || isStaleAbandon) {
    await db.query(`UPDATE order_payments SET status = 'failed' WHERE id = $1`, [payment.id]);
    return { order: await getOrderById(payment.order_id), paymentStatus: "failed" };
  }

  // Still processing (pending/ongoing/queued, or an abandoned checkout
  // that's still within its grace period) — not a failure, just not
  // confirmed yet.
  await db.query(`UPDATE order_payments SET status = 'pending' WHERE id = $1`, [payment.id]);
  return { order: await getOrderById(payment.order_id), paymentStatus: "pending" };
}

// Safety net for payments that never got resolved by the frontend's
// post-redirect check or by the webhook — e.g. the buyer closed the tab
// before confirmation finished, or the webhook never reached us (not
// configured on the Paystack dashboard yet, brief downtime, etc). Re-checks
// still-"pending" Paystack payments from the last couple of days directly
// against Paystack, using the exact same logic as a manual recheck. Meant
// to be run on an interval (see server.js) — small batch size so it never
// hammers Paystack's API.
const RECONCILE_LOOKBACK_HOURS = 48;
const RECONCILE_BATCH_SIZE = 25;

async function reconcilePendingPayments() {
  const { rows } = await db.query(
    `SELECT paystack_reference FROM order_payments
     WHERE status = 'pending'
       AND paystack_reference IS NOT NULL
       AND recorded_at > now() - interval '${RECONCILE_LOOKBACK_HOURS} hours'
     ORDER BY recorded_at ASC
     LIMIT ${RECONCILE_BATCH_SIZE}`
  );

  let checked = 0;
  for (const row of rows) {
    try {
      // Single-pass check here (no need for the multi-retry loop — this
      // job runs every few minutes anyway, so it'll simply try again next
      // time if this pass is still inconclusive).
      await confirmPaystackPayment(row.paystack_reference, { attempts: 1 });
      checked++;
    } catch (err) {
      console.error("Payment reconciliation: failed to check", row.paystack_reference, err.message);
    }
  }
  return checked;
}

module.exports = {
  initializePaystackPayment,
  isValidWebhookSignature,
  confirmPaystackPayment,
  reconcilePendingPayments,
};
