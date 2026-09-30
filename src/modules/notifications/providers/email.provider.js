const axios = require("axios");

// Brand colors lifted directly from the PDF receipt (frontend's
// src/utils/receipt.js BRAND constant) so an email looks like it came from
// the same place as the receipt someone just downloaded — same navy header,
// same gold accent, same green for "this went well."
const BRAND = {
  navy: "#0A2D6F",
  blue: "#0F4DB8",
  gold: "#F4B400",
  green: "#2E9E44",
  gray: "#5A626E",
  cream: "#F8F7F4",
};

// `accent` picks the thin bar under the header + the CTA button color —
// gold (default) for anything routine, green for a happy/positive event
// (payment received, approved, welcome), navy for a neutral/administrative
// one. Kept to three so every email still visually agrees with the others
// rather than becoming its own thing per call site.
function renderEmailHtml({ title, message, ctaLabel, ctaUrl, accent = "gold", highlight }) {
  const accentColor = accent === "green" ? BRAND.green : accent === "navy" ? BRAND.navy : BRAND.gold;

  const bodyHtml = String(message)
    .split(/\n{2,}/)
    .map((para) => `<p style="margin:0 0 16px 0;color:#1c2b4a;font-size:15px;line-height:1.65;">${para.replace(/\n/g, "<br/>")}</p>`)
    .join("");

  // Optional callout box (e.g. an amount due, a new total, a reset code) —
  // same visual language as the receipt's navy-header items table: a dark
  // label bar, light body, right-aligned figure.
  const highlightHtml = highlight
    ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:4px 0 20px 0;border:1px solid #e5e1d8;border-radius:8px;overflow:hidden;">
         <tr><td style="background-color:${BRAND.navy};padding:8px 16px;color:#ffffff;font-size:11px;font-weight:700;letter-spacing:0.03em;text-transform:uppercase;">${highlight.label}</td></tr>
         <tr><td style="padding:14px 16px;background-color:#ffffff;color:${BRAND.navy};font-size:22px;font-weight:800;">${highlight.value}</td></tr>
       </table>`
    : "";

  const cta = ctaLabel && ctaUrl
    ? `<tr><td style="padding:8px 0 4px 0;">
         <a href="${ctaUrl}" style="display:inline-block;background-color:${accentColor};color:${accent === "gold" ? BRAND.navy : "#ffffff"};font-weight:700;font-size:14px;text-decoration:none;padding:12px 26px;border-radius:6px;">
           ${ctaLabel}
         </a>
       </td></tr>`
    : "";

  return `<!doctype html>
<html>
  <body style="margin:0;padding:0;background-color:${BRAND.cream};font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:${BRAND.cream};padding:32px 16px;">
      <tr>
        <td align="center">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:480px;background-color:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 1px 3px rgba(10,45,111,0.08);">
            <tr>
              <td style="background-color:${BRAND.navy};padding:22px 32px;">
                <div style="color:${BRAND.gold};font-size:19px;font-weight:800;letter-spacing:0.01em;">Bonchris Industry Nig. Ltd</div>
                <div style="color:#ffffffb3;font-size:12px;margin-top:2px;">Lumine Yoghurt — Kaduna, Nigeria</div>
              </td>
            </tr>
            <tr><td style="height:4px;background-color:${accentColor};"></td></tr>
            <tr>
              <td style="padding:32px;">
                <h1 style="margin:0 0 16px 0;color:${BRAND.navy};font-size:19px;font-weight:800;">${title}</h1>
                ${bodyHtml}
                ${highlightHtml}
                <table role="presentation" cellpadding="0" cellspacing="0">${cta}</table>
              </td>
            </tr>
            <tr>
              <td style="padding:18px 32px;background-color:${BRAND.cream};border-top:1px solid #ece8de;">
                <p style="margin:0;color:${BRAND.gray};font-size:11px;line-height:1.5;">
                  Bonchris Industry Nig. Ltd · Kaduna, Nigeria<br/>
                  This is an automated message — if you weren't expecting it, you can safely ignore it.
                </p>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;
}

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
// Nothing else in the app needs to change once BREVO_API_KEY and
// BREVO_SENDER_EMAIL are set as env vars — every notify() call already
// routes through here automatically.
//
// `title`/`ctaLabel`/`ctaUrl`/`accent`/`highlight` are optional — when
// present they drive the branded HTML template above, sent alongside the
// plain-text fallback every client still gets. Passing html directly skips
// template generation entirely, for a caller that wants full control.
async function sendEmail({ to, subject, message, title, ctaLabel, ctaUrl, accent, highlight, html }) {
  const apiKey = process.env.BREVO_API_KEY;
  const senderEmail = process.env.BREVO_SENDER_EMAIL;
  const senderName = process.env.BREVO_SENDER_NAME || "Lumine";
  const replyTo = process.env.BREVO_REPLY_TO || senderEmail;

  if (!apiKey || !senderEmail) {
    console.error("Email not sent — BREVO_API_KEY or BREVO_SENDER_EMAIL is not configured.");
    return;
  }

  const htmlContent = html || renderEmailHtml({ title: title || subject, message, ctaLabel, ctaUrl, accent, highlight });

  await axios.post(
    "https://api.brevo.com/v3/smtp/email",
    {
      sender: { name: senderName, email: senderEmail },
      to: [{ email: to }],
      replyTo: { email: replyTo },
      subject,
      textContent: message,
      htmlContent,
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

module.exports = { sendEmail, renderEmailHtml };
