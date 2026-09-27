// Health-claim compliance for food supplements and foods sold in Great Britain.
//
// The law (retained Regulation (EC) 1924/2006 + the GB Nutrition and Health
// Claims Register): a health claim may only be made if it is on the GB
// register, for a product that meets the claim's conditions of use, in
// wording that doesn't change its meaning. Medicinal claims (treat, cure,
// prevent disease) are banned outright for foods.
//
// How the store enforces it:
//  - AUTHORISED below lists register claims per nutrient with their
//    conditions (minimum amount per daily dose). Keep it in sync with
//    https://www.gov.uk/government/publications/great-britain-nutrition-and-health-claims-nhc-register
//    — check new claims against the register before adding them here.
//  - allowedClaims(product) returns the claims a specific product qualifies
//    for, from its recorded ingredients and amounts per daily dose.
//  - checkCopy(text, product) flags any health-benefit wording that isn't
//    one of those claims (near-verbatim), plus banned medicinal / weight-loss
//    / "clinically proven" language. Every AI agent's output goes through it.
//
// This is a guardrail, not legal advice: have a regulatory adviser review
// your label and core claims before launch.

// Daily-dose thresholds: "source of" = 15% of the NRV per daily dose.
const AUTHORISED = {
  magnesium: {
    min: { amount: 56.25, unit: "mg" },
    claims: [
      "Magnesium contributes to a reduction of tiredness and fatigue",
      "Magnesium contributes to normal muscle function",
      "Magnesium contributes to normal psychological function",
      "Magnesium contributes to normal energy-yielding metabolism",
    ],
  },
  "vitamin d": {
    min: { amount: 0.75, unit: "µg" },
    claims: [
      "Vitamin D contributes to the normal function of the immune system",
      "Vitamin D contributes to the maintenance of normal bones",
      "Vitamin D contributes to the maintenance of normal muscle function",
    ],
  },
  "vitamin c": {
    min: { amount: 12, unit: "mg" },
    claims: [
      "Vitamin C contributes to the normal function of the immune system",
      "Vitamin C contributes to the reduction of tiredness and fatigue",
    ],
  },
  zinc: {
    min: { amount: 1.5, unit: "mg" },
    claims: ["Zinc contributes to the normal function of the immune system", "Zinc contributes to normal cognitive function"],
  },
  "vitamin b6": {
    min: { amount: 0.21, unit: "mg" },
    claims: [
      "Vitamin B6 contributes to the reduction of tiredness and fatigue",
      "Vitamin B6 contributes to normal psychological function",
    ],
  },
  "vitamin b12": {
    min: { amount: 0.375, unit: "µg" },
    claims: [
      "Vitamin B12 contributes to the reduction of tiredness and fatigue",
      "Vitamin B12 contributes to normal psychological function",
    ],
  },
  protein: {
    // Food must be at least a "source of protein" (12% of energy from protein).
    min: { amount: 12, unit: "% energy" },
    claims: [
      "Protein contributes to a growth in muscle mass",
      "Protein contributes to the maintenance of muscle mass",
      "Protein contributes to the maintenance of normal bones",
    ],
  },
  creatine: {
    min: { amount: 3, unit: "g" },
    claims: ["Creatine increases physical performance in successive bursts of short-term, high intensity exercise"],
    note: "Only for adults performing high-intensity exercise; the label must say so.",
  },
  "epa and dha": {
    min: { amount: 250, unit: "mg" },
    claims: ["EPA and DHA contribute to the normal function of the heart"],
  },
};

// Botanicals (incl. ashwagandha) have no authorised health claims in GB.
// Mandatory label text for any food supplement, plus ingredient-specific
// warnings. Ashwagandha is under UK Committee on Toxicity review.
const SUPPLEMENT_WARNINGS = [
  "Food supplement.",
  "Do not exceed the recommended daily dose.",
  "Food supplements should not be used as a substitute for a varied and balanced diet and a healthy lifestyle.",
  "Keep out of reach of young children.",
];
const INGREDIENT_WARNINGS = {
  ashwagandha: [
    "Not suitable for children, or if you are pregnant, trying to conceive or breastfeeding.",
    "Do not use if you have a thyroid or liver condition. Consult your doctor before use if you take any medication.",
  ],
  caffeine: ["Contains caffeine. Not recommended for children or pregnant or breastfeeding women."],
};
// Ingredients under active regulatory review: products containing them are
// re-checked by the regulation watch and pulled automatically on restriction.
const REGULATORY_WATCH = ["ashwagandha"];

function norm(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/[’']/g, "'")
    .replace(/[^a-z0-9%µ' ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function unitMatches(a, b) {
  return norm(a).replace("mcg", "µg").replace("ug", "µg") === norm(b).replace("mcg", "µg").replace("ug", "µg");
}

// product.ingredients: [{ name, amount, unit }] per recommended daily dose.
function allowedClaims(product) {
  const out = [];
  for (const ing of product.ingredients || []) {
    const entry = AUTHORISED[norm(ing.name)];
    if (!entry) continue;
    if (unitMatches(ing.unit, entry.min.unit) && Number(ing.amount) >= entry.min.amount) out.push(...entry.claims);
  }
  return [...new Set(out)];
}

function warningsFor(product) {
  const w = [];
  if (product.product_type === "supplement") w.push(...SUPPLEMENT_WARNINGS);
  for (const ing of product.ingredients || []) w.push(...(INGREDIENT_WARNINGS[norm(ing.name)] || []));
  return [...new Set([...w, ...(product.warnings || [])])];
}

function watchedIngredients(product) {
  return (product.ingredients || []).map((i) => norm(i.name)).filter((n) => REGULATORY_WATCH.includes(n));
}

// Language that is never allowed for a food, whatever the ingredients.
const BANNED = [
  { re: /\b(?:cure[sd]?|treat(?:s|ed|ment)?|prevent(?:s|ion)?|heal(?:s|ing)?|remed(?:y|ies)|diagnos\w*)\b/i, why: "medicinal claim" },
  { re: /\b(?:anxiety|depression|insomnia|arthritis|diabetes|cancer|covid|adhd|infection|disease|disorder|inflammation)\b/i, why: "disease reference" },
  { re: /\b(?:weight loss|lose weight|burn(?:s)? fat|fat burn\w*|slimming|appetite suppress\w*|detox\w*)\b/i, why: "weight-loss / detox claim" },
  { re: /\b(?:clinically (?:proven|tested)|doctor recommended|scientifically proven|miracle|guaranteed results)\b/i, why: "unsubstantiated efficacy claim" },
  { re: /\b(?:cortisol|testosterone|hormone\w*)\b/i, why: "hormonal claim (not authorised)" },
];

// Health-benefit wording that must match an authorised claim to be allowed.
const BENEFIT = /\b(?:support\w*|boost\w*|improv\w*|enhanc\w*|reduc\w*|relie\w*|help\w* (?:you |with |to )?(?:sleep|relax|calm|recover|focus|stress)|contribut\w*|promot\w*|strengthen\w*|immun\w*|energy|energis\w*|fatigue|tiredness|stress|sleep|calm\w*|relax\w*|recover\w*|focus|mood|muscle\w*|bones?|heart|metabolism|performance|cognitive|brain)\b/i;

function sentences(text) {
  return String(text || "")
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

// Returns a list of problems ([] = compliant).
// For fitness gear (not a food) only the banned list applies: GB health-
// claim rules cover foods, but medicinal and weight-loss claims are still
// off-limits under the CAP code.
function checkCopy(text, product = {}) {
  const allowed = allowedClaims(product).map(norm);
  const isFood = product.product_type !== "gear";
  const problems = [];
  for (const s of sentences(text)) {
    for (const b of BANNED) if (b.re.test(s)) problems.push({ sentence: s, why: b.why });
    if (isFood && BENEFIT.test(s)) {
      const n = norm(s);
      // Authorised wording must appear intact (small additions like "Did you
      // know" around it are fine; rewording is not).
      if (!allowed.some((c) => n.includes(c))) problems.push({ sentence: s, why: "health/benefit wording that isn't an authorised GB claim for this product" });
    }
  }
  return problems;
}

module.exports = {
  AUTHORISED,
  SUPPLEMENT_WARNINGS,
  INGREDIENT_WARNINGS,
  REGULATORY_WATCH,
  allowedClaims,
  warningsFor,
  watchedIngredients,
  checkCopy,
  norm,
};
