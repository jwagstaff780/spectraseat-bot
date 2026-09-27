const db = require("../../lib/db");
const { runDailyReport } = require("../../lib/agents/salesManager");
const { requireBearer } = require("../../lib/auth");
const { methodNotAllowed, serverError } = require("../../lib/http");

// POST /api/cron/report — sales manager agent's daily briefing + rules.
module.exports = async (req, res) => {
  if (req.method !== "POST") return methodNotAllowed(res, ["POST"]);
  if (!requireBearer(req, res, "CRON_SECRET")) return;
  try {
    res.status(200).json(await db.recordRun("sales-report", runDailyReport));
  } catch (err) {
    serverError(res, err);
  }
};
