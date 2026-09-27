#!/usr/bin/env node
// End-to-end run of the whole autopilot against a real Postgres, with the
// supplier, Stripe, Resend, Meta and the Claude API faked at the HTTP layer.
// Drives everything through the real API dispatchers:
//   source cron -> admin publish -> storefront -> checkout -> Stripe webhook
//   (and a duplicate redelivery) -> supplier order + Meta CAPI -> fulfil cron
//   -> tracking email -> delivered -> admin P&L -> reviews (supplier import,
//   verified review via emailed link) -> support agent (tool loop, refund
//   policy, tickets) -> abandoned-cart recovery -> content agent -> ads
//   manager (dry run, live launch, kill, stop-loss, resume) -> sales manager.
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
  ANTHROPIC_API_KEY: "sk-ant-test",
  META_ACCESS_TOKEN: "meta-token",
  META_AD_ACCOUNT_ID: "123",
  META_PIXEL_ID: "px1",
  META_PAGE_ID: "page1",
  OWNER_EMAIL: "owner@example.com",
  REVIEW_SECRET: "review-secret",
});
delete process.env.META_PAGE_ACCESS_TOKEN; // social posts queue instead of publishing

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
  async getReviews() {
    return [
      { externalId: "r1", author: "margaret", country: "US", rating: 5, body: "Very comfy.", reviewedAt: new Date() },
      { externalId: "r2", author: "tom", country: "GB", rating: 1, body: "Flattened after a week.", reviewedAt: new Date() },
      { externalId: "r3", author: "spam", country: "US", rating: 5, body: "buy cheap at www.spam.example", reviewedAt: new Date() },
    ];
  },
};
require.cache[require.resolve("../lib/supplier")] = {
  id: require.resolve("../lib/supplier"),
  filename: require.resolve("../lib/supplier"),
  loaded: true,
  exports: { getSupplier: () => fakeSupplier, enabledSuppliers: () => [fakeSupplier], adapters: { cj: fakeSupplier } },
};

const sentEmails = [];
const stripeSessions = [];
const refunds = [];
const disputeUpdates = [];
const metaCalls = [];
const metaState = { insights: [] };
const claudeRequests = [];
const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } });

// Fake Claude: answers structured-output requests by schema shape, and
// drives the support agent through one lookup_order tool call.
function fakeClaude(body) {
  const msg = (content, stop_reason = "end_turn") => ({
    id: "msg_test", type: "message", role: "assistant", model: body.model, content, stop_reason,
    stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 },
  });
  const text = (obj) => msg([{ type: "text", text: JSON.stringify(obj) }]);
  const fmt = body.output_config && body.output_config.format;
  if (fmt) {
    const keys = Object.keys(fmt.schema.properties);
    if (keys.includes("clean_image_indexes")) {
      const imgs = body.messages[0].content.filter((b) => b.type === "image").length;
      return text({ score: 78, summary: "Solves a clear problem.", risks: { trademark_or_knockoff: false, regulated_product: false, fragile_or_hard_to_ship: false, high_return_risk: false }, clean_image_indexes: [...Array(imgs).keys()] });
    }
    if (keys.includes("seo_description")) return text({ title: "Cloud Memory Foam Seat Cushion", description: "Soft memory foam.", bullets: ["Non-slip base"], seo_description: "Soft memory foam cushion." });
    if (keys.includes("variants")) return text({ variants: [1, 2, 3].map((i) => ({ angle: `angle ${i}`, primary_text: `Text ${i}`, headline: `Headline ${i}`, description: "Free shipping" })) });
    if (keys.includes("caption")) return text({ caption: "Sit better. #comfort" });
    if (keys.includes("sections")) return text({ headline: "Profitable week.", sections: [{ heading: "Performance", points: ["2 orders"] }] });
    if (keys.includes("body")) return text({ title: "How to Choose a Seat Cushion", body: "## Why it matters\n\nComfort counts." });
    throw new Error(`fake Claude: unknown schema ${keys}`);
  }
  if (body.tools) {
    const last = body.messages[body.messages.length - 1];
    if (typeof last.content === "string") {
      const m = last.content.match(/order (\d+)/);
      return msg([{ type: "tool_use", id: "tu_1", name: "lookup_order", input: { email: "buyer@example.com", order_number: Number(m && m[1]) } }], "tool_use");
    }
    const result = JSON.parse(last.content[0].content);
    return msg([{ type: "text", text: `Your order status is ${result.status}.` }]);
  }
  throw new Error("fake Claude: unexpected request");
}

function fakeMeta(url, opts) {
  const u = new URL(url);
  const path = u.pathname.replace(/^\/v[\d.]+\//, "");
  const params = Object.fromEntries(opts.method === "GET" || !opts.method ? u.searchParams : new URLSearchParams(opts.body));
  metaCalls.push({ method: opts.method || "GET", path, params });
  if (path === "px1/events") return json({ events_received: 1 });
  if (path.endsWith("/campaigns")) return json({ id: "camp1" });
  if (path.endsWith("/adsets")) return json({ id: "adset1" });
  if (path.endsWith("/adimages")) return json({ images: { img: { hash: "hash1" } } });
  if (path.endsWith("/adcreatives")) return json({ id: `cr${metaCalls.length}` });
  if (path.endsWith("/ads")) return json({ id: `ad${metaCalls.length}` });
  if (path === "adset1/insights") return json({ data: metaState.insights });
  if (path === "adset1") return json({ success: true });
  throw new Error(`fake Meta: unexpected ${path}`);
}

global.fetch = async (url, opts = {}) => {
  url = String(url);
  if (url.startsWith("https://api.anthropic.com/")) {
    const body = JSON.parse(opts.body);
    claudeRequests.push({ body, beta: new Headers(opts.headers).get("anthropic-beta") });
    return json(fakeClaude(body));
  }
  if (url.startsWith("https://graph.facebook.com/")) return fakeMeta(url, opts);
  if (url.startsWith("https://img.example/")) return new Response(Buffer.from("fake-image"), { status: 200 });
  if (url.startsWith("https://api.stripe.com/v1/disputes/")) {
    disputeUpdates.push({ id: url.split("/").pop(), params: new URLSearchParams(opts.body) });
    return json({ id: url.split("/").pop(), status: "under_review" });
  }
  if (url.startsWith("https://api.stripe.com/v1/refunds")) {
    refunds.push(new URLSearchParams(opts.body).get("payment_intent"));
    return json({ id: "re_1", status: "succeeded" });
  }
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

// Route through the real per-directory dispatchers (api/<dir>/[route].js).
function H(path) {
  const [dir, route] = path.split("/");
  const dispatcher = require(`../api/${dir}/[route].js`);
  return (req, res) => {
    req.query = { ...req.query, route };
    return dispatcher(req, res);
  };
}

const cron = { headers: { authorization: "Bearer cron-secret" } };
const admin = { headers: { authorization: "Bearer admin-token" } };

(async () => {
  const db = require("../lib/db");
  await db.getPool().query(
    `DROP TABLE IF EXISTS order_items, orders, products, automation_runs, kv, reviews, ad_campaigns, ad_metrics_daily,
       ad_decisions, content, support_tickets, checkout_recoveries, agent_reports, rate_limits, product_variants CASCADE`
  );

  // 1. Sourcing imports only the product that clears the guardrails, as draft.
  let r = await call(H("cron/source"), { method: "POST", ...cron });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.sourcing.imported.length, 1, `one product imported: ${JSON.stringify(r.body.sourcing)}`);
  assert.equal(r.body.sourcing.imported[0].supplierReviews, 3, "supplier reviews imported");
  assert.equal(r.body.sourcing.imported[0].title, "Cloud Memory Foam Seat Cushion", "AI copywriter used");
  assert.equal(r.body.sourcing.rejected, 1, "pricey product rejected");
  const imported = r.body.sourcing.imported[0];
  assert.equal(imported.status, "draft");
  assert.equal(Number(imported.price), 28.99);
  console.log("ok: sourcing imported 1 draft at $28.99, rejected 1");

  r = await call(H("cron/source"), { method: "POST", query: {}, headers: { authorization: "Bearer wrong" } });
  assert.equal(r.status, 401);
  console.log("ok: cron rejects bad secret");

  // 2. Draft is invisible until published from admin.
  r = await call(H("shop/products"));
  assert.equal(r.body.products.length, 0);
  r = await call(H("admin/products"), { method: "PATCH", query: { id: imported.id }, body: { status: "active" }, ...admin });
  assert.equal(r.body.status, "active");
  r = await call(H("shop/products"));
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
  // 2 units -> multi-buy tier (10% off $28.99 = $26.09 each), priced server-side.
  assert.equal(sent.get("line_items[0][price_data][unit_amount]"), "2609");
  assert.equal(product.variants.length, 1);
  assert.equal(sent.get("metadata[cart]"), JSON.stringify([[product.id, product.variants[0].id, 2, 2609]]));
  assert.equal(sent.get("allow_promotion_codes"), "true");
  console.log("ok: checkout priced from DB with multi-buy discount ($26.09 × 2), promo codes on");

  // 4. Stripe webhook -> order recorded, confirmation email, supplier order placed.
  const session = {
    id: "cs_test_1",
    payment_intent: "pi_1",
    payment_status: "paid",
    currency: "usd",
    amount_subtotal: 5218,
    amount_total: 5218,
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
  const capi = metaCalls.filter((c) => c.path === "px1/events");
  assert.equal(capi.length, 1, "purchase sent to Meta CAPI");
  assert.equal(JSON.parse(capi[0].params.data)[0].event_id, `order-${orderId}`);
  console.log("ok: webhook recorded order, emailed confirmation, placed supplier order, sent CAPI purchase");

  // Stripe redelivers the same event: no duplicate order, no duplicate purchase.
  r = await call(require("../api/webhooks/stripe"), { method: "POST", raw, headers: { "stripe-signature": sign(raw) } });
  assert.equal(r.body.created, false);
  assert.equal(supplierState.orders.length, 1);
  assert.equal(sentEmails.length, 1);
  assert.equal(metaCalls.filter((c) => c.path === "px1/events").length, 1, "no duplicate CAPI event");
  console.log("ok: webhook redelivery is idempotent");

  // 5. Fulfil cron: no tracking yet -> nothing; tracking -> shipped + email; then delivered.
  r = await call(H("cron/fulfil"), { method: "POST", ...cron });
  assert.equal(r.body.shipped, 0);
  supplierState.orderStatus[`CJ-${orderId}`] = { status: "shipped", trackingNumber: "YT123", carrier: "YunExpress" };
  r = await call(H("cron/fulfil"), { method: "POST", ...cron });
  assert.equal(r.body.shipped, 1, JSON.stringify(r.body));
  const shipMail = sentEmails.find((e) => e.subject.includes("shipped"));
  assert(shipMail && shipMail.html.includes("YT123"));
  supplierState.orderStatus[`CJ-${orderId}`] = { status: "delivered", trackingNumber: "YT123" };
  r = await call(H("cron/fulfil"), { method: "POST", ...cron });
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
  for (let i = 0; i < 5; i++) await call(H("cron/fulfil"), { method: "POST", ...cron });
  r = await call(H("admin/summary"), { ...admin });
  assert(r.body.attention.some((o) => o.id === order2 || Number(o.id) === order2), "failed order flagged");
  fakeSupplier.createOrder = failingCreate;
  r = await call(H("admin/orders"), { method: "POST", query: { id: order2 }, body: { action: "retry" }, ...admin });
  assert.equal(r.body.placed, true, JSON.stringify(r.body));
  console.log("ok: repeated supplier failure escalates; admin retry places it");

  // 7. P&L maths.
  r = await call(H("admin/summary"), { ...admin });
  const p = r.body.pnl;
  assert.equal(p.orders, 2);
  assert(Math.abs(p.revenue - 104.36) < 0.01, `revenue ${p.revenue}`);
  assert(Math.abs(p.cogs - 40) < 0.01, `cogs ${p.cogs}`);
  assert(p.net_profit > 0 && p.margin_pct > 40, `margin ${p.margin_pct}`);
  console.log(`ok: P&L revenue $${p.revenue.toFixed(2)}, net $${p.net_profit.toFixed(2)} (${p.margin_pct.toFixed(1)}%)`);

  // 8. Supplier cost spike: catalogue sync pauses the product, checkout refuses it.
  fakeSupplier.quoteShipping = async () => ({ method: "CJPacket", cost: 30, days: { min: 7, max: 12 } });
  r = await call(H("cron/source"), { method: "POST", query: { only: "sync" }, ...cron });
  assert.equal(r.body.sync.paused, 1, JSON.stringify(r.body));
  r = await call(require("../api/checkout"), { method: "POST", body: { items: [{ productId: product.id, quantity: 1 }] } });
  assert.equal(r.status, 400);
  // ...and resumes automatically when costs recover.
  fakeSupplier.quoteShipping = async () => ({ method: "CJPacket", cost: 4, days: { min: 7, max: 12 } });
  r = await call(H("cron/source"), { method: "POST", query: { only: "sync" }, ...cron });
  assert.equal(r.body.sync.resumed, 1, JSON.stringify(r.body));
  console.log("ok: margin breach auto-pauses, recovery auto-resumes");

  // 9. A product a human paused is never auto-resumed by the sync.
  await call(H("admin/products"), { method: "PATCH", query: { id: product.id }, body: { status: "paused" }, ...admin });
  r = await call(H("cron/source"), { method: "POST", query: { only: "sync" }, ...cron });
  assert.equal(r.body.sync.resumed, 0);
  r = await call(H("shop/products"));
  assert.equal(r.body.products.length, 0);
  console.log("ok: manual pause is respected by the sync");

  // 10. Reviews: supplier reviews shown unfiltered by rating (1★ kept),
  //     link spam hidden; verified review via the emailed signed link.
  const { query } = require("../lib/db");
  await query(`UPDATE products SET status='active', status_reason=NULL WHERE id=$1`, [product.id]);
  r = await call(H("shop/reviews"), { query: { productId: product.id } });
  assert.equal(r.body.supplier.count, 2, "spam hidden, rest shown");
  assert(r.body.supplier.reviews.some((x) => x.rating === 1), "1-star supplier review NOT suppressed");
  assert.equal(r.body.verified.count, 0, "supplier reviews never count as verified");
  await query(`UPDATE orders SET delivered_at = now() - interval '6 days' WHERE id=$1`, [orderId]);
  r = await call(H("cron/fulfil"), { method: "POST", ...cron });
  assert.equal(r.body.reviewRequests, 1, JSON.stringify(r.body));
  const reviewMail = sentEmails.find((e) => e.subject.includes("How is your order"));
  const link = reviewMail.html.match(/review\.html\?t=([^&"]+)&amp;p=(\d+)/);
  const token = decodeURIComponent(link[1]);
  r = await call(H("shop/reviews"), { method: "POST", body: { token, productId: Number(link[2]), rating: 2, body: "Too firm for me.", name: "sam" } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  r = await call(H("shop/reviews"), { method: "POST", body: { token, productId: Number(link[2]), rating: 5, body: "again" } });
  assert.equal(r.status, 400, "one review per order item");
  r = await call(H("shop/reviews"), { method: "POST", body: { token: token.replace(/.$/, "0"), productId: product.id, rating: 5, body: "forged" } });
  assert.equal(r.status, 400, "forged token rejected");
  r = await call(H("shop/reviews"), { query: { productId: product.id } });
  assert.equal(r.body.verified.count, 1);
  assert.equal(r.body.verified.average, 2, "negative verified review published as written");
  console.log("ok: reviews — supplier unfiltered & labelled, verified via signed link, negatives kept");

  // 11. Support agent: Claude tool loop + deterministic refund policy.
  r = await call(H("shop/support"), { method: "POST", body: { messages: [{ role: "user", content: `where is order ${orderId}?` }] } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.reply, "Your order status is delivered.");
  const supportReq = claudeRequests.filter((c) => c.body.tools);
  assert.equal(supportReq[1].body.messages.at(-1).content[0].type, "tool_result", "tool result fed back");
  assert.equal(supportReq[0].body.fallbacks, "default", "refusal fallbacks enabled");
  assert(String(supportReq[0].beta).includes("server-side-fallback-2026-07-01"), "fallback beta header");
  const support = require("../lib/agents/support");
  let t = await support.runTool("lookup_order", { email: "someone@else.com", order_number: orderId }, []);
  assert(t.error, "order lookup needs the matching email");
  t = await support.runTool("request_refund", { email: "buyer@example.com", order_number: order2, reason: "changed my mind" }, []);
  assert.equal(t.result, "escalated", "in-window refund escalates to a ticket");
  await query(`UPDATE orders SET created_at = now() - interval '40 days' WHERE id=$1`, [order2]);
  t = await support.runTool("request_refund", { email: "buyer@example.com", order_number: order2, reason: "never arrived" }, []);
  assert.equal(t.result, "refunded", JSON.stringify(t));
  assert.deepEqual(refunds, ["pi_2"]);
  t = await support.runTool("request_refund", { email: "buyer@example.com", order_number: order2, reason: "again" }, []);
  assert.equal(t.result, "already_refunded", "no double refund");
  assert.equal(refunds.length, 1);
  r = await call(H("admin/tickets"), { ...admin });
  assert.equal(r.body.tickets.length, 1, "escalation ticket visible to admin");
  console.log("ok: support agent — tool loop, email-gated lookups, capped auto-refund, escalations");

  // 12. Abandoned checkout recovery only with consent, only once.
  const expired = (id, consent) => {
    const body = JSON.stringify({ type: "checkout.session.expired", data: { object: {
      id, consent: { promotions: consent }, after_expiration: { recovery: { url: "https://checkout.stripe.test/recover" } },
      customer_details: { email: "maybe@example.com", name: "May" } } } });
    return call(require("../api/webhooks/stripe"), { method: "POST", raw: body, headers: { "stripe-signature": sign(body) } });
  };
  assert.equal((await expired("cs_x1", "opt_in")).body.sent, true);
  assert.equal((await expired("cs_x1", "opt_in")).body.sent, false, "recovery sent once");
  assert.equal((await expired("cs_x2", "opt_out")).body.sent, false, "no consent, no email");
  console.log("ok: abandoned-cart recovery respects consent and dedupes");

  // 13. Content agent: blog article + social posts (queued without Page token).
  r = await call(H("cron/marketing"), { method: "POST", query: { only: "content" }, ...cron });
  assert.equal(r.body.content.blog.length, 1, JSON.stringify(r.body));
  assert.equal(r.body.content.social.length, 2);
  assert(r.body.content.social.every((x) => x.status === "queued"));
  r = await call(H("shop/content"));
  assert.equal(r.body.articles.length, 1);
  r = await call(H("shop/content"), { query: { slug: r.body.articles[0].slug } });
  assert.equal(r.body.article.title, "How to Choose a Seat Cushion");
  r = await call(H("cron/marketing"), { method: "POST", query: { only: "content" }, ...cron });
  assert.equal(r.body.content.blog.length + r.body.content.social.length, 0, "daily quota respected");
  console.log("ok: content agent — blog published on-site, social queued, daily quota");

  // 14. Ads manager: dry run spends nothing; live launches; kill rule; stop-loss.
  const config = require("../lib/config");
  r = await call(H("cron/marketing"), { method: "POST", query: { only: "ads" }, ...cron });
  assert.equal(r.body.ads.mode, "dry_run");
  assert.equal(r.body.ads.launched.length, 1, JSON.stringify(r.body));
  assert.equal(metaCalls.filter((c) => c.method === "POST" && !c.path.endsWith("/events")).length, 0, "dry run never writes to Meta");

  config.ADS.MODE = "live";
  r = await call(H("cron/marketing"), { method: "POST", query: { only: "ads" }, ...cron });
  assert.equal(r.body.ads.launched.length, 1, JSON.stringify(r.body));
  const adsetCall = metaCalls.find((c) => c.path === "act_123/adsets");
  assert.equal(adsetCall.params.daily_budget, "1000", "test launched at $10/day");
  assert.equal(JSON.parse(adsetCall.params.promoted_object).custom_event_type, "PURCHASE");
  assert.equal(metaCalls.filter((c) => c.path === "act_123/ads").length, 3, "one ad per creative variant");

  const today = new Date();
  const dayStr = (n) => new Date(today.getTime() - n * 86400000).toISOString().slice(0, 10);
  metaState.insights = [2, 1, 0].map((n) => ({ date_start: dayStr(n), spend: "10", impressions: "1000", clicks: "20", actions: [] }));
  r = await call(H("cron/marketing"), { method: "POST", query: { only: "ads" }, ...cron });
  assert.equal(r.body.ads.killed.length, 1, JSON.stringify(r.body));
  assert(metaCalls.some((c) => c.path === "adset1" && c.params.status === "PAUSED"), "losing ad set paused on Meta");

  const { rows: [camp] } = await query(`SELECT id FROM ad_campaigns WHERE NOT dry_run`);
  await query(`INSERT INTO ad_metrics_daily (campaign_id, day, spend) VALUES ($1, current_date - 1, 500)
               ON CONFLICT (campaign_id, day) DO UPDATE SET spend = 500`, [camp.id]);
  r = await call(H("cron/marketing"), { method: "POST", query: { only: "ads" }, ...cron });
  assert(r.body.ads.halted && /stop-loss/.test(r.body.ads.halted.reason), JSON.stringify(r.body));
  r = await call(H("cron/marketing"), { method: "POST", query: { only: "ads" }, ...cron });
  assert.equal(r.body.ads.launched.length, 0, "halted: nothing launches");
  r = await call(H("admin/ads"), { method: "POST", body: { action: "resume" }, ...admin });
  assert.equal(r.body.halted, null);
  r = await call(H("admin/summary"), { ...admin });
  assert(r.body.pnl.ad_spend >= 500 && r.body.pnl.net_profit < 0, "ad spend in P&L");
  config.ADS.MODE = "dry_run";
  console.log("ok: ads — dry run is read-only, live launch, kill rule pauses on Meta, stop-loss halts, P&L includes ads");

  // 15. Sales manager: rules act, AI writes, owner gets the briefing.
  const sm = require("../lib/agents/salesManager");
  const acted = await sm.applyRules({ refundsByProduct: [{ id: product.id, title: "x", status: "active", orders: 6, refunds: 2 }] });
  assert.equal(acted.length, 1, "high-refund product paused");
  r = await call(H("cron/source"), { method: "POST", query: { only: "sync" }, ...cron });
  assert.equal(r.body.sync.resumed, 0, "refund-paused product is not auto-resumed");
  r = await call(H("cron/report"), { method: "POST", ...cron });
  assert(r.body.reportId, JSON.stringify(r.body));
  assert(sentEmails.some((e) => e.to === "owner@example.com" && e.subject.includes("daily briefing")));
  r = await call(H("admin/agents"), { ...admin });
  assert(r.body.reports[0].body.startsWith("Profitable week."));
  console.log("ok: sales manager — refund rule, AI briefing stored and emailed to owner");

  // 16. Chargebacks: shipped order -> evidence auto-submitted; unshipped -> owner alerted.
  const disputeEvent = (id, pi, type = "charge.dispute.created", status = "needs_response") => {
    const body = JSON.stringify({ type, data: { object: { id, payment_intent: pi, amount: 5218, reason: "product_not_received", status } } });
    return call(require("../api/webhooks/stripe"), { method: "POST", raw: body, headers: { "stripe-signature": sign(body) } });
  };
  r = await disputeEvent("dp_1", "pi_1");
  assert.equal(r.body.submitted, true, JSON.stringify(r.body));
  const ev = disputeUpdates[0].params;
  assert.equal(ev.get("evidence[shipping_tracking_number]"), "YT123");
  assert.equal(ev.get("evidence[customer_email_address]"), "buyer@example.com");
  assert.equal(ev.get("submit"), "true");
  assert(sentEmails.some((e) => e.to === "owner@example.com" && /evidence submitted/.test(e.subject)));
  await query(`UPDATE orders SET status='placed', tracking_number=NULL WHERE id=$1`, [order2]);
  r = await disputeEvent("dp_2", "pi_2");
  assert.equal(r.body.submitted, false, "no tracking -> no auto-evidence");
  assert.equal(disputeUpdates.length, 1);
  assert(sentEmails.some((e) => /needs you/.test(e.subject)));
  r = await disputeEvent("dp_1", "pi_1", "charge.dispute.closed", "won");
  assert.equal(r.body.updated, 1);
  console.log("ok: chargebacks — evidence auto-submitted with tracking; unshipped escalated; closure recorded");

  // 17. Delay notice (FTC Mail Order Rule) sent once; owner alert de-duplicated.
  await query(`UPDATE orders SET created_at = now() - interval '6 days' WHERE id=$1`, [order2]);
  r = await call(H("cron/fulfil"), { method: "POST", ...cron });
  assert.equal(r.body.delayNotices, 1, JSON.stringify(r.body));
  r = await call(H("cron/fulfil"), { method: "POST", ...cron });
  assert.equal(r.body.delayNotices, 0, "delay notice sent once");
  const alerts = require("../lib/alerts");
  assert.equal(await alerts.notifyOwner("test-key", "x", "y"), true);
  assert.equal(await alerts.notifyOwner("test-key", "x", "y"), false, "alert cooldown");
  console.log("ok: delay notice with cancel option; owner alerts de-duplicated");

  // 18. Conversions API only for consent-exempt countries.
  const meta = require("../lib/ads/meta");
  assert.equal(await meta.sendPurchase({ id: 99, email: "a@b.co", currency: "gbp", total: 10, shipping_address: { country: "GB" } }), false);
  assert.equal(await meta.sendPurchase({ id: 98, email: "a@b.co", currency: "usd", total: 10, shipping_address: { country: "US" } }), true);
  console.log("ok: Meta CAPI respects country consent list");

  r = await call(H("admin/nope"), { ...admin });
  assert.equal(r.status, 404, "unknown route 404s");

  await db.getPool().end();
  console.log("\nall e2e checks passed");
})().catch(async (err) => {
  console.error(err);
  process.exit(1);
});
