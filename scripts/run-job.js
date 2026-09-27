#!/usr/bin/env node
// Runs one automation job directly (no web server involved). This is what
// the scheduled GitHub Actions workflow calls, so the agents run free and
// without serverless time limits.
//   node scripts/run-job.js <fulfil|source|sync|marketing|ads|content|report|migrate>
//
// The repo may be public, and so are Actions logs: only counts are printed,
// never customer data. Full summaries go to the automation log on /admin.html.

const db = require("../lib/db");

const JOBS = {
  migrate: async () => {
    await db.ensureSchema();
    return { ok: true };
  },
  fulfil: () => db.recordRun("fulfil", require("../lib/fulfilment").syncOrders),
  sync: () => db.recordRun("catalog-sync", require("../lib/sourcing").syncCatalog),
  source: async () => ({
    sync: await db.recordRun("catalog-sync", require("../lib/sourcing").syncCatalog),
    sourcing: await db.recordRun("sourcing", require("../lib/sourcing").runSourcing),
  }),
  content: () => db.recordRun("content", require("../lib/agents/content").runContent),
  ads: () => db.recordRun("ads", require("../lib/ads/manager").runAds),
  marketing: async () => ({
    content: await db.recordRun("content", require("../lib/agents/content").runContent).catch((e) => ({ error: e.message })),
    ads: await db.recordRun("ads", require("../lib/ads/manager").runAds).catch((e) => ({ error: e.message })),
  }),
  report: () => db.recordRun("sales-report", require("../lib/agents/salesManager").runDailyReport),
};

// Reduce a summary to numbers and booleans only (safe for public logs).
function redact(value, depth = 0) {
  if (value === null || typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) return `${value.length} item(s)`;
  if (typeof value === "object" && depth < 3) {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redact(v, depth + 1)]));
  }
  // A few enum-like strings are safe and useful in logs.
  if (typeof value === "string" && /^(dry_run|live|off|catalogue full)$/.test(value)) return value;
  return typeof value === "string" ? "[text]" : value;
}

(async () => {
  const name = process.argv[2];
  const job = JOBS[name];
  if (!job) {
    console.error(`usage: run-job.js <${Object.keys(JOBS).join("|")}>`);
    process.exit(2);
  }
  let failed = false;
  try {
    const summary = await job();
    console.log(`${name}:`, JSON.stringify(redact(summary)));
    if (summary && (summary.error || (summary.content && summary.content.error) || (summary.ads && summary.ads.error))) failed = true;
  } catch (err) {
    failed = true;
    // Error messages can include API responses; keep them out of public logs.
    console.error(`${name} failed — see the automation log on /admin.html (${err.constructor.name})`);
    await require("../lib/alerts")
      .notifyOwner(`job:${name}`, `Automation job "${name}" failed`, String(err.message || err))
      .catch(() => {});
  } finally {
    await db.end().catch(() => {});
  }
  process.exit(failed ? 1 : 0);
})();
