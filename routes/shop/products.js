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
      const { rows: variants } = await db.query(`SELECT * FROM product_variants WHERE product_id = $1`, [rows[0].id]);
      res.setHeader("Cache-Control", "s-maxage=60, stale-while-revalidate=300");
      return res.status(200).json({ product: publicProduct(rows[0], variants) });
    }
    const { rows } = await db.query(
      // Best sellers first (last 30 days), then the scout's strongest picks, then newest.
      `SELECT p.* FROM products p
       LEFT JOIN (
         SELECT oi.product_id, sum(oi.quantity) AS units FROM order_items oi JOIN orders o ON o.id = oi.order_id
         WHERE o.created_at > now() - interval '30 days' AND o.status NOT IN ('refunded','cancelled')
         GROUP BY oi.product_id
       ) s ON s.product_id = p.id
       WHERE p.status = 'active' AND p.in_stock
       ORDER BY coalesce(s.units, 0) DESC, p.scout_score DESC NULLS LAST, p.created_at DESC LIMIT 200`
    );
    const { rows: variants } = await db.query(`SELECT * FROM product_variants WHERE product_id = ANY($1::bigint[])`, [
      rows.map((r) => r.id),
    ]);
    res.setHeader("Cache-Control", "s-maxage=60, stale-while-revalidate=300");
    res.status(200).json({ products: rows.map((r) => publicProduct(r, variants)) });
  } catch (err) {
    serverError(res, err);
  }
};
