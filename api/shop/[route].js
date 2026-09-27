// One serverless function that dispatches /api/shop/<route> to
// routes/shop/<route>.js — keeps the deployment under Vercel Hobby's
// function-count limit. Add new routes to this map.
const routes = {
  contact: require("../../routes/shop/contact"),
  content: require("../../routes/shop/content"),
  products: require("../../routes/shop/products"),
  reviews: require("../../routes/shop/reviews"),
  store: require("../../routes/shop/store"),
  support: require("../../routes/shop/support"),
  track: require("../../routes/shop/track"),
};

module.exports = (req, res) => {
  const handler = Object.prototype.hasOwnProperty.call(routes, req.query.route) ? routes[req.query.route] : null;
  if (!handler) return res.status(404).json({ error: "not found" });
  return handler(req, res);
};
