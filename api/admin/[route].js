// One serverless function that dispatches /api/admin/<route> to
// routes/admin/<route>.js — keeps the deployment under Vercel Hobby's
// function-count limit. Add new routes to this map.
const routes = {
  ads: require("../../routes/admin/ads"),
  agents: require("../../routes/admin/agents"),
  orders: require("../../routes/admin/orders"),
  products: require("../../routes/admin/products"),
  summary: require("../../routes/admin/summary"),
  tickets: require("../../routes/admin/tickets"),
};

module.exports = (req, res) => {
  const handler = Object.prototype.hasOwnProperty.call(routes, req.query.route) ? routes[req.query.route] : null;
  if (!handler) return res.status(404).json({ error: "not found" });
  return handler(req, res);
};
