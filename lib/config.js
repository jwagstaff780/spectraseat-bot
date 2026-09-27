// Central knobs for the store. Branding, niche, pricing guardrails and
// automation behaviour all live here — nothing else should need to change
// to re-point the store at a different niche.

module.exports = {
  // ---- Faceless brand identity -------------------------------------------
  // No founder name, no face, no personal story. The brand is the product
  // and the promise. Change these to rebrand the whole store.
  BRAND: {
    name: process.env.STORE_NAME || "SpectraSeat",
    tagline: "Smarter comfort for the way you sit, work and play.",
    supportEmail: process.env.SUPPORT_EMAIL || "support@example.com",
    // Voice guide fed to the AI copywriter so every listing sounds the same.
    voice:
      "Confident, warm, benefit-led, no hype words like 'revolutionary' or " +
      "'game-changer', no fake scarcity, no medical claims, second person, " +
      "short sentences, British-neutral spelling.",
  },

  CURRENCY: "usd",
  CURRENCY_SYMBOL: "$",

  // Countries Stripe Checkout will collect a shipping address for. Keep this
  // in sync with the destinations your supplier actually ships to.
  SHIP_TO_COUNTRIES: ["US", "GB", "CA", "AU", "IE", "NZ"],
  // Country used to quote supplier freight when sourcing (your main market).
  PRIMARY_MARKET: "US",

  // ---- Automated sourcing ------------------------------------------------
  // The sourcing cron searches the supplier catalogue for each keyword and
  // imports products that pass every guardrail below.
  NICHE_KEYWORDS: [
    "ergonomic seat cushion",
    "lumbar support pillow",
    "gaming chair cushion",
    "car seat cushion",
    "memory foam footrest",
    "laptop stand",
  ],
  SOURCING_RESULTS_PER_KEYWORD: 20,
  MAX_NEW_PRODUCTS_PER_RUN: 5,
  MAX_ACTIVE_PRODUCTS: 60,
  // true: new products go live immediately. false: they land as 'draft' and
  // wait for one click on the admin dashboard.
  AUTO_PUBLISH: process.env.AUTO_PUBLISH === "true",

  // ---- Pricing & margin guardrails (see lib/pricing.js) -------------------
  PRICING: {
    // Retail = landed cost × multiplier, then charm-rounded.
    MARKUP_MULTIPLIER: 2.8,
    // After payment fees, reject anything that doesn't clear both floors.
    MIN_GROSS_MARGIN_PCT: 40,
    MIN_GROSS_PROFIT: 8,
    // Keep the catalogue in an impulse-buy band.
    MIN_RETAIL: 14.99,
    MAX_RETAIL: 89.99,
    // Strike-through "compare at" price, shown only when it's a real
    // multiple of our price (no fake 90%-off anchors).
    COMPARE_AT_MULTIPLIER: 1.35,
    // Payment processor fee model (Stripe standard card pricing).
    PAYMENT_FEE_PCT: 2.9,
    PAYMENT_FEE_FIXED: 0.3,
    // Reprice when supplier landed cost drifts more than this.
    REPRICE_DRIFT_PCT: 5,
  },

  // Supplier shipping estimates longer than this are rejected at sourcing
  // time — slow shipping is the #1 driver of chargebacks in dropshipping.
  MAX_SHIPPING_DAYS: 15,
  // Extra buffer added to the supplier's delivery estimate before we show
  // it to customers, so the promise we make is one we keep.
  SHIPPING_PROMISE_BUFFER_DAYS: 3,

  // ---- Fulfilment ---------------------------------------------------------
  // Paid orders that fail to place with the supplier are retried by the
  // fulfilment cron until this many attempts, then flagged for a human.
  MAX_FULFILMENT_ATTEMPTS: 5,
  // Orders with no tracking this long after being placed get flagged.
  TRACKING_OVERDUE_DAYS: 7,

  // ---- AI copywriter ------------------------------------------------------
  COPY_MODEL: "claude-opus-5",
};
