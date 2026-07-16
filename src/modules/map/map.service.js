const db = require("../../config/db");

// Returns every distributor, sales rep, and customer with a captured GPS
// location, for the admin map view. Users without lat/long (e.g. denied
// location permission at signup) are simply omitted, as are soft-deleted
// accounts — nothing to plot for either.
//
// For sales reps specifically, "location" prefers their most recent
// delivery GPS ping (order_location_updates, captured each time they
// update a delivery en route) over their static signup location — that's
// the closest thing to a live position this system tracks, since it
// doesn't run continuous background GPS. If they have no recent ping, it
// falls back to their registration location.
async function listMappableLocations() {
  const distributors = await db.query(
    `SELECT u.id AS user_id, u.full_name, u.state, u.local_government,
            u.latitude, u.longitude, u.status,
            d.id AS distributor_id, d.business_name, d.approval_status
     FROM users u
     JOIN distributors d ON d.user_id = u.id
     WHERE u.role = 'distributor' AND d.distributor_type = 'distributor'
       AND u.deleted_at IS NULL AND u.latitude IS NOT NULL AND u.longitude IS NOT NULL`
  );

  const salesReps = await db.query(
    `SELECT u.id AS user_id, u.full_name, u.state, u.local_government,
            u.latitude AS reg_latitude, u.longitude AS reg_longitude, u.status,
            d.id AS distributor_id, d.business_name, d.approval_status,
            latest_ping.latitude AS ping_latitude, latest_ping.longitude AS ping_longitude,
            latest_ping.recorded_at AS ping_recorded_at
     FROM users u
     JOIN distributors d ON d.user_id = u.id
     LEFT JOIN LATERAL (
       SELECT olu.latitude, olu.longitude, olu.recorded_at
       FROM order_location_updates olu
       JOIN orders o ON o.id = olu.order_id
       WHERE o.distributor_id = d.id
       ORDER BY olu.recorded_at DESC
       LIMIT 1
     ) latest_ping ON true
     WHERE u.role = 'distributor' AND d.distributor_type = 'sales_rep'
       AND u.deleted_at IS NULL
       AND (u.latitude IS NOT NULL OR latest_ping.latitude IS NOT NULL)`
  );

  const customers = await db.query(
    `SELECT u.id AS user_id, u.full_name, u.state, u.local_government,
            u.latitude, u.longitude, u.status,
            cp.business_name, cp.customer_type, cp.delivery_address,
            cp.assigned_distributor_id
     FROM users u
     JOIN customer_profiles cp ON cp.user_id = u.id
     WHERE u.role = 'customer' AND u.deleted_at IS NULL
       AND u.latitude IS NOT NULL AND u.longitude IS NOT NULL`
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
    salesReps: salesReps.rows.map((s) => {
      const usingPing = s.ping_latitude != null;
      return {
        type: "sales_rep",
        userId: s.user_id,
        distributorId: s.distributor_id,
        name: s.business_name || s.full_name,
        contactName: s.full_name,
        state: s.state,
        localGovernment: s.local_government,
        latitude: Number(usingPing ? s.ping_latitude : s.reg_latitude),
        longitude: Number(usingPing ? s.ping_longitude : s.reg_longitude),
        approvalStatus: s.approval_status,
        locationSource: usingPing ? "delivery_ping" : "registration",
        lastSeenAt: usingPing ? s.ping_recorded_at : null,
      };
    }),
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
