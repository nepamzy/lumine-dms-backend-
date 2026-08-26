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
// redirect can arrive before or after the webhook does. Also reused as the
// buyer/admin-facing "Recheck with Paystack" action on a pending or failed
// payment row, since it's the exact same idempotent check.
const verifyHandler = asyncHandler(async (req, res) => {
  const { order, paymentStatus, flagged } = await paymentService.confirmPaystackPayment(req.params.reference);
  res.json({ success: true, data: order, paymentStatus, flagged: flagged || null });
});

// Admin-only manual trigger for the reconciliation sweep (it also runs
// automatically on an interval — see server.js). Useful to run on demand
// right after fixing a Paystack/webhook configuration issue, instead of
// waiting for the next scheduled pass.
const reconcileHandler = asyncHandler(async (req, res) => {
  const checked = await paymentService.reconcilePendingPayments();
  res.json({ success: true, data: { checked } });
});

module.exports = { initializeHandler, webhookHandler, verifyHandler, reconcileHandler };
