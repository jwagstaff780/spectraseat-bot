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
  // Suppliers whose cancel/fail rate on our orders exceeds this (over at
  // least 10 orders in 90 days) are dropped from sourcing automatically.
  MAX_SUPPLIER_FAILURE_RATE_PCT: 10,

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

  // ---- AI agents ------------------------------------------------------------
  AI_MODEL: "claude-opus-5",

  // ---- Ads agent (Meta: Facebook + Instagram) --------------------------------
  // The creative agent writes ads; the optimiser below decides budgets with
  // fixed rules. ADS_MODE: 'off' | 'dry_run' (decide + log, spend nothing) |
  // 'live' (actually create/pause/scale on Meta). Start in dry_run.
  ADS: {
    MODE: process.env.ADS_MODE || "dry_run",
    COUNTRIES: ["US"],
    // New product test: one campaign/ad set per product at this daily budget.
    TEST_DAILY_BUDGET: 10,
    MAX_CONCURRENT_TESTS: 3,
    // Hard ceiling on the sum of all active ad-set daily budgets.
    MAX_TOTAL_DAILY_BUDGET: 60,
    // Kill a test that has spent this multiple of the product's gross
    // profit per sale without a single purchase.
    KILL_NO_SALE_SPEND_MULTIPLE: 1.5,
    // After this much spend, judge on ROAS vs the product's break-even ROAS.
    MIN_SPEND_TO_JUDGE: 20,
    // Scale winners whose 3-day ROAS is at least this multiple of break-even.
    SCALE_ROAS_MULTIPLE: 1.5,
    MIN_PURCHASES_TO_SCALE: 3,
    SCALE_STEP_PCT: 20,
    MAX_ADSET_DAILY_BUDGET: 40,
    // Circuit breaker: if the store's trailing-7-day profit after ad spend
    // is below this, every ad is paused until a human re-enables.
    STOP_LOSS_7D: -150,
  },

  // ---- Content agent ---------------------------------------------------------
  CONTENT: {
    BLOG_POSTS_PER_DAY: 1,
    SOCIAL_POSTS_PER_DAY: 2,
  },

  // ---- Sales team agents -----------------------------------------------------
  SALES: {
    // Support agent may refund automatically ONLY when an order is past its
    // latest promised delivery date by this many days, undelivered, and
    // no more than AUTO_REFUND_MAX. Everything else becomes a ticket.
    AUTO_REFUND_MAX: 60,
    AUTO_REFUND_GRACE_DAYS: 5,
    // Ask verified buyers for a review this many days after delivery.
    REVIEW_REQUEST_DELAY_DAYS: 5,
    // Pause products whose refund rate is above this (with enough orders).
    MAX_REFUND_RATE_PCT: 15,
    MIN_ORDERS_FOR_REFUND_RULE: 5,
    // Public chat abuse limit.
    SUPPORT_MESSAGES_PER_HOUR_PER_IP: 30,
  },
};
