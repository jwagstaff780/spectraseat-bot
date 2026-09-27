const db = require("../../lib/db");
const { syncOrders } = require("../../lib/fulfilment");
const { requireBearer } = require("../../lib/auth");
const { methodNotAllowed, serverError } = require("../../lib/http");

// POST /api/cron/fulfil — places/retries supplier orders, syncs tracking,
// emails shipping notices. Called every 15 min by GitHub Actions.
module.exports = async (req, res) => {
  if (req.method !== "POST") return methodNotAllowed(res, ["POST"]);
  if (!requireBearer(req, res, "CRON_SECRET")) return;
  try {
    const summary = await db.recordRun("fulfil", syncOrders);
    await db.query(`DELETE FROM automation_runs WHERE started_at < now() - interval '30 days'`);
    res.status(200).json(summary);
  } catch (err) {
    serverError(res, err);
  }
};
