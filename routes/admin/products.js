const db = require("../../lib/db");
const { requireBearer } = require("../../lib/auth");
const { methodNotAllowed, serverError } = require("../../lib/http");

// PATCH /api/admin/products?id=1 { status: 'active'|'paused'|'archived' }
module.exports = async (req, res) => {
  if (req.method !== "PATCH") return methodNotAllowed(res, ["PATCH"]);
  if (!requireBearer(req, res, "ADMIN_TOKEN")) return;
  try {
    const id = Number(req.query.id);
    const status = req.body && req.body.status;
    if (!id || !["active", "paused", "archived"].includes(status)) {
      return res.status(400).json({ error: "id and a valid status are required" });
    }
    // 'manual' tells the catalogue sync never to auto-resume this product.
    const { rows } = await db.query(
      `UPDATE products SET status=$2, status_reason=CASE WHEN $2='active' THEN NULL ELSE 'manual' END, updated_at=now()
       WHERE id=$1 RETURNING id, status`,
      [id, status]
    );
    if (!rows[0]) return res.status(404).json({ error: "not found" });
    res.status(200).json(rows[0]);
  } catch (err) {
    serverError(res, err);
  }
};
