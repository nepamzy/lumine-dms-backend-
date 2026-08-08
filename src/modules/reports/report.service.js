const db = require("../../config/db");
const ApiError = require("../../utils/ApiError");

function validateDateRange(startDate, endDate) {
  if (startDate && isNaN(Date.parse(startDate))) {
    throw new ApiError(400, "Invalid startDate");
  }
  if (endDate && isNaN(Date.parse(endDate))) {
    throw new ApiError(400, "Invalid endDate");
  }
}

// Revenue and order counts, broken down by state and by product.
// Only counts orders that actually reached 'paid' or further — pending/
// cancelled orders never happened from a revenue standpoint.
async function salesReport({ startDate, endDate } = {}) {
  validateDateRange(startDate, endDate);
  const paidStatuses = ["paid", "processing", "out_for_delivery", "delivered"];

  const params = [paidStatuses];
  let dateFilter = "";
  if (startDate) {
    params.push(startDate);
    dateFilter += ` AND o.created_at >= $${params.length}`;
  }
  if (endDate) {
    params.push(endDate);
    dateFilter += ` AND o.created_at <= $${params.length}`;
  }

  const summary = await db.query(
    `SELECT COUNT(*) AS order_count, COALESCE(SUM(o.total_amount), 0) AS total_revenue
     FROM orders o
     WHERE o.status = ANY($1) ${dateFilter}`,
    params
  );

  const byState = await db.query(
    `SELECT u.state, COUNT(*) AS order_count, COALESCE(SUM(o.total_amount), 0) AS revenue
     FROM orders o
     JOIN users u ON u.id = o.customer_id
     WHERE o.status = ANY($1) ${dateFilter}
     GROUP BY u.state
     ORDER BY revenue DESC`,
    params
  );

  const byProduct = await db.query(
    `SELECT p.name AS product_name, p.sku,
            SUM(oi.quantity) AS units_sold,
            COALESCE(SUM(oi.line_total), 0) AS revenue
     FROM order_items oi
     JOIN orders o ON o.id = oi.order_id
     JOIN products p ON p.id = oi.product_id
     WHERE o.status = ANY($1) ${dateFilter}
     GROUP BY p.id, p.name, p.sku
     ORDER BY revenue DESC`,
    params
  );

  const byDistributor = await db.query(
    `SELECT d.id AS distributor_id, d.business_name,
            COUNT(*) AS order_count, COALESCE(SUM(o.total_amount), 0) AS revenue
     FROM orders o
     JOIN distributors d ON d.id = o.distributor_id
     WHERE o.status = ANY($1) ${dateFilter}
     GROUP BY d.id, d.business_name
     ORDER BY revenue DESC`,
    params
  );

  // Sales reps' own personal orders (never assigned to a distributor for
  // delivery, since they ARE the buyer) — broken out separately so revenue
  // from this new order type is visible, not just folded into the total.
  const salesRepSelfOrders = await db.query(
    `SELECT COUNT(*) AS order_count, COALESCE(SUM(o.total_amount), 0) AS revenue
     FROM orders o
     JOIN users u ON u.id = o.customer_id
     JOIN distributors d ON d.user_id = u.id
     WHERE u.role = 'distributor' AND d.distributor_type = 'sales_rep'
       AND o.status = ANY($1) ${dateFilter}`,
    params
  );

  // Customer orders currently inside the 65%-on-arrival payment reminder
  // window (see order.service.js confirmReceived) and still not fully paid.
  const pendingPaymentReminders = await db.query(
    `SELECT COUNT(*) AS count
     FROM orders o
     WHERE o.payment_due_at IS NOT NULL
       AND o.status != 'cancelled'
       AND COALESCE((SELECT SUM(amount) FROM order_payments WHERE order_id = o.id AND status = 'successful'), 0) < o.total_amount`
  );

  return {
    summary: summary.rows[0],
    byState: byState.rows,
    byProduct: byProduct.rows,
    byDistributor: byDistributor.rows,
    salesRepSelfOrders: salesRepSelfOrders.rows[0],
    pendingPaymentReminders: Number(pendingPaymentReminders.rows[0].count),
  };
}

// Current stock position across the catalog, plus what's expiring soon —
// the two numbers an admin actually checks every morning.
async function inventoryReport({ expiringWithinDays = 30 } = {}) {
  const stockByProduct = await db.query(
    `SELECT p.id, p.name, p.sku, p.category,
            COALESCE(SUM(b.quantity_on_hand), 0) AS total_stock,
            MIN(b.expiry_date) FILTER (WHERE b.quantity_on_hand > 0) AS nearest_expiry
     FROM products p
     LEFT JOIN product_batches b ON b.product_id = p.id
     WHERE p.is_active = true
     GROUP BY p.id
     ORDER BY p.name ASC`
  );

  const expiringBatches = await db.query(
    `SELECT b.id, p.name AS product_name, p.sku, b.batch_number,
            b.quantity_on_hand, b.expiry_date,
            (b.expiry_date - CURRENT_DATE) AS days_until_expiry
     FROM product_batches b
     JOIN products p ON p.id = b.product_id
     WHERE b.expiry_date <= (CURRENT_DATE + $1::int)
       AND b.quantity_on_hand > 0
     ORDER BY b.expiry_date ASC`,
    [expiringWithinDays]
  );

  const lowStock = await db.query(
    `SELECT p.id, p.name, p.sku, COALESCE(SUM(b.quantity_on_hand), 0) AS total_stock
     FROM products p
     LEFT JOIN product_batches b ON b.product_id = p.id
     WHERE p.is_active = true
     GROUP BY p.id
     HAVING COALESCE(SUM(b.quantity_on_hand), 0) < 50
     ORDER BY total_stock ASC`
  );

  return {
    stockByProduct: stockByProduct.rows,
    expiringBatches: expiringBatches.rows,
    lowStock: lowStock.rows,
  };
}

// Delivery performance: status breakdown and average time from "assigned" to "delivered"
async function deliveryReport({ startDate, endDate } = {}) {
  validateDateRange(startDate, endDate);

  const params = [];
  let dateFilter = "";
  if (startDate) {
    params.push(startDate);
    dateFilter += ` AND d.updated_at >= $${params.length}`;
  }
  if (endDate) {
    params.push(endDate);
    dateFilter += ` AND d.updated_at <= $${params.length}`;
  }

  const statusBreakdown = await db.query(
    `SELECT gps_status, COUNT(*) AS count
     FROM deliveries d
     WHERE true ${dateFilter}
     GROUP BY gps_status`,
    params
  );

  const avgDeliveryTime = await db.query(
    `SELECT AVG(EXTRACT(EPOCH FROM (delivered_at - d.updated_at)) / 3600) AS avg_hours
     FROM deliveries d
     WHERE gps_status = 'delivered' AND delivered_at IS NOT NULL ${dateFilter}`,
    params
  );

  const byDistributor = await db.query(
    `SELECT dist.business_name, dist.id AS distributor_id,
            COUNT(*) FILTER (WHERE d.gps_status = 'delivered') AS delivered_count,
            COUNT(*) FILTER (WHERE d.gps_status = 'failed') AS failed_count
     FROM deliveries d
     JOIN distributors dist ON dist.id = d.distributor_id
     WHERE true ${dateFilter}
     GROUP BY dist.id, dist.business_name
     ORDER BY delivered_count DESC`,
    params
  );

  return {
    statusBreakdown: statusBreakdown.rows,
    avgDeliveryTimeHours: avgDeliveryTime.rows[0]?.avg_hours
      ? Number(avgDeliveryTime.rows[0].avg_hours).toFixed(1)
      : null,
    byDistributor: byDistributor.rows,
  };
}

// One row per Sales Rep / Distributor: their state, total revenue, and a
// completed/pending order split (completed = 100% paid). This single
// dataset powers the whole Overview revenue drill-down (state -> rep type
// -> individual -> their orders) without a separate API call per level.
//
// "Distributor" revenue = orders where they are the buyer themselves.
// "Sales Rep" revenue = orders they've generated for their customers
// (assigned to them for delivery) — their own personal orders are tracked
// separately under salesRepSelfOrders in salesReport().
async function repRevenueBreakdown({ startDate, endDate } = {}) {
  validateDateRange(startDate, endDate);
  const paidStatuses = ["paid", "processing", "out_for_delivery", "delivered"];

  const params = [paidStatuses];
  let dateFilter = "";
  if (startDate) {
    params.push(startDate);
    dateFilter += ` AND o.created_at >= $${params.length}`;
  }
  if (endDate) {
    params.push(endDate);
    dateFilter += ` AND o.created_at <= $${params.length}`;
  }

  const result = await db.query(
    `SELECT
       d.id AS distributor_id, d.distributor_type, d.business_name,
       u.id AS user_id, u.full_name, u.state,
       COUNT(*) AS order_count,
       COUNT(*) FILTER (
         WHERE COALESCE(paid.total, 0) >= o.total_amount
       ) AS completed_count,
       COUNT(*) FILTER (
         WHERE COALESCE(paid.total, 0) < o.total_amount
       ) AS pending_count,
       COALESCE(SUM(o.total_amount), 0) AS revenue
     FROM distributors d
     JOIN users u ON u.id = d.user_id
     JOIN orders o ON (
       (d.distributor_type = 'distributor' AND o.customer_id = d.user_id)
       OR (d.distributor_type = 'sales_rep' AND o.distributor_id = d.id)
     )
     LEFT JOIN LATERAL (
       SELECT SUM(amount) AS total FROM order_payments WHERE order_id = o.id AND status = 'successful'
     ) paid ON true
     WHERE o.status = ANY($1) ${dateFilter}
     GROUP BY d.id, d.distributor_type, d.business_name, u.id, u.full_name, u.state
     ORDER BY revenue DESC`,
    params
  );

  return result.rows;
}

module.exports = { salesReport, inventoryReport, deliveryReport, repRevenueBreakdown };
