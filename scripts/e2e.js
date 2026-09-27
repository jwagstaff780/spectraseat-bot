#!/usr/bin/env node
// End-to-end run of the whole autopilot against a real Postgres, with the
// supplier, Stripe and Resend faked. Walks one product from sourcing to
// delivery through the real API handlers:
//   source cron -> admin publish -> storefront -> checkout -> Stripe webhook
//   (and a duplicate redelivery) -> supplier order -> fulfil cron -> tracking
//   email -> delivered -> admin P&L.
// Usage: DATABASE_URL=postgres://... node scripts/e2e.js   (DROPS store tables)

const crypto = require("crypto");
const assert = require("assert");
const { Readable } = require("stream");

if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL required (use a throwaway database — this drops tables).");
  process.exit(1);
}
Object.assign(process.env, {
  CRON_SECRET: "cron-secret",
  ADMIN_TOKEN: "admin-token",
  STRIPE_SECRET_KEY: "sk_test_fake",
  STRIPE_WEBHOOK_SECRET: "whsec_fake",
  RESEND_API_KEY: "re_fake",
  EMAIL_FROM: "Store <orders@example.com>",
  APP_URL: "https://store.example",
});
delete process.env.ANTHROPIC_API_KEY; // exercise the fallback copywriter

// ---- fakes ---------------------------------------------------------------
const supplierState = { orders: [], orderStatus: {} };
const fakeSupplier = {
  name: "cj",
  async searchProducts() {
    return [
      { productId: "P-GOOD", title: "Memory Foam Seat Cushion Ergonomic", price: 6 },
      { productId: "P-PRICEY", title: "Deluxe Massage Chair Pad", price: 45 },
    ];
  },
  async getProduct(id) {
    const price = id === "P-GOOD" ? 6 : 45;
    return {
      productId: id,
      title: `Supplier title for ${id}`,
      description: "Soft memory foam. Non-slip base.",
      images: ["https://img.example/1.jpg"],
      variants: [{ variantId: `${id}-V1`, name: "Black", price, image: "https://img.example/v.jpg" }],
    };
  },
  async getStock() {
    return 500;
  },
  async quoteShipping() {
    return { method: "CJPacket", cost: 4, days: { min: 7, max: 12 } };
  },
  async createOrder(order, items, method) {
    supplierState.orders.push({ orderId: order.id, items: items.map((i) => [i.supplier_variant_id, i.quantity]), method });
    return { supplierOrderId: `CJ-${order.id}` };
  },
  async getOrderStatus(id) {
    return supplierState.orderStatus[id] || { status: "processing", trackingNumber: null };
  },
};
require.cache[require.resolve("../lib/supplier")] = {
  id: require.resolve("../lib/supplier"),
  filename: require.resolve("../lib/supplier"),
  loaded: true,
  exports: { getSupplier: () => fakeSupplier },
};

const sentEmails = [];
const stripeSessions = [];
global.fetch = async (url, opts = {}) => {
  url = String(url);
  if (url.startsWith("https://api.stripe.com/v1/checkout/sessions")) {
    const params = new URLSearchParams(opts.body);
    stripeSessions.push(params);
    return new Response(JSON.stringify({ id: "cs_test_1", url: "https://checkout.stripe.test/cs_test_1" }), { status: 200 });
  }
  if (url.startsWith("https://api.resend.com/emails")) {
    sentEmails.push(JSON.parse(opts.body));
    return new Response("{}", { status: 200 });
  }
  throw new Error(`unexpected fetch ${url}`);
};

// ---- tiny Vercel req/res shim -------------------------------------------
async function call(handler, { method = "GET", query = {}, body, raw, headers = {} } = {}) {
  const req = raw !== undefined ? Readable.from([Buffer.from(raw)]) : Readable.from([]);
  Object.assign(req, { method, query, body, headers: { host: "store.example", ...headers } });
  let status = 200;
  let payload;
  const res = {
    setHeader() {},
    status(s) {
      status = s;
      return res;
    },
    json(p) {
      payload = p;
      return res;
    },
  };
  await handler(req, res);
  return { status, body: payload };
}

const cron = { headers: { authorization: "Bearer cron-secret" } };
const admin = { headers: { authorization: "Bearer admin-token" } };

(async () => {
  const db = require("../lib/db");
  await db.getPool().query("DROP TABLE IF EXISTS order_items, orders, products, automation_runs, kv CASCADE");

  // 1. Sourcing imports only the product that clears the guardrails, as draft.
  let r = await call(require("../api/cron/source"), { method: "POST", ...cron });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.sourcing.imported.length, 1, "one product imported");
  assert.equal(r.body.sourcing.rejected, 1, "pricey product rejected");
  const imported = r.body.sourcing.imported[0];
  assert.equal(imported.status, "draft");
  assert.equal(Number(imported.price), 28.99);
  console.log("ok: sourcing imported 1 draft at $28.99, rejected 1");

  r = await call(require("../api/cron/source"), { method: "POST", query: {}, headers: { authorization: "Bearer wrong" } });
  assert.equal(r.status, 401);
  console.log("ok: cron rejects bad secret");

  // 2. Draft is invisible until published from admin.
  r = await call(require("../api/products"));
  assert.equal(r.body.products.length, 0);
  r = await call(require("../api/admin/products"), { method: "PATCH", query: { id: imported.id }, body: { status: "active" }, ...admin });
  assert.equal(r.body.status, "active");
  r = await call(require("../api/products"));
  assert.equal(r.body.products.length, 1);
  const product = r.body.products[0];
  assert(!("landed_cost" in product));
  console.log("ok: publish makes product visible; no cost leak");

  // 3. Checkout uses DB price even if the client lies.
  r = await call(require("../api/checkout"), {
    method: "POST",
    body: { items: [{ productId: product.id, quantity: 2, price: 0.01 }] },
  });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const sent = stripeSessions[0];
  assert.equal(sent.get("line_items[0][price_data][unit_amount]"), "2899");
  assert.equal(sent.get("metadata[cart]"), JSON.stringify([[product.id, 2, 2899]]));
  console.log("ok: checkout session priced from DB ($28.99 × 2)");

  // 4. Stripe webhook -> order recorded, confirmation email, supplier order placed.
  const session = {
    id: "cs_test_1",
    payment_intent: "pi_1",
    payment_status: "paid",
    currency: "usd",
    amount_subtotal: 5798,
    amount_total: 5798,
    customer_details: { email: "buyer@example.com", name: "Sam Buyer", phone: "+15550100" },
    collected_information: {
      shipping_details: { name: "Sam Buyer", address: { line1: "1 Main St", city: "Springfield", state: "IL", postal_code: "62701", country: "US" } },
    },
    metadata: { cart: sent.get("metadata[cart]") },
  };
  const raw = JSON.stringify({ id: "evt_1", type: "checkout.session.completed", data: { object: session } });
  const sign = (body) => {
    const t = Math.floor(Date.now() / 1000);
    return `t=${t},v1=${crypto.createHmac("sha256", "whsec_fake").update(`${t}.${body}`).digest("hex")}`;
  };

  r = await call(require("../api/webhooks/stripe"), { method: "POST", raw, headers: { "stripe-signature": "t=1,v1=00" } });
  assert.equal(r.status, 400);
  console.log("ok: webhook rejects bad signature");

  r = await call(require("../api/webhooks/stripe"), { method: "POST", raw, headers: { "stripe-signature": sign(raw) } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.created, true);
  const orderId = r.body.orderId;
  assert.equal(supplierState.orders.length, 1);
  assert.deepEqual(supplierState.orders[0].items, [["P-GOOD-V1", 2]]);
  assert.equal(sentEmails.filter((e) => e.subject.includes("confirmed")).length, 1);
  console.log("ok: webhook recorded order, emailed confirmation, placed supplier order");

  // Stripe redelivers the same event: no duplicate order, no duplicate purchase.
  r = await call(require("../api/webhooks/stripe"), { method: "POST", raw, headers: { "stripe-signature": sign(raw) } });
  assert.equal(r.body.created, false);
  assert.equal(supplierState.orders.length, 1);
  assert.equal(sentEmails.length, 1);
  console.log("ok: webhook redelivery is idempotent");

  // 5. Fulfil cron: no tracking yet -> nothing; tracking -> shipped + email; then delivered.
  r = await call(require("../api/cron/fulfil"), { method: "POST", ...cron });
  assert.equal(r.body.shipped, 0);
  supplierState.orderStatus[`CJ-${orderId}`] = { status: "shipped", trackingNumber: "YT123", carrier: "YunExpress" };
  r = await call(require("../api/cron/fulfil"), { method: "POST", ...cron });
  assert.equal(r.body.shipped, 1, JSON.stringify(r.body));
  const shipMail = sentEmails.find((e) => e.subject.includes("shipped"));
  assert(shipMail && shipMail.html.includes("YT123"));
  supplierState.orderStatus[`CJ-${orderId}`] = { status: "delivered", trackingNumber: "YT123" };
  r = await call(require("../api/cron/fulfil"), { method: "POST", ...cron });
  assert.equal(r.body.delivered, 1);
  assert.equal(sentEmails.filter((e) => e.subject.includes("shipped")).length, 1, "only one shipping email");
  console.log("ok: tracking synced, shipping email sent once, order delivered");

  // 6. A supplier failure retries then escalates to needs_attention.
  const failingCreate = fakeSupplier.createOrder;
  fakeSupplier.createOrder = async () => {
    throw new Error("insufficient wallet balance");
  };
  const session2 = { ...session, id: "cs_test_2", payment_intent: "pi_2" };
  const raw2 = JSON.stringify({ id: "evt_2", type: "checkout.session.completed", data: { object: session2 } });
  r = await call(require("../api/webhooks/stripe"), { method: "POST", raw: raw2, headers: { "stripe-signature": sign(raw2) } });
  const order2 = r.body.orderId;
  for (let i = 0; i < 5; i++) await call(require("../api/cron/fulfil"), { method: "POST", ...cron });
  r = await call(require("../api/admin/summary"), { ...admin });
  assert(r.body.attention.some((o) => o.id === order2 || Number(o.id) === order2), "failed order flagged");
  fakeSupplier.createOrder = failingCreate;
  r = await call(require("../api/admin/orders"), { method: "POST", query: { id: order2 }, body: { action: "retry" }, ...admin });
  assert.equal(r.body.placed, true, JSON.stringify(r.body));
  console.log("ok: repeated supplier failure escalates; admin retry places it");

  // 7. P&L maths.
  r = await call(require("../api/admin/summary"), { ...admin });
  const p = r.body.pnl;
  assert.equal(p.orders, 2);
  assert(Math.abs(p.revenue - 115.96) < 0.01);
  assert(Math.abs(p.cogs - 40) < 0.01, `cogs ${p.cogs}`);
  assert(p.net_profit > 0 && p.margin_pct > 40, `margin ${p.margin_pct}`);
  console.log(`ok: P&L revenue $${p.revenue.toFixed(2)}, net $${p.net_profit.toFixed(2)} (${p.margin_pct.toFixed(1)}%)`);

  // 8. Supplier cost spike: catalogue sync pauses the product, checkout refuses it.
  fakeSupplier.quoteShipping = async () => ({ method: "CJPacket", cost: 30, days: { min: 7, max: 12 } });
  r = await call(require("../api/cron/source"), { method: "POST", query: { only: "sync" }, ...cron });
  assert.equal(r.body.sync.paused, 1, JSON.stringify(r.body));
  r = await call(require("../api/checkout"), { method: "POST", body: { items: [{ productId: product.id, quantity: 1 }] } });
  assert.equal(r.status, 400);
  // ...and resumes automatically when costs recover.
  fakeSupplier.quoteShipping = async () => ({ method: "CJPacket", cost: 4, days: { min: 7, max: 12 } });
  r = await call(require("../api/cron/source"), { method: "POST", query: { only: "sync" }, ...cron });
  assert.equal(r.body.sync.resumed, 1, JSON.stringify(r.body));
  console.log("ok: margin breach auto-pauses, recovery auto-resumes");

  // 9. A product a human paused is never auto-resumed by the sync.
  await call(require("../api/admin/products"), { method: "PATCH", query: { id: product.id }, body: { status: "paused" }, ...admin });
  r = await call(require("../api/cron/source"), { method: "POST", query: { only: "sync" }, ...cron });
  assert.equal(r.body.sync.resumed, 0);
  r = await call(require("../api/products"));
  assert.equal(r.body.products.length, 0);
  console.log("ok: manual pause is respected by the sync");

  await db.getPool().end();
  console.log("\nall e2e checks passed");
})().catch(async (err) => {
  console.error(err);
  process.exit(1);
});
