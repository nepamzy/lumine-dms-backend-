const db = require("../../config/db");
const ApiError = require("../../utils/ApiError");

async function listCustomers({ distributorId } = {}) {
  const conditions = ["u.role = 'customer'", "u.deleted_at IS NULL"];
  const values = [];
  if (distributorId) {
    conditions.push(`cp.assigned_distributor_id = $${values.length + 1}`);
    values.push(distributorId);
  }
  const result = await db.query(
    `SELECT u.id, u.full_name, u.email, u.phone, u.state, u.local_government, u.address, u.status, u.created_at,
            u.latitude, u.longitude,
            cp.business_name, cp.customer_type, cp.delivery_address,
            cp.assigned_distributor_id, cp.referred_by_distributor_id, cp.registered_by_distributor_id,
            ad.business_name AS assigned_distributor_name,
            adu.full_name AS assigned_distributor_full_name,
            (SELECT COUNT(*) FROM users u2 WHERE u2.email = u.email AND u2.deleted_at IS NOT NULL) AS prior_accounts_count
     FROM users u
     LEFT JOIN customer_profiles cp ON cp.user_id = u.id
     LEFT JOIN distributors ad ON ad.id = cp.assigned_distributor_id
     LEFT JOIN users adu ON adu.id = ad.user_id
     WHERE ${conditions.join(" AND ")}
     ORDER BY u.created_at DESC`,
    values
  );
  return result.rows;
}

// Admin manually reassigns a customer to a different distributor — e.g. when
// the auto-matched or referring distributor isn't performing well. Passing
// distributorId = null unassigns the customer entirely.
async function reassignDistributor(customerUserId, distributorId) {
  if (distributorId) {
    const dist = await db.query("SELECT id, distributor_type FROM distributors WHERE id = $1", [distributorId]);
    if (dist.rows.length === 0) throw new ApiError(404, "Distributor not found");
    // Customers are never attached to a true distributor — only sales reps
    // manage a customer book.
    if (dist.rows[0].distributor_type === "distributor") {
      throw new ApiError(400, "Customers can only be assigned to a sales rep, not a distributor");
    }
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

// Soft-delete — nothing is destroyed. Hidden from every normal view (and
// getCurrentUser rejects them, logging them out everywhere), but stays
// visible to admin under Trash. Their email/phone frees up for a fresh
// signup; if that happens, the new account shows a "(2)" marker on the
// admin side only, via prior_accounts_count above.
async function removeCustomer(customerUserId) {
  const result = await db.query(
    `UPDATE users SET deleted_at = now() WHERE id = $1 AND role = 'customer' AND deleted_at IS NULL RETURNING id`,
    [customerUserId]
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
    `SELECT u.id, u.full_name, u.email, u.phone, u.state, u.local_government, u.address, u.status, u.created_at,
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

  // Uses order_payments (the real installment/Paystack log), not the old
  // single-shot `payments` table this used to reference.
  const ordersResult = await db.query(
    `SELECT o.id, o.order_number, o.status, o.total_amount, o.created_at,
            del.gps_status AS delivery_status,
            dd.business_name AS distributor_business_name, du.full_name AS distributor_full_name,
            COALESCE(
              (SELECT SUM(amount) FROM order_payments WHERE order_id = o.id AND status = 'successful'),
              0
            ) AS paid_amount,
            COALESCE(
              (SELECT json_agg(json_build_object(
                 'productName', pr.name, 'size', v.size, 'quantity', oi.quantity,
                 'unitPrice', oi.unit_price, 'lineTotal', oi.line_total
               ) ORDER BY pr.name)
               FROM order_items oi
               JOIN products pr ON pr.id = oi.product_id
               LEFT JOIN product_variants v ON v.id = oi.variant_id
               WHERE oi.order_id = o.id),
              '[]'
            ) AS items
     FROM orders o
     LEFT JOIN deliveries del ON del.order_id = o.id
     LEFT JOIN distributors dd ON dd.id = o.distributor_id
     LEFT JOIN users du ON du.id = dd.user_id
     WHERE o.customer_id = $1
     ORDER BY o.created_at DESC`,
    [customerUserId]
  );

  const orders = ordersResult.rows.map((o) => ({
    ...o,
    payment_percent: Number(o.total_amount) > 0 ? (Number(o.paid_amount) / Number(o.total_amount)) * 100 : 0,
  }));

  return { profile: profileResult.rows[0], orders, summary: buildOrderSummary(orders) };
}

function buildOrderSummary(orders) {
  const totalOrders = orders.length;
  const totalSpent = orders.reduce((sum, o) => sum + Number(o.paid_amount || 0), 0);
  const pendingPayments = orders.filter((o) => o.payment_percent < 100).length;
  const failedPayments = 0; // failed attempts don't count toward paid_amount, so nothing to sum here
  return { totalOrders, totalSpent, pendingPayments, failedPayments };
}

module.exports = { listCustomers, reassignDistributor, getCustomerHistory, removeCustomer };
