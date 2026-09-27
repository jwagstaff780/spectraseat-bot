const { Pool } = require("pg");
const fs = require("fs");
const path = require("path");

let pool = null;
let schemaReady = null;

function getPool() {
  if (!pool) {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) {
      throw new Error("DATABASE_URL is not set.");
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

// Run fn(client) inside a transaction.
async function tx(fn) {
  await ensureSchema();
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

// Wraps an automated job so every run is recorded in automation_runs.
async function recordRun(job, fn) {
  const { rows } = await query(`INSERT INTO automation_runs (job) VALUES ($1) RETURNING id`, [job]);
  const id = rows[0].id;
  try {
    const summary = await fn();
    await query(`UPDATE automation_runs SET finished_at = now(), ok = TRUE, summary = $2 WHERE id = $1`, [id, summary]);
    return summary;
  } catch (err) {
    await query(`UPDATE automation_runs SET finished_at = now(), ok = FALSE, summary = $2 WHERE id = $1`, [
      id,
      { error: String(err.message || err) },
    ]);
    throw err;
  }
}

module.exports = { getPool, ensureSchema, query, tx, recordRun };
