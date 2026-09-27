// Video script agent: writes a 20-30 second vertical video (YouTube Shorts,
// TikTok, Instagram Reels) in which Nova — the store's fictional AI
// character — presents one product.
//
// Compliance is enforced twice: in the prompt, and by checkScript() below,
// which rejects scripts that claim personal experience (fake testimonial —
// banned by the DMCC Act 2024 and the CAP code), make health claims, or use
// fake urgency. Rejected scripts fall back to a safe template.

const config = require("../config");
const ai = require("../ai");
const claims = require("../compliance/claims");

const C = config.CHARACTER;

const SCHEMA = {
  type: "object",
  properties: {
    hook: { type: "string", description: "The first line, spoken in under 2 seconds. Must stop the scroll." },
    beats: {
      type: "array",
      description: "3-5 spoken lines after the hook, then a call to action last.",
      items: {
        type: "object",
        properties: {
          say: { type: "string", description: "What Nova says. One sentence, max 16 words." },
          caption: { type: "string", description: "Punchy on-screen text for this beat, max 5 words." },
          visual: { type: "string", enum: ["product", "detail", "price", "cta"] },
        },
        required: ["say", "caption", "visual"],
        additionalProperties: false,
      },
    },
    title: { type: "string", description: "Video title, max 70 characters, no clickbait." },
    description: { type: "string", description: "1-2 sentence post description." },
    hashtags: { type: "array", items: { type: "string" }, description: "4-6 relevant hashtags without #." },
  },
  required: ["hook", "beats", "title", "description", "hashtags"],
  additionalProperties: false,
};

const SYSTEM = `You write short vertical videos for ${config.BRAND.name}, a UK online store.
The presenter is ${C.name}, a fictional AI character (the store's "${C.role}"). Personality: ${C.personality}
British English. Total script 55-80 spoken words (20-30 seconds).

Structure: a scroll-stopping hook (a surprising fact, a relatable problem, or "I found the thing that..."), 3-5 beats that
SHOW what the product does and why it's clever, one beat with the price, then a clear call to action to the store.

Hard rules — breaking any of these makes the video unusable:
- ${C.name} is an AI. Never claim to have personally used, owned, worn, tried, slept on, or lived with the product, and never
  describe physical sensations ("so comfy", "I love mine"). Instead: explain, demonstrate, compare, or report what the
  store's checks found (e.g. "I checked the specs", "it passed our quality checks", "here's what it does").
- No testimonials, no invented reviews, statistics, awards, or "everyone is buying this".
- No health or medical claims. No fake urgency or scarcity ("selling out", "last chance", countdowns).
- Only facts present in the product data. Price must be exactly as given.
- Don't mention suppliers, China, dropshipping, or other brands.`;

// Phrases that imply personal experience or banned claims.
const BANNED = [
  /\bI(?: have|['’]ve)? (?:been |always |now )?(?:use[ds]?|using|tried|tested|wore|wear|own|bought|slept|sit|sat|love[ds]?)\b/i,
  /\b(?:my (?:own|favourite|favorite|new)|mine)\b/i,
  /\b(?:cure|cures|heal|heals|treat|treats|relieve|relieves|pain relief|therapeutic|clinically)\b/i,
  /\b(?:selling out|sold out|last chance|limited time|hurry|only \d+ left|going fast)\b/i,
  /\b(?:everyone|everybody) (?:is|'s) (?:buying|obsessed)/i,
];

function checkScript(script, product = null) {
  const lines = [script.hook, ...script.beats.map((b) => b.say), ...script.beats.map((b) => b.caption), script.title, script.description];
  const problems = [];
  for (const line of lines) for (const re of BANNED) if (re.test(line)) problems.push(`"${line}" matches ${re}`);
  // Health products: every line must pass the GB health-claims checker.
  if (product && product.product_type && product.product_type !== "gear") {
    for (const line of lines) for (const p of claims.checkCopy(line, product)) problems.push(`"${p.sentence}": ${p.why}`);
  }
  if (script.beats.length < 3) problems.push("too few beats");
  if (script.beats[script.beats.length - 1].visual !== "cta") problems.push("must end with a call to action");
  const words = lines.slice(0, 1 + script.beats.length).join(" ").split(/\s+/).length;
  if (words > 95) problems.push(`too long (${words} words)`);
  return problems;
}

function money(n) {
  return `${config.CURRENCY_SYMBOL}${Number(n).toFixed(2)}`;
}

// Safe, deterministic fallback when AI is off or the script failed checks.
function templateScript(product) {
  const isHealth = product.product_type && product.product_type !== "gear";
  const first = isHealth
    ? `It comes as ${product.net_quantity || "a simple daily format"}, made in the UK.`
    : String(product.description || "").split(/(?<=[.!?])\s+/)[0] || product.title;
  const bullets = (isHealth ? claims.allowedClaims(product) : product.bullets || []).slice(0, 2);
  return {
    hook: `Okay, this one's genuinely clever.`,
    beats: [
      { say: `Meet the ${product.title}.`, caption: product.title.split(" ").slice(0, 4).join(" "), visual: "product" },
      { say: first.slice(0, 120), caption: "Here's the idea", visual: "detail" },
      ...bullets.map((b) => ({ say: b.slice(0, 120), caption: b.split(" ").slice(0, 4).join(" "), visual: "detail" })),
      { say: `It's ${money(product.price)}, with free UK delivery.`, caption: `${money(product.price)} · free delivery`, visual: "price" },
      { say: isHealth ? `Always read the label. Tap the link for the full details.` : `Tap the link to take a closer look.`, caption: "Link in bio", visual: "cta" },
    ],
    title: product.title.slice(0, 70),
    description: `${C.name} (a fictional AI character) shows you the ${product.title}.`,
    hashtags: ["tiktokmademebuyit", "cleverfinds", "ukshopping", "gadgets"],
  };
}

async function writeVideoScript(product) {
  const data = {
    title: product.title,
    description: product.description,
    bullets: product.bullets,
    price: money(product.price),
    compare_at_price: product.compare_at_price ? money(product.compare_at_price) : null,
    delivery: "free tracked UK delivery, 30-day returns",
    quality_check: product.scout_summary || null,
  };
  const isHealth = product.product_type && product.product_type !== "gear";
  const allowed = isHealth ? claims.allowedClaims(product) : [];
  const healthRules = isHealth
    ? `\nThis is a ${product.product_type}. GB law: the ONLY health claims allowed are these, word for word:\n` +
      (allowed.length ? allowed.map((c) => `- ${c}`).join("\n") : "- none — talk about ingredients, format, label facts and how to use it") +
      "\nNever mention stress, sleep, anxiety, mood, hormones, weight, detox or disease. Include 'always read the label' in the CTA beat. Not medical advice."
    : "";
  if (isHealth) data.ingredients_per_daily_dose = product.ingredients;
  const out = await ai.generateJson({ system: SYSTEM + healthRules, effort: "medium", schema: SCHEMA, prompt: `Product:\n${JSON.stringify(data)}` });
  if (out) {
    const problems = checkScript(out, product);
    if (!problems.length) return { script: out, source: "ai" };
    return { script: templateScript(product), source: "template", rejected: problems.slice(0, 3) };
  }
  return { script: templateScript(product), source: "template" };
}

// Platform post text: always discloses the AI character and the ad.
function postText(script, url) {
  const tags = [...new Set(["ad", "aicharacter", ...script.hashtags.map((h) => h.replace(/^#/, "").replace(/\s+/g, ""))])]
    .slice(0, 8)
    .map((h) => `#${h}`)
    .join(" ");
  return {
    title: script.title.slice(0, 90),
    caption: `${script.description} ${C.name} is a fictional AI character. Ad for ${config.BRAND.name}.\n${url}\n${tags}`.slice(0, 2000),
  };
}

module.exports = { writeVideoScript, checkScript, templateScript, postText, BANNED };
