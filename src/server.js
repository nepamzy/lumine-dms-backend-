require("dotenv").config();
const app = require("./app");
const { reconcilePendingPayments } = require("./modules/payments/payment.service");

const PORT = process.env.PORT || 4000;

app.listen(PORT, () => {
  console.log(`Lumine DMS API running on port ${PORT}`);
});

// Safety net so a Paystack payment can never get stuck showing "pending"
// (or wrongly "failed") just because the buyer closed the tab before the
// frontend finished checking, or the webhook didn't arrive. Runs shortly
// after boot, then every few minutes for as long as the server is up.
const RECONCILE_INTERVAL_MS = 3 * 60 * 1000;

function runReconciliation() {
  reconcilePendingPayments()
    .then((checked) => {
      if (checked > 0) console.log(`Payment reconciliation: re-checked ${checked} pending payment(s).`);
    })
    .catch((err) => console.error("Payment reconciliation error:", err.message));
}

setTimeout(runReconciliation, 15 * 1000);
setInterval(runReconciliation, RECONCILE_INTERVAL_MS);
