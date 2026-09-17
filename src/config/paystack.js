const axios = require("axios");

const PAYSTACK_BASE_URL = "https://api.paystack.co";

// Shared by payment.service.js (charging buyers) and distributor.service.js
// (bank resolution + subaccount setup) — same auth, same base URL.
function paystackClient() {
  return axios.create({
    baseURL: PAYSTACK_BASE_URL,
    headers: {
      Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}`,
      "Content-Type": "application/json",
    },
  });
}

module.exports = { paystackClient, PAYSTACK_BASE_URL };
