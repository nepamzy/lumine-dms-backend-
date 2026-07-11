const { sendEmail } = require("../notifications/providers/email.provider");
const asyncHandler = require("../../utils/asyncHandler");

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const submitContactForm = asyncHandler(async (req, res) => {
  const { name, email, phone, subject, message } = req.body || {};

  const errors = [];
  if (!name || !name.trim()) errors.push("Name is required.");
  if (!email || !EMAIL_RE.test(email.trim())) errors.push("A valid email is required.");
  if (!subject || !subject.trim()) errors.push("Subject is required.");
  if (!message || !message.trim()) errors.push("Message is required.");

  if (errors.length > 0) {
    return res.status(400).json({ success: false, message: errors.join(" ") });
  }

  const destination = process.env.CONTACT_EMAIL || process.env.SMTP_USER;

  await sendEmail({
    to: destination,
    subject: `[Lumine Website] ${subject.trim()}`,
    message:
      `New contact form submission from the Lumine website:\n\n` +
      `Name: ${name.trim()}\n` +
      `Email: ${email.trim()}\n` +
      `Phone: ${phone ? phone.trim() : "Not provided"}\n` +
      `Subject: ${subject.trim()}\n\n` +
      `Message:\n${message.trim()}`,
  });

  res.json({ success: true, message: "Message sent. We'll get back to you soon." });
});

module.exports = { submitContactForm };
