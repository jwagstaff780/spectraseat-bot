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

async function writeCopy(product, variant) {
  const supplierData = JSON.stringify({
    title: product.title,
    variant: variant && variant.name,
    description: String(product.description || "").slice(0, 4000),
  });
  const copy = await ai.generateJson({
    system: SYSTEM_PROMPT,
    prompt: `Write the listing for this supplier product:\n${supplierData}`,
    schema: COPY_SCHEMA,
  });
  if (!copy) return fallbackCopy(product);
  copy.title = copy.title.slice(0, 70);
  copy.seo_description = copy.seo_description.slice(0, 155);
  return copy;
}

module.exports = { writeCopy, fallbackCopy, SYSTEM_PROMPT };
