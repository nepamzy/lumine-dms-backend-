const db = require("../../config/db");
const ApiError = require("../../utils/ApiError");
const { reserveStockFEFO } = require("../products/product.service");
const { notifyOrderCreated, notifyDistributorAssigned, notifyOutForDelivery } = require("../notifications/notification.service");

function generateOrderNumber() {
  const datePart = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  const randomPart = Math.floor(1000 + Math.random() * 9000);
  return `LUM-${datePart}-${randomPart}`;
}

const PRODUCTION_DELAY_HOURS = 48;
const DISTRIBUTOR_MIN_PAYMENT_PERCENT = 70; // per-payment floor for distributor orders
const DISTRIBUTOR_NEXT_ORDER_MIN_PERCENT = 85; // must reach this on current order before placing another
const CUSTOMER_NEXT_ORDER_MIN_PERCENT = 100; // must be fully paid before placing another
const HALF_PACK_UNITS = { "35cl": 12, "50cl": 12, "1L": 6 }; // must match frontend src/utils/packSizes.js
const EXPIRY_WINDOW_DAYS = 50; // set on the order the moment it's confirmed "on transport"
const EXPIRY_RED_DAYS = 35; // <= this many days left = red (close to expiring)
const EXPIRY_YELLOW_DAYS = 40; // <= this many days left (and > red) = yellow (worth watching)

const VALID_TRANSITIONS = {
  pending: ["paid", "cancelled"],
  paid: ["processing", "cancelled"],
  processing: ["out_for_delivery", "cancelled"],
  out_for_delivery: ["delivered"],
  delivered: [],
  cancelled: [],
};

// Picks the first approved SALES REP (never a true distributor — customers
// are never attached to distributors) whose territory matches the
// customer's state. Falls back to unassigned (admin can assign manually)
// if no match is found — never blocks order creation on this.
async function findDistributorForState(client, state) {
  const result = await client.query(
    `SELECT d.id FROM distributors d
     JOIN territories t ON t.id = d.territory_id
     WHERE t.state = $1 AND d.approval_status = 'approved' AND d.distributor_type = 'sales_rep'
     LIMIT 1`,
    [state]
  );
  return result.rows[0]?.id || null;
}

// A buyer can be a real customer, or a "true" distributor buying for
// themselves (never a sales rep — sales reps place orders on a customer's
// behalf but never own one). Returns { id, state, kind: 'customer'|'distributor' }.
async function resolveBuyer(client, buyerId) {
  const result = await client.query(
    `SELECT u.id, u.state, u.role, d.distributor_type
     FROM users u
     LEFT JOIN distributors d ON d.user_id = u.id
     WHERE u.id = $1`,
    [buyerId]
  );
  if (result.rows.length === 0) throw new ApiError(404, "Buyer not found");
  const row = result.rows[0];

  if (row.role === "customer") return { id: row.id, state: row.state, kind: "customer" };
  if (row.role === "distributor" && row.distributor_type === "distributor") {
    return { id: row.id, state: row.state, kind: "distributor" };
  }
  throw new ApiError(403, "Only customers and distributors can place their own orders");
}

// Blocks placing a new order until the buyer's existing orders clear the
// required payment threshold — 100% for customers, 85% for distributors.
// Sales reps never buy, so they're never subject to this.
async function assertCanPlaceOrder(client, buyerId, kind) {
  const threshold = kind === "distributor" ? DISTRIBUTOR_NEXT_ORDER_MIN_PERCENT : CUSTOMER_NEXT_ORDER_MIN_PERCENT;

  const result = await client.query(
    `SELECT o.id, o.order_number, o.total_amount,
            COALESCE((SELECT SUM(amount) FROM order_payments WHERE order_id = o.id), 0) AS paid
     FROM orders o
     WHERE o.customer_id = $1 AND o.status != 'cancelled'`,
    [buyerId]
  );

  for (const row of result.rows) {
    const percent = Number(row.total_amount) > 0 ? (Number(row.paid) / Number(row.total_amount)) * 100 : 100;
    if (percent < threshold) {
      throw new ApiError(
        400,
        `You have an unpaid order (${row.order_number}) at ${percent.toFixed(0)}% paid. ` +
          `Reach at least ${threshold}% before placing a new order.`
      );
    }
  }
}

async function createOrder(buyerId, items, { placedByUserId } = {}) {
  if (!Array.isArray(items) || items.length === 0) {
    throw new ApiError(400, "Order must contain at least one item");
  }

  const client = await db.pool.connect();
  try {
    await client.query("BEGIN");

    const buyer = await resolveBuyer(client, buyerId);

    // If a sales rep is placing this order on the customer's behalf,
    // confirm they're actually that customer's attached sales rep first.
    if (placedByUserId && placedByUserId !== buyerId) {
      if (buyer.kind !== "customer") {
        throw new ApiError(400, "Orders can only be placed on behalf of a customer");
      }
      const salesRepCheck = await client.query(
        `SELECT 1 FROM customer_profiles cp
         JOIN distributors d ON d.id = cp.assigned_distributor_id
         WHERE cp.user_id = $1 AND d.user_id = $2 AND d.distributor_type = 'sales_rep'`,
        [buyerId, placedByUserId]
      );
      if (salesRepCheck.rows.length === 0) {
        throw new ApiError(403, "You can only place orders for customers assigned to you");
      }
    }

    await assertCanPlaceOrder(client, buyer.id, buyer.kind);

    const customer = buyer; // kept as `customer` below to minimize diff noise

    let totalAmount = 0;
    const orderItemRows = []; // { productId, batchId, quantity, unitPrice }

for (const item of items) {
      if (!item.variantId || !item.quantity || item.quantity <= 0) {
        throw new ApiError(400, "Each item needs a valid variantId and quantity > 0");
      }

      const variantResult = await client.query(
        `SELECT v.id AS variant_id, v.product_id, v.size, p.is_active
         FROM product_variants v
         JOIN products p ON p.id = v.product_id
         WHERE v.id = $1`,
        [item.variantId]
      );
      if (variantResult.rows.length === 0) {
        throw new ApiError(404, `Variant ${item.variantId} not found`);
      }
      const variant = variantResult.rows[0];
      if (!variant.is_active) {
        throw new ApiError(400, `This product is no longer available`);
      }

      // Orders are placed in half-pack increments only — never single
      // bottles. 50cl/35cl come 24 to a pack (half = 12); 1L comes 12 to a
      // pack (half = 6).
      const halfPackUnit = HALF_PACK_UNITS[variant.size] || 1;
      if (item.quantity % halfPackUnit !== 0) {
        throw new ApiError(
          400,
          `${variant.size} must be ordered in half-pack increments of ${halfPackUnit} bottles`
        );
      }

      // Resolve the correct tiered price for the requested quantity
      // Sales reps place orders on a customer's behalf but never handle
      // payment or pricing incentives themselves — when placedByUserId is
      // set (a sales rep placed this), always use the base/first-tier
      // price, matching exactly what they saw while building the order.
      // Otherwise resolve the normal quantity-based discount tier.
      const tierResult = placedByUserId
        ? await client.query(
            `SELECT price FROM price_tiers WHERE variant_id = $1 ORDER BY min_qty ASC LIMIT 1`,
            [item.variantId]
          )
        : await client.query(
            `SELECT price FROM price_tiers
             WHERE variant_id = $1 AND min_qty <= $2 AND (max_qty IS NULL OR max_qty >= $2)
             ORDER BY min_qty DESC LIMIT 1`,
            [item.variantId, item.quantity]
          );
      if (tierResult.rows.length === 0) {
        throw new ApiError(400, `No price tier found for this quantity`);
      }
      const unitPrice = Number(tierResult.rows[0].price);

      // FEFO reservation ΓÇö may split across multiple batches if needed
      const allocations = await reserveStockFEFO(client, variant.product_id, item.quantity);

      for (const allocation of allocations) {
        orderItemRows.push({
          productId: variant.product_id,
          variantId: item.variantId,
          batchId: allocation.batchId,
          quantity: allocation.quantity,
          unitPrice,
        });
        totalAmount += allocation.quantity * unitPrice;
      }
    }

    // A distributor's own order isn't delivered by a sales rep — only
    // customer orders get a sales rep assigned as the deliverer.
    const distributorId = customer.kind === "customer" ? await findDistributorForState(client, customer.state) : null;
    const orderNumber = generateOrderNumber();

    const orderResult = await client.query(
      `INSERT INTO orders (order_number, customer_id, distributor_id, status, total_amount, placed_by_user_id)
       VALUES ($1, $2, $3, 'pending', $4, $5) RETURNING *`,
      [orderNumber, buyer.id, distributorId, totalAmount, placedByUserId || buyer.id]
    );
    const order = orderResult.rows[0];

   for (const row of orderItemRows) {
      await client.query(
        `INSERT INTO order_items (order_id, product_id, variant_id, batch_id, quantity, unit_price)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [order.id, row.productId, row.variantId, row.batchId, row.quantity, row.unitPrice]
      );
    }
    await client.query("COMMIT");
    const fullOrder = await getOrderById(order.id);

    // Notifications are fire-and-forget side effects — never let them
    // delay the response or roll back an already-committed order.
    notifyOrderCreated(fullOrder, buyer.id).catch(() => {});
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

async function getPaymentSummary(orderId, totalAmount) {
  const result = await db.query(
    `SELECT id, amount, status, recorded_by, note, recorded_at, paystack_reference,
            (SELECT full_name FROM users WHERE id = order_payments.recorded_by) AS recorded_by_name
     FROM order_payments WHERE order_id = $1 ORDER BY recorded_at ASC`,
    [orderId]
  );
  // Only Paystack-confirmed payments count toward the total — a 'pending'
  // row (checkout started but not yet confirmed) or 'failed' one never
  // counts, no matter what amount was entered.
  const totalPaid = result.rows
    .filter((p) => p.status === "successful")
    .reduce((sum, p) => sum + Number(p.amount), 0);
  const percent = Number(totalAmount) > 0 ? (totalPaid / Number(totalAmount)) * 100 : 0;
  return { totalPaid, percent, payments: result.rows };
}

// Shared validation for any payment attempt — used both by the (legacy)
// manual logPayment and the real Paystack initialize flow. Throws if the
// amount isn't allowed; returns nothing if it's fine.
function validatePaymentAmount(order, amount) {
  if (!(amount > 0)) throw new ApiError(400, "Payment amount must be greater than zero");
  if (order.payment.totalPaid >= Number(order.total_amount)) {
    throw new ApiError(400, "This order is already fully paid");
  }
  if (order.buyerKind === "distributor") {
    const wouldBeTotal = order.payment.totalPaid + Number(amount);
    const wouldCompleteOrder = wouldBeTotal >= Number(order.total_amount);
    const minPayment = (DISTRIBUTOR_MIN_PAYMENT_PERCENT / 100) * Number(order.total_amount);
    if (Number(amount) < minPayment && !wouldCompleteOrder) {
      throw new ApiError(
        400,
        `Distributor payments must be at least ${DISTRIBUTOR_MIN_PAYMENT_PERCENT}% of the order total (₦${minPayment.toLocaleString()}) unless it completes the order.`
      );
    }
  }
}

// Placed and in-production are derived, never stored: placed = the order
// exists; production = 48 hours have passed since creation, regardless of
// payment status. Transport and received are manual, stored ticks.
function computeStage(order, buyerKind) {
  const hoursSincePlaced = (Date.now() - new Date(order.created_at).getTime()) / (1000 * 60 * 60);
  const production = hoursSincePlaced >= PRODUCTION_DELAY_HOURS;
  const transport = !!order.transport_confirmed_at;

  const received =
    buyerKind === "distributor"
      ? {
          admin: !!order.received_confirmed_admin_at,
          buyer: !!order.received_confirmed_buyer_at,
          allDone: !!order.received_confirmed_admin_at && !!order.received_confirmed_buyer_at,
        }
      : {
          admin: !!order.received_confirmed_admin_at,
          staff: !!order.received_confirmed_staff_at,
          buyer: !!order.received_confirmed_buyer_at,
          allDone:
            !!order.received_confirmed_admin_at &&
            !!order.received_confirmed_staff_at &&
            !!order.received_confirmed_buyer_at,
        };

  return { placed: true, production, transport, received };
}

async function getOrderById(id) {
  const orderResult = await db.query(
    `SELECT o.*, u.role AS buyer_role, d.distributor_type AS buyer_distributor_type
     FROM orders o
     JOIN users u ON u.id = o.customer_id
     LEFT JOIN distributors d ON d.user_id = u.id
     WHERE o.id = $1`,
    [id]
  );
  if (orderResult.rows.length === 0) throw new ApiError(404, "Order not found");
  const order = orderResult.rows[0];
  const buyerKind = order.buyer_role === "distributor" ? "distributor" : "customer";

  const itemsResult = await db.query(
    `SELECT oi.*, p.name AS product_name, p.sku, b.batch_number, b.expiry_date, v.size AS variant_size
     FROM order_items oi
     JOIN products p ON p.id = oi.product_id
     JOIN product_batches b ON b.id = oi.batch_id
     LEFT JOIN product_variants v ON v.id = oi.variant_id
     WHERE oi.order_id = $1`,
    [id]
  );

  const payment = await getPaymentSummary(id, order.total_amount);
  const stage = computeStage(order, buyerKind);
  const expiry = getExpiryInfo(order.expiry_date);

  return { ...order, items: itemsResult.rows, payment, stage, buyerKind, expiry };
}

// Customers see only their own orders; distributors see only assigned orders; admins see all
async function listOrders(user, { status } = {}) {
  const conditions = [];
  const values = [];
  let i = 1;

  if (user.role === "customer") {
    conditions.push(`o.customer_id = $${i++}`);
    values.push(user.id);
  } else if (user.role === "distributor") {
    const distResult = await db.query(
      "SELECT id, distributor_type FROM distributors WHERE user_id = $1",
      [user.id]
    );
    if (distResult.rows.length === 0) throw new ApiError(404, "Distributor profile not found");
    const dist = distResult.rows[0];
    if (dist.distributor_type === "distributor") {
      // A true distributor sees their OWN purchases, same as a customer would.
      conditions.push(`o.customer_id = $${i++}`);
      values.push(user.id);
    } else {
      // A sales rep sees orders they're assigned to deliver.
      conditions.push(`o.distributor_id = $${i++}`);
      values.push(dist.id);
    }
  }
  // admin: no filter, sees everything

  if (status) {
    conditions.push(`o.status = $${i++}`);
    values.push(status);
  }

  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  const result = await db.query(
    `SELECT o.*, u.full_name AS customer_name, u.state AS customer_state, u.role AS buyer_role,
            COALESCE((SELECT SUM(amount) FROM order_payments WHERE order_id = o.id), 0) AS paid_amount
     FROM orders o
     JOIN users u ON u.id = o.customer_id
     ${where}
     ORDER BY o.created_at DESC`,
    values
  );
  return result.rows.map((row) => ({
    ...row,
    buyerKind: row.buyer_role === "distributor" ? "distributor" : "customer",
    paymentPercent: Number(row.total_amount) > 0 ? (Number(row.paid_amount) / Number(row.total_amount)) * 100 : 0,
  }));
}

function assertCanAccessOrder(order, user) {  if (user.role === "admin") return;
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

// Logs a payment toward an order. Only the buyer (whoever owns customer_id
// on this order) or an admin can log a payment. Distributor orders enforce
// a per-payment floor of 70% of the total — unless this payment is the one
// that completes the order (brings it to 100%), so a small final top-up
// isn't wrongly blocked. Customers can pay any amount, any number of times.
// Manual payment logging — kept as an admin-only escape hatch (e.g.
// reconciling a payment confirmed by other means), NOT exposed to buyers.
// Real buyer-facing payments always go through Paystack via
// initializePaystackPayment / confirmPaystackPayment below, so they only
// ever count once the money is actually confirmed received.
async function logPayment(orderId, amount, actingUser, note) {
  if (actingUser.role !== "admin") {
    throw new ApiError(403, "Payments must go through Paystack — only admin can log a manual entry");
  }

  const order = await getOrderById(orderId);
  validatePaymentAmount(order, amount);

  await db.query(
    `INSERT INTO order_payments (order_id, amount, recorded_by, note, status) VALUES ($1, $2, $3, $4, 'successful')`,
    [orderId, amount, actingUser.id, note || null]
  );

  return getOrderById(orderId);
}

// Admin-only: moves an order to "on transport." Also stamps expiry_date =
// now + 50 days, which drives the expiry countdown shown across every role.
async function confirmTransport(orderId, actingUser) {
  if (actingUser.role !== "admin") throw new ApiError(403, "Only admin can confirm transport");

  const result = await db.query(
    `UPDATE orders
     SET transport_confirmed_at = now(),
         expiry_date = now() + ($2 || ' days')::interval,
         updated_at = now()
     WHERE id = $1 AND transport_confirmed_at IS NULL RETURNING *`,
    [orderId, EXPIRY_WINDOW_DAYS]
  );
  if (result.rows.length === 0) {
    throw new ApiError(400, "Order not found, or transport is already confirmed");
  }
  return getOrderById(orderId);
}

// Days remaining until expiry, and which color band that falls into. Red =
// closest to expiring (urgent), green = plenty of time left.
function getExpiryInfo(expiryDate) {
  if (!expiryDate) return null;
  const daysRemaining = Math.ceil((new Date(expiryDate).getTime() - Date.now()) / (1000 * 60 * 60 * 24));
  const band = daysRemaining <= EXPIRY_RED_DAYS ? "red" : daysRemaining <= EXPIRY_YELLOW_DAYS ? "yellow" : "green";
  return { daysRemaining, band };
}

// Multi-party "received" confirmation. `as` lets an admin tick a box on
// someone else's behalf (e.g. the distributor's own confirmation), which is
// recorded as done-by-admin so the UI can show who actually clicked it.
async function confirmReceived(orderId, actingUser, { as } = {}) {
  const order = await getOrderById(orderId);
  const isAdmin = actingUser.role === "admin";
  const isBuyer = order.customer_id === actingUser.id;

  let column, byColumn, byUserId;

  if (as === "admin" || (!as && isAdmin)) {
    if (!isAdmin) throw new ApiError(403, "Only admin can confirm the admin box");
    column = "received_confirmed_admin_at";
  } else if (as === "staff") {
    if (order.buyerKind !== "customer") throw new ApiError(400, "This order has no staff confirmation step");
    if (!isAdmin) {
      // Confirm the actor really is this order's assigned sales rep.
      const check = await db.query(
        `SELECT 1 FROM distributors d WHERE d.id = $1 AND d.user_id = $2`,
        [order.distributor_id, actingUser.id]
      );
      if (check.rows.length === 0) throw new ApiError(403, "You're not the sales rep assigned to this order");
    }
    column = "received_confirmed_staff_at";
    byColumn = "received_confirmed_staff_by";
    byUserId = actingUser.id;
  } else if (as === "buyer") {
    if (!isAdmin && !isBuyer) throw new ApiError(403, "Only the buyer or admin can confirm this box");
    column = "received_confirmed_buyer_at";
    byColumn = "received_confirmed_buyer_by";
    byUserId = actingUser.id;
  } else if (!as && isBuyer) {
    column = "received_confirmed_buyer_at";
    byColumn = "received_confirmed_buyer_by";
    byUserId = actingUser.id;
  } else {
    throw new ApiError(400, "Unable to determine which confirmation box to tick");
  }

  const setClauses = [`${column} = now()`, "updated_at = now()"];
  const values = [orderId];
  if (byColumn) {
    setClauses.push(`${byColumn} = $${values.length + 1}`);
    values.push(byUserId);
  }

  const result = await db.query(
    `UPDATE orders SET ${setClauses.join(", ")} WHERE id = $1 RETURNING *`,
    values
  );
  if (result.rows.length === 0) throw new ApiError(404, "Order not found");
  return getOrderById(orderId);
}

// Every order with an active expiry countdown, scoped by role:
// - admin sees everything
// - customer sees their own orders
// - sales rep sees orders they're assigned to deliver
// - true distributor sees their own orders (they're the buyer)
// Each row is enriched with customer/product names for the popup/tab display.
async function listExpiringOrders(user) {
  const conditions = ["o.expiry_date IS NOT NULL"];
  const values = [];
  let i = 1;

  if (user.role === "customer") {
    conditions.push(`o.customer_id = $${i++}`);
    values.push(user.id);
  } else if (user.role === "distributor") {
    const distResult = await db.query(
      "SELECT id, distributor_type FROM distributors WHERE user_id = $1",
      [user.id]
    );
    if (distResult.rows.length === 0) throw new ApiError(404, "Distributor profile not found");
    const dist = distResult.rows[0];
    if (dist.distributor_type === "distributor") {
      conditions.push(`o.customer_id = $${i++}`);
      values.push(user.id);
    } else {
      conditions.push(`o.distributor_id = $${i++}`);
      values.push(dist.id);
    }
  }
  // admin: no filter

  const result = await db.query(
    `SELECT o.id, o.order_number, o.expiry_date, u.full_name AS customer_name,
            (SELECT string_agg(DISTINCT p.name, ', ') FROM order_items oi
             JOIN products p ON p.id = oi.product_id WHERE oi.order_id = o.id) AS product_names
     FROM orders o
     JOIN users u ON u.id = o.customer_id
     WHERE ${conditions.join(" AND ")}
     ORDER BY o.expiry_date ASC`,
    values
  );

  return result.rows.map((row) => ({ ...row, ...getExpiryInfo(row.expiry_date) }));
}

module.exports = {
  createOrder,
  getOrderById,
  listOrders,
  updateStatus,
  cancelOrder,
  assignDistributor,
  logPayment,
  confirmTransport,
  confirmReceived,
  listExpiringOrders,
  validatePaymentAmount,
};
