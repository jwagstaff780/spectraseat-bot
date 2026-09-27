// One serverless function that dispatches /api/cron/<route> to
// routes/cron/<route>.js — keeps the deployment under Vercel Hobby's
// function-count limit. Add new routes to this map.
const routes = {
  fulfil: require("../../routes/cron/fulfil"),
  marketing: require("../../routes/cron/marketing"),
  report: require("../../routes/cron/report"),
  source: require("../../routes/cron/source"),
};

module.exports = (req, res) => {
  const handler = Object.prototype.hasOwnProperty.call(routes, req.query.route) ? routes[req.query.route] : null;
  if (!handler) return res.status(404).json({ error: "not found" });
  return handler(req, res);
};
