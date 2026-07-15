const axios = require("axios");

// Sends transactional email via Brevo's HTTPS transactional email API.
// Deliberately NOT using raw SMTP — Render's free tier blocks outbound SMTP
// ports (25/465/587) entirely, so any SMTP-based sender (Gmail's own SMTP
// included) silently fails from there. Brevo's API runs over HTTPS, which
// isn't blocked.
//
// BREVO_SENDER_EMAIL must be a verified sender in your Brevo account
// (Settings → Senders, Domains & Dedicated IPs → add + verify via the
// confirmation email Brevo sends to that inbox). Until it's verified,
// sends will fail with a 401/403 from Brevo — that's expected, not a bug.
async function sendEmail({ to, subject, message }) {
  const apiKey = process.env.BREVO_API_KEY;
  const senderEmail = process.env.BREVO_SENDER_EMAIL;
  const senderName = process.env.BREVO_SENDER_NAME || "Lumine Support";
  const replyTo = process.env.BREVO_REPLY_TO || senderEmail;

  if (!apiKey || !senderEmail) {
    console.error("Email not sent — BREVO_API_KEY or BREVO_SENDER_EMAIL is not configured.");
    return;
  }

  await axios.post(
    "https://api.brevo.com/v3/smtp/email",
    {
      sender: { name: senderName, email: senderEmail },
      to: [{ email: to }],
      replyTo: { email: replyTo },
      subject,
      textContent: message,
    },
    {
      headers: {
        "api-key": apiKey,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
    }
  );
}

module.exports = { sendEmail };
