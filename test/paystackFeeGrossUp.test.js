const { test } = require("node:test");
const assert = require("node:assert/strict");

const { grossUpForPaystackFee } = require("../src/modules/payments/payment.service");

// Paystack NG fee schedule this math assumes: 1.5% + N100, N100 waived
// under N2,500, fee capped at N2,000. Re-derives the fee Paystack would
// deduct from a given charge, to check the gross-up actually nets the
// buyer's intended amount.
function paystackFeeFor(charge) {
  const flat = charge >= 2500 ? 100 : 0;
  return Math.min(charge * 0.015 + flat, 2000);
}

test("grosses up a mid-size amount so the net matches after Paystack's fee", () => {
  const net = 10000;
  const charge = grossUpForPaystackFee(net);
  const fee = paystackFeeFor(charge);
  assert.ok(charge - fee >= net, `expected net proceeds >= ${net}, got ${charge - fee}`);
  // Rounding should never overshoot by more than a naira or two.
  assert.ok(charge - fee - net < 1, `overshoot too large: ${charge - fee - net}`);
});

test("grosses up a small amount under the N2,500 flat-fee waiver threshold", () => {
  const net = 1000;
  const charge = grossUpForPaystackFee(net);
  assert.ok(charge < 2500, "charge should stay under the waiver threshold for a small net amount");
  const fee = paystackFeeFor(charge);
  assert.ok(charge - fee >= net);
});

test("grosses up an amount that crosses the N2,500 flat-fee waiver boundary", () => {
  const net = 2450; // charge will land just above 2500 once grossed up
  const charge = grossUpForPaystackFee(net);
  const fee = paystackFeeFor(charge);
  assert.ok(charge - fee >= net);
});

test("grosses up a large amount past the N2,000 fee cap", () => {
  const net = 500000;
  const charge = grossUpForPaystackFee(net);
  const fee = paystackFeeFor(charge);
  assert.equal(fee, 2000, "fee should be capped at N2,000 for a large charge");
  assert.ok(charge - fee >= net);
  assert.equal(charge, net + 2000, "at the cap, gross-up is a flat N2,000 addition");
});

test("never nets less than the requested amount across a spread of values", () => {
  for (const net of [50, 500, 1500, 2499, 2500, 2501, 5000, 25000, 100000, 126000, 200000, 1000000]) {
    const charge = grossUpForPaystackFee(net);
    const fee = paystackFeeFor(charge);
    assert.ok(charge - fee >= net, `net=${net} charge=${charge} fee=${fee} proceeds=${charge - fee}`);
  }
});
