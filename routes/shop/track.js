const support = require("../../lib/agents/support");
const ratelimit = require("../../lib/ratelimit");
const { methodNotAllowed, serverError } = require("../../lib/http");

// POST /api/shop/track { email, orderNumber } — self-serve order status.
// Same email-gated lookup the support agent uses.
module.exports = async (req, res) => {
  if (req.method !== "POST") return methodNotAllowed(res, ["POST"]);
  try {
    if (!(await ratelimit.allow(`track:${ratelimit.clientIp(req)}`, 20))) {
      return res.status(429).json({ error: "Too many attempts — please try again later." });
    }
    const { email, orderNumber } = req.body || {};
    const n = Number(String(orderNumber || "").replace(/\D/g, ""));
    if (!email || !n) return res.status(400).json({ error: "Enter your email and order number." });
    const result = await support.runTool("lookup_order", { email: String(email), order_number: n }, []);
    if (result.error) return res.status(404).json({ error: "We couldn't find an order with that email and number." });
    res.status(200).json(result);
  } catch (err) {
    serverError(res, err);
  }
};
