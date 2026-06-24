const asyncHandler = require("../../utils/asyncHandler");
const ApiError = require("../../utils/ApiError");
const db = require("../../config/db");
const paymentService = require("./payment.service");

const initializeHandler = asyncHandler(async (req, res) => {
  const { orderId } = req.body;
  if (!orderId) throw new ApiError(400, "orderId is required");

  // confirm the order belongs to the requesting customer
  const orderResult = await db.query("SELECT customer_id FROM orders WHERE id = $1", [orderId]);
  if (orderResult.rows.length === 0) throw new ApiError(404, "Order not found");
  if (orderResult.rows[0].customer_id !== req.user.id) {
    throw new ApiError(403, "This isn't your order");
  }

  const userResult = await db.query("SELECT email FROM users WHERE id = $1", [req.user.id]);
  const { authorizationUrl, reference } = await paymentService.initializePayment(
    orderId,
    userResult.rows[0].email
  );

  res.json({ success: true, data: { authorizationUrl, reference } });
});

// Public — Paystack calls this directly. Signature is verified against the raw body.
const webhookHandler = asyncHandler(async (req, res) => {
  const signature = req.headers["x-paystack-signature"];
  const isValid = paymentService.isValidWebhookSignature(req.body, signature);

  if (!isValid) {
    return res.status(401).json({ success: false, message: "Invalid signature" });
  }

  // req.body is a raw Buffer here (see app.js) — parse only after verifying
  const event = JSON.parse(req.body.toString("utf8"));

  if (event.event === "charge.success") {
    await paymentService.confirmAndApplyPayment(event.data.reference);
  }

  // Always 200 quickly so Paystack doesn't retry unnecessarily
  res.sendStatus(200);
});

// Lets the frontend poll/confirm status after redirect back from Paystack
const verifyHandler = asyncHandler(async (req, res) => {
  const payment = await paymentService.confirmAndApplyPayment(req.params.reference);
  res.json({ success: true, data: payment });
});

module.exports = { initializeHandler, webhookHandler, verifyHandler };
