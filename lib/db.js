const { Pool } = require("pg");
const fs = require("fs");
const path = require("path");

let pool = null;
let schemaReady = null;

function getPool() {
  if (!pool) {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) {
      throw new Error("DATABASE_URL is not set — no synthetic data, no synthetic database either.");
    }
    pool = new Pool({
      connectionString,
      ssl: connectionString.includes("sslmode=disable") ? false : { rejectUnauthorized: false },
      max: 3,
    });
  }
  return pool;
}

// Idempotent, cached per warm lambda instance so it only runs once.
async function ensureSchema() {
  if (!schemaReady) {
    const schemaSql = fs.readFileSync(path.join(__dirname, "..", "db", "schema.sql"), "utf8");
    schemaReady = getPool().query(schemaSql);
  }
  await schemaReady;
}

async function query(text, params) {
  await ensureSchema();
  return getPool().query(text, params);
}

module.exports = { getPool, ensureSchema, query };
