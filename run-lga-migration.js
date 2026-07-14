const fs = require("fs");
const { Client } = require("pg");

const DATABASE_URL = process.argv[2];
const migrationFile = process.argv[3];

if (!DATABASE_URL || !migrationFile) {
  console.error("Usage: node run-migration.js <DATABASE_URL> <path-to-sql-file>");
  process.exit(1);
}

const client = new Client({
  connectionString: DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

async function run() {
  const sql = fs.readFileSync(migrationFile, "utf8");
  await client.connect();
  console.log("Connected. Running migration...");
  await client.query(sql);
  console.log("Migration applied successfully.");
  await client.end();
}

run().catch((err) => {
  console.error("Migration failed:", err.message);
  process.exit(1);
});