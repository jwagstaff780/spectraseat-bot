// AI copywriter: turns raw supplier listings (machine-translated titles,
// keyword-stuffed descriptions) into on-brand storefront copy. This is what
// keeps the store "faceless" but still coherent — one consistent brand voice
// across every product, with no human writing listings.

const Anthropic = require("@anthropic-ai/sdk");
const config = require("./config");

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

let client = null;
function getClient() {
  if (!client) client = new Anthropic();
  return client;
}

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
  if (!process.env.ANTHROPIC_API_KEY) return fallbackCopy(product);

  const supplierData = JSON.stringify({
    title: product.title,
    variant: variant && variant.name,
    description: String(product.description || "").slice(0, 4000),
  });

  const response = await getClient().beta.messages.create({
    model: config.COPY_MODEL,
    max_tokens: 16000,
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    output_config: { effort: "low", format: { type: "json_schema", schema: COPY_SCHEMA } },
    system: SYSTEM_PROMPT,
    messages: [{ role: "user", content: `Write the listing for this supplier product:\n${supplierData}` }],
  });

  if (response.stop_reason === "refusal" || response.stop_reason === "max_tokens") {
    return fallbackCopy(product);
  }
  const text = response.content.find((b) => b.type === "text");
  if (!text) return fallbackCopy(product);
  const copy = JSON.parse(text.text);
  copy.title = copy.title.slice(0, 70);
  copy.seo_description = copy.seo_description.slice(0, 155);
  return copy;
}

module.exports = { writeCopy, fallbackCopy };
