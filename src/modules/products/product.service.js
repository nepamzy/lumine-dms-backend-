const db = require("../../config/db");
const ApiError = require("../../utils/ApiError");

async function listProducts({ activeOnly = true } = {}) {
  // Soft-deleted products never come back here, regardless of activeOnly —
  // that flag only toggles whether "marked out of stock" (is_active=false)
  // products are included, not deleted ones.
  const conditions = ["p.deleted_at IS NULL"];
  if (activeOnly) conditions.push("p.is_active = true");

  const result = await db.query(
    `SELECT p.*,
            COALESCE(SUM(b.quantity_on_hand), 0) AS total_stock,
            MIN(b.expiry_date) FILTER (WHERE b.quantity_on_hand > 0) AS nearest_expiry
     FROM products p
     LEFT JOIN product_batches b ON b.product_id = p.id
     WHERE ${conditions.join(" AND ")}
     GROUP BY p.id
     ORDER BY p.name ASC`
  );
  return result.rows;
}

async function getProductById(id) {
  // Not filtered by deleted_at on purpose — past orders/receipts still
  // need to resolve a product's name/sku even after it's been removed
  // from the live catalog.
  const result = await db.query("SELECT * FROM products WHERE id = $1", [id]);
  if (result.rows.length === 0) throw new ApiError(404, "Product not found");

  const batches = await db.query(
    `SELECT * FROM product_batches WHERE product_id = $1 ORDER BY expiry_date ASC`,
    [id]
  );
  return { ...result.rows[0], batches: batches.rows };
}

// Soft-deletes an entire product line ("remove a whole tab of product").
// Variants/batches stay in the DB (so historical orders keep resolving
// correctly) but the product itself disappears from every product list.
async function deleteProduct(id) {
  const result = await db.query(
    `UPDATE products SET deleted_at = now(), is_active = false
     WHERE id = $1 AND deleted_at IS NULL RETURNING id`,
    [id]
  );
  if (result.rows.length === 0) throw new ApiError(404, "Product not found or already removed");
  return result.rows[0];
}

// Edits the quantity_on_hand of a batch that was already entered — for
// correcting a mistyped figure, not for adding new stock (use addBatch
// for that, since new stock should always be its own traceable batch).
async function updateBatchQuantity(productId, batchId, quantity) {
  if (quantity === undefined || quantity === null || quantity < 0) {
    throw new ApiError(400, "quantity must be a number >= 0");
  }
  const result = await db.query(
    `UPDATE product_batches SET quantity_on_hand = $1
     WHERE id = $2 AND product_id = $3 RETURNING *`,
    [quantity, batchId, productId]
  );
  if (result.rows.length === 0) throw new ApiError(404, "Batch not found for this product");
  return result.rows[0];
}

// Removes a single out-of-stock batch entirely. Only allowed when its
// quantity is already 0 — batches still holding stock should be corrected
// via updateBatchQuantity instead, so nothing with live stock disappears
// silently.
async function deleteBatch(productId, batchId) {
  const batch = await db.query(
    `SELECT quantity_on_hand FROM product_batches WHERE id = $1 AND product_id = $2`,
    [batchId, productId]
  );
  if (batch.rows.length === 0) throw new ApiError(404, "Batch not found for this product");
  // Admin can force-delete a batch even with stock remaining — same
  // "admin's word is authoritative" pattern as manual payment authorization.
  // The frontend confirm dialog makes this explicit before it happens.
  try {
    await db.query(`DELETE FROM product_batches WHERE id = $1`, [batchId]);
  } catch (err) {
    if (err.code === "23503") {
      // FK violation — real orders reference this batch's history
      throw new ApiError(
        400,
        "This batch can't be deleted — it's referenced by real order history. Set its quantity to 0 instead to stop it being sold further."
      );
    }
    throw err;
  }
  return { id: batchId };
}

async function createProduct({ name, sku, category, unitPrice, imageUrl }) {
  if (!name || !sku || unitPrice === undefined) {
    throw new ApiError(400, "name, sku, and unitPrice are required");
  }
  if (unitPrice < 0) throw new ApiError(400, "unitPrice cannot be negative");

  const result = await db.query(
    `INSERT INTO products (name, sku, category, unit_price, image_url)
     VALUES ($1, $2, $3, $4, $5) RETURNING *`,
    [name, sku, category || null, unitPrice, imageUrl || null]
  );
  return result.rows[0];
}

async function updateProduct(id, updates) {
  const allowed = ["name", "category", "unit_price", "image_url", "is_active"];
  const fields = [];
  const values = [];
  let i = 1;

  for (const [key, value] of Object.entries(updates)) {
    const column = key.replace(/[A-Z]/g, (m) => "_" + m.toLowerCase());
    if (allowed.includes(column)) {
      fields.push(`${column} = $${i}`);
      values.push(value);
      i++;
    }
  }
  if (fields.length === 0) throw new ApiError(400, "No valid fields to update");

  fields.push(`updated_at = now()`);
  values.push(id);

  const result = await db.query(
    `UPDATE products SET ${fields.join(", ")} WHERE id = $${i} RETURNING *`,
    values
  );
  if (result.rows.length === 0) throw new ApiError(404, "Product not found");
  return result.rows[0];
}

// Adds new stock as a batch — never overwrites existing stock, since each
// batch must stay individually traceable for expiry/recall purposes.
async function addBatch(productId, { batchNumber, quantity, expiryDate }) {
  if (!batchNumber || !quantity || !expiryDate) {
    throw new ApiError(400, "batchNumber, quantity, and expiryDate are required");
  }
  if (quantity <= 0) throw new ApiError(400, "quantity must be greater than 0");

  const product = await db.query("SELECT id FROM products WHERE id = $1", [productId]);
  if (product.rows.length === 0) throw new ApiError(404, "Product not found");

  const result = await db.query(
    `INSERT INTO product_batches (product_id, batch_number, quantity_on_hand, expiry_date)
     VALUES ($1, $2, $3, $4) RETURNING *`,
    [productId, batchNumber, quantity, expiryDate]
  );
  return result.rows[0];
}

// Automated daily batch creation — meant to be called once every 24hrs by
// an external scheduler (Render Cron Job, or any HTTP-hitting cron
// service) hitting POST /products/run-daily-batch. Idempotent: calling it
// again the same calendar day is a safe no-op.
//
// For each active product:
//   1. Any of ITS OWN previous auto-generated batches still holding stock
//      get zeroed out — that's the "unsold" leftover being wiped. Batches
//      that already had stock consumed by real orders keep those
//      order_items rows untouched (we only ever zero quantity_on_hand,
//      never delete/alter the batch or its order history).
//   2. A fresh batch of 500 packs is created.
//
// PACK -> BOTTLE conversion: a batch belongs to a whole PRODUCT (flavor),
// not one size, and pack sizes differ by size (1L = 12 bottles/pack, 50cl
// & 35cl = 24 bottles/pack). Since a single batch has no size of its own,
// "500 packs" is converted using the 24-bottle/pack convention (the size
// most of the catalog uses) = 12,000 bottles. Flag this back to the team —
// if a different basis was intended, this line is the one to change.
const AUTO_BATCH_PACKS_PER_DAY = 500;
const AUTO_BATCH_BOTTLES_PER_PACK = 24;
const AUTO_BATCH_SHELF_LIFE_DAYS = 60; // assumption — adjust if actual shelf life differs

async function runDailyBatchCreation() {
  const today = new Date();
  const todayStr = today.toISOString().slice(0, 10); // YYYY-MM-DD, for the UNIQUE run_date check

  const existingRun = await db.query(`SELECT sequence_no FROM auto_batch_runs WHERE run_date = $1`, [todayStr]);
  if (existingRun.rows.length > 0) {
    return { alreadyRanToday: true, sequenceNo: existingRun.rows[0].sequence_no };
  }

  const client = await db.pool.connect();
  try {
    await client.query("BEGIN");

    const seqResult = await client.query(
      `INSERT INTO auto_batch_runs (run_date, sequence_no)
       VALUES ($1, COALESCE((SELECT MAX(sequence_no) FROM auto_batch_runs), 0) + 1)
       ON CONFLICT (run_date) DO NOTHING
       RETURNING sequence_no`,
      [todayStr]
    );
    if (seqResult.rows.length === 0) {
      // Another concurrent call won the race and already inserted today's run
      await client.query("ROLLBACK");
      const raceCheck = await db.query(`SELECT sequence_no FROM auto_batch_runs WHERE run_date = $1`, [todayStr]);
      return { alreadyRanToday: true, sequenceNo: raceCheck.rows[0]?.sequence_no };
    }
    const sequenceNo = seqResult.rows[0].sequence_no;

    // Format: no.(4 digits) + day-of-month(no leading zero) + last-2-digits-of-year
    const batchNumber = `${String(sequenceNo).padStart(4, "0")}${today.getDate()}${String(today.getFullYear() % 100).padStart(2, "0")}`;

    const bottlesPerBatch = AUTO_BATCH_PACKS_PER_DAY * AUTO_BATCH_BOTTLES_PER_PACK;
    const expiryDate = new Date(today.getTime() + AUTO_BATCH_SHELF_LIFE_DAYS * 24 * 60 * 60 * 1000)
      .toISOString()
      .slice(0, 10);

    const products = await client.query(
      `SELECT id FROM products WHERE is_active = true AND deleted_at IS NULL`
    );

    const created = [];
    for (const product of products.rows) {
      // Wipe unsold stock from this product's previous auto-generated batches
      await client.query(
        `UPDATE product_batches SET quantity_on_hand = 0
         WHERE product_id = $1 AND is_auto_generated = true AND quantity_on_hand > 0`,
        [product.id]
      );

      const batchResult = await client.query(
        `INSERT INTO product_batches (product_id, batch_number, quantity_on_hand, expiry_date, is_auto_generated)
         VALUES ($1, $2, $3, $4, true)
         ON CONFLICT (product_id, batch_number) DO NOTHING
         RETURNING *`,
        [product.id, batchNumber, bottlesPerBatch, expiryDate]
      );
      if (batchResult.rows.length > 0) created.push(batchResult.rows[0]);
    }

    await client.query("COMMIT");
    return { alreadyRanToday: false, sequenceNo, batchNumber, productsUpdated: created.length, batches: created };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}
// Returns batches expiring within `days`, soonest first — powers the
// admin "expiring soon" dashboard alert.
async function getExpiringBatches(days = 30) {
  const result = await db.query(
    `SELECT b.*, p.name AS product_name, p.sku
     FROM product_batches b
     JOIN products p ON p.id = b.product_id
     WHERE b.expiry_date <= (CURRENT_DATE + $1::int)
       AND b.quantity_on_hand > 0
     ORDER BY b.expiry_date ASC`,
    [days]
  );
  return result.rows.map((row) => {
    const daysRemaining = Math.ceil((new Date(row.expiry_date).getTime() - Date.now()) / (1000 * 60 * 60 * 24));
    const band = daysRemaining <= 7 ? "red" : daysRemaining <= 14 ? "yellow" : "green";
    return { ...row, daysRemaining, band };
  });
}

// FEFO stock reservation: pulls from the batch expiring soonest first.
// Used internally by the order service when an order is paid.
async function reserveStockFEFO(client, productId, quantityNeeded) {
  const batches = await client.query(
    `SELECT * FROM product_batches
     WHERE product_id = $1 AND quantity_on_hand > 0
     ORDER BY expiry_date ASC
     FOR UPDATE`,
    [productId]
  );

  let remaining = quantityNeeded;
  const allocations = [];

  for (const batch of batches.rows) {
    if (remaining <= 0) break;
    const take = Math.min(batch.quantity_on_hand, remaining);
    await client.query(
      `UPDATE product_batches SET quantity_on_hand = quantity_on_hand - $1 WHERE id = $2`,
      [take, batch.id]
    );
    allocations.push({ batchId: batch.id, quantity: take });
    remaining -= take;
  }

  if (remaining > 0) {
    throw new ApiError(409, "Insufficient stock to fulfill this order");
  }

  return allocations;
}

async function getVariantsWithTiers(productId) {
  const variants = await db.query(
    `SELECT * FROM product_variants WHERE product_id = $1
     ORDER BY CASE size WHEN '1L' THEN 1 WHEN '50cl' THEN 2 WHEN '35cl' THEN 3 ELSE 4 END`,
    [productId]
  );
  for (const variant of variants.rows) {
    const tiers = await db.query(
      `SELECT min_qty, max_qty, price FROM price_tiers WHERE variant_id = $1 ORDER BY min_qty ASC`,
      [variant.id]
    );
    // priceTiers = distributor-only bulk discount tiers (by pack count).
    // packPrice = the flat "Normal Price" everyone else always pays.
    variant.priceTiers = tiers.rows;
    variant.packPrice = variant.pack_price;
  }
  return variants.rows;
}

async function createVariant(productId, { size, sku, imageUrl, tiers }) {
  if (!size || !tiers || !Array.isArray(tiers) || tiers.length === 0) {
    throw new ApiError(400, "size and at least one price tier are required");
  }

  const product = await db.query("SELECT id FROM products WHERE id = $1", [productId]);
  if (product.rows.length === 0) throw new ApiError(404, "Product not found");

  const client = await db.pool.connect();
  try {
    await client.query("BEGIN");
    const variantResult = await client.query(
      `INSERT INTO product_variants (product_id, size, sku, image_url) VALUES ($1, $2, $3, $4) RETURNING *`,
      [productId, size, sku || null, imageUrl || null]
    );
    const variant = variantResult.rows[0];

    for (const tier of tiers) {
      if (tier.minQty === undefined || tier.price === undefined) {
        throw new ApiError(400, "Each tier needs minQty and price");
      }
      await client.query(
        `INSERT INTO price_tiers (variant_id, min_qty, max_qty, price) VALUES ($1, $2, $3, $4)`,
        [variant.id, tier.minQty, tier.maxQty ?? null, tier.price]
      );
    }
    await client.query("COMMIT");
    return variant;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

// Given a variant and desired quantity, finds the matching price tier
function resolveTierPrice(tiers, quantity) {
  for (const tier of tiers) {
    if (quantity >= tier.min_qty && (tier.max_qty === null || quantity <= tier.max_qty)) {
      return tier.price;
    }
  }
  return null;
}

module.exports = {
  listProducts,
  getProductById,
  createProduct,
  updateProduct,
  deleteProduct,
  addBatch,
  updateBatchQuantity,
  deleteBatch,
  getExpiringBatches,
  reserveStockFEFO,
  getVariantsWithTiers,
  createVariant,
  resolveTierPrice,
  runDailyBatchCreation,
};