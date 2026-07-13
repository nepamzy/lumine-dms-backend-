const db = require("../../config/db");

// Returns every distributor and customer that has a captured GPS location,
// for plotting on the admin map view. Users without lat/long (e.g. denied
// location permission at signup) are simply omitted — there's nothing to
// plot for them.
async function listMappableLocations() {
  const distributors = await db.query(
    `SELECT u.id AS user_id, u.full_name, u.state, u.local_government,
            u.latitude, u.longitude, u.status,
            d.id AS distributor_id, d.business_name, d.approval_status
     FROM users u
     JOIN distributors d ON d.user_id = u.id
     WHERE u.role = 'distributor' AND u.latitude IS NOT NULL AND u.longitude IS NOT NULL`
  );

  const customers = await db.query(
    `SELECT u.id AS user_id, u.full_name, u.state, u.local_government,
            u.latitude, u.longitude, u.status,
            cp.business_name, cp.customer_type, cp.delivery_address,
            cp.assigned_distributor_id
     FROM users u
     JOIN customer_profiles cp ON cp.user_id = u.id
     WHERE u.role = 'customer' AND u.latitude IS NOT NULL AND u.longitude IS NOT NULL`
  );

  return {
    distributors: distributors.rows.map((d) => ({
      type: "distributor",
      userId: d.user_id,
      distributorId: d.distributor_id,
      name: d.business_name || d.full_name,
      contactName: d.full_name,
      state: d.state,
      localGovernment: d.local_government,
      latitude: Number(d.latitude),
      longitude: Number(d.longitude),
      approvalStatus: d.approval_status,
    })),
    customers: customers.rows.map((c) => ({
      type: "customer",
      userId: c.user_id,
      name: c.business_name || c.full_name,
      contactName: c.full_name,
      state: c.state,
      localGovernment: c.local_government,
      latitude: Number(c.latitude),
      longitude: Number(c.longitude),
      customerType: c.customer_type,
      deliveryAddress: c.delivery_address,
      assignedDistributorId: c.assigned_distributor_id,
    })),
  };
}

module.exports = { listMappableLocations };
