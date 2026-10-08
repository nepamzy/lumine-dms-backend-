const axios = require("axios");

// Termii is used here since Lumine operates in Nigeria — it has direct
// local network routing (better delivery rates than generic global SMS
// APIs for Nigerian numbers). Swap this file alone if a different
// provider is preferred; nothing else in the app needs to change.
async function sendSMS({ to, message }) {
  if (!process.env.TERMII_API_KEY) {
    throw new Error("TERMII_API_KEY is not configured");
  }

  try {
    await axios.post("https://api.ng.termii.com/api/sms/send", {
      api_key: process.env.TERMII_API_KEY,
      to,
      from: process.env.TERMII_SENDER_ID || "Lumine",
      sms: message,
      type: "plain",
      channel: "generic",
    });
  } catch (err) {
    // Termii puts the actual rejection reason (bad key, no balance, sender
    // ID not registered, etc.) in the response body — axios's own
    // err.message is just "Request failed with status code 401", which
    // every notify() caller logs verbatim and gives no way to tell those
    // reasons apart. Surface the body so that log line is actionable.
    const detail = err.response?.data?.message || JSON.stringify(err.response?.data) || err.message;
    throw new Error(`Termii SMS send failed: ${detail}`);
  }
}

module.exports = { sendSMS };
