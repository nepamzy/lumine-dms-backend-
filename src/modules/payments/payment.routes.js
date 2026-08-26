const express = require("express");
const router = express.Router();
const { authenticate, authorize } = require("../../middleware/auth.middleware");
const { initializeHandler, verifyHandler, reconcileHandler } = require("./payment.controller");

router.post("/initialize", authenticate, authorize("customer", "distributor"), initializeHandler);
router.get("/verify/:reference", authenticate, verifyHandler);
router.post("/reconcile", authenticate, authorize("admin"), reconcileHandler);

// Note: POST /webhook is intentionally NOT here — it's mounted directly in
// app.js with express.raw() before the global JSON parser, since Paystack's
// signature verification requires the exact raw request bytes.

module.exports = router;
