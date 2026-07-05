require("dotenv").config();
const { Pool } = require("pg");
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});
async function list() {
  const result = await pool.query("SELECT id, name, sku, unit_price FROM products ORDER BY name");
  console.log(result.rows);
  await pool.end();
}
list();