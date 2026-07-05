const db = require("../../config/db");

async function listCustomers() {
  const result = await db.query(
    `SELECT u.id, u.full_name, u.email, u.phone, u.state, u.status, u.created_at,
            cp.business_name, cp.customer_type, cp.delivery_address
     FROM users u
     LEFT JOIN customer_profiles cp ON cp.user_id = u.id
     WHERE u.role = 'customer'
     ORDER BY u.created_at DESC`
  );
  return result.rows;
}

module.exports = { listCustomers };