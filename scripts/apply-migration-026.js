// One-time, idempotent migration runner invoked via npm's postinstall hook.
// Added because this project's Render plan doesn't include Shell access to
// run migrations by hand the normal way (node run-migration.js <URL> <file>,
// same as every other numbered migration here). Safe to leave in place: it's
// a no-op once the column it checks for already exists, and does nothing at
// all if DATABASE_URL isn't set (e.g. a contributor's first `npm install`
// before .env is configured).
const fs = require("fs");
const path = require("path");

const MIGRATION_FILE = "026_password_reset_otp.sql";
const CHECK_COLUMN = "reset_otp_hash";

async function main() {
  if (!process.env.DATABASE_URL) {
    console.log("[migrate] DATABASE_URL not set — skipping pending-migration check.");
    return;
  }

  const { Client } = require("pg");
  const client = new Client({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.NODE_ENV === "production" ? { rejectUnauthorized: false } : false,
  });

  await client.connect();
  try {
    const result = await client.query(
      `SELECT 1 FROM information_schema.columns WHERE table_name = 'users' AND column_name = $1`,
      [CHECK_COLUMN]
    );
    if (result.rows.length > 0) {
      console.log(`[migrate] ${MIGRATION_FILE} already applied — skipping.`);
      return;
    }
    const sql = fs.readFileSync(path.join(__dirname, "..", "migrations", MIGRATION_FILE), "utf8");
    console.log(`[migrate] Applying ${MIGRATION_FILE}...`);
    await client.query(sql);
    console.log(`[migrate] ${MIGRATION_FILE} applied successfully.`);
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  // Never fail the whole build/deploy over this — the app runs fine on the
  // old schema; only the new forgot-password endpoints need this column,
  // and a hard postinstall failure would take the entire deploy down.
  console.error("[migrate] Migration check failed:", err.message);
  process.exit(0);
});
