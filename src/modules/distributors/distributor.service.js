const db = require("../../config/db");
const ApiError = require("../../utils/ApiError");
const { notifyDistributorApproved } = require("../notifications/notification.service");

async function listDistributors({ status } = {}) {
  const params = [];
  let where = "";
  if (status) {
    params.push(status);
    where = "WHERE d.approval_status = $1";
  }

  const result = await db.query(
    `SELECT d.*, u.full_name, u.email, u.phone, u.state, u.status AS user_status, t.name AS territory_name
     FROM distributors d
     JOIN users u ON u.id = d.user_id
     LEFT JOIN territories t ON t.id = d.territory_id
     ${where}
     ORDER BY d.created_at DESC`,
    params
  );
  return result.rows;
}

// Approving a distributor also flips their user account from 'pending' to
// 'active' — otherwise they'd be approved but still locked out at login.
async function approveDistributor(distributorId, territoryId) {
  const client = await db.pool.connect();
  try {
    await client.query("BEGIN");

    const distResult = await client.query(
      `UPDATE distributors SET approval_status = 'approved', territory_id = COALESCE($1, territory_id)
       WHERE id = $2 RETURNING *`,
      [territoryId || null, distributorId]
    );
    if (distResult.rows.length === 0) throw new ApiError(404, "Distributor not found");

    await client.query(
      `UPDATE users SET status = 'active' WHERE id = $1`,
      [distResult.rows[0].user_id]
    );

    await client.query("COMMIT");

    notifyDistributorApproved(distResult.rows[0].user_id).catch(() => {});

    return distResult.rows[0];
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}
async function rejectDistributor(distributorId) {
  const result = await db.query(
    `UPDATE distributors SET approval_status = 'rejected' WHERE id = $1 RETURNING *`,
    [distributorId]
  );
  if (result.rows.length === 0) throw new ApiError(404, "Distributor not found");
  return result.rows[0];
}

async function suspendDistributor(distributorId) {
  const client = await db.pool.connect();
  try {
    await client.query("BEGIN");
    const distResult = await client.query(
      `UPDATE distributors SET approval_status = 'suspended' WHERE id = $1 RETURNING *`,
      [distributorId]
    );
    if (distResult.rows.length === 0) throw new ApiError(404, "Distributor not found");

    await client.query(`UPDATE users SET status = 'suspended' WHERE id = $1`, [
      distResult.rows[0].user_id,
    ]);
    await client.query("COMMIT");
    return distResult.rows[0];
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

async function listTerritories() {
  const result = await db.query("SELECT * FROM territories ORDER BY state ASC, name ASC");
  return result.rows;
}

async function createTerritory({ name, state }) {
  if (!name || !state) throw new ApiError(400, "name and state are required");
  const result = await db.query(
    `INSERT INTO territories (name, state) VALUES ($1, $2) RETURNING *`,
    [name, state]
  );
  return result.rows[0];
}

// Distributor's own referral code, plus counts of customers referred through
// it vs. currently assigned to them (these can differ after an admin
// reassignment — referred_by never changes, assigned_distributor_id can).
async function getReferralInfo(userId) {
  const distResult = await db.query(
    `SELECT id, referral_code, business_name, distributor_type FROM distributors WHERE user_id = $1`,
    [userId]
  );
  if (distResult.rows.length === 0) throw new ApiError(404, "Distributor profile not found");
  const distributor = distResult.rows[0];

  const counts = await db.query(
    `SELECT
       COUNT(*) FILTER (WHERE referred_by_distributor_id = $1) AS referred_count,
       COUNT(*) FILTER (WHERE assigned_distributor_id = $1) AS assigned_count
     FROM customer_profiles`,
    [distributor.id]
  );

  return {
    referralCode: distributor.referral_code,
    businessName: distributor.business_name,
    distributorType: distributor.distributor_type,
    referredCount: Number(counts.rows[0].referred_count),
    assignedCount: Number(counts.rows[0].assigned_count),
  };
}

// Full activity history for one distributor — profile, every order routed
// to them, each order's payment status, delivery status, and line items.
// Used by the admin's distributor-detail view.
async function getDistributorHistory(distributorId) {
  const profileResult = await db.query(
    `SELECT d.id, d.business_name, d.approval_status, d.referral_code, d.distributor_type, d.created_at,
            u.full_name, u.email, u.phone, u.state, u.local_government, u.status AS user_status,
            t.name AS territory_name
     FROM distributors d
     JOIN users u ON u.id = d.user_id
     LEFT JOIN territories t ON t.id = d.territory_id
     WHERE d.id = $1`,
    [distributorId]
  );
  if (profileResult.rows.length === 0) throw new ApiError(404, "Distributor not found");

  const ordersResult = await db.query(
    `SELECT o.id, o.order_number, o.status, o.total_amount, o.created_at,
            p.status AS payment_status, p.paid_at, p.paystack_ref, p.amount AS payment_amount,
            del.gps_status AS delivery_status,
            cu.full_name AS customer_full_name, cp.business_name AS customer_business_name,
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
     LEFT JOIN users cu ON cu.id = o.customer_id
     LEFT JOIN customer_profiles cp ON cp.user_id = o.customer_id
     WHERE o.distributor_id = $1
     ORDER BY o.created_at DESC`,
    [distributorId]
  );

  const orders = ordersResult.rows;
  const totalOrders = orders.length;
  const totalRevenue = orders
    .filter((o) => o.payment_status === "successful")
    .reduce((sum, o) => sum + Number(o.payment_amount || 0), 0);
  const pendingPayments = orders.filter((o) => !o.payment_status || o.payment_status === "initiated").length;
  const failedPayments = orders.filter((o) => o.payment_status === "failed").length;

  return {
    profile: profileResult.rows[0],
    orders,
    summary: { totalOrders, totalRevenue, pendingPayments, failedPayments },
  };
}

module.exports = {
  listDistributors,
  approveDistributor,
  rejectDistributor,
  suspendDistributor,
  listTerritories,
  createTerritory,
  getReferralInfo,
  getDistributorHistory,
};
