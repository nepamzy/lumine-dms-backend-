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

// Confirms a transaction directly with Paystack (used by both the webhook
// and the frontend's post-redirect verify call) — we never trust a
// client-reported "it worked", only Paystack's own verify response. Only
// once this confirms 'success' does the payment count toward the order's
// paid percentage.
async function confirmPaystackPayment(reference) {
  const paymentResult = await db.query("SELECT * FROM order_payments WHERE paystack_reference = $1", [
    reference,
  ]);
  if (paymentResult.rows.length === 0) {
    throw new ApiError(404, "Payment record not found for this reference");
  }
  const payment = paymentResult.rows[0];

  if (payment.status === "successful") {
    return getOrderById(payment.order_id); // already processed — idempotent
  }

  let response;
  try {
    response = await paystackClient().get(`/transaction/verify/${reference}`);
  } catch (err) {
    throw new ApiError(502, "Could not verify payment with Paystack");
  }
  const transaction = response.data.data;

  if (transaction.status === "success" && transaction.amount === Math.round(Number(payment.amount) * 100)) {
    await db.query(`UPDATE order_payments SET status = 'successful' WHERE id = $1`, [payment.id]);
    const order = await getOrderById(payment.order_id);
    notifyPaymentSuccess(order, order.customer_id).catch(() => {});
    return order;
  } else {
    await db.query(`UPDATE order_payments SET status = 'failed' WHERE id = $1`, [payment.id]);
    return getOrderById(payment.order_id);
  }
}

module.exports = {
  initializePaystackPayment,
  isValidWebhookSignature,
  confirmPaystackPayment,
};
