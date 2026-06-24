const db = require("../../config/db");
const ApiError = require("../../utils/ApiError");

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

module.exports = {
  listDistributors,
  approveDistributor,
  rejectDistributor,
  suspendDistributor,
  listTerritories,
  createTerritory,
};
