// One-time, idempotent migration runner invoked via npm's postinstall hook.
// Added because this project's Render plan doesn't include Shell access to
// run migrations by hand the normal way (node run-migration.js <URL> <file>,
// same as every other numbered migration here). Safe to leave in place:
// each entry is a no-op once the column it checks for already exists, and
// the whole thing does nothing at all if DATABASE_URL isn't set (e.g. a
// contributor's first `npm install` before .env is configured).
//
// Add a new entry here whenever a migration needs to reach production and
// Shell access still isn't available — same {file, table, column} shape.
const fs = require("fs");
const path = require("path");

const PENDING_MIGRATIONS = [
  { file: "026_password_reset_otp.sql", table: "users", column: "reset_otp_hash" },
  { file: "027_distributor_hierarchy_and_subaccounts.sql", table: "distributors", column: "registered_by_distributor_id" },
];

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
    for (const migration of PENDING_MIGRATIONS) {
      const result = await client.query(
        `SELECT 1 FROM information_schema.columns WHERE table_name = $1 AND column_name = $2`,
        [migration.table, migration.column]
      );
      if (result.rows.length > 0) {
        console.log(`[migrate] ${migration.file} already applied — skipping.`);
        continue;
      }
      const sql = fs.readFileSync(path.join(__dirname, "..", "migrations", migration.file), "utf8");
      console.log(`[migrate] Applying ${migration.file}...`);
      await client.query(sql);
      console.log(`[migrate] ${migration.file} applied successfully.`);
    }
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  // Never fail the whole build/deploy over this — the app runs fine on the
  // old schema; only features that depend on the missing column are
  // affected, and a hard postinstall failure would take the entire deploy
  // down over what's usually a transient DB connectivity hiccup.
  console.error("[migrate] Migration check failed:", err.message);
  process.exit(0);
});
