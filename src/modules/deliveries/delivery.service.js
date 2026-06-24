const db = require("../../config/db");
const ApiError = require("../../utils/ApiError");
const { notifyDelivered } = require("../notifications/notification.service");

// Creates the delivery record once an order is paid and a distributor is assigned.
// Called when an order moves to 'processing' (admin/distributor action).
async function createDelivery(orderId) {
  const orderResult = await db.query("SELECT * FROM orders WHERE id = $1", [orderId]);
  if (orderResult.rows.length === 0) throw new ApiError(404, "Order not found");
  const order = orderResult.rows[0];

  if (!order.distributor_id) {
    throw new ApiError(400, "Order has no distributor assigned yet");
  }

  const existing = await db.query("SELECT id FROM deliveries WHERE order_id = $1", [orderId]);
  if (existing.rows.length > 0) {
    throw new ApiError(409, "A delivery record already exists for this order");
  }

  const result = await db.query(
    `INSERT INTO deliveries (order_id, distributor_id, gps_status)
     VALUES ($1, $2, 'assigned') RETURNING *`,
    [orderId, order.distributor_id]
  );
  return result.rows[0];
}

async function getDeliveryByOrderId(orderId) {
  const result = await db.query("SELECT * FROM deliveries WHERE order_id = $1", [orderId]);
  if (result.rows.length === 0) throw new ApiError(404, "Delivery record not found");
  return result.rows[0];
}

// Called by the distributor's device/app, frequently, while a delivery is in transit.
async function updateGpsPosition(orderId, distributorUserId, { lat, lng }) {
  if (lat === undefined || lng === undefined) {
    throw new ApiError(400, "lat and lng are required");
  }

  const delivery = await getDeliveryByOrderId(orderId);
  await assertOwnsDelivery(delivery, distributorUserId);

  const result = await db.query(
    `UPDATE deliveries
     SET current_lat = $1, current_lng = $2,
         gps_status = CASE WHEN gps_status = 'assigned' THEN 'in_transit' ELSE gps_status END,
         updated_at = now()
     WHERE order_id = $3
     RETURNING *`,
    [lat, lng, orderId]
  );
  return result.rows[0];
}

async function assertOwnsDelivery(delivery, distributorUserId) {
  const distResult = await db.query("SELECT id FROM distributors WHERE user_id = $1", [
    distributorUserId,
  ]);
  if (distResult.rows.length === 0 || distResult.rows[0].id !== delivery.distributor_id) {
    throw new ApiError(403, "This delivery isn't assigned to you");
  }
}

// Marks delivery complete and cascades the order status to 'delivered' in
// the same operation, so the two never drift out of sync.
async function markDelivered(orderId, actingUser) {
  const delivery = await getDeliveryByOrderId(orderId);

  if (actingUser.role === "distributor") {
    await assertOwnsDelivery(delivery, actingUser.id);
  } else if (actingUser.role !== "admin") {
    throw new ApiError(403, "Only the assigned distributor or an admin can do this");
  }

  if (delivery.gps_status === "delivered") {
    throw new ApiError(400, "This delivery is already marked as delivered");
  }

  const client = await db.pool.connect();
  try {
    await client.query("BEGIN");

    const deliveryResult = await client.query(
      `UPDATE deliveries SET gps_status = 'delivered', delivered_at = now(), updated_at = now()
       WHERE order_id = $1 RETURNING *`,
      [orderId]
    );

    await client.query(
      `UPDATE orders SET status = 'delivered', updated_at = now() WHERE id = $1`,
      [orderId]
    );

    await client.query("COMMIT");

    const orderResult = await db.query("SELECT customer_id, order_number FROM orders WHERE id = $1", [
      orderId,
    ]);
    notifyDelivered(orderResult.rows[0], orderResult.rows[0].customer_id).catch(() => {});

    return deliveryResult.rows[0];
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

async function markFailed(orderId, actingUser, reason) {
  const delivery = await getDeliveryByOrderId(orderId);

  if (actingUser.role === "distributor") {
    await assertOwnsDelivery(delivery, actingUser.id);
  } else if (actingUser.role !== "admin") {
    throw new ApiError(403, "Only the assigned distributor or an admin can do this");
  }

  const result = await db.query(
    `UPDATE deliveries SET gps_status = 'failed', updated_at = now() WHERE order_id = $1 RETURNING *`,
    [orderId]
  );
  return result.rows[0];
}

// Lists active deliveries for a distributor's "today's route" view
async function listForDistributor(distributorUserId) {
  const distResult = await db.query("SELECT id FROM distributors WHERE user_id = $1", [
    distributorUserId,
  ]);
  if (distResult.rows.length === 0) throw new ApiError(404, "Distributor profile not found");

  const result = await db.query(
    `SELECT d.*, o.order_number, o.total_amount, cp.delivery_address
     FROM deliveries d
     JOIN orders o ON o.id = d.order_id
     JOIN customer_profiles cp ON cp.user_id = o.customer_id
     WHERE d.distributor_id = $1 AND d.gps_status IN ('assigned','in_transit')
     ORDER BY d.updated_at ASC`,
    [distResult.rows[0].id]
  );
  return result.rows;
}

module.exports = {
  createDelivery,
  getDeliveryByOrderId,
  updateGpsPosition,
  markDelivered,
  markFailed,
  listForDistributor,
};
