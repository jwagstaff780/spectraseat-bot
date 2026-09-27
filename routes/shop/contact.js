const db = require("../../lib/db");
const ratelimit = require("../../lib/ratelimit");
const { methodNotAllowed, serverError } = require("../../lib/http");

const TOPICS = new Set(["other", "delivery", "damaged_or_wrong", "return", "address_change"]);

// POST /api/shop/contact { name, email, orderNumber?, topic, message } -> { ticket }
// Lands in the same ticket queue as the support agent's escalations.
module.exports = async (req, res) => {
  if (req.method !== "POST") return methodNotAllowed(res, ["POST"]);
  try {
    if (!(await ratelimit.allow(`contact:${ratelimit.clientIp(req)}`, 5))) {
      return res.status(429).json({ error: "Too many messages — please email us instead." });
    }
    const b = req.body || {};
    const email = String(b.email || "").trim();
    const message = String(b.message || "").trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 120) return res.status(400).json({ error: "Please enter a valid email." });
    if (message.length < 5 || message.length > 2000) return res.status(400).json({ error: "Please write a message (5–2000 characters)." });
    const orderNumber = Number(String(b.orderNumber || "").replace(/\D/g, "")) || null;
    // Only link the ticket to an order if the email matches it.
    let orderId = null;
    if (orderNumber) {
      const { rows } = await db.query(`SELECT id FROM orders WHERE id = $1 AND lower(email) = lower($2)`, [orderNumber, email]);
      orderId = rows[0] ? rows[0].id : null;
    }
    const topic = TOPICS.has(b.topic) ? b.topic : "other";
    const name = String(b.name || "").slice(0, 80);
    const { rows } = await db.query(
      `INSERT INTO support_tickets (order_id, email, category, summary, transcript) VALUES ($1,$2,$3,$4,$5) RETURNING id`,
      [orderId, email, topic, `${name ? name + ": " : ""}${message}`.slice(0, 2000), JSON.stringify([{ role: "user", content: message }])]
    );
    res.status(200).json({ ticket: rows[0].id });
  } catch (err) {
    serverError(res, err);
  }
};
