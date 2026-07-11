#!/usr/bin/env node
// Phase 1 of the multi-sport expansion probe. Free call (0 credits) — just
// lists every sport The Odds API currently has ACTIVE, grouped by category,
// so we can pick real candidates instead of guessing sport keys from memory.
// Run this first; phase 2 (scripts/probe-sports-odds.js) actually spends
// credits checking anchor/market availability on the sports we pick from
// this list.

const API_KEY = process.env.ODDS_API_KEY;
if (!API_KEY) {
  console.error("ODDS_API_KEY is not set. Aborting — no synthetic data will be used.");
  process.exit(1);
}

const BASE = "https://api.the-odds-api.com/v4";

function pad(str, len) {
  str = String(str);
  return str.length >= len ? str.slice(0, len) : str + " ".repeat(len - str.length);
}

async function main() {
  const url = `${BASE}/sports/?apiKey=${API_KEY}&all=false`; // active only
  const res = await fetch(url);
  const remaining = res.headers.get("x-requests-remaining");
  const used = res.headers.get("x-requests-used");
  const body = await res.json();

  if (!res.ok) {
    console.error(`FAILED: status ${res.status}`);
    console.error(JSON.stringify(body, null, 2));
    process.exit(1);
  }

  console.log(`=== ACTIVE SPORTS CATALOG ===`);
  console.log(`Total active: ${body.length}  (credits used: ${used}, remaining: ${remaining})\n`);

  const byGroup = new Map();
  for (const s of body) {
    if (!byGroup.has(s.group)) byGroup.set(s.group, []);
    byGroup.get(s.group).push(s);
  }

  const groups = [...byGroup.keys()].sort();
  for (const group of groups) {
    console.log(`--- ${group} ---`);
    console.log(pad("key", 40) + "title");
    for (const s of byGroup.get(group)) {
      console.log(pad(s.key, 40) + s.title);
    }
    console.log();
  }

  const horseRacing = body.filter(
    (s) => /horse/i.test(s.key) || /horse/i.test(s.title) || /racing/i.test(s.group || "")
  );
  console.log(`=== Horse racing matches ===`);
  if (horseRacing.length === 0) {
    console.log("NONE FOUND in the active sports list.");
  } else {
    for (const s of horseRacing) console.log(`  ${s.key} — ${s.title} (group: ${s.group})`);
  }
}

main().catch((err) => {
  console.error("Probe crashed:", err);
  process.exit(1);
});
