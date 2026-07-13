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

module.exports = { listCustomers, reassignDistributor };
