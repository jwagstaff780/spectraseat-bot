// Order pipeline: paid -> placing -> placed -> shipped -> delivered.
//
// recordPaidOrder(): turn a completed Stripe Checkout Session into an order
//   row (idempotent on the session id — Stripe retries webhooks).
// placeOrder():      buy the goods from the supplier, shipped straight to
//   the customer. Claimed with a status transition so a webhook and the
//   cron can never both place the same order.
// syncOrders():      the cron's job — retry failed placements, pull
//   tracking, email customers, flag anything stuck for a human.

const config = require("./config");
const db = require("./db");
const email = require("./email");
const { getSupplier } = require("./supplier");
const { paymentFee, round2 } = require("./pricing");

// Stripe moved shipping details under collected_information in newer API
// versions; accept both shapes.
function extractShipping(session) {
  const ship =
    (session.collected_information && session.collected_information.shipping_details) ||
    session.shipping_details ||
    {};
  const cust = session.customer_details || {};
  const addr = ship.address || cust.address || {};
  return {
    name: ship.name || cust.name || null,
    email: cust.email || session.customer_email,
    address: {
      line1: addr.line1 || "",
      line2: addr.line2 || "",
      city: addr.city || "",
      state: addr.state || "",
      postal_code: addr.postal_code || "",
      country: addr.country || "",
      phone: cust.phone || "",
    },
  };
}

// cart metadata is written server-side by /api/checkout:
// [[productId, qty, unitPriceCents], ...] — the price the customer saw.
function parseCartMetadata(session) {
  const raw = session.metadata && session.metadata.cart;
  const parsed = JSON.parse(raw || "[]");
  if (!Array.isArray(parsed) || parsed.length === 0) throw new Error("session has no cart metadata");
  return parsed.map(([productId, quantity, unitPriceCents]) => ({
    productId: Number(productId),
    quantity: Number(quantity),
    unitPrice: round2(Number(unitPriceCents) / 100),
  }));
}

async function recordPaidOrder(session) {
  const cart = parseCartMetadata(session);
  const ship = extractShipping(session);
  const total = round2(session.amount_total / 100);
  const subtotal = round2(session.amount_subtotal / 100);

  return db.tx(async (client) => {
    const { rows: existing } = await client.query(`SELECT * FROM orders WHERE stripe_session_id = $1`, [session.id]);
    if (existing[0]) return { order: existing[0], created: false };

    const { rows: products } = await client.query(`SELECT * FROM products WHERE id = ANY($1::bigint[])`, [
      cart.map((c) => c.productId),
    ]);
    const byId = new Map(products.map((p) => [Number(p.id), p]));
    const items = cart.map((c) => {
      const p = byId.get(c.productId);
      if (!p) throw new Error(`product ${c.productId} missing`);
      return {
        product_id: p.id,
        supplier_variant_id: p.supplier_variant_id,
        title: p.title,
        quantity: c.quantity,
        // Price the customer actually paid (the product row can be
        // repriced between checkout and webhook).
        unit_price: c.unitPrice,
        unit_landed_cost: Number(p.landed_cost),
      };
    });
    const cogs = round2(items.reduce((s, i) => s + i.unit_landed_cost * i.quantity, 0));

    const { rows } = await client.query(
      `INSERT INTO orders (stripe_session_id, stripe_payment_intent, email, customer_name, shipping_address,
         currency, subtotal, shipping_charged, total, cogs, payment_fee)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
      [
        session.id,
        session.payment_intent,
        ship.email,
        ship.name,
        ship.address,
        session.currency,
        subtotal,
        round2(total - subtotal),
        total,
        cogs,
        paymentFee(total),
      ]
    );
    const order = rows[0];
    for (const i of items) {
      await client.query(
        `INSERT INTO order_items (order_id, product_id, supplier_variant_id, title, quantity, unit_price, unit_landed_cost)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [order.id, i.product_id, i.supplier_variant_id, i.title, i.quantity, i.unit_price, i.unit_landed_cost]
      );
    }
    return { order, created: true };
  });
}

async function getItems(orderId) {
  const { rows } = await db.query(
    `SELECT oi.*, p.shipping_method FROM order_items oi JOIN products p ON p.id = oi.product_id WHERE oi.order_id = $1 ORDER BY oi.id`,
    [orderId]
  );
  return rows;
}

async function sendConfirmation(order) {
  if (order.confirmation_emailed_at) return;
  const items = await getItems(order.id);
  if (await email.send(order.email, email.orderConfirmation(order, items))) {
    await db.query(`UPDATE orders SET confirmation_emailed_at = now() WHERE id = $1`, [order.id]);
  }
}

async function placeOrder(orderId) {
  // Claim: only one caller can move paid -> placing.
  const { rows } = await db.query(
    `UPDATE orders SET status='placing', fulfilment_attempts = fulfilment_attempts + 1, updated_at=now()
     WHERE id=$1 AND status='paid' RETURNING *`,
    [orderId]
  );
  const order = rows[0];
  if (!order) return { skipped: true };

  const supplier = getSupplier();
  try {
    const items = await getItems(order.id);
    // All items ship from the same supplier; use the method quoted at
    // sourcing time for the first line.
    const method = items[0].shipping_method;
    const { supplierOrderId } = await supplier.createOrder(order, items, method);
    await db.query(
      `UPDATE orders SET status='placed', supplier_order_id=$2, placed_at=now(), last_fulfilment_error=NULL, updated_at=now() WHERE id=$1`,
      [order.id, String(supplierOrderId)]
    );
    return { placed: true, supplierOrderId };
  } catch (err) {
    const giveUp = order.fulfilment_attempts >= config.MAX_FULFILMENT_ATTEMPTS;
    await db.query(
      `UPDATE orders SET status=$2, last_fulfilment_error=$3, status_reason=$4, updated_at=now() WHERE id=$1`,
      [order.id, giveUp ? "needs_attention" : "paid", err.message, giveUp ? "supplier order failed repeatedly" : null]
    );
    return { placed: false, error: err.message };
  }
}

async function syncOrders() {
  const supplier = getSupplier();
  const summary = { placed: 0, placeFailed: 0, shipped: 0, delivered: 0, flagged: 0, errors: [] };

  // 1. An order stuck in 'placing' means a lambda died mid-call. We can't
  //    know whether the supplier accepted it, so a human must check rather
  //    than risk ordering twice.
  const stuck = await db.query(
    `UPDATE orders SET status='needs_attention', status_reason='placement interrupted — check supplier dashboard before retrying', updated_at=now()
     WHERE status='placing' AND updated_at < now() - interval '15 minutes' RETURNING id`
  );
  summary.flagged += stuck.rowCount;

  // 2. Place (or retry) paid orders.
  const { rows: toPlace } = await db.query(`SELECT id FROM orders WHERE status='paid' ORDER BY created_at LIMIT 25`);
  for (const { id } of toPlace) {
    const r = await placeOrder(id);
    if (r.placed) summary.placed++;
    else if (!r.skipped) summary.placeFailed++;
  }

  // 3. Pull tracking for in-flight orders.
  const { rows: inFlight } = await db.query(
    `SELECT * FROM orders WHERE status IN ('placed','shipped') AND supplier_order_id IS NOT NULL ORDER BY updated_at LIMIT 50`
  );
  for (const order of inFlight) {
    try {
      const s = await supplier.getOrderStatus(order.supplier_order_id);
      if (s.status === "cancelled") {
        await db.query(`UPDATE orders SET status='needs_attention', status_reason='supplier cancelled order', updated_at=now() WHERE id=$1`, [order.id]);
        summary.flagged++;
        continue;
      }
      if (order.status === "placed" && s.trackingNumber) {
        const trackingUrl = `https://t.17track.net/en#nums=${encodeURIComponent(s.trackingNumber)}`;
        const { rows } = await db.query(
          `UPDATE orders SET status='shipped', tracking_number=$2, carrier=$3, tracking_url=$4, shipped_at=now(), updated_at=now()
           WHERE id=$1 RETURNING *`,
          [order.id, s.trackingNumber, s.carrier, trackingUrl]
        );
        summary.shipped++;
        if (!rows[0].shipping_emailed_at && (await email.send(rows[0].email, email.shippingNotice(rows[0])))) {
          await db.query(`UPDATE orders SET shipping_emailed_at=now() WHERE id=$1`, [order.id]);
        }
      }
      if (s.status === "delivered") {
        await db.query(`UPDATE orders SET status='delivered', delivered_at=now(), updated_at=now() WHERE id=$1`, [order.id]);
        summary.delivered++;
      } else {
        await db.query(`UPDATE orders SET updated_at=now() WHERE id=$1 AND status IN ('placed','shipped')`, [order.id]);
      }
    } catch (err) {
      summary.errors.push(`order ${order.id}: ${err.message}`);
    }
  }

  // 4. Flag orders placed long ago with still no tracking.
  const overdue = await db.query(
    `UPDATE orders SET status='needs_attention', status_reason='no tracking after ${config.TRACKING_OVERDUE_DAYS} days', updated_at=now()
     WHERE status='placed' AND placed_at < now() - make_interval(days => $1) RETURNING id`,
    [config.TRACKING_OVERDUE_DAYS]
  );
  summary.flagged += overdue.rowCount;

  // 5. Retry any confirmation emails that failed at webhook time.
  const { rows: unconfirmed } = await db.query(
    `SELECT * FROM orders WHERE confirmation_emailed_at IS NULL AND created_at > now() - interval '2 days' LIMIT 25`
  );
  for (const o of unconfirmed) {
    try {
      await sendConfirmation(o);
    } catch (err) {
      summary.errors.push(`email ${o.id}: ${err.message}`);
    }
  }

  return summary;
}

module.exports = { recordPaidOrder, placeOrder, syncOrders, sendConfirmation, extractShipping, parseCartMetadata };
