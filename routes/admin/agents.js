const db = require("../../lib/db");
const { requireBearer } = require("../../lib/auth");
const { methodNotAllowed, serverError } = require("../../lib/http");

// GET /api/admin/agents — latest sales-manager briefings and content output.
module.exports = async (req, res) => {
  if (req.method !== "GET") return methodNotAllowed(res, ["GET"]);
  if (!requireBearer(req, res, "ADMIN_TOKEN")) return;
  try {
    const [reports, content] = await Promise.all([
      db.query(`SELECT id, body, actions, created_at FROM agent_reports ORDER BY created_at DESC LIMIT 7`),
      db.query(
        `SELECT id, kind, slug, title, left(body, 300) AS body, image, status, channels, created_at FROM content ORDER BY created_at DESC LIMIT 30`
      ),
    ]);
    res.status(200).json({ reports: reports.rows, content: content.rows });
  } catch (err) {
    serverError(res, err);
  }
};
