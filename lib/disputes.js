// Chargeback defence. When a customer disputes a payment, Stripe gives the
// store a few days to respond. If the order has shipped, we submit the
// evidence automatically (tracking number, carrier, ship date, delivery
// address, product description, refund policy) — that alone wins many
// "item not received" disputes. If it hasn't shipped, a human decides.

const config = require("./config");
const db = require("./db");
const stripe = require("./stripe");
const { notifyOwner } = require("./alerts");

function formatAddress(a = {}) {
  return [a.line1, a.line2, a.city, a.state, a.postal_code, a.country].filter(Boolean).join(", ");
}

function evidenceFor(order, items) {
  return {
    customer_email_address: order.email,
    customer_name: order.customer_name || undefined,
    shipping_address: formatAddress(order.shipping_address),
    shipping_carrier: order.carrier || undefined,
    shipping_tracking_number: order.tracking_number,
    shipping_date: order.shipped_at ? new Date(order.shipped_at).toISOString().slice(0, 10) : undefined,
    product_description: items.map((i) => `${i.quantity} × ${i.title}${i.variant_name ? ` (${i.variant_name})` : ""}`).join("; "),
    refund_policy_disclosure: "Shown on every product page and at /policies.html before purchase.",
    refund_policy:
      "30-day returns after delivery. Damaged or not-as-described items are replaced or refunded in full. " +
      `Orders not delivered within the promised window are refunded on request. Contact: ${config.BRAND.supportEmail}.`,
    uncategorized_text:
      `Order #${order.id} was paid on ${new Date(order.created_at).toISOString().slice(0, 10)} and shipped with tracking ` +
      `${order.tracking_number}${order.carrier ? ` via ${order.carrier}` : ""} to the address the customer entered at checkout. ` +
      `Order status: ${order.status}${order.delivered_at ? `, delivered ${new Date(order.delivered_at).toISOString().slice(0, 10)}` : ""}. ` +
      `The customer did not request a refund through our support channels before disputing.`,
  };
}

async function handleDisputeCreated(dispute) {
  const { rows } = await db.query(`SELECT * FROM orders WHERE stripe_payment_intent = $1`, [dispute.payment_intent]);
  const order = rows[0];
  if (!order) {
    await notifyOwner(`dispute:${dispute.id}`, "Chargeback on an unknown payment", `Dispute ${dispute.id} (${dispute.reason}) has no matching order. Check Stripe.`);
    return { handled: false, reason: "no matching order" };
  }
  await db.query(`UPDATE orders SET dispute_id=$2, dispute_status=$3, dispute_amount=$4, updated_at=now() WHERE id=$1`, [
    order.id,
    dispute.id,
    dispute.status,
    dispute.amount / 100,
  ]);

  if (order.tracking_number && ["shipped", "delivered"].includes(order.status)) {
    const { rows: items } = await db.query(`SELECT * FROM order_items WHERE order_id = $1`, [order.id]);
    await stripe.updateDispute(dispute.id, { evidence: evidenceFor(order, items), submit: true });
    await db.query(`UPDATE orders SET dispute_status='evidence_submitted' WHERE id=$1`, [order.id]);
    await notifyOwner(
      `dispute:${dispute.id}`,
      `Chargeback on order #${order.id} — evidence submitted automatically`,
      `Reason: ${dispute.reason}. Amount: ${dispute.amount / 100}. Tracking ${order.tracking_number} was submitted to Stripe. Nothing to do unless Stripe asks for more.`
    );
    return { handled: true, submitted: true };
  }
  await notifyOwner(
    `dispute:${dispute.id}`,
    `Chargeback on order #${order.id} — needs you`,
    `Reason: ${dispute.reason}. The order has no tracking yet (status ${order.status}), so evidence was NOT submitted. ` +
      `Usually best: accept the dispute in Stripe and cancel the supplier order if it hasn't shipped.`
  );
  return { handled: true, submitted: false };
}

async function handleDisputeClosed(dispute) {
  const { rows } = await db.query(
    `UPDATE orders SET dispute_status=$2, updated_at=now() WHERE dispute_id=$1 RETURNING id`,
    [dispute.id, dispute.status]
  );
  if (rows[0]) {
    await notifyOwner(`dispute-closed:${dispute.id}`, `Chargeback on order #${rows[0].id} closed: ${dispute.status}`, `Final status: ${dispute.status}.`);
  }
  return { updated: rows.length };
}

module.exports = { handleDisputeCreated, handleDisputeClosed, evidenceFor };
