const config = require("../../lib/config");
const db = require("../../lib/db");
const manager = require("../../lib/ads/manager");
const { requireBearer } = require("../../lib/auth");
const { methodNotAllowed, serverError } = require("../../lib/http");

// GET  /api/admin/ads — campaigns with lifetime metrics, recent decisions, halt state
// POST /api/admin/ads { action: 'halt' | 'resume' } — manual kill switch
module.exports = async (req, res) => {
  if (!requireBearer(req, res, "ADMIN_TOKEN")) return;
  try {
    if (req.method === "POST") {
      const action = req.body && req.body.action;
      if (action === "halt") await manager.setHalted("halted manually from admin");
      else if (action === "resume") await manager.setHalted(null);
      else return res.status(400).json({ error: "action must be halt or resume" });
      return res.status(200).json({ halted: await manager.isHalted() });
    }
    if (req.method !== "GET") return methodNotAllowed(res, ["GET", "POST"]);
    const [campaigns, decisions] = await Promise.all([
      db.query(
        `SELECT c.id, c.status, c.status_reason, c.daily_budget::float, c.dry_run, c.created_at, c.creative,
                p.title, p.slug,
                coalesce(sum(m.spend),0)::float AS spend, coalesce(sum(m.purchases),0)::int AS purchases,
                coalesce(sum(m.purchase_value),0)::float AS purchase_value, coalesce(sum(m.clicks),0)::int AS clicks
         FROM ad_campaigns c JOIN products p ON p.id = c.product_id
         LEFT JOIN ad_metrics_daily m ON m.campaign_id = c.id
         GROUP BY c.id, p.title, p.slug ORDER BY c.status, c.created_at DESC LIMIT 100`
      ),
      db.query(`SELECT * FROM ad_decisions ORDER BY created_at DESC LIMIT 50`),
    ]);
    res.status(200).json({
      mode: config.ADS.MODE,
      limits: config.ADS,
      halted: await manager.isHalted(),
      campaigns: campaigns.rows,
      decisions: decisions.rows,
    });
  } catch (err) {
    serverError(res, err);
  }
};
