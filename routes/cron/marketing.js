const db = require("../../lib/db");
const { runContent } = require("../../lib/agents/content");
const { runAds } = require("../../lib/ads/manager");
const { requireBearer } = require("../../lib/auth");
const { methodNotAllowed, serverError } = require("../../lib/http");

// POST /api/cron/marketing — content agent (blog + social) then ads manager.
// ?only=ads | ?only=content to run one half.
module.exports = async (req, res) => {
  if (req.method !== "POST") return methodNotAllowed(res, ["POST"]);
  if (!requireBearer(req, res, "CRON_SECRET")) return;
  try {
    const only = req.query.only;
    const result = {};
    if (only !== "ads") result.content = await db.recordRun("content", runContent).catch((e) => ({ error: e.message }));
    if (only !== "content") result.ads = await db.recordRun("ads", runAds).catch((e) => ({ error: e.message }));
    res.status(200).json(result);
  } catch (err) {
    serverError(res, err);
  }
};
