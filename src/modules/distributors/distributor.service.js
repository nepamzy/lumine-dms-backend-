const db = require("../../config/db");
const ApiError = require("../../utils/ApiError");
const { notifyDistributorApproved, notify } = require("../notifications/notification.service");
const { paystackClient } = require("../../config/paystack");

// Lazily required to avoid a require-cycle at module-load time (auth.service
// doesn't depend on distributor.service, so this is safe either way, but
// lazy keeps the dependency direction obvious).
function authService() {
  return require("../auth/auth.service");
}

// Requires the caller to be a TRUE distributor (never a sales rep — only a
// true distributor gets a Paystack subaccount, since only their affiliated
// customers/reps' payments ever need to split away from main). Returns the
// distributor row.
async function requireTrueDistributor(userId) {
  const distResult = await db.query(
    `SELECT id, business_name, distributor_type, paystack_subaccount_code, paystack_settlement_bank,
            paystack_account_number, paystack_account_name
     FROM distributors WHERE user_id = $1`,
    [userId]
  );
  if (distResult.rows.length === 0) throw new ApiError(404, "Distributor profile not found");
  const dist = distResult.rows[0];
  if (dist.distributor_type !== "distributor") {
    throw new ApiError(403, "Only distributors can manage a payout bank account");
  }
  return dist;
}

// Nigerian bank list, cached in-process — it changes rarely and Paystack
// itself recommends caching it rather than calling /bank on every page
// load. Refreshed at most once an hour.
let bankListCache = null;
let bankListCachedAt = 0;
const BANK_LIST_CACHE_MS = 60 * 60 * 1000;

async function listBanks() {
  if (!process.env.PAYSTACK_SECRET_KEY) {
    throw new ApiError(503, "Payments aren't connected yet — Paystack isn't configured. Contact support.");
  }
  if (bankListCache && Date.now() - bankListCachedAt < BANK_LIST_CACHE_MS) {
    return bankListCache;
  }
  let response;
  try {
    response = await paystackClient().get("/bank", { params: { country: "nigeria", currency: "NGN" } });
  } catch (err) {
    if (bankListCache) return bankListCache; // stale cache beats a hard failure
    throw new ApiError(502, "Could not load the bank list from Paystack. Please try again.");
  }
  bankListCache = (response.data.data || []).map((b) => ({ name: b.name, code: b.code }));
  bankListCachedAt = Date.now();
  return bankListCache;
}

// Free — resolves an account number + bank code to the account holder's
// name via Paystack, WITHOUT creating or changing anything. Lets the
// distributor see who they're about to attach as their payout account
// before confirming. Never trust a client-supplied account name for the
// actual subaccount creation below — always re-resolve server-side there.
async function resolveBankAccount(userId, { bankCode, accountNumber }) {
  await requireTrueDistributor(userId);
  if (!process.env.PAYSTACK_SECRET_KEY) {
    throw new ApiError(503, "Payments aren't connected yet — Paystack isn't configured. Contact support.");
  }
  if (!bankCode || !accountNumber) {
    throw new ApiError(400, "Bank and account number are required");
  }
  let response;
  try {
    response = await paystackClient().get("/bank/resolve", {
      params: { account_number: accountNumber, bank_code: bankCode },
    });
  } catch (err) {
    throw new ApiError(
      400,
      err.response?.data?.message || "Couldn't verify that account. Please check the details and try again."
    );
  }
  return { accountNumber: response.data.data.account_number, accountName: response.data.data.account_name };
}

// Creates the distributor's Paystack subaccount — only after they've seen
// the resolved account name (via resolveBankAccount above) and explicitly
// confirmed. percentage_charge: 0 means 0% of every split transaction goes
// to Paystack's main/platform account — 100% goes to this subaccount (see
// Paystack's subaccount docs: percentage_charge is the MAIN account's cut).
// Re-resolves the account name itself rather than trusting whatever the
// client sends back from the earlier verify step, so a tampered client
// can never register a subaccount under a name that doesn't actually match
// the bank's own records for that account number.
async function createSubaccountForDistributor(userId, { bankCode, accountNumber }) {
  const dist = await requireTrueDistributor(userId);
  if (!process.env.PAYSTACK_SECRET_KEY) {
    throw new ApiError(503, "Payments aren't connected yet — Paystack isn't configured. Contact support.");
  }
  if (!bankCode || !accountNumber) {
    throw new ApiError(400, "Bank and account number are required");
  }

  const resolved = await resolveBankAccount(userId, { bankCode, accountNumber });

  let response;
  try {
    response = await paystackClient().post("/subaccount", {
      business_name: dist.business_name || resolved.accountName,
      settlement_bank: bankCode,
      account_number: accountNumber,
      percentage_charge: 0,
    });
  } catch (err) {
    throw new ApiError(
      400,
      err.response?.data?.message || "Couldn't set up your payout account with Paystack. Please try again."
    );
  }

  const subaccountCode = response.data.data.subaccount_code;
  await db.query(
    `UPDATE distributors
     SET paystack_subaccount_code = $1, paystack_settlement_bank = $2,
         paystack_account_number = $3, paystack_account_name = $4
     WHERE id = $5`,
    [subaccountCode, bankCode, accountNumber, resolved.accountName, dist.id]
  );

  return {
    subaccountCode,
    bankCode,
    accountNumber,
    accountName: resolved.accountName,
  };
}

// Read-only status for the distributor's own dashboard — never re-fetches
// from Paystack, just reflects what's on file.
async function getPayoutAccountStatus(userId) {
  const dist = await requireTrueDistributor(userId);
  return {
    configured: !!dist.paystack_subaccount_code,
    settlementBank: dist.paystack_settlement_bank || null,
    accountNumber: dist.paystack_account_number || null,
    accountName: dist.paystack_account_name || null,
  };
}

// Registers a customer directly on behalf of the caller — for people
// without an Android phone / who can't do the signup flow themselves. Same
// fields and rules as a normal customer signup (business name still
// mandatory), except location isn't required and the customer is
// auto-assigned straight to the caller. Callable by a sales rep (existing
// behavior) or a true distributor (new — distributors can now build their
// own customer book directly, same as a sales rep always could).
async function registerCustomerForRep(callerUserId, payload) {
  const repResult = await db.query(
    `SELECT id, distributor_type FROM distributors WHERE user_id = $1`,
    [callerUserId]
  );
  if (repResult.rows.length === 0) {
    console.error("registerCustomerForRep blocked: no distributors row found for user_id", callerUserId);
    throw new ApiError(403, "Only sales reps and distributors can register a customer directly");
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

// Distributor-only (never a sales rep — a sales rep doesn't manage other
// reps): onboards a new sales rep directly. Unlike registerCustomerForRep,
// this creates a REAL, real account — the new rep needs to actually log in
// and work — so email/phone/password all come from the form the
// distributor fills in on their behalf, and the rep can change the
// password later (or use forgot-password if they don't know what was set).
// Auto-approved and immediately active — the registering distributor is
// vouching for them, same as their own customer registrations never
// needing separate admin approval.
async function registerSalesRepForDistributor(distributorUserId, payload) {
  const distResult = await db.query(
    `SELECT id, distributor_type FROM distributors WHERE user_id = $1`,
    [distributorUserId]
  );
  const isTrueDistributor =
    distResult.rows.length > 0 &&
    String(distResult.rows[0].distributor_type || "").trim().toLowerCase() === "distributor";
  if (!isTrueDistributor) {
    throw new ApiError(403, "Only distributors can register a sales rep directly");
  }

  const { fullName, email, phone, password, state, localGovernment, businessName, address } = payload;
  if (!fullName || !email || !phone || !password || !state) {
    throw new ApiError(400, "Full name, email, phone, password, and state are required");
  }
  if (password.length < 8) {
    throw new ApiError(400, "Password must be at least 8 characters");
  }

  return authService().register({
    fullName,
    email,
    phone,
    password,
    role: "distributor",
    state,
    localGovernment,
    extra: { distributorType: "sales_rep", businessName, address },
    registeredByDistributorId: distResult.rows[0].id,
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
            u.full_name, u.email, u.phone, u.state, u.local_government, u.address, u.status AS user_status,
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
     WHERE o.distributor_id = $1 AND o.deleted_at IS NULL
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

// The caller's own book of customers with a real account — used to pick
// who they're placing an order on behalf of. Both a sales rep and a true
// distributor can have one now (a distributor's own customer book, per
// their direct registration power).
async function listMyCustomers(userId) {
  const distResult = await db.query(
    "SELECT id, distributor_type FROM distributors WHERE user_id = $1",
    [userId]
  );
  if (distResult.rows.length === 0) throw new ApiError(404, "Distributor profile not found");
  const dist = distResult.rows[0];

  const result = await db.query(
    `SELECT u.id, u.full_name, u.email, u.phone, cp.business_name
     FROM customer_profiles cp
     JOIN users u ON u.id = cp.user_id
     WHERE cp.assigned_distributor_id = $1 AND cp.registered_by_distributor_id IS NULL
       AND u.deleted_at IS NULL
     ORDER BY u.full_name ASC`,
    [dist.id]
  );
  return result.rows;
}

async function requireSalesRepDistributorId(userId) {
  const distResult = await db.query("SELECT id, distributor_type FROM distributors WHERE user_id = $1", [userId]);
  if (distResult.rows.length === 0) throw new ApiError(404, "Distributor profile not found");
  if (distResult.rows[0].distributor_type !== "sales_rep") {
    throw new ApiError(403, "Only sales reps have a customer book");
  }
  return distResult.rows[0].id;
}

// Every customer this rep is either currently assigned, or has ever
// fulfilled an order for — broader than listMyCustomers (which only shows
// current assignments and excludes proxy-registered walk-ins), because
// Track Record needs to keep showing a customer's history even after
// they've been reassigned or removed, not just make them disappear.
async function listTrackRecordCustomers(userId) {
  const distributorId = await requireSalesRepDistributorId(userId);

  const result = await db.query(
    `SELECT DISTINCT u.id, u.full_name, u.email, u.phone, cp.business_name,
            (cp.assigned_distributor_id = $1) AS currently_assigned
     FROM users u
     JOIN customer_profiles cp ON cp.user_id = u.id
     WHERE u.deleted_at IS NULL AND u.role = 'customer'
       AND (
         cp.assigned_distributor_id = $1
         OR EXISTS (
           SELECT 1 FROM orders o WHERE o.customer_id = u.id AND o.distributor_id = $1 AND o.deleted_at IS NULL
         )
       )
     ORDER BY u.full_name ASC`,
    [distributorId]
  );
  return result.rows;
}

// One customer's order history as this rep should see it: full detail if
// they're still assigned to this rep, but only their 100%-paid orders if
// they've since been reassigned elsewhere or removed — the reassigned-away
// customer keeps showing up in Track Record, just without their unpaid
// history following them around a rep they're no longer with.
async function getCustomerHistoryForRep(userId, customerId) {
  const distributorId = await requireSalesRepDistributorId(userId);

  const customerResult = await db.query(
    `SELECT u.id, u.full_name, u.email, u.phone, cp.business_name,
            (cp.assigned_distributor_id = $1) AS currently_assigned
     FROM users u
     JOIN customer_profiles cp ON cp.user_id = u.id
     WHERE u.id = $2 AND u.deleted_at IS NULL AND u.role = 'customer'`,
    [distributorId, customerId]
  );
  if (customerResult.rows.length === 0) throw new ApiError(404, "Customer not found");
  const customer = customerResult.rows[0];

  const ordersResult = await db.query(
    `SELECT o.id, o.order_number, o.status, o.total_amount, o.created_at,
            COALESCE((SELECT SUM(amount) FROM order_payments WHERE order_id = o.id AND status = 'successful'), 0) AS paid_amount
     FROM orders o
     WHERE o.customer_id = $1 AND o.distributor_id = $2 AND o.deleted_at IS NULL
     ORDER BY o.created_at DESC`,
    [customerId, distributorId]
  );

  let orders = ordersResult.rows.map((o) => ({
    ...o,
    payment_percent: Number(o.total_amount) > 0 ? (Number(o.paid_amount) / Number(o.total_amount)) * 100 : 0,
  }));
  if (!customer.currently_assigned) {
    orders = orders.filter((o) => o.payment_percent >= 100);
  }

  return { customer, orders };
}

// Admin-only. A sales rep's Target Overview for one calendar month: every
// order that's been through the monthly sweep (moved_to_target_overview_at
// set), credited to whichever month it actually reached 100% paid
// (paid_in_full_at) -- not the month it was placed. Attribution is by
// orders.distributor_id, frozen at order-creation time, same rule as
// getCustomerHistoryForRep above -- a rep keeps credit for a sale even if
// the customer is later reassigned to someone else.
async function getTargetOverviewForRep(distributorId, year, month) {
  const monthStart = new Date(Date.UTC(year, month - 1, 1));
  const monthEnd = new Date(Date.UTC(year, month, 1));

  const result = await db.query(
    `SELECT o.id, o.order_number, o.total_amount, o.paid_in_full_at, o.created_at,
            u.full_name AS customer_name, cp.business_name AS customer_business_name
     FROM orders o
     JOIN users u ON u.id = o.customer_id
     LEFT JOIN customer_profiles cp ON cp.user_id = o.customer_id
     WHERE o.distributor_id = $1
       AND o.moved_to_target_overview_at IS NOT NULL
       AND o.paid_in_full_at >= $2 AND o.paid_in_full_at < $3
       AND o.deleted_at IS NULL
     ORDER BY o.paid_in_full_at DESC`,
    [distributorId, monthStart, monthEnd]
  );

  const orders = result.rows;
  const totalRevenue = orders.reduce((sum, o) => sum + Number(o.total_amount), 0);

  return {
    orders,
    summary: { totalOrders: orders.length, totalRevenue },
  };
}

// Sends an SMS nudging a customer to complete payment on an order — the
// sales rep's "Ping" action in Track Record. Reuses the existing generic
// notify() (same Termii SMS path every other notification already goes
// through), so it needs no new provider code.
async function pingCustomer(userId, customerId, orderId) {
  const distributorId = await requireSalesRepDistributorId(userId);

  const orderResult = await db.query(
    `SELECT order_number FROM orders WHERE id = $1 AND customer_id = $2 AND distributor_id = $3 AND deleted_at IS NULL`,
    [orderId, customerId, distributorId]
  );
  if (orderResult.rows.length === 0) throw new ApiError(404, "Order not found for this customer");

  const customerResult = await db.query(`SELECT full_name FROM users WHERE id = $1`, [customerId]);
  if (customerResult.rows.length === 0) throw new ApiError(404, "Customer not found");

  await notify({
    userId: customerId,
    type: "payment_reminder",
    channel: "sms",
    message: `Hi ${customerResult.rows[0].full_name}, this is Lumine. You have an outstanding balance on order ${orderResult.rows[0].order_number}. Please complete payment soon to keep your account in good standing. Thank you!`,
  });
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

// Admin-only. Reverses a soft-delete for any role (customer, distributor,
// sales rep) — the operation itself doesn't need to be role-specific.
// Checks first whether a newer account has since taken the same email or
// phone (the partial-unique index only applies to non-deleted rows, so
// that's allowed to happen once this one's gone) — restoring would violate
// that index, so this rejects clearly instead of letting the UPDATE throw
// a raw DB error.
async function restoreUser(userId) {
  const userResult = await db.query(`SELECT id, email, phone, deleted_at FROM users WHERE id = $1`, [userId]);
  if (userResult.rows.length === 0) throw new ApiError(404, "User not found");
  const user = userResult.rows[0];
  if (!user.deleted_at) throw new ApiError(400, "User is not deleted");

  const conflict = await db.query(
    `SELECT id FROM users WHERE (email = $1 OR phone = $2) AND deleted_at IS NULL AND id != $3`,
    [user.email, user.phone, userId]
  );
  if (conflict.rows.length > 0) {
    throw new ApiError(
      409,
      "Can't restore — a newer account already uses this email or phone. Remove or change that account first."
    );
  }

  const result = await db.query(`UPDATE users SET deleted_at = NULL WHERE id = $1 RETURNING id`, [userId]);
  return result.rows[0];
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
  listTrackRecordCustomers,
  getCustomerHistoryForRep,
  getTargetOverviewForRep,
  pingCustomer,
  removeDistributor,
  listTrash,
  restoreUser,
  registerCustomerForRep,
  registerSalesRepForDistributor,
  listBanks,
  resolveBankAccount,
  createSubaccountForDistributor,
  getPayoutAccountStatus,
};
