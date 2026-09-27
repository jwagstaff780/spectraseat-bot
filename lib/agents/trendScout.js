// Trend scout: finds what's going viral in the UK *right now* so sourcing
// chases live demand instead of a fixed niche list.
//
// Step 1 — research: Claude uses Anthropic's server-side web search to look
//   at current UK signals (TikTok Shop UK best-sellers and "TikTok made me
//   buy it" trends, Amazon UK Movers & Shakers, trending-product roundups).
// Step 2 — extract: a second call turns that research into supplier search
//   keywords, dropping anything branded, regulated or hard to ship.
// Keywords expire after TRENDS.KEYWORD_TTL_DAYS unless seen again, so the
// catalogue follows the trend cycle.

const config = require("../config");
const db = require("../db");
const ai = require("../ai");

const RESEARCH_SYSTEM =
  "You are a UK e-commerce trend analyst for a dropshipping store. Research what physical products are going viral " +
  "or selling fast in the UK in the last few weeks. Prefer primary signals (TikTok Shop UK charts, Amazon UK Movers & " +
  "Shakers, Google Trends UK) over generic listicles. Report concrete product types with the evidence you found.";

const EXTRACT_SCHEMA = {
  type: "object",
  properties: {
    keywords: {
      type: "array",
      items: {
        type: "object",
        properties: {
          keyword: { type: "string", description: "2-5 word generic product search term a wholesale supplier would recognise, no brand names." },
          score: { type: "integer", description: "0-100 strength of current UK demand signal." },
          why: { type: "string", description: "One sentence of evidence." },
          sources: { type: "array", items: { type: "string" }, description: "URLs supporting it." },
        },
        required: ["keyword", "score", "why", "sources"],
        additionalProperties: false,
      },
    },
  },
  required: ["keywords"],
  additionalProperties: false,
};

const EXTRACT_SYSTEM =
  "Turn trend research into product search keywords for a general-merchandise dropshipping store. EXCLUDE: branded or " +
  "trademarked items and 'dupes'; supplements, cosmetics, skincare, teeth whitening, medical or health-claim devices; " +
  "baby/children's products and toys; mains-powered electricals and heaters; food; weapons; anything bulky, fragile or " +
  "liquid; clothing with complex sizing. KEEP unbranded, lightweight, visual, problem-solving items that ship well.";

async function research() {
  const client = ai.getClient();
  const messages = [
    {
      role: "user",
      content: `Today is ${new Date().toISOString().slice(0, 10)}. What unbranded physical products are trending or going viral with UK shoppers right now? List 15-25 with evidence.`,
    },
  ];
  // Server-side web search can pause long turns; resume up to 4 times.
  for (let i = 0; i < 5; i++) {
    const res = await client.beta.messages.create(
      ai.baseRequest({
        system: RESEARCH_SYSTEM,
        output_config: { effort: "medium" },
        tools: [{ type: "web_search_20260209", name: "web_search", max_uses: 8, user_location: { type: "approximate", country: "GB" } }],
        messages,
      })
    );
    if (res.stop_reason === "pause_turn") {
      messages.push({ role: "assistant", content: res.content });
      continue;
    }
    if (res.stop_reason === "refusal") return null;
    return res.content.filter((b) => b.type === "text").map((b) => b.text).join("\n");
  }
  return null;
}

async function runTrends({ force = false } = {}) {
  if (!config.TRENDS.ENABLED) return { skipped: "disabled" };
  if (!ai.enabled()) return { skipped: "no ANTHROPIC_API_KEY" };
  if (!force) {
    const { rows } = await db.query(
      `SELECT 1 FROM trend_keywords WHERE last_seen > now() - make_interval(hours => $1) LIMIT 1`,
      [config.TRENDS.REFRESH_HOURS]
    );
    if (rows[0]) return { skipped: "fresh" };
  }

  const notes = await research();
  if (!notes) return { error: "research unavailable" };
  const out = await ai.generateJson({
    system: EXTRACT_SYSTEM,
    effort: "low",
    schema: EXTRACT_SCHEMA,
    prompt: `Research notes:\n${notes.slice(0, 20000)}\n\nReturn up to ${config.TRENDS.MAX_KEYWORDS} keywords, strongest first.`,
  });
  if (!out) return { error: "extraction unavailable" };

  const kept = out.keywords
    .map((k) => ({ ...k, keyword: k.keyword.toLowerCase().replace(/[^a-z0-9 -]/g, "").trim() }))
    .filter((k) => k.keyword.length >= 3 && k.score >= 40)
    .slice(0, config.TRENDS.MAX_KEYWORDS);
  for (const k of kept) {
    await db.query(
      `INSERT INTO trend_keywords (keyword, score, why, sources, expires_at)
       VALUES ($1, $2, $3, $4, now() + make_interval(days => $5))
       ON CONFLICT (keyword) DO UPDATE SET score = EXCLUDED.score, why = EXCLUDED.why, sources = EXCLUDED.sources,
         last_seen = now(), expires_at = EXCLUDED.expires_at`,
      [k.keyword, k.score, k.why.slice(0, 500), k.sources.slice(0, 5), config.TRENDS.KEYWORD_TTL_DAYS]
    );
  }
  return { keywords: kept.map((k) => k.keyword) };
}

// Keywords for sourcing: live trends first (strongest signal first), then
// the evergreen list.
async function sourcingKeywords() {
  let trends = [];
  if (config.TRENDS.ENABLED) {
    const { rows } = await db.query(`SELECT keyword FROM trend_keywords WHERE expires_at > now() ORDER BY score DESC`);
    trends = rows.map((r) => r.keyword);
  }
  return [...new Set([...trends, ...config.NICHE_KEYWORDS])];
}

module.exports = { runTrends, sourcingKeywords };
