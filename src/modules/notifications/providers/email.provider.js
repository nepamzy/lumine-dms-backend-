const nodemailer = require("nodemailer");

let transporter;

function getTransporter() {
  if (!transporter) {
    transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: Number(process.env.SMTP_PORT) || 587,
      secure: process.env.SMTP_PORT === "465",
      auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS,
      },
    });
  }
  return transporter;
}

async function sendEmail({ to, subject, message }) {
  await getTransporter().sendMail({
    from: process.env.SMTP_FROM || "Lumine <no-reply@lumine.ng>",
    to,
    subject,
    text: message,
  });
}

module.exports = { sendEmail };
