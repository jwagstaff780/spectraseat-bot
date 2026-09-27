const { Pool } = require("pg");

// Two runtimes:
//  - Node (GitHub Actions jobs, Vercel, local): one shared pool per process,
//    schema applied lazily on first query.
//  - Cloudflare Workers (the free storefront host): Workers forbid sharing
//    a socket between requests, so each request gets its own small pool,
//    opened lazily and closed by the adapter when the response is sent
//    (functions/api/[[path]].js). The schema is applied by the scheduled
//    GitHub Actions jobs instead (`npm run migrate`).
const IS_WORKERS = typeof navigator !== "undefined" && navigator.userAgent === "Cloudflare-Workers";

let requestScope = null; // AsyncLocalStorage, Workers only
function setRequestScope(als) {
  requestScope = als;
}

function makePool(max) {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error("DATABASE_URL is not set.");
  return new Pool({
    connectionString,
    ssl: connectionString.includes("sslmode=disable") ? false : { rejectUnauthorized: false },
    max,
  });
}

let pool = null;
function getPool() {
  if (requestScope) {
    const scope = requestScope.getStore();
    if (!scope) throw new Error("database used outside a request scope");
    if (!scope.pool) scope.pool = makePool(2);
    return scope.pool;
  }
  if (!pool) pool = makePool(3);
  return pool;
}

let schemaReady = null;
// Idempotent (CREATE ... IF NOT EXISTS), cached per process.
async function ensureSchema() {
  if (IS_WORKERS) return;
  if (!schemaReady) schemaReady = getPool().query(require("../db/schema"));
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

async function end() {
  if (pool) await pool.end();
  pool = null;
  schemaReady = null;
}

module.exports = { getPool, ensureSchema, query, tx, recordRun, end, setRequestScope, IS_WORKERS };
