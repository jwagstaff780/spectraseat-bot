const db = require("../../lib/db");
const { runSourcing, syncCatalog } = require("../../lib/sourcing");
const { requireBearer } = require("../../lib/auth");
const { methodNotAllowed, serverError } = require("../../lib/http");

// POST /api/cron/source          — sync existing catalogue, then import new winners
// POST /api/cron/source?only=sync — just the stock/price sync
module.exports = async (req, res) => {
  if (req.method !== "POST") return methodNotAllowed(res, ["POST"]);
  if (!requireBearer(req, res, "CRON_SECRET")) return;
  try {
    const sync = await db.recordRun("catalog-sync", syncCatalog);
    const sourcing = req.query.only === "sync" ? null : await db.recordRun("sourcing", runSourcing);
    res.status(200).json({ sync, sourcing });
  } catch (err) {
    serverError(res, err);
  }
};
