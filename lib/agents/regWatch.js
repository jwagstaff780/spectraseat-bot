// Regulation watch: weekly check on ingredients under UK regulatory review
// (config: lib/compliance/claims.js REGULATORY_WATCH — currently
// ashwagandha, which the Committee on Toxicity is assessing).
// Claude researches the current FSA/COT position with web search; if the
// ingredient becomes restricted or banned in food supplements, every
// product containing it is paused and you're alerted. New official advice
// that falls short of a restriction triggers an alert to review warnings.

const db = require("../db");
const ai = require("../ai");
const { REGULATORY_WATCH, watchedIngredients } = require("../compliance/claims");
const { notifyOwner } = require("../alerts");

const CHECK_EVERY_DAYS = 7;

const SCHEMA = {
  type: "object",
  properties: {
    status: { type: "string", enum: ["no_change", "advice_published", "restricted", "banned"] },
    summary: { type: "string", description: "Two sentences on the current GB position, with dates." },
    sources: { type: "array", items: { type: "string" } },
  },
  required: ["status", "summary", "sources"],
  additionalProperties: false,
};

async function lastResult(ingredient) {
  const { rows } = await db.query(`SELECT value FROM kv WHERE key = $1`, [`regwatch:${ingredient}`]);
  return rows[0] ? rows[0].value : null;
}

async function checkIngredient(ingredient) {
  const notes = await ai.research({
    system: "You are a UK food-law regulatory analyst. Use primary sources (food.gov.uk, cot.food.gov.uk, gov.uk, legislation.gov.uk) over news.",
    question:
      `Today is ${new Date().toISOString().slice(0, 10)}. What is the current regulatory status of ${ingredient} in food supplements in Great Britain? ` +
      "Has the Food Standards Agency or the Committee on Toxicity published a final statement, consumer advice, mandatory warning, restriction or ban? Give dates and links.",
  });
  if (!notes) return null;
  return ai.generateJson({
    system: "Classify UK regulatory status from research notes. 'restricted' = legal limits/prohibition for some uses; 'banned' = may not be sold in food supplements; 'advice_published' = new official advice/warnings only; otherwise 'no_change'.",
    prompt: `Ingredient: ${ingredient}\n\nNotes:\n${notes.slice(0, 15000)}`,
    schema: SCHEMA,
    effort: "low",
  });
}

async function runRegWatch({ force = false } = {}) {
  const { rows: products } = await db.query(`SELECT id, title, ingredients, status FROM products WHERE status IN ('active','draft','paused')`);
  const inUse = new Set(products.flatMap((p) => watchedIngredients(p)));
  const summary = { checked: [], paused: 0 };
  for (const ingredient of REGULATORY_WATCH.filter((i) => inUse.has(i))) {
    const prev = await lastResult(ingredient);
    if (!force && prev && Date.now() - new Date(prev.at).getTime() < CHECK_EVERY_DAYS * 86400000) continue;
    const r = await checkIngredient(ingredient);
    if (!r) {
      summary.checked.push({ ingredient, error: "research unavailable" });
      continue;
    }
    await db.query(`INSERT INTO kv (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [
      `regwatch:${ingredient}`,
      { ...r, at: new Date().toISOString() },
    ]);
    summary.checked.push({ ingredient, status: r.status });

    if (r.status === "restricted" || r.status === "banned") {
      const hit = products.filter((p) => watchedIngredients(p).includes(ingredient) && p.status === "active");
      for (const p of hit) {
        await db.query(`UPDATE products SET status='paused', status_reason=$2, updated_at=now() WHERE id=$1`, [
          p.id,
          `manual: regulatory — ${ingredient} ${r.status} in GB food supplements`,
        ]);
      }
      summary.paused += hit.length;
      await notifyOwner(
        `regwatch:${ingredient}:${r.status}`,
        `${ingredient}: ${r.status} in GB — ${hit.length} product(s) paused`,
        `${r.summary}\n\nSources:\n${r.sources.join("\n")}\n\nProducts were paused automatically. Check with your supplier and a regulatory adviser before relisting.`
      ).catch(() => {});
    } else if (r.status === "advice_published" && (!prev || prev.status !== "advice_published")) {
      await notifyOwner(
        `regwatch:${ingredient}:advice`,
        `${ingredient}: new UK official advice — review your label warnings`,
        `${r.summary}\n\nSources:\n${r.sources.join("\n")}`
      ).catch(() => {});
    }
  }
  return summary;
}

module.exports = { runRegWatch, checkIngredient };
