const { test } = require("node:test");
const assert = require("node:assert/strict");

const { reserveStockFEFO } = require("../src/modules/products/product.service");

// A minimal fake of the pg client `reserveStockFEFO` receives — it only
// ever calls client.query(sql, params), so that's all we need to fake.
// Batches are returned pre-sorted by expiry_date ASC, exactly as the real
// "ORDER BY expiry_date ASC" SQL would give it.
function makeFakeClient(batches) {
  const updateCalls = [];
  return {
    updateCalls,
    async query(sql, params) {
      if (sql.includes("SELECT")) {
        return { rows: batches };
      }
      if (sql.includes("UPDATE")) {
        const [take, batchId] = params;
        updateCalls.push({ batchId, take });
        return { rows: [] };
      }
      throw new Error("Unexpected query in fake client: " + sql);
    },
  };
}

test("takes entirely from the single oldest batch when it has enough stock", async () => {
  const client = makeFakeClient([
    { id: "batch-old", quantity_on_hand: 50, expiry_date: "2026-01-01" },
    { id: "batch-new", quantity_on_hand: 100, expiry_date: "2026-06-01" },
  ]);

  const allocations = await reserveStockFEFO(client, "product-1", 30);

  assert.deepEqual(allocations, [{ batchId: "batch-old", quantity: 30 }]);
  assert.deepEqual(client.updateCalls, [{ batchId: "batch-old", take: 30 }]);
});

test("spills over into the next-oldest batch(es) in expiry order when one isn't enough", async () => {
  const client = makeFakeClient([
    { id: "batch-oldest", quantity_on_hand: 10, expiry_date: "2026-01-01" },
    { id: "batch-middle", quantity_on_hand: 10, expiry_date: "2026-03-01" },
    { id: "batch-newest", quantity_on_hand: 100, expiry_date: "2026-06-01" },
  ]);

  const allocations = await reserveStockFEFO(client, "product-1", 25);

  assert.deepEqual(allocations, [
    { batchId: "batch-oldest", quantity: 10 },
    { batchId: "batch-middle", quantity: 10 },
    { batchId: "batch-newest", quantity: 5 },
  ]);
  assert.equal(client.updateCalls.length, 3);
});

test("throws 409 Insufficient stock when total across all batches falls short, without over-decrementing", async () => {
  const client = makeFakeClient([
    { id: "batch-a", quantity_on_hand: 5, expiry_date: "2026-01-01" },
    { id: "batch-b", quantity_on_hand: 5, expiry_date: "2026-02-01" },
  ]);

  await assert.rejects(
    () => reserveStockFEFO(client, "product-1", 100),
    (err) => {
      assert.equal(err.statusCode, 409);
      return true;
    }
  );

  // Both batches were still fully allocated before the shortfall was detected
  // (matches current behavior: partial decrements happen inside the same DB
  // transaction the caller wraps this in, so a thrown error rolls them back).
  assert.deepEqual(client.updateCalls, [
    { batchId: "batch-a", take: 5 },
    { batchId: "batch-b", take: 5 },
  ]);
});

test("requesting exactly zero needs no allocation at all", async () => {
  const client = makeFakeClient([{ id: "batch-a", quantity_on_hand: 10, expiry_date: "2026-01-01" }]);

  const allocations = await reserveStockFEFO(client, "product-1", 0);

  assert.deepEqual(allocations, []);
  assert.deepEqual(client.updateCalls, []);
});
