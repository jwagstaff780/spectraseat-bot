const db = require("../../lib/db");
const stripe = require("../../lib/stripe");
const { placeOrder } = require("../../lib/fulfilment");
const { requireBearer } = require("../../lib/auth");
const { methodNotAllowed, serverError } = require("../../lib/http");

// GET  /api/admin/orders?status=needs_attention
// POST /api/admin/orders?id=1 { action: 'retry' | 'refund' | 'mark_placed', supplierOrderId? }
//   retry       — send a needs_attention order back through supplier placement
//   mark_placed — you placed it by hand; record the supplier order id so tracking sync takes over
//   refund      — full Stripe refund, order marked refunded
module.exports = async (req, res) => {
  if (!requireBearer(req, res, "ADMIN_TOKEN")) return;
  try {
    if (req.method === "GET") {
      const params = [];
      let where = "";
      if (req.query.status) {
        params.push(req.query.status);
        where = "WHERE status = $1";
      }
      const { rows } = await db.query(`SELECT * FROM orders ${where} ORDER BY created_at DESC LIMIT 200`, params);
      return res.status(200).json({ orders: rows });
    }
    if (req.method !== "POST") return methodNotAllowed(res, ["GET", "POST"]);

    const id = Number(req.query.id);
    const { action, supplierOrderId } = req.body || {};
    const { rows } = await db.query(`SELECT * FROM orders WHERE id = $1`, [id]);
    const order = rows[0];
    if (!order) return res.status(404).json({ error: "not found" });

    if (action === "retry") {
      if (order.status !== "needs_attention") return res.status(409).json({ error: `order is ${order.status}` });
      await db.query(
        `UPDATE orders SET status='paid', status_reason=NULL, fulfilment_attempts=0, updated_at=now() WHERE id=$1`,
        [id]
      );
      return res.status(200).json(await placeOrder(id));
    }
    if (action === "mark_placed") {
      if (!supplierOrderId) return res.status(400).json({ error: "supplierOrderId required" });
      await db.query(
        `UPDATE orders SET status='placed', supplier_order_id=$2, placed_at=coalesce(placed_at, now()), status_reason=NULL, updated_at=now() WHERE id=$1`,
        [id, String(supplierOrderId)]
      );
      return res.status(200).json({ ok: true });
    }
    if (action === "refund") {
      if (order.status === "refunded") return res.status(409).json({ error: "already refunded" });
      await stripe.createRefund(order.stripe_payment_intent);
      await db.query(`UPDATE orders SET status='refunded', updated_at=now() WHERE id=$1`, [id]);
      return res.status(200).json({ ok: true });
    }
    res.status(400).json({ error: "unknown action" });
  } catch (err) {
    serverError(res, err);
  }
};
