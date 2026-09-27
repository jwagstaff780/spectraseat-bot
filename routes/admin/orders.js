const db = require("../../lib/db");
const stripe = require("../../lib/stripe");
const { placeOrder, setShipmentTracking, rollUpOrder, syncOrders } = require("../../lib/fulfilment");
const { requireBearer } = require("../../lib/auth");
const { methodNotAllowed, serverError } = require("../../lib/http");

// GET  /api/admin/orders?awaiting=tracking  — shipments placed but without tracking
// POST /api/admin/orders?shipment=5 { action: 'add_tracking', trackingNumber, carrier }
// GET  /api/admin/orders?status=needs_attention
// POST /api/admin/orders?id=1 { action: 'retry' | 'refund' | 'mark_placed', supplierOrderId? }
//   retry       — send a needs_attention order back through supplier placement
//   mark_placed — you placed it by hand; record the supplier order id so tracking sync takes over
//   refund      — full Stripe refund, order marked refunded
module.exports = async (req, res) => {
  if (!requireBearer(req, res, "ADMIN_TOKEN")) return;
  try {
    if (req.method === "GET" && req.query.awaiting === "tracking") {
      const { rows } = await db.query(
        `SELECT s.id, s.order_id, s.supplier, s.supplier_order_id, s.placed_at, o.customer_name, o.email,
                (SELECT string_agg(oi.quantity || ' × ' || oi.title || coalesce(' (' || nullif(oi.variant_name, '') || ')', ''), ', ')
                   FROM order_items oi JOIN products p ON p.id = oi.product_id WHERE oi.order_id = s.order_id AND p.supplier = s.supplier) AS items
         FROM shipments s JOIN orders o ON o.id = s.order_id
         WHERE s.status = 'placed' AND s.tracking_number IS NULL ORDER BY s.placed_at LIMIT 100`
      );
      return res.status(200).json({ shipments: rows });
    }
    if (req.method === "POST" && req.query.shipment) {
      const { action, trackingNumber, carrier } = req.body || {};
      if (action !== "add_tracking" || !trackingNumber || String(trackingNumber).length > 60) {
        return res.status(400).json({ error: "action add_tracking with trackingNumber required" });
      }
      const sh = await setShipmentTracking(Number(req.query.shipment), String(trackingNumber).trim(), carrier ? String(carrier).slice(0, 40) : null);
      if (!sh) return res.status(404).json({ error: "shipment not found or not awaiting tracking" });
      await rollUpOrder(sh.order_id);
      // Send the customer's shipping email now rather than at the next run.
      await syncOrders().catch(() => {});
      return res.status(200).json({ ok: true, shipment: sh.id });
    }
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
      // Record it as the shipment(s) for this order so tracking sync takes over.
      await db.query(
        `INSERT INTO shipments (order_id, supplier, status, supplier_order_id, placed_at)
         SELECT DISTINCT $1::bigint, p.supplier, 'placed', $2, now() FROM order_items oi JOIN products p ON p.id = oi.product_id WHERE oi.order_id = $1
         ON CONFLICT (order_id, supplier) DO UPDATE SET status='placed', supplier_order_id=EXCLUDED.supplier_order_id, placed_at=coalesce(shipments.placed_at, now())`,
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
