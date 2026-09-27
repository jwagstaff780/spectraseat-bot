const db = require("../../lib/db");
const { methodNotAllowed, serverError } = require("../../lib/http");

// GET /api/shop/content            — blog index
// GET /api/shop/content?slug=...   — one article (+ its featured product)
module.exports = async (req, res) => {
  if (req.method !== "GET") return methodNotAllowed(res, ["GET"]);
  try {
    res.setHeader("Cache-Control", "s-maxage=300, stale-while-revalidate=3600");
    if (req.query.slug) {
      const { rows } = await db.query(
        `SELECT c.title, c.body, c.image, c.published_at, p.slug AS product_slug, p.title AS product_title, p.price
         FROM content c LEFT JOIN products p ON p.id = c.product_id AND p.status = 'active'
         WHERE c.kind='blog' AND c.status='published' AND c.slug=$1`,
        [req.query.slug]
      );
      if (!rows[0]) return res.status(404).json({ error: "not found" });
      return res.status(200).json({ article: { ...rows[0], price: rows[0].price && Number(rows[0].price) } });
    }
    const { rows } = await db.query(
      `SELECT slug, title, image, published_at, left(body, 220) AS excerpt FROM content
       WHERE kind='blog' AND status='published' ORDER BY published_at DESC LIMIT 50`
    );
    res.status(200).json({ articles: rows });
  } catch (err) {
    serverError(res, err);
  }
};
