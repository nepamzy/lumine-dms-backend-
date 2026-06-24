const db = require("../../config/db");
const ApiError = require("../../utils/ApiError");

async function listProducts({ activeOnly = true } = {}) {
  const result = await db.query(
    `SELECT p.*,
            COALESCE(SUM(b.quantity_on_hand), 0) AS total_stock,
            MIN(b.expiry_date) FILTER (WHERE b.quantity_on_hand > 0) AS nearest_expiry
     FROM products p
     LEFT JOIN product_batches b ON b.product_id = p.id
     ${activeOnly ? "WHERE p.is_active = true" : ""}
     GROUP BY p.id
     ORDER BY p.name ASC`
  );
  return result.rows;
}

async function getProductById(id) {
  const result = await db.query("SELECT * FROM products WHERE id = $1", [id]);
  if (result.rows.length === 0) throw new ApiError(404, "Product not found");

  const batches = await db.query(
    `SELECT * FROM product_batches WHERE product_id = $1 ORDER BY expiry_date ASC`,
    [id]
  );
  return { ...result.rows[0], batches: batches.rows };
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

module.exports = {
  listProducts,
  getProductById,
  createProduct,
  updateProduct,
  addBatch,
  getExpiringBatches,
  reserveStockFEFO,
};
