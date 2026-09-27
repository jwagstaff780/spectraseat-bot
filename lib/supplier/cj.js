// CJdropshipping API v2 adapter. CJ stocks, packs and ships every order
// under a neutral label, so the customer only ever sees our brand.
//
// Docs: https://developers.cjdropshipping.com — run `npm run probe:supplier`
// against a live key before relying on any field mapping below; the parsers
// are deliberately defensive because CJ's payloads vary between endpoints.

const db = require("../db");

const BASE = "https://developers.cjdropshipping.com/api2.0/v1";
const TOKEN_KEY = "cj_access_token";

function requireKey() {
  const key = process.env.CJ_API_KEY;
  if (!key) throw new Error("CJ_API_KEY is not set.");
  return key;
}

// CJ only allows minting a token every few minutes and each lasts ~15 days,
// so it's cached in Postgres (shared across every lambda) with an in-memory
// copy on top.
let memToken = null;
async function getAccessToken() {
  if (memToken && memToken.expiresAt > Date.now()) return memToken.token;

  // Scripts (e.g. the probe) run without a database; cache in memory only.
  const useDb = Boolean(process.env.DATABASE_URL);
  if (useDb) {
    const { rows } = await db.query(`SELECT value FROM kv WHERE key = $1 AND expires_at > now() + interval '1 hour'`, [
      TOKEN_KEY,
    ]);
    if (rows[0]) {
      memToken = rows[0].value;
      return memToken.token;
    }
  }

  const res = await fetch(`${BASE}/authentication/getAccessToken`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ apiKey: requireKey() }),
  });
  const body = await res.json();
  if (!body.result || !body.data || !body.data.accessToken) {
    throw new Error(`CJ auth failed: ${body.message || res.status}`);
  }
  const expiresAt = body.data.accessTokenExpiryDate
    ? new Date(body.data.accessTokenExpiryDate).getTime()
    : Date.now() + 14 * 24 * 3600 * 1000;
  memToken = { token: body.data.accessToken, expiresAt };
  if (useDb) await db.query(
    `INSERT INTO kv (key, value, expires_at) VALUES ($1, $2, to_timestamp($3 / 1000.0))
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, expires_at = EXCLUDED.expires_at`,
    [TOKEN_KEY, memToken, expiresAt]
  );
  return memToken.token;
}

async function call(method, path, { query, body } = {}) {
  const token = await getAccessToken();
  const url = new URL(BASE + path);
  if (query) for (const [k, v] of Object.entries(query)) if (v !== undefined) url.searchParams.set(k, String(v));
  const res = await fetch(url, {
    method,
    headers: { "Content-Type": "application/json", "CJ-Access-Token": token },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json.result === false || (json.code && json.code !== 200)) {
    throw new Error(`CJ ${method} ${path} failed: ${json.message || res.status}`);
  }
  return json.data;
}

function parseImages(raw) {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw.filter(Boolean);
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter(Boolean) : [String(raw)];
  } catch {
    return String(raw).split(",").map((s) => s.trim()).filter(Boolean);
  }
}

// "7-15" -> { min: 7, max: 15 }
function parseAging(aging) {
  const nums = String(aging || "").match(/\d+/g);
  if (!nums) return { min: null, max: null };
  const n = nums.map(Number);
  return { min: Math.min(...n), max: Math.max(...n) };
}

// ---- Supplier interface (see lib/supplier/index.js) -----------------------

async function searchProducts(keyword, pageSize = 20) {
  const data = await call("GET", "/product/list", { query: { productNameEn: keyword, pageNum: 1, pageSize } });
  return (data && data.list ? data.list : []).map((p) => ({
    productId: p.pid,
    title: p.productNameEn,
    image: p.productImage,
    price: Number(p.sellPrice),
    category: p.categoryName,
  }));
}

async function getProduct(productId) {
  const p = await call("GET", "/product/query", { query: { pid: productId } });
  const variants = (p.variants || []).map((v) => ({
    variantId: v.vid,
    name: v.variantNameEn || v.variantKey || "",
    price: Number(v.variantSellPrice),
    image: v.variantImage,
  }));
  return {
    productId: p.pid,
    title: p.productNameEn,
    description: String(p.description || "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim(),
    images: parseImages(p.productImageSet || p.productImage),
    variants,
  };
}

async function getStock(variantId) {
  const data = await call("GET", "/product/stock/queryByVid", { query: { vid: variantId } });
  const rows = Array.isArray(data) ? data : [];
  return rows.reduce((sum, r) => sum + Number(r.totalInventoryNum ?? r.storageNum ?? 0), 0);
}

// Cheapest shipping option that meets the delivery-time ceiling, checked
// from each CJ warehouse region. A product stocked in a US warehouse ships
// in days instead of weeks, which the cheapest-within-ceiling rule picks up
// whenever it's price-competitive.
const ORIGINS = ["US", "CN"];
async function quoteShipping(variantId, countryCode, maxDays) {
  const options = [];
  for (const origin of ORIGINS) {
    let data;
    try {
      data = await call("POST", "/logistic/freightCalculate", {
        body: { startCountryCode: origin, endCountryCode: countryCode, products: [{ quantity: 1, vid: variantId }] },
      });
    } catch {
      continue; // not stocked in that region
    }
    for (const o of Array.isArray(data) ? data : []) {
      options.push({ origin, method: o.logisticName, cost: Number(o.logisticPrice), days: parseAging(o.logisticAging) });
    }
  }
  const eligible = options
    .filter((o) => o.cost >= 0 && o.days.max !== null && o.days.max <= maxDays)
    // cheapest first; on a near-tie (within $1) prefer the faster option
    .sort((a, b) => (Math.abs(a.cost - b.cost) <= 1 ? a.days.max - b.days.max : a.cost - b.cost));
  return eligible[0] || null;
}

async function createOrder(order, items, shippingMethod) {
  const a = order.shipping_address;
  const data = await call("POST", "/shopping/order/createOrderV2", {
    body: {
      orderNumber: `SS-${order.id}`,
      shippingCountryCode: a.country,
      shippingCountry: a.country,
      shippingProvince: a.state || "",
      shippingCity: a.city || "",
      shippingAddress: a.line1 || "",
      shippingAddress2: a.line2 || "",
      shippingZip: a.postal_code || "",
      shippingCustomerName: order.customer_name || "",
      shippingPhone: a.phone || "",
      email: order.email,
      logisticName: shippingMethod,
      fromCountryCode: items[0].ship_from || "CN",
      // 2 = pay from CJ wallet balance, so the order is paid and processed
      // without anyone logging in. Keep the wallet topped up.
      payType: 2,
      products: items.map((i) => ({ vid: i.supplier_variant_id, quantity: i.quantity })),
    },
  });
  return { supplierOrderId: data.orderId || data.orderNum || data.id };
}

// -> { status: 'processing'|'shipped'|'delivered'|'cancelled', trackingNumber, carrier }
async function getOrderStatus(supplierOrderId) {
  const d = await call("GET", "/shopping/order/getOrderDetail", { query: { orderId: supplierOrderId } });
  const raw = String(d.orderStatus || "").toUpperCase();
  let status = "processing";
  if (raw === "DELIVERED") status = "delivered";
  else if (raw === "SHIPPED" || d.trackNumber) status = "shipped";
  else if (raw === "CANCELLED") status = "cancelled";
  return { status, trackingNumber: d.trackNumber || null, carrier: d.logisticName || null, raw };
}

// Buyer reviews of this product on CJ's marketplace. Returned as-is: we
// never filter by rating (suppressing negative reviews is itself unlawful
// under FTC 16 CFR 465.7).
async function getReviews(productId, pageSize = 20) {
  const data = await call("GET", "/product/productComments", { query: { pid: productId, pageNum: 1, pageSize } });
  const list = (data && (data.list || data.content)) || (Array.isArray(data) ? data : []);
  return list
    .map((r) => ({
      externalId: String(r.commentId || r.id || ""),
      author: r.commentUser || null,
      country: r.countryCode || null,
      rating: Math.min(5, Math.max(1, Math.round(Number(r.score)))) || null,
      body: String(r.comment || "").trim(),
      reviewedAt: r.commentDate ? new Date(r.commentDate) : null,
    }))
    .filter((r) => r.externalId && r.body);
}

module.exports = {
  name: "cj",
  getReviews,
  searchProducts,
  getProduct,
  getStock,
  quoteShipping,
  createOrder,
  getOrderStatus,
  // exported for tests
  _parseAging: parseAging,
  _parseImages: parseImages,
};
