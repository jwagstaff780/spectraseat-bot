const db = require("../../lib/db");
const { requireBearer } = require("../../lib/auth");
const { methodNotAllowed, serverError } = require("../../lib/http");

// GET  /api/admin/tickets?status=open
// POST /api/admin/tickets?id=1 { resolution }
module.exports = async (req, res) => {
  if (!requireBearer(req, res, "ADMIN_TOKEN")) return;
  try {
    if (req.method === "GET") {
      const { rows } = await db.query(
        `SELECT * FROM support_tickets WHERE status = $1 ORDER BY created_at DESC LIMIT 100`,
        [req.query.status || "open"]
      );
      return res.status(200).json({ tickets: rows });
    }
    if (req.method !== "POST") return methodNotAllowed(res, ["GET", "POST"]);
    const { rows } = await db.query(
      `UPDATE support_tickets SET status='resolved', resolution=$2, resolved_at=now() WHERE id=$1 RETURNING id, status`,
      [Number(req.query.id), String((req.body && req.body.resolution) || "resolved")]
    );
    if (!rows[0]) return res.status(404).json({ error: "not found" });
    res.status(200).json(rows[0]);
  } catch (err) {
    serverError(res, err);
  }
};
