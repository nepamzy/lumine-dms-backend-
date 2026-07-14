const db = require("../../config/db");
const ApiError = require("../../utils/ApiError");

async function listCustomers() {
  const result = await db.query(
    `SELECT u.id, u.full_name, u.email, u.phone, u.state, u.local_government, u.status, u.created_at,
            u.latitude, u.longitude,
            cp.business_name, cp.customer_type, cp.delivery_address,
            cp.assigned_distributor_id, cp.referred_by_distributor_id,
            ad.business_name AS assigned_distributor_name,
            adu.full_name AS assigned_distributor_full_name
     FROM users u
     LEFT JOIN customer_profiles cp ON cp.user_id = u.id
     LEFT JOIN distributors ad ON ad.id = cp.assigned_distributor_id
     LEFT JOIN users adu ON adu.id = ad.user_id
     WHERE u.role = 'customer'
     ORDER BY u.created_at DESC`
  );
  return result.rows;
}

// Admin manually reassigns a customer to a different distributor — e.g. when
// the auto-matched or referring distributor isn't performing well. Passing
// distributorId = null unassigns the customer entirely.
async function reassignDistributor(customerUserId, distributorId) {
  if (distributorId) {
    const dist = await db.query("SELECT id FROM distributors WHERE id = $1", [distributorId]);
    if (dist.rows.length === 0) throw new ApiError(404, "Distributor not found");
  }

  const result = await db.query(
    `UPDATE customer_profiles SET assigned_distributor_id = $1
     WHERE user_id = $2
     RETURNING *`,
    [distributorId || null, customerUserId]
  );
  if (result.rows.length === 0) throw new ApiError(404, "Customer not found");
  return result.rows[0];
}

// Full activity history for one customer — profile, every order they've
// placed, each order's payment status (and whether it actually went
// through), delivery status, and line items. Used by the admin's
// customer-detail view.
async function getCustomerHistory(customerUserId) {
  const profileResult = await db.query(
    `SELECT u.id, u.full_name, u.email, u.phone, u.state, u.local_government, u.status, u.created_at,
            cp.business_name, cp.customer_type, cp.delivery_address,
            cp.assigned_distributor_id, cp.referred_by_distributor_id,
            ad.business_name AS assigned_distributor_name,
            adu.full_name AS assigned_distributor_full_name
     FROM users u
     LEFT JOIN customer_profiles cp ON cp.user_id = u.id
     LEFT JOIN distributors ad ON ad.id = cp.assigned_distributor_id
     LEFT JOIN users adu ON adu.id = ad.user_id
     WHERE u.id = $1 AND u.role = 'customer'`,
    [customerUserId]
  );
  if (profileResult.rows.length === 0) throw new ApiError(404, "Customer not found");

  const ordersResult = await db.query(
    `SELECT o.id, o.order_number, o.status, o.total_amount, o.created_at,
            p.status AS payment_status, p.paid_at, p.paystack_ref, p.amount AS payment_amount,
            del.gps_status AS delivery_status,
            dd.business_name AS distributor_business_name, du.full_name AS distributor_full_name,
            COALESCE(
              (SELECT json_agg(json_build_object(
                 'productName', pr.name, 'quantity', oi.quantity,
                 'unitPrice', oi.unit_price, 'lineTotal', oi.line_total
               ) ORDER BY pr.name)
               FROM order_items oi JOIN products pr ON pr.id = oi.product_id
               WHERE oi.order_id = o.id),
              '[]'
            ) AS items
     FROM orders o
     LEFT JOIN payments p ON p.order_id = o.id
     LEFT JOIN deliveries del ON del.order_id = o.id
     LEFT JOIN distributors dd ON dd.id = o.distributor_id
     LEFT JOIN users du ON du.id = dd.user_id
     WHERE o.customer_id = $1
     ORDER BY o.created_at DESC`,
    [customerUserId]
  );

  return { profile: profileResult.rows[0], orders: ordersResult.rows, summary: buildOrderSummary(ordersResult.rows) };
}

function buildOrderSummary(orders) {
  const totalOrders = orders.length;
  const totalSpent = orders
    .filter((o) => o.payment_status === "successful")
    .reduce((sum, o) => sum + Number(o.payment_amount || 0), 0);
  const pendingPayments = orders.filter((o) => !o.payment_status || o.payment_status === "initiated").length;
  const failedPayments = orders.filter((o) => o.payment_status === "failed").length;
  return { totalOrders, totalSpent, pendingPayments, failedPayments };
}

module.exports = { listCustomers, reassignDistributor, getCustomerHistory };
