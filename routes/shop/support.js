const config = require("../../lib/config");
const support = require("../../lib/agents/support");
const ratelimit = require("../../lib/ratelimit");
const { methodNotAllowed, serverError } = require("../../lib/http");

// POST /api/shop/support { messages: [{ role: 'user'|'assistant', content }] } -> { reply }
module.exports = async (req, res) => {
  if (req.method !== "POST") return methodNotAllowed(res, ["POST"]);
  try {
    const ip = ratelimit.clientIp(req);
    if (!(await ratelimit.allow(`support:${ip}`, config.SALES.SUPPORT_MESSAGES_PER_HOUR_PER_IP))) {
      return res.status(429).json({ error: `Too many messages — please email ${config.BRAND.supportEmail}.` });
    }
    const reply = await support.reply((req.body && req.body.messages) || []);
    res.status(200).json({ reply });
  } catch (err) {
    if (/last message/.test(err.message)) return res.status(400).json({ error: err.message });
    serverError(res, err);
  }
};
