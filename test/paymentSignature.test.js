const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");

const TEST_SECRET = "test_secret_key_for_paystack_webhook";
let originalSecret;

before(() => {
  originalSecret = process.env.PAYSTACK_SECRET_KEY;
  process.env.PAYSTACK_SECRET_KEY = TEST_SECRET;
});

after(() => {
  process.env.PAYSTACK_SECRET_KEY = originalSecret;
});

// Loaded after PAYSTACK_SECRET_KEY is set, and read fresh per-test via
// process.env inside the function itself (see payment.service.js), so
// requiring it once up top is safe.
const { isValidWebhookSignature } = require("../src/modules/payments/payment.service");

function signBody(bodyBuffer, secret = TEST_SECRET) {
  return crypto.createHmac("sha512", secret).update(bodyBuffer).digest("hex");
}

test("accepts a signature genuinely computed from the raw body and secret", () => {
  const body = Buffer.from(JSON.stringify({ event: "charge.success", data: { reference: "ref_123" } }));
  const signature = signBody(body);
  assert.equal(isValidWebhookSignature(body, signature), true);
});

test("rejects a signature computed with the wrong secret", () => {
  const body = Buffer.from(JSON.stringify({ event: "charge.success", data: { reference: "ref_123" } }));
  const signature = signBody(body, "an_attackers_guessed_secret");
  assert.equal(isValidWebhookSignature(body, signature), false);
});

test("rejects when the body has been tampered with after signing", () => {
  const originalBody = Buffer.from(JSON.stringify({ event: "charge.success", data: { reference: "ref_123", amount: 100 } }));
  const signature = signBody(originalBody);
  const tamperedBody = Buffer.from(JSON.stringify({ event: "charge.success", data: { reference: "ref_123", amount: 999999 } }));
  assert.equal(isValidWebhookSignature(tamperedBody, signature), false);
});

test("rejects a missing signature header", () => {
  const body = Buffer.from(JSON.stringify({ event: "charge.success" }));
  assert.equal(isValidWebhookSignature(body, undefined), false);
});

test("rejects when PAYSTACK_SECRET_KEY isn't configured", () => {
  const body = Buffer.from(JSON.stringify({ event: "charge.success" }));
  const signature = signBody(body);
  const saved = process.env.PAYSTACK_SECRET_KEY;
  delete process.env.PAYSTACK_SECRET_KEY;
  try {
    assert.equal(isValidWebhookSignature(body, signature), false);
  } finally {
    process.env.PAYSTACK_SECRET_KEY = saved;
  }
});
