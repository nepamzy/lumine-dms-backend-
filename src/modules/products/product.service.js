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
  if (Number(batch.rows[0].quantity_on_hand) > 0) {
    throw new ApiError(400, "Only out-of-stock batches (0 quantity) can be deleted");
  }
  await db.query(`DELETE FROM product_batches WHERE id = $1`, [batchId]);
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
  return result.rows;
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
    `SELECT * FROM product_variants WHERE product_id = $1 ORDER BY size`,
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
};