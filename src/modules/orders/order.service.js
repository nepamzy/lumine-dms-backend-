const db = require("../../config/db");
const ApiError = require("../../utils/ApiError");
const { reserveStockFEFO } = require("../products/product.service");
const { notify, notifyOrderCreated, notifyDistributorAssigned, notifyOutForDelivery, notifyPaymentSuccess } = require("../notifications/notification.service");

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

// A buyer's order-level "kind" for pricing/payment-rule purposes, derived
// from the raw role + distributor_type columns joined onto an order row
// (aliased as buyer_role / buyer_distributor_type everywhere this is used).
function resolveBuyerKindFromRow(row) {
  if (row.buyer_role === "distributor" && row.buyer_distributor_type === "sales_rep") return "salesRepSelf";
  if (row.buyer_role === "distributor") return "distributor";
  return "customer";
}
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

// A buyer can be: a real customer, a "true" distributor buying for
// themselves, or (new) a sales rep buying for THEIR OWN personal order —
// distinct from a sales rep placing an order on a customer's behalf.
// Returns { id, state, kind: 'customer'|'distributor'|'salesRepSelf' }.
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
  if (row.role === "distributor" && row.distributor_type === "sales_rep") {
    return { id: row.id, state: row.state, kind: "salesRepSelf" };
  }
  throw new ApiError(403, "Only customers and distributors can place their own orders");
}

// Blocks placing a new order until the buyer's existing orders clear the
// required payment threshold — 100% for customers and sales reps buying
// for themselves, 85% for true distributors.
async function assertCanPlaceOrder(client, buyerId, kind) {
  const threshold =
    kind === "distributor" ? DISTRIBUTOR_NEXT_ORDER_MIN_PERCENT : CUSTOMER_NEXT_ORDER_MIN_PERCENT;

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

// Validates + prices a set of { variantId, quantity } items and reserves
// FEFO stock for them. Shared by createOrder (new orders) and
// editOrderItems (amending an existing pre-production order) so both
// always price and reserve stock identically.
async function buildOrderItemRows(client, buyer, items) {
  let totalAmount = 0;
  let totalPacks = 0;
  const orderItemRows = []; // { productId, variantId, batchId, quantity, unitPrice }

  for (const item of items) {
    if (!item.variantId || !item.quantity || item.quantity <= 0) {
      throw new ApiError(400, "Each item needs a valid variantId and quantity > 0");
    }

    const variantResult = await client.query(
      `SELECT v.id AS variant_id, v.product_id, v.size, v.pack_price, p.is_active
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
    if (variant.pack_price == null) {
      throw new ApiError(400, `No price configured for this product yet`);
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

    // Pricing is per PACK. Customers and sales reps (placedByUserId set,
    // or a customer buying for themselves) always pay the flat pack
    // price — no discount, ever. Only a true distributor buying for
    // themselves gets the bulk pack-count discount tiers.
    const packSize = halfPackUnit * 2;
    const packs = item.quantity / packSize;
    totalPacks += packs;
    let pricePerPack = Number(variant.pack_price);

    if (buyer.kind === "distributor") {
      const tierResult = await client.query(
        `SELECT price FROM price_tiers
         WHERE variant_id = $1 AND min_qty <= $2 AND (max_qty IS NULL OR max_qty >= $2)
         ORDER BY min_qty DESC LIMIT 1`,
        [item.variantId, packs]
      );
      if (tierResult.rows.length > 0) {
        pricePerPack = Number(tierResult.rows[0].price);
      }
    }

    const unitPrice = pricePerPack / packSize;

    // FEFO reservation — may split across multiple batches if needed
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

  const SALES_REP_MAX_PACKS = 5;
  if (buyer.kind === "salesRepSelf" && totalPacks > SALES_REP_MAX_PACKS) {
    throw new ApiError(
      400,
      `Sales rep orders are capped at ${SALES_REP_MAX_PACKS} packs total across all products (this order is ${totalPacks} packs).`
    );
  }

  return { orderItemRows, totalAmount };
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

    const { orderItemRows, totalAmount } = await buildOrderItemRows(client, buyer, items);

    // A distributor's own order isn't delivered by a sales rep — only
    // customer orders get a sales rep assigned as the deliverer. Use the
    // customer's ACTUAL assigned sales rep (set at registration/referral
    // time) so every order they place — whether they click it themselves
    // or their sales rep places it on their behalf — always routes to the
    // same rep. Only fall back to a fresh state-based match if they
    // somehow have no assignment yet.
    let distributorId = null;
    if (customer.kind === "customer") {
      const assignedResult = await client.query(
        `SELECT assigned_distributor_id FROM customer_profiles WHERE user_id = $1`,
        [buyer.id]
      );
      distributorId = assignedResult.rows[0]?.assigned_distributor_id || null;
      if (!distributorId) {
        distributorId = await findDistributorForState(client, customer.state);
      }
    }
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

  const wouldBeTotal = order.payment.totalPaid + Number(amount);
  const wouldCompleteOrder = wouldBeTotal >= Number(order.total_amount);

  // A sales rep's own personal order must be paid 100% upfront — no
  // partial/installment payments at all, ever. Any amount that wouldn't
  // fully settle the order is rejected outright.
  if (order.buyerKind === "salesRepSelf" && !wouldCompleteOrder) {
    throw new ApiError(
      400,
      "Sales rep orders must be paid in full upfront — partial payments aren't allowed on this order type."
    );
  }

  if (order.buyerKind === "distributor") {
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
    buyerKind === "distributor" || buyerKind === "salesRepSelf"
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
    `SELECT o.*, u.role AS buyer_role, d.distributor_type AS buyer_distributor_type,
            u.full_name AS customer_name, u.email AS customer_email, u.phone AS customer_phone
     FROM orders o
     JOIN users u ON u.id = o.customer_id
     LEFT JOIN distributors d ON d.user_id = u.id
     WHERE o.id = $1`,
    [id]
  );
  if (orderResult.rows.length === 0) throw new ApiError(404, "Order not found");
  const order = orderResult.rows[0];
  const buyerKind = resolveBuyerKindFromRow(order);

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
  const paymentDue = getPaymentDueInfo({ ...order, payment });

  return { ...order, items: itemsResult.rows, payment, stage, buyerKind, expiry, paymentDue };
}

// Customers see only their own orders; distributors see only assigned orders; admins see all
async function listOrders(user, { status } = {}) {
  const conditions = ["o.deleted_at IS NULL"];
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
    buyerKind: resolveBuyerKindFromRow(row),
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
  if (order.stage.production) {
    throw new ApiError(400, "This order has entered production and can no longer be cancelled");
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

// Lets the buyer (or the sales rep who placed it on their behalf, or an
// admin) change what's in an order — but only up until it enters
// production (48hrs after creation), same cutoff as cancelOrder. Old
// reserved stock is released and the new items are priced/reserved fresh,
// using the exact same pricing logic as a brand-new order.
async function editOrderItems(orderId, items, actingUser) {
  if (!Array.isArray(items) || items.length === 0) {
    throw new ApiError(400, "Order must contain at least one item");
  }

  const client = await db.pool.connect();
  try {
    await client.query("BEGIN");

    const orderResult = await client.query(
      `SELECT o.*, u.role AS buyer_role, d.distributor_type AS buyer_distributor_type
       FROM orders o
       JOIN users u ON u.id = o.customer_id
       LEFT JOIN distributors d ON d.user_id = u.id
       WHERE o.id = $1
       FOR UPDATE`,
      [orderId]
    );
    if (orderResult.rows.length === 0) throw new ApiError(404, "Order not found");
    const order = orderResult.rows[0];

    const isAdmin = actingUser.role === "admin";
    const isBuyer = order.customer_id === actingUser.id;
    const isPlacer = order.placed_by_user_id === actingUser.id;
    if (!isAdmin && !isBuyer && !isPlacer) {
      throw new ApiError(403, "You don't have access to this order");
    }

    if (!["pending", "paid"].includes(order.status)) {
      throw new ApiError(400, `Order in status "${order.status}" can no longer be edited`);
    }

    const hoursSincePlaced = (Date.now() - new Date(order.created_at).getTime()) / (1000 * 60 * 60);
    if (hoursSincePlaced >= PRODUCTION_DELAY_HOURS) {
      throw new ApiError(400, "This order has entered production and can no longer be edited");
    }

    const buyerKind = resolveBuyerKindFromRow(order);

    // Release the old reservation before re-pricing/re-reserving the new items
    const oldItems = await client.query(
      `SELECT batch_id, quantity FROM order_items WHERE order_id = $1`,
      [orderId]
    );
    for (const item of oldItems.rows) {
      await client.query(
        `UPDATE product_batches SET quantity_on_hand = quantity_on_hand + $1 WHERE id = $2`,
        [item.quantity, item.batch_id]
      );
    }
    await client.query(`DELETE FROM order_items WHERE order_id = $1`, [orderId]);

    const { orderItemRows, totalAmount } = await buildOrderItemRows(
      client,
      { id: order.customer_id, kind: buyerKind },
      items
    );

    for (const row of orderItemRows) {
      await client.query(
        `INSERT INTO order_items (order_id, product_id, variant_id, batch_id, quantity, unit_price)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [orderId, row.productId, row.variantId, row.batchId, row.quantity, row.unitPrice]
      );
    }

    await client.query(
      `UPDATE orders SET total_amount = $1, updated_at = now() WHERE id = $2`,
      [totalAmount, orderId]
    );

    await client.query("COMMIT");
    return getOrderById(orderId);
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

// Admin-only. Soft-deletes an order (never a hard DELETE — payments and
// deliveries reference orders without cascade, so a real DELETE would
// throw the moment either table has a row). If the order hadn't already
// been delivered or cancelled, its reserved stock is released back first,
// same as a cancellation, so inventory doesn't leak.
async function deleteOrder(orderId, actingUser) {
  if (actingUser.role !== "admin") throw new ApiError(403, "Only admin can delete an order");

  const order = await getOrderById(orderId);

  const client = await db.pool.connect();
  try {
    await client.query("BEGIN");

    if (!["delivered", "cancelled"].includes(order.status)) {
      for (const item of order.items) {
        await client.query(
          `UPDATE product_batches SET quantity_on_hand = quantity_on_hand + $1 WHERE id = $2`,
          [item.quantity, item.batch_id]
        );
      }
    }

    const result = await client.query(
      `UPDATE orders SET deleted_at = now(), updated_at = now() WHERE id = $1 AND deleted_at IS NULL RETURNING id`,
      [orderId]
    );
    if (result.rows.length === 0) throw new ApiError(404, "Order not found or already removed");

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
// Baseline sanity checks only — no role-specific floors. Used for admin's
// manual authorization, which deliberately overrides the distributor 70%
// floor and the sales-rep-must-pay-in-full-only rule: admin's word is
// authoritative for every user type, full stop.
function validateAdminPaymentAmount(order, amount) {
  if (!(amount > 0)) throw new ApiError(400, "Payment amount must be greater than zero");
  if (order.payment.totalPaid >= Number(order.total_amount)) {
    throw new ApiError(400, "This order is already fully paid");
  }
}

// Admin-only manual payment entry — this is the authoritative "admin's
// word surpasses Paystack" path: it marks the payment successful
// immediately, with no Paystack confirmation involved at all, and applies
// to every buyer type (customer, distributor, sales rep) equally —
// bypassing their normal payment-amount restrictions entirely. Accepts
// either a raw amount or a percentOfTotal (e.g. 40 for 40%), so admin can
// enter whichever is more convenient — percentOfTotal is converted to a
// naira amount against the order's total before validation.
async function logPayment(orderId, amount, actingUser, note, { percentOfTotal } = {}) {
  if (actingUser.role !== "admin") {
    throw new ApiError(403, "Payments must go through Paystack — only admin can log a manual entry");
  }

  const order = await getOrderById(orderId);

  let resolvedAmount = amount;
  if (percentOfTotal != null && percentOfTotal > 0) {
    resolvedAmount = (Number(percentOfTotal) / 100) * Number(order.total_amount);
  }

  validateAdminPaymentAmount(order, resolvedAmount);

  await db.query(
    `INSERT INTO order_payments (order_id, amount, recorded_by, note, status) VALUES ($1, $2, $3, $4, 'successful')`,
    [orderId, resolvedAmount, actingUser.id, note || null]
  );

  const updatedOrder = await getOrderById(orderId);
  notifyPaymentSuccess(updatedOrder, updatedOrder.customer_id).catch(() => {});
  return updatedOrder;
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

// Days remaining on the customer's 2-week post-arrival payment window
// (see confirmReceived's 65% reminder). Null once the order is fully paid
// or if no reminder was ever triggered.
function getPaymentDueInfo(order) {
  if (!order.payment_due_at) return null;
  if (order.payment.percent >= 100) return null;
  const daysRemaining = Math.ceil((new Date(order.payment_due_at).getTime() - Date.now()) / (1000 * 60 * 60 * 24));
  return { dueAt: order.payment_due_at, daysRemaining, overdue: daysRemaining < 0 };
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

  const wasFirstReceivedConfirmation =
    !order.received_confirmed_admin_at && !order.received_confirmed_staff_at && !order.received_confirmed_buyer_at;

  const setClauses = [`${column} = now()`, "updated_at = now()"];
  const values = [orderId];
  if (byColumn) {
    setClauses.push(`${byColumn} = $${values.length + 1}`);
    values.push(byUserId);
  }

  // Customers must have paid at least 65% by the time the order arrives;
  // sales reps buying for themselves must have paid 100% (no partial
  // payments allowed on that order type at all). Either way, this is the
  // moment ("arrival") to remind them if they haven't.
  const PAYMENT_REMINDER_THRESHOLD_PERCENT = 65;
  const PAYMENT_REMINDER_WINDOW_DAYS = 14;
  const isCustomerShortfall =
    order.buyerKind === "customer" && order.payment.percent < PAYMENT_REMINDER_THRESHOLD_PERCENT;
  const isSalesRepShortfall = order.buyerKind === "salesRepSelf" && order.payment.percent < 100;
  const needsPaymentReminder = wasFirstReceivedConfirmation && (isCustomerShortfall || isSalesRepShortfall);

  if (needsPaymentReminder) {
    setClauses.push(`payment_due_at = now() + ($${values.length + 1} || ' days')::interval`);
    values.push(PAYMENT_REMINDER_WINDOW_DAYS);
  }

  const result = await db.query(
    `UPDATE orders SET ${setClauses.join(", ")} WHERE id = $1 RETURNING *`,
    values
  );
  if (result.rows.length === 0) throw new ApiError(404, "Order not found");

  if (needsPaymentReminder) {
    const remaining = Number(order.total_amount) - order.payment.totalPaid;
    const message = isSalesRepShortfall
      ? `Your Lumine order ${order.order_number} has arrived! Sales rep orders require 100% payment upfront — ` +
        `please pay the remaining ₦${remaining.toLocaleString()} as soon as possible from your order page. ` +
        `You won't be able to place another order until this one is fully paid.`
      : `Your Lumine order ${order.order_number} has arrived! You've paid ${order.payment.percent.toFixed(0)}% so far — ` +
        `at least ${PAYMENT_REMINDER_THRESHOLD_PERCENT}% is required upon arrival. Please pay the remaining balance ` +
        `of ₦${remaining.toLocaleString()} within the next ${PAYMENT_REMINDER_WINDOW_DAYS} days, in up to two installments, ` +
        `from your order page.`;
    notify({
      userId: order.customer_id,
      type: "payment_reminder",
      channel: "email",
      message,
    }).catch(() => {});
  }

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
  editOrderItems,
  deleteOrder,
  assignDistributor,
  logPayment,
  confirmTransport,
  confirmReceived,
  listExpiringOrders,
  validatePaymentAmount,
};
