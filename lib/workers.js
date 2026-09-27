// Cloudflare Workers / Pages Functions runtime glue shared by every
// function in functions/: copies secrets from `env` into process.env (the
// shared code reads process.env) and gives each request its own database
// pool (Workers forbid sharing sockets across requests), closed after the
// response is produced.

const { AsyncLocalStorage } = require("node:async_hooks");
const db = require("./db");

const scope = new AsyncLocalStorage();
db.setRequestScope(scope);

function exposeEnv(env) {
  for (const [k, v] of Object.entries(env || {})) {
    if (typeof v === "string") process.env[k] = v;
  }
}

async function withDb(context, fn) {
  exposeEnv(context.env);
  const store = {};
  try {
    return await scope.run(store, fn);
  } finally {
    if (store.pool) context.waitUntil(store.pool.end().catch(() => {}));
  }
}

function siteOrigin(request) {
  return (process.env.APP_URL || new URL(request.url).origin).replace(/\/$/, "");
}

module.exports = { withDb, exposeEnv, siteOrigin };
