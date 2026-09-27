#!/usr/bin/env node
// Read-only check of the Meta setup the ads + content agents need: ad
// account, Page, Instagram account and pixel. Never creates anything.
// Usage: META_ACCESS_TOKEN=... META_AD_ACCOUNT_ID=... META_PAGE_ID=... META_PIXEL_ID=... node scripts/probe-meta.js

const meta = require("../lib/ads/meta");

(async () => {
  const acct = `act_${String(process.env.META_AD_ACCOUNT_ID || "").replace(/^act_/, "")}`;
  const checks = [
    ["ad account", acct, { fields: "name,account_status,currency,amount_spent,spend_cap" }],
    ["page", process.env.META_PAGE_ID, { fields: "name,fan_count" }],
    ["pixel", process.env.META_PIXEL_ID, { fields: "name,last_fired_time" }],
    ["instagram", process.env.META_IG_USER_ID, { fields: "username" }],
  ];
  let failed = 0;
  for (const [label, id, params] of checks) {
    if (!id || id === "act_") {
      console.log(`- ${label}: not configured`);
      continue;
    }
    try {
      console.log(`✓ ${label}:`, await meta.graph("GET", id, params));
    } catch (err) {
      failed++;
      console.log(`✗ ${label}: ${err.message}`);
    }
  }
  console.log("\naccount_status 1 = active. Set a spend cap on the ad account in Meta as a second safety net.");
  process.exit(failed ? 1 : 0);
})();
