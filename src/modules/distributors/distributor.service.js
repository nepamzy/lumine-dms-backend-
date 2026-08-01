const db = require("../../config/db");
const ApiError = require("../../utils/ApiError");
const { notifyDistributorApproved } = require("../notifications/notification.service");

// Lazily required to avoid a require-cycle at module-load time (auth.service
// doesn't depend on distributor.service, so this is safe either way, but
// lazy keeps the dependency direction obvious).
function authService() {
  return require("../auth/auth.service");
}

// Sales-rep-only: registers a customer directly on their behalf — for
// people without an Android phone / who can't do the signup flow
// themselves. Same fields and rules as a normal customer signup (business
// name still mandatory), except location isn't required and the customer
// is auto-assigned straight to this rep.
async function registerCustomerForRep(salesRepUserId, payload) {
  const repResult = await db.query(
    `SELECT id, distributor_type FROM distributors WHERE user_id = $1`,
    [salesRepUserId]
  );
  const isSalesRep =
    repResult.rows.length > 0 &&
    String(repResult.rows[0].distributor_type || "").trim().toLowerCase() === "sales_rep";
  if (!isSalesRep) {
    console.error(
      "registerCustomerForRep blocked:",
      repResult.rows.length === 0
        ? `no distributors row found for user_id ${salesRepUserId}`
        : `distributor_type was "${repResult.rows[0].distributor_type}"`
    );
    throw new ApiError(403, "Only sales reps can register a customer directly");
  }

  const { businessName, customerType, deliveryAddress, password, ...rest } = payload;

  // This is a contact record, not a functioning account — the customer
  // never logs in themselves, so the password is random and never shared
  // anywhere. login() also explicitly blocks these accounts as a second
  // layer, but not issuing a real password is the first line of defense.
  const crypto = require("crypto");
  const randomPassword = crypto.randomBytes(24).toString("hex");

  return authService().register({
    ...rest,
    password: randomPassword,
    role: "customer",
    extra: { businessName, customerType, deliveryAddress },
    registeredByDistributorId: repResult.rows[0].id,
  });
}

async function listDistributors({ status, distributorType } = {}) {
  const conditions = ["u.deleted_at IS NULL"];
  const params = [];
  if (status) {
    params.push(status);
    conditions.push(`d.approval_status = $${params.length}`);
  }
  if (distributorType) {
    params.push(distributorType);
    conditions.push(`d.distributor_type = $${params.length}`);
  }
  const where = `WHERE ${conditions.join(" AND ")}`;

  const result = await db.query(
    `SELECT d.*, u.full_name, u.email, u.phone, u.state, u.status AS user_status, t.name AS territory_name,
            (SELECT COUNT(*) FROM users u2 WHERE u2.email = u.email AND u2.deleted_at IS NOT NULL) AS prior_accounts_count
     FROM distributors d
     JOIN users u ON u.id = d.user_id
     LEFT JOIN territories t ON t.id = d.territory_id
     ${where}
     ORDER BY d.created_at DESC`,
    params
  );
  return result.rows;
}

// Soft-delete — see removeCustomer in customer.service.js for the full
// rationale. Works for both a sales rep and a true distributor; the row
// stays in `distributors` untouched, only the linked `users` row is marked
// deleted, which is what every list/lookup filters on.
async function removeDistributor(distributorId) {
  const dist = await db.query("SELECT user_id FROM distributors WHERE id = $1", [distributorId]);
  if (dist.rows.length === 0) throw new ApiError(404, "Distributor not found");

  const result = await db.query(
    `UPDATE users SET deleted_at = now() WHERE id = $1 AND deleted_at IS NULL RETURNING id`,
    [dist.rows[0].user_id]
  );
  if (result.rows.length === 0) throw new ApiError(400, "Already removed");
  return result.rows[0];
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
            del.gps_status AS delivery_status,
            cu.full_name AS customer_full_name, cp.business_name AS customer_business_name,
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
     LEFT JOIN users cu ON cu.id = o.customer_id
     LEFT JOIN customer_profiles cp ON cp.user_id = o.customer_id
     WHERE o.distributor_id = $1
     ORDER BY o.created_at DESC`,
    [distributorId]
  );

  const orders = ordersResult.rows.map((o) => ({
    ...o,
    payment_percent: Number(o.total_amount) > 0 ? (Number(o.paid_amount) / Number(o.total_amount)) * 100 : 0,
  }));
  const totalOrders = orders.length;
  const totalRevenue = orders.reduce((sum, o) => sum + Number(o.paid_amount || 0), 0);
  const pendingPayments = orders.filter((o) => o.payment_percent < 100).length;
  const failedPayments = 0;

  return {
    profile: profileResult.rows[0],
    orders,
    summary: { totalOrders, totalRevenue, pendingPayments, failedPayments },
  };
}

// A sales rep's own book of customers — used to pick who they're placing
// an order on behalf of. Never exposed to a true distributor (they don't
// manage customers at all).
async function listMyCustomers(userId) {
  const distResult = await db.query(
    "SELECT id, distributor_type FROM distributors WHERE user_id = $1",
    [userId]
  );
  if (distResult.rows.length === 0) throw new ApiError(404, "Distributor profile not found");
  const dist = distResult.rows[0];
  if (dist.distributor_type !== "sales_rep") {
    throw new ApiError(403, "Only sales reps have a customer book");
  }

  const result = await db.query(
    `SELECT u.id, u.full_name, u.email, u.phone, cp.business_name
     FROM customer_profiles cp
     JOIN users u ON u.id = cp.user_id
     WHERE cp.assigned_distributor_id = $1 AND cp.registered_by_distributor_id IS NULL
     ORDER BY u.full_name ASC`,
    [dist.id]
  );
  return result.rows;
}

// Everything currently in the trash — customers, sales reps, and
// distributors together, admin-only. Nothing here is destroyed; this is
// purely a visibility view.
async function listTrash() {
  const result = await db.query(
    `SELECT u.id, u.full_name, u.email, u.phone, u.role, u.deleted_at,
            d.business_name AS distributor_business_name, d.distributor_type,
            cp.business_name AS customer_business_name
     FROM users u
     LEFT JOIN distributors d ON d.user_id = u.id
     LEFT JOIN customer_profiles cp ON cp.user_id = u.id
     WHERE u.deleted_at IS NOT NULL
     ORDER BY u.deleted_at DESC`
  );
  return result.rows;
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
  listMyCustomers,
  removeDistributor,
  listTrash,
  registerCustomerForRep,
};
