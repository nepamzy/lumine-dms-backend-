const express = require("express");
const rateLimit = require("express-rate-limit");
const router = express.Router();
const { authenticate, authorize } = require("../../middleware/auth.middleware");
const {
  registerHandler,
  loginHandler,
  refreshHandler,
  logoutHandler,
  meHandler,
  updateProfileHandler,
  changePasswordHandler,
  acknowledgePaymentNoticeHandler,
  updateLocationHandler,
  forgotPasswordHandler,
  verifyResetOtpHandler,
  resetPasswordHandler,
} = require("./auth.controller");

// Tighter than the general authLimiter this router is already mounted
// behind (app.js) — each request here sends a real email/SMS, so it needs
// its own, smaller cap to keep someone from running up the Brevo/Termii
// bill by spamming a single address.
const forgotPasswordLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  message: { success: false, message: "Too many requests. Try again later." },
});

router.post("/register", registerHandler);
router.post("/login", loginHandler);
router.post("/refresh", refreshHandler);
router.post("/logout", logoutHandler);
router.post("/forgot-password", forgotPasswordLimiter, forgotPasswordHandler);
router.post("/verify-reset-otp", verifyResetOtpHandler);
router.post("/reset-password", resetPasswordHandler);
router.get("/me", authenticate, meHandler);
router.patch("/me", authenticate, updateProfileHandler);
router.patch("/me/location", authenticate, updateLocationHandler);
router.post("/change-password", authenticate, changePasswordHandler);
router.post("/acknowledge-payment-notice", authenticate, authorize("customer"), acknowledgePaymentNoticeHandler);

module.exports = router;
