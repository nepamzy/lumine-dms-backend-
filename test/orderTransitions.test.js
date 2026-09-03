const { test } = require("node:test");
const assert = require("node:assert/strict");

const { VALID_TRANSITIONS } = require("../src/modules/orders/order.service");

const ALL_STATUSES = ["pending", "paid", "processing", "out_for_delivery", "delivered", "cancelled"];

test("every real status has an explicit (possibly empty) transition list", () => {
  for (const status of ALL_STATUSES) {
    assert.ok(
      Object.prototype.hasOwnProperty.call(VALID_TRANSITIONS, status),
      `VALID_TRANSITIONS is missing an entry for "${status}"`
    );
  }
});

test("delivered and cancelled are terminal — nothing can follow them", () => {
  assert.deepEqual(VALID_TRANSITIONS.delivered, []);
  assert.deepEqual(VALID_TRANSITIONS.cancelled, []);
});

test("the happy path moves strictly forward one stage at a time", () => {
  assert.ok(VALID_TRANSITIONS.pending.includes("paid"));
  assert.ok(VALID_TRANSITIONS.paid.includes("processing"));
  assert.ok(VALID_TRANSITIONS.processing.includes("out_for_delivery"));
  assert.ok(VALID_TRANSITIONS.out_for_delivery.includes("delivered"));
});

test("an order can only be cancelled before it's out for delivery", () => {
  assert.ok(VALID_TRANSITIONS.pending.includes("cancelled"));
  assert.ok(VALID_TRANSITIONS.paid.includes("cancelled"));
  assert.ok(VALID_TRANSITIONS.processing.includes("cancelled"));
  assert.ok(!VALID_TRANSITIONS.out_for_delivery.includes("cancelled"));
});

test("no status can be skipped — e.g. pending cannot jump straight to processing or delivered", () => {
  assert.ok(!VALID_TRANSITIONS.pending.includes("processing"));
  assert.ok(!VALID_TRANSITIONS.pending.includes("out_for_delivery"));
  assert.ok(!VALID_TRANSITIONS.pending.includes("delivered"));
});

test("no status transitions to itself", () => {
  for (const status of ALL_STATUSES) {
    assert.ok(
      !(VALID_TRANSITIONS[status] || []).includes(status),
      `"${status}" should not be able to transition to itself`
    );
  }
});
