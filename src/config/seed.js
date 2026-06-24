// Run once after migration: node src/config/seed.js
// Creates the first Admin account (admin signup is intentionally not public)
// and a starter set of territories so distributor auto-assignment has
// something to match against from day one.
require("dotenv").config();
const bcrypt = require("bcrypt");
const db = require("./db");

const ADMIN_EMAIL = process.env.SEED_ADMIN_EMAIL || "admin@lumine.ng";
const ADMIN_PASSWORD = process.env.SEED_ADMIN_PASSWORD || "ChangeMe123!";

const STARTER_TERRITORIES = [
  { name: "Kaduna Metro", state: "Kaduna" },
  { name: "Abuja Central", state: "Abuja" },
  { name: "Lagos Mainland", state: "Lagos" },
  { name: "Lagos Island", state: "Lagos" },
  { name: "Kano Metro", state: "Kano" },
  { name: "Rivers (Port Harcourt)", state: "Rivers" },
  { name: "Oyo (Ibadan)", state: "Oyo" },
];

async function seed() {
  console.log("Seeding Lumine DMS...");

  const existingAdmin = await db.query("SELECT id FROM users WHERE role = 'admin' LIMIT 1");
  if (existingAdmin.rows.length === 0) {
    const passwordHash = await bcrypt.hash(ADMIN_PASSWORD, 12);
    await db.query(
      `INSERT INTO users (full_name, email, phone, password_hash, role, state, status)
       VALUES ('Lumine Admin', $1, '+2340000000000', $2, 'admin', 'Kaduna', 'active')`,
      [ADMIN_EMAIL, passwordHash]
    );
    console.log(`✓ Admin account created — email: ${ADMIN_EMAIL}, password: ${ADMIN_PASSWORD}`);
    console.log("  ⚠ Change this password immediately after first login.");
  } else {
    console.log("✓ Admin account already exists, skipping.");
  }

  const existingTerritories = await db.query("SELECT COUNT(*) FROM territories");
  if (Number(existingTerritories.rows[0].count) === 0) {
    for (const t of STARTER_TERRITORIES) {
      await db.query("INSERT INTO territories (name, state) VALUES ($1, $2)", [t.name, t.state]);
    }
    console.log(`✓ ${STARTER_TERRITORIES.length} starter territories created.`);
  } else {
    console.log("✓ Territories already exist, skipping.");
  }

  console.log("Seeding complete.");
  process.exit(0);
}

seed().catch((err) => {
  console.error("Seeding failed:", err);
  process.exit(1);
});
