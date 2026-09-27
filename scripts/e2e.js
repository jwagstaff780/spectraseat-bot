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
// Real UK email-dropship adapter, on a temporary catalogue file.
const E2E_CATALOGUE = "scripts/.e2e-specialist.json";
require("fs").writeFileSync(require("path").join(__dirname, "..", E2E_CATALOGUE), JSON.stringify({
  supplier: "specialist",
  shipping: { method: "Royal Mail Tracked 48", cost: 3.2, days: { min: 2, max: 4 } },
  products: [
    { sku: "MAG-120", type: "supplement", title: "Magnesium Glycinate 120 Capsules", cost: 6.5, net_quantity: "120 capsules",
      images: ["https://img.example/mag.jpg"], ingredients: [{ name: "Magnesium", amount: 200, unit: "mg" }],
      ingredients_text: "Magnesium Bisglycinate, Capsule Shell (HPMC).", allergens: [], directions: "Take two capsules daily with water." },
    { sku: "ASH-60", type: "supplement", title: "Ashwagandha Root Extract 60 Capsules", cost: 5.9, net_quantity: "60 capsules",
      images: ["https://img.example/ash.jpg"], ingredients: [{ name: "Ashwagandha", amount: 500, unit: "mg" }],
      ingredients_text: "Ashwagandha Root Extract, Capsule Shell (HPMC).", allergens: [], directions: "Take one capsule daily with water." },
  ],
}));
const specialist = require("../lib/supplier/emailDropship").makeEmailDropshipSupplier({
  name: "specialist", displayName: "Specialist Supplements", catalogueFile: E2E_CATALOGUE, orderEmailEnv: "SPECIALIST_ORDER_EMAIL",
});
process.env.SPECIALIST_ORDER_EMAIL = "orders@specialist.example";

require.cache[require.resolve("../lib/supplier")] = {
  id: require.resolve("../lib/supplier"),
  filename: require.resolve("../lib/supplier"),
  loaded: true,
  exports: {
    getSupplier: (name) => (name === "specialist" ? specialist : fakeSupplier),
    enabledSuppliers: () => [fakeSupplier],
    catalogueSuppliers: () => [specialist],
    adapters: { cj: fakeSupplier },
  },
};

// Rendering needs Chromium + ffmpeg; CI covers it separately (render smoke
// test). Here a stub writes a tiny file so the publishing pipeline runs.
const renderCalls = [];
require.cache[require.resolve("../lib/video/render")] = {
  id: require.resolve("../lib/video/render"),
  filename: require.resolve("../lib/video/render"),
  loaded: true,
  exports: {
    renderVideo: async ({ script, product, outFile }) => {
      renderCalls.push({ script, product: product.id });
      require("fs").writeFileSync(outFile, Buffer.from("fake-mp4"));
      return { file: outFile, duration: 24, voiced: false };
    },
  },
};
const videoCalls = [];
require.cache[require.resolve("../lib/video/compose")] = {
  id: require.resolve("../lib/video/compose"),
  filename: require.resolve("../lib/video/compose"),
  loaded: true,
  exports: {
    composeClip: async ({ inputFile, product, outFile }) => {
      videoCalls.push({ to: "compose", product: product.id, bytes: require("fs").statSync(inputFile).size });
      require("fs").copyFileSync(inputFile, outFile);
      return outFile;
    },
    overlayHtml: () => "",
  },
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
    if (keys.includes("beats")) {
      return text({ hook: "Your desk lamp is lying to your eyes.", beats: [
        { say: "This clips onto your monitor.", caption: "Clips on", visual: "product" },
        { say: "The beam angles away from the screen, so there's no glare.", caption: "No glare", visual: "detail" },
        { say: "It's £28.99 with free UK delivery.", caption: "£28.99", visual: "price" },
        { say: "Tap the link to take a closer look.", caption: "Link in bio", visual: "cta" },
      ], title: "No-glare desk light", description: "Nova shows a clever desk light.", hashtags: ["desksetup", "cleverfinds"] });
    }
    if (keys.includes("keywords")) {
      return text({ keywords: [
        { keyword: "Monitor Light Bar!", score: 90, why: "Top of TikTok Shop UK desk setups.", sources: ["https://example.com/a"] },
        { keyword: "weak idea", score: 10, why: "Barely any signal.", sources: [] },
      ] });
    }
    if (keys.includes("clean_image_indexes")) {
      const imgs = body.messages[0].content.filter((b) => b.type === "image").length;
      return text({ score: 78, summary: "Solves a clear problem.", risks: { trademark_or_knockoff: false, regulated_product: false, fragile_or_hard_to_ship: false, high_return_risk: false }, clean_image_indexes: [...Array(imgs).keys()] });
    }
    if (keys.includes("seo_description") && /\(none: describe ingredients/.test(body.system)) {
      // Health product without authorised claims: a non-compliant draft (must be rejected).
      return text({ title: "Ashwagandha Root Extract", description: "Ashwagandha helps you sleep and reduces stress.", bullets: ["Supports a calm mood"], seo_description: "Calm." });
    }
    if (keys.includes("seo_description") && /Magnesium contributes/.test(body.system)) {
      return text({ title: "Magnesium Glycinate Capsules", description: "Two capsules give you 200mg of magnesium. Magnesium contributes to a reduction of tiredness and fatigue.", bullets: ["120 capsules"], seo_description: "UK-made magnesium capsules." });
    }
    if (keys.includes("sources") && keys.includes("status")) {
      return text({ status: "banned", summary: "Test: FSA prohibits ashwagandha in food supplements from 2026-12-01.", sources: ["https://www.food.gov.uk/test"] });
    }
    if (keys.includes("seo_description")) return text({ title: "Cloud Memory Foam Seat Cushion", description: "Soft memory foam.", bullets: ["Non-slip base"], seo_description: "Soft memory foam cushion." });
    if (keys.includes("variants")) return text({ variants: [1, 2, 3].map((i) => ({ angle: `angle ${i}`, primary_text: `Text ${i}`, headline: `Headline ${i}`, description: "Free shipping" })) });
    if (keys.includes("caption")) return text({ caption: "Sit better. #comfort" });
    if (keys.includes("sections")) return text({ headline: "Profitable week.", sections: [{ heading: "Performance", points: ["2 orders"] }] });
    if (keys.includes("body")) return text({ title: "How to Choose a Seat Cushion", body: "## Why it matters\n\nComfort counts." });
    throw new Error(`fake Claude: unknown schema ${keys}`);
  }
  if (body.tools && body.tools[0].type === "web_search_20260209") {
    // First call pauses mid-research (server tool loop limit); second finishes.
    if (body.messages.length === 1) return msg([{ type: "text", text: "Researching…" }], "pause_turn");
    return msg([{ type: "text", text: "UK trends: monitor light bars are everywhere on TikTok Shop UK." }]);
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
  if (path.endsWith("/advideos")) return json({ id: "vid1" });
  if (path === "igu/media") return json({ id: "cont1" });
  if (path === "cont1") return json({ status_code: "FINISHED" });
  if (path === "igu/media_publish") return json({ id: "reel1" });
  if (path === "page1/videos") return json({ id: "fbvid1" });
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
  if (url.startsWith("https://api.github.com/repos/acme/store/releases/tags/media")) return json({ message: "Not Found" }, 404);
  if (url === "https://api.github.com/repos/acme/store/releases") {
    videoCalls.push({ to: "github-release", body: JSON.parse(opts.body) });
    return json({ id: 1, upload_url: "https://uploads.github.com/repos/acme/store/releases/1/assets{?name,label}" }, 201);
  }
  if (url.startsWith("https://uploads.github.com/repos/acme/store/releases/1/assets")) {
    const name = new URL(url).searchParams.get("name");
    videoCalls.push({ to: "github-asset", name });
    return json({ browser_download_url: `https://github.com/acme/store/releases/download/media/${name}` }, 201);
  }
  if (url === "https://oauth2.googleapis.com/token") return json({ access_token: "yt-token" });
  if (url.startsWith("https://www.googleapis.com/upload/youtube/v3/videos")) {
    videoCalls.push({ to: "youtube-init", body: JSON.parse(opts.body) });
    return new Response("{}", { status: 200, headers: { location: "https://upload.youtube.test/session1" } });
  }
  if (url === "https://upload.youtube.test/session1") return json({ id: "yt123" });
  if (url === "https://open.tiktokapis.com/v2/oauth/token/") return json({ access_token: "tt-token" });
  if (url === "https://open.tiktokapis.com/v2/post/publish/video/init/") {
    videoCalls.push({ to: "tiktok-init", body: JSON.parse(opts.body) });
    return json({ data: { publish_id: "tt-pub-1", upload_url: "https://upload.tiktok.test/u1" }, error: { code: "ok" } });
  }
  if (url === "https://upload.tiktok.test/u1") return new Response("", { status: 201 });
  if (url === "https://cdn.higgsfield.test/clip.mp4") return new Response(Buffer.from("higgsfield-clip"), { status: 200, headers: { "content-type": "video/mp4" } });
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
       ad_decisions, content, support_tickets, checkout_recoveries, agent_reports, rate_limits, product_variants,
       trend_keywords, shipments, video_briefs CASCADE`
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
  assert.equal(sent.get("metadata[ad_consent]"), "0", "no cookie consent sent -> no ad consent");
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
  assert.equal(await meta.sendPurchase({ id: 97, email: "a@b.co", currency: "gbp", total: 10, ad_consent: true, shipping_address: { country: "GB" } }), true);
  console.log("ok: Meta CAPI only with UK cookie consent (or opt-out countries)");

  // 19. Trend scout: web research (with pause_turn resume) -> keywords -> sourcing order.
  const trends = require("../lib/agents/trendScout");
  r = await trends.runTrends({ force: true });
  assert.deepEqual(r.keywords, ["monitor light bar"], JSON.stringify(r));
  const research = claudeRequests.filter((c) => c.body.tools && c.body.tools[0].type === "web_search_20260209");
  assert.equal(research.length, 2, "paused research turn resumed");
  assert.equal(research[1].body.messages[1].role, "assistant", "resume re-sends the paused assistant turn");
  assert.equal(research[0].body.tools[0].user_location.country, "GB");
  assert.deepEqual(await trends.runTrends(), { skipped: "fresh" }, "daily refresh throttle");
  const kws = await trends.sourcingKeywords();
  assert.equal(kws[0], "monitor light bar", "trends are sourced before evergreen keywords");
  console.log("ok: trend scout — UK web research, pause_turn resume, weak signals dropped, trends sourced first");

  // 20. Nova video agent: script (compliance-checked) -> render -> host -> publish everywhere.
  Object.assign(process.env, {
    GITHUB_TOKEN: "gh-token", GITHUB_REPOSITORY: "acme/store",
    YOUTUBE_CLIENT_ID: "y", YOUTUBE_CLIENT_SECRET: "y", YOUTUBE_REFRESH_TOKEN: "y",
    TIKTOK_CLIENT_KEY: "t", TIKTOK_CLIENT_SECRET: "t", TIKTOK_REFRESH_TOKEN: "t",
    META_PAGE_ACCESS_TOKEN: "page-token", META_IG_USER_ID: "igu",
  });
  await query(`UPDATE products SET status='active', status_reason=NULL WHERE id=$1`, [product.id]);
  const videoAgent = require("../lib/agents/videoAgent");
  r = await videoAgent.runVideos();
  assert.equal(r.made.length, 1, JSON.stringify(r));
  assert.equal(r.made[0].source, "ai", "AI script passed the compliance check");
  const vs = renderCalls[0].script;
  assert(vs.beats.at(-1).visual === "cta");
  const ytInit = videoCalls.find((c) => c.to === "youtube-init").body;
  assert.equal(ytInit.status.containsSyntheticMedia, true, "YouTube synthetic-media disclosure");
  assert.equal(ytInit.status.privacyStatus, "private");
  assert(/#Shorts/.test(ytInit.snippet.title));
  const ttInit = videoCalls.find((c) => c.to === "tiktok-init").body;
  assert.equal(ttInit.post_info.is_aigc, true, "TikTok AI-generated label");
  assert.equal(ttInit.post_info.brand_organic_toggle, true, "TikTok commercial-content disclosure");
  assert(/#ad\b/.test(ttInit.post_info.title) && /fictional AI character/.test(ttInit.post_info.title));
  assert(metaCalls.some((c) => c.path === "igu/media" && c.params.media_type === "REELS"), "Instagram Reel posted");
  assert(metaCalls.some((c) => c.path === "page1/videos"), "Facebook video posted");
  const { rows: [vrow] } = await query(`SELECT * FROM content WHERE kind='video'`);
  assert.equal(vrow.status, "published");
  assert(vrow.channels.mediaUrl.startsWith("https://github.com/acme/store/releases/download/media/nova-"));
  assert.equal(vrow.channels.youtube.id, "yt123");
  r = await videoAgent.runVideos();
  assert.equal(r.made.length, 0, "daily quota respected");

  // ...and a new Meta ad test leads with that video.
  await meta.launchProductTest({ name: "t", dailyBudgetCents: 1000, countries: ["GB"], link: "https://shop/p/x", imageUrl: "https://img.example/v.jpg",
    variants: [{ primary_text: "a", headline: "b", description: "c" }, { primary_text: "d", headline: "e", description: "f" }], videoUrl: vrow.channels.mediaUrl });
  assert(metaCalls.some((c) => c.path.endsWith("/advideos") && c.params.file_url === vrow.channels.mediaUrl), "video uploaded to ad account");
  const creatives = metaCalls.filter((c) => c.path.endsWith("/adcreatives")).slice(-2).map((c) => JSON.parse(c.params.object_story_spec));
  assert(creatives[0].video_data && creatives[0].video_data.video_id === "vid1", "first ad uses the Nova video");
  assert(creatives[1].link_data, "second ad stays an image ad for comparison");
  console.log("ok: Nova video agent — compliant script, hosted, posted to YouTube/TikTok/IG/FB with AI + ad disclosures; used as Meta video ad");

  // 21. UK own-label supplements: import (drafts, legal info, claims-checked copy).
  const { runCatalogueImport } = require("../lib/catalogueImport");
  r = await runCatalogueImport();
  assert.equal(r.imported.length, 2, JSON.stringify(r));
  const { rows: [mag] } = await query(`SELECT * FROM products WHERE supplier_product_id='MAG-120'`);
  const { rows: [ash] } = await query(`SELECT * FROM products WHERE supplier_product_id='ASH-60'`);
  assert.equal(mag.status, "draft", "supplements always import as drafts for human review");
  assert.equal(mag.product_type, "supplement");
  assert(/Magnesium contributes to a reduction of tiredness and fatigue/.test(mag.description), "compliant AI copy kept (authorised claim verbatim)");
  assert(!/sleep|stress|calm/i.test(ash.description + ash.bullets.join(" ")), "non-compliant ashwagandha copy replaced with claim-free copy");
  assert(ash.warnings.some((w) => /thyroid or liver/.test(w)) && ash.warnings.includes("Keep out of reach of young children."), "mandatory + ashwagandha warnings attached");
  r = await runCatalogueImport();
  assert.equal(r.updated, 2, "re-import refreshes, doesn't duplicate");
  for (const pid of [mag.id, ash.id]) {
    await call(H("admin/products"), { method: "PATCH", query: { id: pid }, body: { status: "active" }, ...admin });
  }
  r = await call(H("shop/products"), { query: { slug: mag.slug } });
  assert.equal(r.body.product.health.ingredients[0].amount, 200, "product page gets per-dose ingredients");
  assert(r.body.product.health.warnings.includes("Food supplement."), "legal name + warnings shown before purchase");
  console.log("ok: UK supplements — drafts, legal info, only authorised claims (bad AI copy replaced), idempotent re-import");

  // 22. Mixed basket: UK supplement + CJ gear -> two shipments; dashboard tracking entry.
  const { rows: [magV] } = await query(`SELECT id FROM product_variants WHERE product_id=$1`, [mag.id]);
  const { rows: [gearV] } = await query(`SELECT id FROM product_variants WHERE product_id=$1`, [product.id]);
  await query(`UPDATE products SET status='active', status_reason=NULL, in_stock=TRUE WHERE id=$1`, [product.id]);
  const mixed = { ...session, id: "cs_mixed", payment_intent: "pi_mixed", amount_subtotal: 4000, amount_total: 4000,
    metadata: { cart: JSON.stringify([[mag.id, magV.id, 1, 1999], [product.id, gearV.id, 1, 2001]]) } };
  const rawMixed = JSON.stringify({ id: "evt_mixed", type: "checkout.session.completed", data: { object: mixed } });
  r = await call(require("../api/webhooks/stripe"), { method: "POST", raw: rawMixed, headers: { "stripe-signature": sign(rawMixed) } });
  const mixedId = r.body.orderId;
  const { rows: shs } = await query(`SELECT supplier, status, supplier_order_id FROM shipments WHERE order_id=$1 ORDER BY supplier`, [mixedId]);
  assert.deepEqual(shs.map((x) => [x.supplier, x.status]), [["cj", "placed"], ["specialist", "placed"]], JSON.stringify(shs));
  const dropMail = sentEmails.find((e) => e.to === "orders@specialist.example");
  assert(dropMail && dropMail.subject === `Dropship order ${shs[1].supplier_order_id}` && dropMail.attachments[0].filename.endsWith(".csv"), "UK supplier order emailed with CSV");
  assert(Buffer.from(dropMail.attachments[0].content, "base64").toString().includes("MAG-120,1"), "CSV has the supplier SKU");
  assert(!Buffer.from(dropMail.attachments[0].content, "base64").toString().includes("P-GOOD"), "gear line not sent to the UK supplier");
  supplierState.orderStatus[`CJ-${mixedId}`] = { status: "shipped", trackingNumber: "CJTRACK1", carrier: "YunExpress" };
  await call(H("cron/fulfil"), { method: "POST", ...cron });
  let { rows: [mo] } = await query(`SELECT status FROM orders WHERE id=$1`, [mixedId]);
  assert.equal(mo.status, "placed", "not 'shipped' until every shipment has tracking");
  r = await call(H("admin/orders"), { query: { awaiting: "tracking" }, ...admin });
  const waiting = r.body.shipments.find((x) => Number(x.order_id) === Number(mixedId));
  assert(waiting && waiting.supplier === "specialist" && /Magnesium/.test(waiting.items), JSON.stringify(r.body));
  r = await call(H("admin/orders"), { method: "POST", query: { shipment: waiting.id }, body: { action: "add_tracking", trackingNumber: "RM123456789GB", carrier: "Royal Mail" }, ...admin });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  ({ rows: [mo] } = await query(`SELECT status FROM orders WHERE id=$1`, [mixedId]));
  assert.equal(mo.status, "shipped");
  assert.equal(sentEmails.filter((e) => e.to === "buyer@example.com" && /has shipped/.test(e.subject) && /RM123456789GB|CJTRACK1/.test(e.html)).length >= 2, true, "a shipping email per shipment");
  console.log("ok: mixed basket split into CJ + UK-supplier shipments; supplier emailed CSV; dashboard tracking emails the customer");

  // 23. Regulation watch: ashwagandha banned -> products paused + owner alerted.
  const { runRegWatch } = require("../lib/agents/regWatch");
  r = await runRegWatch({ force: true });
  assert.equal(r.checked[0].status, "banned", JSON.stringify(r));
  const { rows: [ash2] } = await query(`SELECT status, status_reason FROM products WHERE id=$1`, [ash.id]);
  assert(ash2.status === "paused" && /regulatory/.test(ash2.status_reason), "ashwagandha products paused");
  const { rows: [mag2] } = await query(`SELECT status FROM products WHERE id=$1`, [mag.id]);
  assert.equal(mag2.status, "active", "other products untouched");
  assert(sentEmails.some((e) => e.to === "owner@example.com" && /ashwagandha: banned/.test(e.subject)));
  r = await call(H("cron/source"), { method: "POST", query: { only: "sync" }, ...cron });
  const { rows: [ash3] } = await query(`SELECT status FROM products WHERE id=$1`, [ash.id]);
  assert.equal(ash3.status, "paused", "catalogue sync never auto-resumes a regulatory pause");
  console.log("ok: regulation watch pauses ashwagandha on a ban, alerts owner, sync won't resume it");

  // 24. Higgsfield engine: brief (claims-checked) -> admin API -> generated clip -> composed + published.
  config.VIDEO.ENGINE = "higgsfield";
  await query(`DELETE FROM content WHERE kind='video'`);
  const va = require("../lib/agents/videoAgent");
  r = await va.runVideos();
  assert.equal(r.briefs.length, 1, JSON.stringify(r));
  r = await call(H("admin/video-briefs"), { query: { status: "pending" }, ...admin });
  const brief = r.body.briefs[0];
  assert(/Dialogue \(spoken exactly, in order\)/.test(brief.prompt) && /No product in hand/.test(brief.prompt));
  r = await call(H("admin/video-briefs"), { method: "POST", query: { id: brief.id }, body: { status: "generating" }, ...admin });
  assert.equal(r.body.status, "generating");
  r = await va.publishBrief(Number(brief.id), "https://cdn.higgsfield.test/clip.mp4");
  assert(r.contentId, JSON.stringify(r));
  assert(videoCalls.some((c) => c.to === "compose" && c.bytes === "higgsfield-clip".length), "clip downloaded and composed with label + product card");
  const { rows: [vb] } = await query(`SELECT status FROM video_briefs WHERE id=$1`, [brief.id]);
  assert.equal(vb.status, "done");
  const { rows: [vc] } = await query(`SELECT channels, body FROM content WHERE id=$1`, [r.contentId]);
  assert(vc.channels.youtube && JSON.parse(vc.body).source === "higgsfield");
  await assert.rejects(() => va.publishBrief(Number(brief.id), "https://cdn.higgsfield.test/clip.mp4"), /already done/);
  config.VIDEO.ENGINE = "animated";
  console.log("ok: Higgsfield pipeline — compliant brief, routine API, clip composed with AI/ad label, published, brief closed");
  require("fs").unlinkSync(require("path").join(__dirname, "..", E2E_CATALOGUE));

  r = await call(H("admin/nope"), { ...admin });
  assert.equal(r.status, 404, "unknown route 404s");

  await db.getPool().end();
  console.log("\nall e2e checks passed");
})().catch(async (err) => {
  console.error(err);
  process.exit(1);
});
