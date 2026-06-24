const axios = require("axios");
const crypto = require("crypto");
const db = require("../../config/db");
const ApiError = require("../../utils/ApiError");
const { getOrderById, updateStatus } = require("../orders/order.service");
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

// Starts a Paystack transaction for a pending order and returns the
// checkout URL the customer is redirected to.
async function initializePayment(orderId, customerEmail) {
  const order = await getOrderById(orderId);

  if (order.status !== "pending") {
    throw new ApiError(400, `Order is "${order.status}" and cannot be paid for again`);
  }

  const existing = await db.query("SELECT * FROM payments WHERE order_id = $1", [orderId]);
  if (existing.rows.length > 0 && existing.rows[0].status === "successful") {
    throw new ApiError(400, "This order has already been paid for");
  }

  const reference = generateReference();
  const amountInKobo = Math.round(Number(order.total_amount) * 100);

  let response;
  try {
    response = await paystackClient().post("/transaction/initialize", {
      email: customerEmail,
      amount: amountInKobo,
      reference,
      callback_url: `${process.env.CLIENT_URL}/orders/${orderId}/payment-callback`,
      metadata: { orderId },
    });
  } catch (err) {
    throw new ApiError(502, "Could not start payment with Paystack. Please try again.");
  }

  if (existing.rows.length > 0) {
    await db.query(
      `UPDATE payments SET paystack_ref = $1, amount = $2, status = 'initiated' WHERE order_id = $3`,
      [reference, order.total_amount, orderId]
    );
  } else {
    await db.query(
      `INSERT INTO payments (order_id, paystack_ref, amount, status)
       VALUES ($1, $2, $3, 'initiated')`,
      [orderId, reference, order.total_amount]
    );
  }

  return {
    authorizationUrl: response.data.data.authorization_url,
    reference,
  };
}

// Verifies signature header against raw request body, per Paystack's
// documented webhook security method (HMAC SHA512 with the secret key).
function isValidWebhookSignature(rawBody, signatureHeader) {
  if (!signatureHeader) return false;
  const hash = crypto
    .createHmac("sha512", process.env.PAYSTACK_SECRET_KEY)
    .update(rawBody)
    .digest("hex");
  return hash === signatureHeader;
}

// Confirms a transaction directly with Paystack (used by both the webhook
// and a manual verify endpoint, so we never trust client-reported status alone).
async function confirmAndApplyPayment(reference) {
  let response;
  try {
    response = await paystackClient().get(`/transaction/verify/${reference}`);
  } catch (err) {
    throw new ApiError(502, "Could not verify payment with Paystack");
  }

  const transaction = response.data.data;
  const paymentResult = await db.query("SELECT * FROM payments WHERE paystack_ref = $1", [
    reference,
  ]);
  if (paymentResult.rows.length === 0) {
    throw new ApiError(404, "Payment record not found for this reference");
  }
  const payment = paymentResult.rows[0];

  if (payment.status === "successful") {
    return payment; // already processed — avoid double-applying on duplicate webhook delivery
  }

  if (transaction.status === "success") {
    await db.query(
      `UPDATE payments SET status = 'successful', paid_at = now() WHERE id = $1`,
      [payment.id]
    );
    await updateStatus(payment.order_id, "paid", { role: "admin", id: null });

    const order = await getOrderById(payment.order_id);
    notifyPaymentSuccess(order, order.customer_id).catch(() => {});

    return { ...payment, status: "successful" };
  } else {
    await db.query(`UPDATE payments SET status = 'failed' WHERE id = $1`, [payment.id]);
    return { ...payment, status: "failed" };
  }
}

module.exports = {
  initializePayment,
  isValidWebhookSignature,
  confirmAndApplyPayment,
};
