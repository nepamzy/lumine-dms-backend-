const axios = require("axios");

// Termii is used here since Lumine operates in Nigeria — it has direct
// local network routing (better delivery rates than generic global SMS
// APIs for Nigerian numbers). Swap this file alone if a different
// provider is preferred; nothing else in the app needs to change.
async function sendSMS({ to, message }) {
  if (!process.env.TERMII_API_KEY) {
    throw new Error("TERMII_API_KEY is not configured");
  }

  await axios.post("https://api.ng.termii.com/api/sms/send", {
    api_key: process.env.TERMII_API_KEY,
    to,
    from: process.env.TERMII_SENDER_ID || "Lumine",
    sms: message,
    type: "plain",
    channel: "generic",
  });
}

module.exports = { sendSMS };
