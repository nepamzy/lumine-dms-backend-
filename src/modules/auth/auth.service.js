const bcrypt = require("bcrypt");
const db = require("../../config/db");
const ApiError = require("../../utils/ApiError");
const {
  signAccessToken,
  signRefreshToken,
  verifyRefreshToken,
} = require("../../utils/jwt");
const { generateUniqueReferralCode } = require("../../utils/referralCode");

// Finds the best distributor to auto-assign a new customer to, when they
// didn't sign up through a specific referral link. Prefers a distributor in
// the exact same LGA; falls back to same state if none found there. Among
// candidates, picks whoever currently has the fewest assigned customers, to
// spread new signups out rather than always picking the same distributor.
async function findClosestDistributor(client, { state, localGovernment }) {
  if (localGovernment) {
    const sameLga = await client.query(
      `SELECT d.id
       FROM distributors d
       JOIN users u ON u.id = d.user_id
       LEFT JOIN customer_profiles cp ON cp.assigned_distributor_id = d.id
       WHERE d.approval_status = 'approved' AND u.status = 'active' AND d.distributor_type = 'sales_rep'
         AND u.state = $1 AND u.local_government = $2
       GROUP BY d.id
       ORDER BY COUNT(cp.id) ASC
       LIMIT 1`,
      [state, localGovernment]
    );
    if (sameLga.rows.length > 0) return sameLga.rows[0].id;
  }

  const sameState = await client.query(
    `SELECT d.id
     FROM distributors d
     JOIN users u ON u.id = d.user_id
     LEFT JOIN customer_profiles cp ON cp.assigned_distributor_id = d.id
     WHERE d.approval_status = 'approved' AND u.status = 'active' AND d.distributor_type = 'sales_rep'
       AND u.state = $1
     GROUP BY d.id
     ORDER BY COUNT(cp.id) ASC
     LIMIT 1`,
    [state]
  );
  return sameState.rows.length > 0 ? sameState.rows[0].id : null;
}

const SALT_ROUNDS = 12;

async function register({ fullName, email, phone, password, role, state, latitude, longitude, localGovernment, extra = {}, registeredByDistributorId } = {}) {
  if (!["customer", "distributor"].includes(role)) {
    // Admins are created directly in the database / by another admin, never via public signup
    throw new ApiError(400, "Invalid role for self-registration");
  }

  // Location is requested at signup for Customers, Sales Reps, and
  // Distributors via the browser's own permission prompt, but it's
  // optional — declining or dismissing it doesn't block account creation.
  // Coordinates are simply stored as null if not provided.

  // Business name is mandatory for Customers, but stays optional for
  // Sales Reps (and true Distributors) — a sales rep may not run their
  // own registered business, but every customer account represents one.
  if (role === "customer" && !String(extra.businessName || "").trim()) {
    throw new ApiError(400, "Business name is required to sign up as a customer");
  }

  // Sales Reps and Distributors previously had no street-address field at
  // all — now mandatory for both at signup (Customers already have their
  // own "delivery address" field, so this doesn't apply to them).
  if (!registeredByDistributorId && role === "distributor" && !String(extra.address || "").trim()) {
    throw new ApiError(400, "Address is required to sign up as a sales rep or distributor");
  }

  const existing = await db.query(
    "SELECT id FROM users WHERE email = $1 AND deleted_at IS NULL",
    [email || null]
  );
  if (existing.rows.length > 0) {
    throw new ApiError(409, "Cannot sign up with this email — an account with it already exists.");
  }

  const passwordHash = await bcrypt.hash(password, SALT_ROUNDS);

  const client = await db.pool.connect();
  try {
    await client.query("BEGIN");

   const userResult = await client.query(
      `INSERT INTO users (full_name, email, phone, password_hash, role, state, local_government, status, latitude, longitude, location_captured_at, address)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
       RETURNING id, full_name, email, phone, role, state, local_government, status, created_at`,
      [
        fullName,
        email || null,
        phone,
        passwordHash,
        role,
        state,
        localGovernment || null,
        role === "distributor" ? "pending" : "active", // distributors need approval
        latitude || null,
        longitude || null,
        latitude && longitude ? new Date() : null,
        extra.address || null,
      ]
    );
    const user = userResult.rows[0];

    if (role === "distributor") {
      const distributorType = extra.distributorType === "distributor" ? "distributor" : "sales_rep";
      const referralCode = await generateUniqueReferralCode(client, extra.businessName || fullName);
      await client.query(
        `INSERT INTO distributors (user_id, territory_id, business_name, approval_status, referral_code, distributor_type)
         VALUES ($1, $2, $3, 'pending', $4, $5)`,
        [user.id, extra.territoryId || null, extra.businessName || null, referralCode, distributorType]
      );
    } else if (role === "customer") {
      // Referral link (?ref=CODE) takes priority. If the customer didn't come
      // through one, try to auto-assign the closest distributor by LGA/state.
      // A sales rep registering the customer directly (no-phone provision)
      // always wins over both — they're assigned straight to that rep.
      let assignedDistributorId = null;
      let referredByDistributorId = null;

      if (registeredByDistributorId) {
        assignedDistributorId = registeredByDistributorId;
      } else if (extra.referralCode) {
        const referrer = await client.query(
          `SELECT d.id
           FROM distributors d
           JOIN users u ON u.id = d.user_id
           WHERE d.referral_code = $1 AND d.approval_status = 'approved' AND u.status = 'active' AND d.distributor_type = 'sales_rep'`,
          [extra.referralCode]
        );
        if (referrer.rows.length > 0) {
          assignedDistributorId = referrer.rows[0].id;
          referredByDistributorId = referrer.rows[0].id;
        }
      }

      if (!assignedDistributorId) {
        assignedDistributorId = await findClosestDistributor(client, { state, localGovernment });
      }

      await client.query(
        `INSERT INTO customer_profiles (user_id, business_name, customer_type, delivery_address, assigned_distributor_id, referred_by_distributor_id, registered_by_distributor_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          user.id,
          extra.businessName || null,
          extra.customerType,
          extra.deliveryAddress,
          assignedDistributorId,
          referredByDistributorId,
          registeredByDistributorId || null,
        ]
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
  const result = await db.query(
    `SELECT u.*, cp.registered_by_distributor_id
     FROM users u
     LEFT JOIN customer_profiles cp ON cp.user_id = u.id
     WHERE u.email = $1 AND u.deleted_at IS NULL`,
    [email]
  );
  const user = result.rows[0];

  if (!user) {
    throw new ApiError(401, "Incorrect email or password");
  }

  const passwordMatches = await bcrypt.compare(password, user.password_hash);
  if (!passwordMatches) {
    throw new ApiError(401, "Incorrect email or password");
  }

  // Customers a sales rep registered directly (no-Android-phone provision)
  // are contact records only — they never get a real functioning account.
  // The sales rep places and pays for their own orders on these
  // customers' behalf entirely outside the login system.
  if (user.registered_by_distributor_id) {
    throw new ApiError(
      403,
      "This account was registered by a sales rep and doesn't have its own login — orders for it are placed by that sales rep."
    );
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
    `SELECT u.id, u.full_name, u.email, u.phone, u.role, u.state, u.local_government, u.status, u.created_at,
            u.location_captured_at, u.address,
            d.id AS distributor_id, d.referral_code, d.business_name AS distributor_business_name,
            d.distributor_type,
            d.approval_status,
            cp.business_name AS customer_business_name, cp.customer_type, cp.delivery_address,
            cp.acknowledged_payment_notice,
            cp.assigned_distributor_id, cp.referred_by_distributor_id
     FROM users u
     LEFT JOIN distributors d ON d.user_id = u.id
     LEFT JOIN customer_profiles cp ON cp.user_id = u.id
     WHERE u.id = $1 AND u.deleted_at IS NULL`,
    [userId]
  );
  if (result.rows.length === 0) throw new ApiError(404, "User not found");
  const user = result.rows[0];

  // Customers, Sales Reps, and Distributors are prompted (dismissibly) to
  // share their location if we don't have it on file — encouraged, not
  // required. Declining or dismissing doesn't affect account status.
  user.needsLocationConsent = !user.location_captured_at && user.role !== "admin";

  // Sales Reps and Distributors are prompted (dismissibly) to fill in a
  // street address if they don't have one on file yet.
  user.needsAddressPrompt = user.role === "distributor" && !user.address;

  return user;
}

// Lets an authenticated user submit their current GPS position — used both
// by the dismissible re-prompt for accounts with no location on file, and
// available for anyone to refresh their location later.
async function updateLocation(userId, { latitude, longitude }) {
  if (latitude == null || longitude == null) {
    throw new ApiError(400, "latitude and longitude are required");
  }
  await db.query(
    `UPDATE users SET latitude = $1, longitude = $2, location_captured_at = now() WHERE id = $3`,
    [latitude, longitude, userId]
  );
  return getCurrentUser(userId);
}
async function updateProfile(userId, updates) {
  const allowedUserFields = ["full_name", "phone", "state", "local_government", "address"];
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
async function acknowledgePaymentNotice(userId) {
  const result = await db.query(
    `UPDATE customer_profiles SET acknowledged_payment_notice = true WHERE user_id = $1 RETURNING *`,
    [userId]
  );
  if (result.rows.length === 0) throw new ApiError(404, "Customer profile not found");
  return result.rows[0];
}

module.exports = { register, login, refresh, logout, getCurrentUser, updateProfile, changePassword, acknowledgePaymentNotice, updateLocation };