// Transactional customer email via Resend. Every customer touchpoint is
// automated and sent from the brand, never a person.

const config = require("./config");

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

function money(n) {
  return `${config.CURRENCY_SYMBOL}${Number(n).toFixed(2)}`;
}

function layout(heading, bodyHtml) {
  return `<div style="font-family:system-ui,-apple-system,Segoe UI,sans-serif;max-width:560px;margin:0 auto;color:#1c1b22">
  <h1 style="font-size:20px">${escapeHtml(config.BRAND.name)}</h1>
  <h2 style="font-size:17px">${escapeHtml(heading)}</h2>
  ${bodyHtml}
  <p style="color:#6b6a75;font-size:13px;margin-top:32px">Questions? Just reply to this email or write to
  ${escapeHtml(config.BRAND.supportEmail)}.</p></div>`;
}

function orderConfirmation(order, items) {
  const rows = items
    .map((i) => `<li>${escapeHtml(i.title)} × ${i.quantity} — ${money(i.unit_price * i.quantity)}</li>`)
    .join("");
  return {
    subject: `Order #${order.id} confirmed`,
    html: layout(
      "Thanks — your order is confirmed",
      `<p>Hi ${escapeHtml(order.customer_name || "there")}, we've received your order and it's being prepared.
      You'll get another email with tracking as soon as it ships.</p>
      <ul>${rows}</ul><p><strong>Total: ${money(order.total)}</strong></p>`
    ),
  };
}

function shippingNotice(order) {
  const link = order.tracking_url
    ? `<p><a href="${escapeHtml(order.tracking_url)}">Track your package</a></p>`
    : "";
  return {
    subject: `Order #${order.id} has shipped`,
    html: layout(
      "Your order is on its way",
      `<p>Tracking number: <strong>${escapeHtml(order.tracking_number)}</strong>
      ${order.carrier ? `(${escapeHtml(order.carrier)})` : ""}</p>${link}
      <p>Tracking can take 2–3 days to show movement after it's first issued.</p>`
    ),
  };
}

function checkoutRecovery(name, recoveryUrl) {
  return {
    subject: "You left something in your cart",
    html: layout(
      "Still thinking it over?",
      `<p>Hi ${escapeHtml(name || "there")}, your cart is saved. Pick up where you left off — shipping is free and tracked,
      with 30-day returns.</p><p><a href="${escapeHtml(recoveryUrl)}">Return to checkout</a></p>
      <p style="color:#6b6a75;font-size:13px">You're receiving this because you opted in to emails at checkout. Reply "stop" and we won't email you again.</p>`
    ),
  };
}

function reviewRequest(order, items, reviewBaseUrl) {
  const links = items
    .map((i) => `<li><a href="${escapeHtml(`${reviewBaseUrl}&p=${i.product_id}`)}">Review ${escapeHtml(i.title)}</a></li>`)
    .join("");
  return {
    subject: `How is your order #${order.id}?`,
    html: layout(
      "How did we do?",
      `<p>Hi ${escapeHtml(order.customer_name || "there")}, we'd love your honest review — good or bad, it's published as written and helps
      other shoppers.</p><ul>${links}</ul>`
    ),
  };
}

async function send(to, { subject, html }) {
  const key = process.env.RESEND_API_KEY;
  const from = process.env.EMAIL_FROM;
  if (!key || !from) {
    console.warn(`email skipped (RESEND_API_KEY/EMAIL_FROM not set): ${subject}`);
    return false;
  }
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from, to, subject, html, reply_to: config.BRAND.supportEmail }),
  });
  if (!res.ok) throw new Error(`Resend ${res.status}: ${await res.text()}`);
  return true;
}

module.exports = { send, orderConfirmation, shippingNotice, checkoutRecovery, reviewRequest, escapeHtml };
