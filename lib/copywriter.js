// AI copywriter: turns raw supplier listings (machine-translated titles,
// keyword-stuffed descriptions) into on-brand storefront copy. This is what
// keeps the store "faceless" but still coherent — one consistent brand voice
// across every product, with no human writing listings.

const config = require("./config");
const ai = require("./ai");

const COPY_SCHEMA = {
  type: "object",
  properties: {
    title: { type: "string", description: "Product title, max 70 characters, no brand names of other companies." },
    description: { type: "string", description: "2 short paragraphs of benefit-led product copy." },
    bullets: { type: "array", items: { type: "string" }, description: "4-5 concise feature bullets." },
    seo_description: { type: "string", description: "Meta description, max 155 characters." },
  },
  required: ["title", "description", "bullets", "seo_description"],
  additionalProperties: false,
};

const SYSTEM_PROMPT = [
  `You write product listings for ${config.BRAND.name}, an online store. ${config.BRAND.tagline}`,
  `Brand voice: ${config.BRAND.voice}`,
  "Only state facts supported by the supplier data you are given. Never invent certifications, materials, " +
    "dimensions, warranties, reviews, health or medical benefits. Never mention the supplier, China, AliExpress, " +
    "CJ, dropshipping, or wholesale. Never name other companies' trademarks.",
].join("\n");

// Fallback when no ANTHROPIC_API_KEY is configured: tidy the supplier text
// so the store still works, just with plainer copy.
function fallbackCopy(product) {
  const title = String(product.title || "Product")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 70);
  const description = String(product.description || title).slice(0, 800);
  return { title, description, bullets: [], seo_description: description.slice(0, 155) };
}

// Health products: the model is given the exact authorised claims it may
// use, and the output must pass the GB claims checker, with one corrective
// retry; otherwise a neutral, claim-free fallback is used.
async function writeCopy(product, variant, health = null) {
  const supplierData = JSON.stringify({
    title: product.title,
    variant: variant && variant.name,
    description: String(product.description || "").slice(0, 4000),
    ...(health ? { ingredients_per_daily_dose: health.ingredients, net_quantity: health.net_quantity } : {}),
  });
  const rules = health
    ? `\nThis is a ${health.product_type} sold in Great Britain. You may make NO health or benefit claims except these, copied word for word:\n` +
      (health.allowedClaims.length ? health.allowedClaims.map((c) => `- ${c}`).join("\n") : "- (none: describe ingredients, format and use only)") +
      "\nNever mention stress, sleep, anxiety, mood, hormones, weight, detox, or any disease."
    : "";
  let feedback = "";
  for (let attempt = 0; attempt < 2; attempt++) {
    const copy = await ai.generateJson({
      system: SYSTEM_PROMPT + rules,
      prompt: `Write the listing for this supplier product:\n${supplierData}${feedback}`,
      schema: COPY_SCHEMA,
    });
    if (!copy) break;
    copy.title = copy.title.slice(0, 70);
    copy.seo_description = copy.seo_description.slice(0, 155);
    if (!health) return copy;
    const { checkCopy } = require("./compliance/claims");
    const problems = checkCopy([copy.title, copy.description, ...copy.bullets, copy.seo_description].join("\n"), health);
    if (!problems.length) return copy;
    feedback = `\n\nYour previous draft broke the rules in: ${problems.map((p) => JSON.stringify(p.sentence)).join(", ")}. Rewrite without those.`;
  }
  return health ? neutralHealthCopy(product, health) : fallbackCopy(product);
}

// Claim-free copy for health products when AI copy isn't available/compliant.
function neutralHealthCopy(product, health) {
  const title = String(product.title).slice(0, 70);
  const parts = (health.ingredients || []).map((i) => `${i.amount}${i.unit === "% energy" ? "% of energy from" : i.unit} ${i.name.toLowerCase()}`);
  const description = `${title}${health.net_quantity ? `, ${health.net_quantity}` : ""}. ${parts.length ? `Each daily serving provides ${parts.join(", ")}.` : ""} Made in the UK.`.trim();
  return { title, description, bullets: health.allowedClaims.slice(0, 3), seo_description: description.slice(0, 155) };
}

module.exports = { writeCopy, fallbackCopy, neutralHealthCopy, SYSTEM_PROMPT };
