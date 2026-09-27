const reviews = require("../../lib/reviews");
const { methodNotAllowed, serverError } = require("../../lib/http");

// GET  /api/shop/reviews?productId=1
// POST /api/shop/reviews { token, productId, rating, body, name }  (signed link from the review email)
module.exports = async (req, res) => {
  try {
    if (req.method === "GET") {
      const id = Number(req.query.productId);
      if (!id) return res.status(400).json({ error: "productId required" });
      res.setHeader("Cache-Control", "s-maxage=300, stale-while-revalidate=600");
      return res.status(200).json(await reviews.forProduct(id));
    }
    if (req.method === "POST") {
      const b = req.body || {};
      const result = await reviews.submitVerifiedReview(b.token, {
        productId: Number(b.productId),
        rating: b.rating,
        body: b.body,
        name: b.name,
      });
      return res.status(result.ok ? 200 : 400).json(result);
    }
    methodNotAllowed(res, ["GET", "POST"]);
  } catch (err) {
    serverError(res, err);
  }
};
