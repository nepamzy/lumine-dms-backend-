const asyncHandler = require("../../utils/asyncHandler");
const ApiError = require("../../utils/ApiError");
const db = require("../../config/db");
const paymentService = require("./payment.service");

const initializeHandler = asyncHandler(async (req, res) => {
  const { orderId, amount } = req.body;
  if (!orderId || !amount) throw new ApiError(400, "orderId and amount are required");

  const userResult = await db.query("SELECT email FROM users WHERE id = $1", [req.user.id]);
  const { authorizationUrl, reference } = await paymentService.initializePaystackPayment(
    orderId,
    Number(amount),
    { id: req.user.id, email: userResult.rows[0].email }
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
    await paymentService.confirmPaystackPayment(event.data.reference);
  }

  // Always 200 quickly so Paystack doesn't retry unnecessarily
  res.sendStatus(200);
});

// Lets the frontend confirm status after redirect back from Paystack —
// belt-and-suspenders alongside the webhook, since a user's browser
// redirect can arrive before or after the webhook does.
const verifyHandler = asyncHandler(async (req, res) => {
  const order = await paymentService.confirmPaystackPayment(req.params.reference);
  res.json({ success: true, data: order });
});

module.exports = { initializeHandler, webhookHandler, verifyHandler };
