const db = require("../../lib/db");
const { methodNotAllowed, serverError, publicProduct } = require("../../lib/http");

// GET /api/products            — the live catalogue
// GET /api/products?slug=...   — one product
module.exports = async (req, res) => {
  if (req.method !== "GET") return methodNotAllowed(res, ["GET"]);
  try {
    if (req.query.slug) {
      const { rows } = await db.query(`SELECT * FROM products WHERE slug = $1 AND status = 'active'`, [req.query.slug]);
      if (!rows[0]) return res.status(404).json({ error: "not found" });
      res.setHeader("Cache-Control", "s-maxage=60, stale-while-revalidate=300");
      return res.status(200).json({ product: publicProduct(rows[0]) });
    }
    const { rows } = await db.query(
      `SELECT * FROM products WHERE status = 'active' AND in_stock ORDER BY created_at DESC LIMIT 200`
    );
    res.setHeader("Cache-Control", "s-maxage=60, stale-while-revalidate=300");
    res.status(200).json({ products: rows.map(publicProduct) });
  } catch (err) {
    serverError(res, err);
  }
};
