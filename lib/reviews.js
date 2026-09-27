// Reviews, done lawfully and automatically.
//
// - Verified reviews: after delivery the customer gets a signed link; what
//   they write is published as-is (only PII/links/abuse are hidden — never
//   hidden for being negative). These alone make up our star rating.
// - Supplier reviews: imported from the supplier's marketplace for the SAME
//   product, unfiltered by rating, displayed in a separate, clearly labelled
//   section. Never mixed into our rating or presented as our customers'.
//   (FTC 16 CFR Part 465 bans both misattributing and suppressing reviews.)

const crypto = require("crypto");
const db = require("./db");

function secret() {
  const s = process.env.REVIEW_SECRET || process.env.CRON_SECRET;
  if (!s) throw new Error("REVIEW_SECRET (or CRON_SECRET) must be set");
  return s;
}

// token = orderId.expiryEpoch.hmac
function signReviewToken(orderId, ttlDays = 60, now = Date.now()) {
  const exp = Math.floor(now / 1000) + ttlDays * 86400;
  const mac = crypto.createHmac("sha256", secret()).update(`review:${orderId}:${exp}`).digest("hex").slice(0, 32);
  return `${orderId}.${exp}.${mac}`;
}

function verifyReviewToken(token, now = Date.now()) {
  const [orderId, exp, mac] = String(token || "").split(".");
  if (!orderId || !exp || !mac) return null;
  if (Number(exp) < now / 1000) return null;
  const expected = crypto.createHmac("sha256", secret()).update(`review:${orderId}:${exp}`).digest("hex").slice(0, 32);
  const a = Buffer.from(mac);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  return Number(orderId);
}

// Content moderation is limited to privacy and abuse — sentiment is never a
// reason to hide a review.
const PII_OR_SPAM = [
  /[\w.+-]+@[\w-]+\.[\w.]+/, // email address
  /(\+?\d[\d\s().-]{8,}\d)/, // phone-like number
  /https?:\/\/|www\./i, // links
];
const ABUSE = /\b(fuck|cunt|nigger|faggot|retard)\w*/i;

function moderate(body) {
  if (PII_OR_SPAM.some((re) => re.test(body))) return "contains contact details or links";
  if (ABUSE.test(body)) return "abusive language";
  return null;
}

// "Margaret" -> "M."; supplier marketplace names are shortened for privacy.
function shortName(name) {
  const n = String(name || "").trim();
  return n ? `${n[0].toUpperCase()}.` : "Buyer";
}

async function importSupplierReviews(supplier, productId, supplierProductId) {
  if (typeof supplier.getReviews !== "function") return 0;
  const reviews = await supplier.getReviews(supplierProductId);
  let n = 0;
  for (const r of reviews) {
    const hidden = moderate(r.body);
    const { rowCount } = await db.query(
      `INSERT INTO reviews (product_id, source, external_id, author, country, rating, body, status, hidden_reason, reviewed_at)
       VALUES ($1, 'supplier', $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (product_id, source, external_id) DO NOTHING`,
      [productId, r.externalId, shortName(r.author), r.country, r.rating, r.body.slice(0, 2000),
       hidden ? "hidden" : "published", hidden, r.reviewedAt]
    );
    n += rowCount;
  }
  return n;
}

// Returns { ok, error } — used by the public review form.
async function submitVerifiedReview(token, { productId, rating, body, name }) {
  const orderId = verifyReviewToken(token);
  if (!orderId) return { ok: false, error: "This review link is invalid or has expired." };
  const r = Number(rating);
  const text = String(body || "").trim();
  if (!Number.isInteger(r) || r < 1 || r > 5) return { ok: false, error: "Please choose 1–5 stars." };
  if (text.length < 3 || text.length > 2000) return { ok: false, error: "Please write between 3 and 2000 characters." };

  const { rows } = await db.query(
    `SELECT o.id, o.status, o.customer_name FROM orders o JOIN order_items oi ON oi.order_id = o.id
     WHERE o.id = $1 AND oi.product_id = $2`,
    [orderId, productId]
  );
  if (!rows[0]) return { ok: false, error: "That product isn't part of this order." };
  if (!["shipped", "delivered"].includes(rows[0].status)) return { ok: false, error: "Reviews open once your order has shipped." };

  const hidden = moderate(text);
  try {
    await db.query(
      `INSERT INTO reviews (product_id, source, order_id, author, rating, body, status, hidden_reason, reviewed_at)
       VALUES ($1, 'verified', $2, $3, $4, $5, $6, $7, now())`,
      [productId, orderId, shortName(name || rows[0].customer_name), r, text, hidden ? "hidden" : "published", hidden]
    );
  } catch (err) {
    if (err.code === "23505") return { ok: false, error: "You've already reviewed this item — thank you!" };
    throw err;
  }
  return { ok: true, held: Boolean(hidden) };
}

async function forProduct(productId) {
  const { rows } = await db.query(
    `SELECT source, author, country, rating, body, reviewed_at FROM reviews
     WHERE product_id = $1 AND status = 'published' ORDER BY reviewed_at DESC NULLS LAST LIMIT 60`,
    [productId]
  );
  const verified = rows.filter((r) => r.source === "verified");
  const supplier = rows.filter((r) => r.source === "supplier");
  const avg = verified.length ? verified.reduce((s, r) => s + r.rating, 0) / verified.length : null;
  return {
    verified: { count: verified.length, average: avg && Math.round(avg * 10) / 10, reviews: verified },
    supplier: { count: supplier.length, reviews: supplier },
  };
}

module.exports = { signReviewToken, verifyReviewToken, moderate, shortName, importSupplierReviews, submitVerifiedReview, forProduct };
