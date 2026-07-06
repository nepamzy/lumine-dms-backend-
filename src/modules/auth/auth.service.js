const bcrypt = require("bcrypt");
const db = require("../../config/db");
const ApiError = require("../../utils/ApiError");
const {
  signAccessToken,
  signRefreshToken,
  verifyRefreshToken,
} = require("../../utils/jwt");

const SALT_ROUNDS = 12;

async function register({ fullName, email, phone, password, role, state, latitude, longitude, extra = {} }) {
  if (!["customer", "distributor"].includes(role)) {
    // Admins are created directly in the database / by another admin, never via public signup
    throw new ApiError(400, "Invalid role for self-registration");
  }

  const existing = await db.query(
    "SELECT id FROM users WHERE email = $1 OR phone = $2",
    [email, phone]
  );
  if (existing.rows.length > 0) {
    throw new ApiError(409, "An account with this email or phone already exists");
  }

  const passwordHash = await bcrypt.hash(password, SALT_ROUNDS);

  const client = await db.pool.connect();
  try {
    await client.query("BEGIN");

   const userResult = await client.query(
      `INSERT INTO users (full_name, email, phone, password_hash, role, state, status, latitude, longitude, location_captured_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       RETURNING id, full_name, email, phone, role, state, status, created_at`,
      [
        fullName,
        email,
        phone,
        passwordHash,
        role,
        state,
        role === "distributor" ? "pending" : "active", // distributors need approval
        latitude || null,
        longitude || null,
        latitude && longitude ? new Date() : null,
      ]
    );
    const user = userResult.rows[0];

    if (role === "distributor") {
      await client.query(
        `INSERT INTO distributors (user_id, territory_id, business_name, approval_status)
         VALUES ($1, $2, $3, 'pending')`,
        [user.id, extra.territoryId || null, extra.businessName || null]
      );
    } else if (role === "customer") {
      await client.query(
        `INSERT INTO customer_profiles (user_id, business_name, customer_type, delivery_address)
         VALUES ($1, $2, $3, $4)`,
        [user.id, extra.businessName || null, extra.customerType, extra.deliveryAddress]
      );
    }

    await client.query("COMMIT");
    return user;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

async function login({ email, password }) {
  const result = await db.query("SELECT * FROM users WHERE email = $1", [email]);
  const user = result.rows[0];

  if (!user) {
    throw new ApiError(401, "Incorrect email or password");
  }

  const passwordMatches = await bcrypt.compare(password, user.password_hash);
  if (!passwordMatches) {
    throw new ApiError(401, "Incorrect email or password");
  }

  if (user.status === "suspended") {
    throw new ApiError(403, "This account has been suspended. Contact support.");
  }
  if (user.status === "pending") {
    throw new ApiError(403, "Your account is pending approval.");
  }

  const tokenPayload = { id: user.id, role: user.role };
  const accessToken = signAccessToken(tokenPayload);
  const refreshToken = signRefreshToken(tokenPayload);

  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7 days
  await db.query(
    `INSERT INTO sessions (user_id, refresh_token, expires_at) VALUES ($1, $2, $3)`,
    [user.id, refreshToken, expiresAt]
  );

  delete user.password_hash;
  return { user, accessToken, refreshToken };
}

async function refresh(refreshToken) {
  if (!refreshToken) throw new ApiError(401, "Refresh token required");

  let decoded;
  try {
    decoded = verifyRefreshToken(refreshToken);
  } catch {
    throw new ApiError(401, "Invalid or expired refresh token");
  }

  const sessionResult = await db.query(
    "SELECT * FROM sessions WHERE refresh_token = $1 AND user_id = $2",
    [refreshToken, decoded.id]
  );
  if (sessionResult.rows.length === 0) {
    throw new ApiError(401, "Session not found. Please log in again.");
  }

  const accessToken = signAccessToken({ id: decoded.id, role: decoded.role });
  return { accessToken };
}

async function logout(refreshToken) {
  if (refreshToken) {
    await db.query("DELETE FROM sessions WHERE refresh_token = $1", [refreshToken]);
  }
}

async function getCurrentUser(userId) {
  const result = await db.query(
    `SELECT id, full_name, email, phone, role, state, status, created_at FROM users WHERE id = $1`,
    [userId]
  );
  if (result.rows.length === 0) throw new ApiError(404, "User not found");
  return result.rows[0];
}
async function updateProfile(userId, updates) {
  const allowedUserFields = ["full_name", "phone", "state"];
  const fields = [];
  const values = [];
  let i = 1;

  for (const [key, value] of Object.entries(updates)) {
    const column = key.replace(/[A-Z]/g, (m) => "_" + m.toLowerCase());
    if (allowedUserFields.includes(column) && value !== undefined) {
      fields.push(`${column} = $${i}`);
      values.push(value);
      i++;
    }
  }

  if (fields.length > 0) {
    values.push(userId);
    await db.query(`UPDATE users SET ${fields.join(", ")} WHERE id = $${i}`, values);
  }

  // Business-specific fields live in customer_profiles / distributors,
  // update those too if provided.
  if (updates.businessName !== undefined || updates.deliveryAddress !== undefined || updates.customerType !== undefined) {
    const cpFields = [];
    const cpValues = [];
    let j = 1;
    if (updates.businessName !== undefined) {
      cpFields.push(`business_name = $${j++}`);
      cpValues.push(updates.businessName);
    }
    if (updates.deliveryAddress !== undefined) {
      cpFields.push(`delivery_address = $${j++}`);
      cpValues.push(updates.deliveryAddress);
    }
    if (updates.customerType !== undefined) {
      cpFields.push(`customer_type = $${j++}`);
      cpValues.push(updates.customerType);
    }
    if (cpFields.length > 0) {
      cpValues.push(userId);
      await db.query(
        `UPDATE customer_profiles SET ${cpFields.join(", ")} WHERE user_id = $${j}`,
        cpValues
      );
    }
  }

  if (updates.businessName !== undefined) {
    await db.query(
      `UPDATE distributors SET business_name = $1 WHERE user_id = $2`,
      [updates.businessName, userId]
    );
  }

  return getCurrentUser(userId);
}

async function changePassword(userId, currentPassword, newPassword) {
  if (!newPassword || newPassword.length < 8) {
    throw new ApiError(400, "New password must be at least 8 characters");
  }

  const result = await db.query("SELECT password_hash FROM users WHERE id = $1", [userId]);
  if (result.rows.length === 0) throw new ApiError(404, "User not found");

  const matches = await bcrypt.compare(currentPassword, result.rows[0].password_hash);
  if (!matches) throw new ApiError(401, "Current password is incorrect");

  const newHash = await bcrypt.hash(newPassword, SALT_ROUNDS);
  await db.query("UPDATE users SET password_hash = $1 WHERE id = $2", [newHash, userId]);
}
module.exports = { register, login, refresh, logout, getCurrentUser, updateProfile, changePassword };