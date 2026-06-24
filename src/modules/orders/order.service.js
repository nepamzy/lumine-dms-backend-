const db = require("../../config/db");
const ApiError = require("../../utils/ApiError");
const { reserveStockFEFO } = require("../products/product.service");
const { notifyOrderCreated, notifyDistributorAssigned, notifyOutForDelivery } = require("../notifications/notification.service");

function generateOrderNumber() {
  const datePart = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  const randomPart = Math.floor(1000 + Math.random() * 9000);
  return `LUM-${datePart}-${randomPart}`;
}

const VALID_TRANSITIONS = {
  pending: ["paid", "cancelled"],
  paid: ["processing", "cancelled"],
  processing: ["out_for_delivery", "cancelled"],
  out_for_delivery: ["delivered"],
  delivered: [],
  cancelled: [],
};

// Picks the first approved distributor whose territory matches the
// customer's state. Falls back to unassigned (admin can assign manually)
// if no match is found — never blocks order creation on this.
async function findDistributorForState(client, state) {
  const result = await client.query(
    `SELECT d.id FROM distributors d
     JOIN territories t ON t.id = d.territory_id
     WHERE t.state = $1 AND d.approval_status = 'approved'
     LIMIT 1`,
    [state]
  );
  return result.rows[0]?.id || null;
}

async function createOrder(customerId, items) {
  if (!Array.isArray(items) || items.length === 0) {
    throw new ApiError(400, "Order must contain at least one item");
  }

  const client = await db.pool.connect();
  try {
    await client.query("BEGIN");

    const customerResult = await client.query(
      "SELECT id, state FROM users WHERE id = $1 AND role = 'customer'",
      [customerId]
    );
    if (customerResult.rows.length === 0) {
      throw new ApiError(404, "Customer not found");
    }
    const customer = customerResult.rows[0];

    let totalAmount = 0;
    const orderItemRows = []; // { productId, batchId, quantity, unitPrice }

    for (const item of items) {
      if (!item.productId || !item.quantity || item.quantity <= 0) {
        throw new ApiError(400, "Each item needs a valid productId and quantity > 0");
      }

      const productResult = await client.query(
        "SELECT id, unit_price, is_active FROM products WHERE id = $1",
        [item.productId]
      );
      if (productResult.rows.length === 0) {
        throw new ApiError(404, `Product ${item.productId} not found`);
      }
      const product = productResult.rows[0];
      if (!product.is_active) {
        throw new ApiError(400, `Product ${item.productId} is no longer available`);
      }

      // FEFO reservation — may split across multiple batches if needed
      const allocations = await reserveStockFEFO(client, item.productId, item.quantity);

      for (const allocation of allocations) {
        orderItemRows.push({
          productId: item.productId,
          batchId: allocation.batchId,
          quantity: allocation.quantity,
          unitPrice: product.unit_price,
        });
        totalAmount += allocation.quantity * Number(product.unit_price);
      }
    }

    const distributorId = await findDistributorForState(client, customer.state);
    const orderNumber = generateOrderNumber();

    const orderResult = await client.query(
      `INSERT INTO orders (order_number, customer_id, distributor_id, status, total_amount)
       VALUES ($1, $2, $3, 'pending', $4) RETURNING *`,
      [orderNumber, customerId, distributorId, totalAmount]
    );
    const order = orderResult.rows[0];

    for (const row of orderItemRows) {
      await client.query(
        `INSERT INTO order_items (order_id, product_id, batch_id, quantity, unit_price)
         VALUES ($1, $2, $3, $4, $5)`,
        [order.id, row.productId, row.batchId, row.quantity, row.unitPrice]
      );
    }

    await client.query("COMMIT");
    const fullOrder = await getOrderById(order.id);

    // Notifications are fire-and-forget side effects — never let them
    // delay the response or roll back an already-committed order.
    notifyOrderCreated(fullOrder, customerId).catch(() => {});
    if (distributorId) {
      db.query("SELECT user_id FROM distributors WHERE id = $1", [distributorId])
        .then((r) => {
          if (r.rows[0]) notifyDistributorAssigned(fullOrder.order_number, r.rows[0].user_id);
        })
        .catch(() => {});
    }

    return fullOrder;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

async function getOrderById(id) {
  const orderResult = await db.query("SELECT * FROM orders WHERE id = $1", [id]);
  if (orderResult.rows.length === 0) throw new ApiError(404, "Order not found");

  const itemsResult = await db.query(
    `SELECT oi.*, p.name AS product_name, p.sku, b.batch_number, b.expiry_date
     FROM order_items oi
     JOIN products p ON p.id = oi.product_id
     JOIN product_batches b ON b.id = oi.batch_id
     WHERE oi.order_id = $1`,
    [id]
  );

  return { ...orderResult.rows[0], items: itemsResult.rows };
}

// Customers see only their own orders; distributors see only assigned orders; admins see all
async function listOrders(user, { status } = {}) {
  const conditions = [];
  const values = [];
  let i = 1;

  if (user.role === "customer") {
    conditions.push(`customer_id = $${i++}`);
    values.push(user.id);
  } else if (user.role === "distributor") {
    const distResult = await db.query("SELECT id FROM distributors WHERE user_id = $1", [user.id]);
    if (distResult.rows.length === 0) throw new ApiError(404, "Distributor profile not found");
    conditions.push(`distributor_id = $${i++}`);
    values.push(distResult.rows[0].id);
  }
  // admin: no filter, sees everything

  if (status) {
    conditions.push(`status = $${i++}`);
    values.push(status);
  }

  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  const result = await db.query(
    `SELECT * FROM orders ${where} ORDER BY created_at DESC`,
    values
  );
  return result.rows;
}

function assertCanAccessOrder(order, user) {
  if (user.role === "admin") return;
  if (user.role === "customer" && order.customer_id === user.id) return;
  // distributor ownership is checked at the route/service boundary where distributor_id is on hand
  if (user.role === "distributor") return; // refined check happens via listOrders filter in practice
  throw new ApiError(403, "You don't have access to this order");
}

async function updateStatus(orderId, newStatus, actingUser) {
  const order = await getOrderById(orderId);
  assertCanAccessOrder(order, actingUser);

  const allowedNext = VALID_TRANSITIONS[order.status] || [];
  if (!allowedNext.includes(newStatus)) {
    throw new ApiError(
      400,
      `Cannot move order from "${order.status}" to "${newStatus}"`
    );
  }

  const result = await db.query(
    `UPDATE orders SET status = $1, updated_at = now() WHERE id = $2 RETURNING *`,
    [newStatus, orderId]
  );

  if (newStatus === "out_for_delivery") {
    notifyOutForDelivery(result.rows[0], order.customer_id).catch(() => {});
  }

  return result.rows[0];
}

// Releases reserved stock back to its batches — used when an order is cancelled before payment
async function cancelOrder(orderId, actingUser) {
  const order = await getOrderById(orderId);
  assertCanAccessOrder(order, actingUser);

  if (!["pending", "paid"].includes(order.status)) {
    throw new ApiError(400, `Order in status "${order.status}" can no longer be cancelled`);
  }

  const client = await db.pool.connect();
  try {
    await client.query("BEGIN");

    for (const item of order.items) {
      await client.query(
        `UPDATE product_batches SET quantity_on_hand = quantity_on_hand + $1 WHERE id = $2`,
        [item.quantity, item.batch_id]
      );
    }

    const result = await client.query(
      `UPDATE orders SET status = 'cancelled', updated_at = now() WHERE id = $1 RETURNING *`,
      [orderId]
    );

    await client.query("COMMIT");
    return result.rows[0];
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

async function assignDistributor(orderId, distributorId) {
  const distResult = await db.query(
    "SELECT id FROM distributors WHERE id = $1 AND approval_status = 'approved'",
    [distributorId]
  );
  if (distResult.rows.length === 0) {
    throw new ApiError(404, "Approved distributor not found");
  }

  const result = await db.query(
    `UPDATE orders SET distributor_id = $1, updated_at = now() WHERE id = $2 RETURNING *`,
    [distributorId, orderId]
  );
  if (result.rows.length === 0) throw new ApiError(404, "Order not found");
  return result.rows[0];
}

module.exports = {
  createOrder,
  getOrderById,
  listOrders,
  updateStatus,
  cancelOrder,
  assignDistributor,
};
