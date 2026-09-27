// Product scout: the "would a good buyer list this?" check that margin
// maths can't do. Before a product is imported, Claude looks at the
// listing AND the supplier photos and scores it on what separates winning
// dropshipping products from dead stock:
//   - solves a clear problem or has obvious visual appeal (ad-friendly)
//   - not a commodity the shopper can buy cheaper at a local big-box store
//   - survives cheap shipping (not fragile, not bulky, no batteries/liquids)
//   - low return risk (no complex sizing, no "doesn't look like the photo")
// and it hard-blocks legal risks: other brands' trademarks / knock-offs,
// regulated goods (medical claims, cosmetics, supplements, children's
// products, electrical mains items, weapons), and misleading images.
// It also picks which supplier photos are clean enough to use (no
// watermarks, no foreign-language text, no other shop's logo).

const config = require("../config");
const ai = require("../ai");

const SCHEMA = {
  type: "object",
  properties: {
    score: { type: "integer", description: "0-100 overall potential as a profitable, low-risk dropshipping product." },
    summary: { type: "string", description: "One sentence: why it will or won't sell." },
    risks: {
      type: "object",
      properties: {
        trademark_or_knockoff: { type: "boolean" },
        regulated_product: { type: "boolean" },
        fragile_or_hard_to_ship: { type: "boolean" },
        high_return_risk: { type: "boolean" },
      },
      required: ["trademark_or_knockoff", "regulated_product", "fragile_or_hard_to_ship", "high_return_risk"],
      additionalProperties: false,
    },
    clean_image_indexes: {
      type: "array",
      items: { type: "integer" },
      description: "0-based indexes of the provided images that are clean: no watermark, no non-English text overlay, no other store's logo, not a collage.",
    },
  },
  required: ["score", "summary", "risks", "clean_image_indexes"],
  additionalProperties: false,
};

const SYSTEM =
  `You are the product-selection lead for ${config.BRAND.name}, a UK online store selling trending, unbranded everyday products to UK shoppers. ` +
  "You decide which supplier products are worth listing. Be a tough, commercially minded judge: most products should score " +
  "below 60. Score high only for products with clear customer appeal, healthy perceived value versus price, and low " +
  "shipping and return risk. Flag any risk honestly — a false negative on trademarks or regulated goods can get the store shut down.";

const MAX_IMAGES = 4;

function verdictFrom(out, cfg = config.SCOUT) {
  const r = out.risks;
  const reasons = [];
  if (r.trademark_or_knockoff) reasons.push("trademark / knock-off risk");
  if (r.regulated_product) reasons.push("regulated product");
  if (out.score < cfg.MIN_SCORE) reasons.push(`scout score ${out.score} < ${cfg.MIN_SCORE}`);
  if (r.fragile_or_hard_to_ship && r.high_return_risk) reasons.push("fragile and high return risk");
  return { ok: reasons.length === 0, reasons };
}

async function ask(product, images, price) {
  const text =
    `Supplier listing:\n${JSON.stringify({
      title: product.title,
      description: String(product.description || "").slice(0, 3000),
      variants: product.variants.slice(0, 10).map((v) => v.name),
      our_retail_price: price,
    })}\n` + (images.length ? `The ${images.length} supplier photos follow, in order (index 0 first).` : "No photos available.");
  return ai.generateJson({
    system: SYSTEM,
    effort: "medium",
    schema: SCHEMA,
    prompt: [{ type: "text", text }, ...images.map((url) => ({ type: "image", source: { type: "url", url } }))],
  });
}

// Returns { ok, score, summary, reasons[], images[] } — images is the
// cleaned photo list to use. Without an API key everything passes
// unscored (the margin guardrails still apply).
async function scout(product, price) {
  const candidates = [...new Set(product.images)].filter(Boolean);
  if (!ai.enabled()) return { ok: true, score: null, summary: null, reasons: [], images: candidates };

  const shown = candidates.slice(0, MAX_IMAGES);
  let out;
  try {
    out = await ask(product, shown, price);
  } catch (err) {
    // An unreachable image URL fails the whole request; judge on text alone.
    out = await ask(product, [], price);
    if (out) out.clean_image_indexes = shown.map((_, i) => i);
  }
  if (!out) return { ok: false, score: null, summary: "scout unavailable (refusal or truncation)", reasons: ["scout unavailable"], images: [] };

  const clean = out.clean_image_indexes.filter((i) => i >= 0 && i < shown.length).map((i) => shown[i]);
  // Photos beyond the first few weren't inspected; keep them only as extras
  // after the verified-clean ones.
  const images = [...clean, ...candidates.slice(MAX_IMAGES)];
  const v = verdictFrom(out);
  if (clean.length === 0) v.reasons.push("no clean product photo");
  return { ok: v.ok && clean.length > 0, score: out.score, summary: out.summary, reasons: v.reasons, images };
}

module.exports = { scout, verdictFrom };
