const axios = require("axios");

// Brand tokens mirrored from the frontend's Tailwind config (navy-900,
// gold-500, cream-50) so transactional email actually looks like it came
// from Lumine rather than a bare-text system alert. Table-based layout,
// inline styles only — the usual constraints for email client
// compatibility (Outlook/Gmail strip <style> blocks and flexbox alike).
function renderEmailHtml({ title, message, ctaLabel, ctaUrl }) {
  const bodyHtml = String(message)
    .split(/\n{2,}/)
    .map((para) => `<p style="margin:0 0 16px 0;color:#1c2b4a;font-size:15px;line-height:1.6;">${para.replace(/\n/g, "<br/>")}</p>`)
    .join("");

  const cta = ctaLabel && ctaUrl
    ? `<tr><td style="padding:8px 0 4px 0;">
         <a href="${ctaUrl}" style="display:inline-block;background-color:#D4AF37;color:#0A2D6F;font-weight:700;font-size:14px;text-decoration:none;padding:12px 24px;border-radius:6px;">
           ${ctaLabel}
         </a>
       </td></tr>`
    : "";

  return `<!doctype html>
<html>
  <body style="margin:0;padding:0;background-color:#F8F7F4;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#F8F7F4;padding:32px 16px;">
      <tr>
        <td align="center">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:480px;background-color:#ffffff;border-radius:12px;overflow:hidden;">
            <tr>
              <td style="background-color:#0A2D6F;padding:24px 32px;">
                <span style="color:#D4AF37;font-size:20px;font-weight:800;letter-spacing:0.02em;">Lumine</span>
              </td>
            </tr>
            <tr>
              <td style="padding:32px;">
                <h1 style="margin:0 0 16px 0;color:#0A2D6F;font-size:19px;font-weight:800;">${title}</h1>
                ${bodyHtml}
                <table role="presentation" cellpadding="0" cellspacing="0">${cta}</table>
              </td>
            </tr>
            <tr>
              <td style="padding:20px 32px;background-color:#F8F7F4;">
                <p style="margin:0;color:#1c2b4a99;font-size:12px;line-height:1.5;">
                  This is an automated message from Lumine. If you weren't expecting it, you can safely ignore it.
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
//
// `title`/`ctaLabel`/`ctaUrl` are optional — when present they drive a
// branded HTML version (see renderEmailHtml above) sent alongside the
// plain-text fallback every client still gets. Passing html directly
// skips template generation entirely, for a caller that wants full control.
async function sendEmail({ to, subject, message, title, ctaLabel, ctaUrl, html }) {
  const apiKey = process.env.BREVO_API_KEY;
  const senderEmail = process.env.BREVO_SENDER_EMAIL;
  const senderName = process.env.BREVO_SENDER_NAME || "Lumine Support";
  const replyTo = process.env.BREVO_REPLY_TO || senderEmail;

  if (!apiKey || !senderEmail) {
    console.error("Email not sent — BREVO_API_KEY or BREVO_SENDER_EMAIL is not configured.");
    return;
  }

  const htmlContent = html || renderEmailHtml({ title: title || subject, message, ctaLabel, ctaUrl });

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
