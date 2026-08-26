// One-off diagnostic — NOT part of the app, just for us to see the truth.
// Prints exactly what Paystack's own API says about every non-successful
// payment on a given order: the real status, the real amount charged, and
// whether it matches what we recorded. Doesn't change anything in the
// database — read-only.
//
// Usage:
//   node diagnose-payment.js <DATABASE_URL> <PAYSTACK_SECRET_KEY> <order_number_or_id>
//
// Example:
//   node diagnose-payment.js "postgresql://..." "sk_live_xxx" LUM-20260814-3505

const { Client } = require("pg");
const axios = require("axios");

const [, , DATABASE_URL, PAYSTACK_SECRET_KEY, orderRef] = process.argv;

if (!DATABASE_URL || !PAYSTACK_SECRET_KEY || !orderRef) {
  console.error("Usage: node diagnose-payment.js <DATABASE_URL> <PAYSTACK_SECRET_KEY> <order_number_or_id>");
  process.exit(1);
}

async function main() {
  const client = new Client({ connectionString: DATABASE_URL, ssl: { rejectUnauthorized: false } });
  await client.connect();

  const orderResult = await client.query(
    `SELECT id, order_number, total_amount FROM orders WHERE order_number = $1 OR id::text = $1`,
    [orderRef]
  );
  if (orderResult.rows.length === 0) {
    console.error(`No order found matching "${orderRef}"`);
    await client.end();
    return;
  }
  const order = orderResult.rows[0];
  console.log(`\nOrder ${order.order_number} — total ₦${Number(order.total_amount).toLocaleString()}\n`);

  const paymentsResult = await client.query(
    `SELECT id, amount, status, paystack_reference, recorded_at, last_checked_at, check_attempts
     FROM order_payments WHERE order_id = $1 ORDER BY recorded_at ASC`,
    [order.id]
  );

  for (const p of paymentsResult.rows) {
    console.log("──────────────────────────────────────────");
    console.log(`Recorded: ${p.recorded_at}   Amount: ₦${Number(p.amount).toLocaleString()}   Our status: ${p.status}`);
    console.log(`Reference: ${p.paystack_reference || "(none — manual entry, not a real Paystack payment)"}`);

    if (!p.paystack_reference) continue;

    try {
      const response = await axios.get(
        `https://api.paystack.co/transaction/verify/${p.paystack_reference}`,
        { headers: { Authorization: `Bearer ${PAYSTACK_SECRET_KEY}` } }
      );
      const t = response.data.data;
      const expectedKobo = Math.round(Number(p.amount) * 100);
      const amountMatches = t.amount === expectedKobo;

      console.log(`Paystack says: status="${t.status}"  gateway_response="${t.gateway_response}"`);
      console.log(`Paystack amount: ₦${(t.amount / 100).toLocaleString()}  |  We expected: ₦${(expectedKobo / 100).toLocaleString()}  |  Match: ${amountMatches ? "YES" : "NO — MISMATCH"}`);
      console.log(`Channel: ${t.channel}   Paid at: ${t.paid_at || "(never paid)"}`);
    } catch (err) {
      if (err.response) {
        console.log(`Paystack API error: ${err.response.status} — ${JSON.stringify(err.response.data)}`);
      } else {
        console.log(`Could not reach Paystack: ${err.message}`);
      }
    }
  }
  console.log("──────────────────────────────────────────\n");

  await client.end();
}

main().catch((err) => {
  console.error("Diagnostic failed:", err.message);
  process.exit(1);
});
