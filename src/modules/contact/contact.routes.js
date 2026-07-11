const express = require("express");
const rateLimit = require("express-rate-limit");
const router = express.Router();
const { submitContactForm } = require("./contact.controller");

// Public endpoint — rate-limited to slow down spam/abuse since it's unauthenticated.
const contactLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: { success: false, message: "Too many messages sent. Please try again later." },
});

router.post("/", contactLimiter, submitContactForm);

module.exports = router;
