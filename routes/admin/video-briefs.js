const db = require("../../lib/db");
const { requireBearer } = require("../../lib/auth");
const { methodNotAllowed, serverError } = require("../../lib/http");

// Used by the scheduled Claude + Higgsfield session (docs/higgsfield-routine.md).
// GET  /api/admin/video-briefs?status=pending       -> briefs to generate
// POST /api/admin/video-briefs?id=1 { status: 'generating' | 'failed', error? }
module.exports = async (req, res) => {
  if (!requireBearer(req, res, "ADMIN_TOKEN")) return;
  try {
    if (req.method === "GET") {
      const { rows } = await db.query(
        `SELECT b.id, b.status, b.prompt, b.script, b.created_at, p.title, p.slug, p.images[1] AS image, p.price
         FROM video_briefs b JOIN products p ON p.id = b.product_id
         WHERE b.status = $1 ORDER BY b.created_at LIMIT 10`,
        [req.query.status || "pending"]
      );
      return res.status(200).json({ briefs: rows });
    }
    if (req.method !== "POST") return methodNotAllowed(res, ["GET", "POST"]);
    const status = req.body && req.body.status;
    if (!["generating", "failed"].includes(status)) return res.status(400).json({ error: "status must be generating or failed" });
    const { rows } = await db.query(
      `UPDATE video_briefs SET status=$2, error=$3, updated_at=now() WHERE id=$1 AND status IN ('pending','generating') RETURNING id, status`,
      [Number(req.query.id), status, (req.body && req.body.error) || null]
    );
    if (!rows[0]) return res.status(404).json({ error: "not found" });
    res.status(200).json(rows[0]);
  } catch (err) {
    serverError(res, err);
  }
};
