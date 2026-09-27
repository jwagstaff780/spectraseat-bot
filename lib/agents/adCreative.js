// Ad creative agent: writes faceless, product-led Meta ad variants. Output
// is constrained to what the listing actually says, and to Meta ad policy
// (no personal-attribute callouts, no before/after or health claims, no
// fake urgency).

const config = require("../config");
const ai = require("../ai");

const SCHEMA = {
  type: "object",
  properties: {
    variants: {
      type: "array",
      description: "Exactly 3 ad variants, each testing a different angle.",
      items: {
        type: "object",
        properties: {
          angle: { type: "string", description: "One-line description of the angle being tested." },
          primary_text: { type: "string", description: "Main ad text, max 280 characters." },
          headline: { type: "string", description: "Max 40 characters." },
          description: { type: "string", description: "Max 30 characters." },
        },
        required: ["angle", "primary_text", "headline", "description"],
        additionalProperties: false,
      },
    },
  },
  required: ["variants"],
  additionalProperties: false,
};

const SYSTEM = [
  `You are the performance-marketing copywriter for ${config.BRAND.name}. ${config.BRAND.tagline}`,
  `Brand voice: ${config.BRAND.voice}`,
  "Write Facebook/Instagram ad copy for one product. Rules you must follow:",
  "- Only use facts present in the listing. No invented stats, awards, reviews, or testimonials.",
  "- Meta ad policy: never assert or imply personal attributes (e.g. 'Do you have back pain?'), no before/after,",
  "  no health or medical claims, no profanity, no clickbait.",
  "- No fake urgency or scarcity. Mention the discount only as the real difference between the listed prices.",
  "- Faceless brand: no founder, no 'I', no people's names.",
].join("\n");

function fallbackVariants(product) {
  const price = `${config.CURRENCY_SYMBOL}${Number(product.price).toFixed(2)}`;
  return [
    { angle: "product benefit", primary_text: `${product.title}. ${String(product.description).split(/(?<=\.)\s/)[0]} Free tracked shipping.`, headline: product.title.slice(0, 40), description: `Now ${price}` },
    { angle: "price + shipping", primary_text: `${product.title} for ${price}, shipped free with tracking. 30-day returns.`, headline: `Only ${price}`.slice(0, 40), description: "Free tracked shipping" },
  ];
}

async function writeAds(product) {
  const listing = JSON.stringify({
    title: product.title,
    description: product.description,
    bullets: product.bullets,
    price: Number(product.price),
    compare_at_price: product.compare_at_price ? Number(product.compare_at_price) : null,
    delivery: "free tracked shipping, 30-day returns",
  });
  const out = await ai.generateJson({ system: SYSTEM, prompt: `Listing:\n${listing}`, schema: SCHEMA, effort: "medium" });
  if (!out || !out.variants || !out.variants.length) return fallbackVariants(product);
  return out.variants.slice(0, 3).map((v) => ({
    angle: v.angle,
    primary_text: v.primary_text.slice(0, 280),
    headline: v.headline.slice(0, 40),
    description: v.description.slice(0, 30),
  }));
}

module.exports = { writeAds, fallbackVariants };
