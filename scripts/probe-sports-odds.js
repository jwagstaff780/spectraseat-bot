#!/usr/bin/env node
// Phase 2 of the multi-sport expansion probe. Spends real credits — checks
// actual odds data (events, markets, anchor availability) for the soccer
// leagues and tennis tournaments confirmed active in phase 1
// (scripts/probe-sports-catalog.js). Basketball (WNBA / NBA Summer League)
// is already validated by the original Step 0 probe and isn't re-tested
// here.

const API_KEY = process.env.ODDS_API_KEY;
if (!API_KEY) {
  console.error("ODDS_API_KEY is not set. Aborting — no synthetic data will be used.");
  process.exit(1);
}

const BASE = "https://api.the-odds-api.com/v4";
const REGIONS = "uk,eu";

// English football only, per instruction — not the broader international
// list. h2h is 3-way (Home/Draw/Away), totals is 2-way (Over/Under).
// None of these showed up in the phase-1 ACTIVE catalog (all=false), which
// is expected: England's domestic season is on its summer break in July,
// so this probe may honestly come back with 0 events for some/all of
// these — that's real information, not a bug. Tested directly by key
// rather than assumed, same as everything else in this project.
const SOCCER_SPORTS = [
  "soccer_epl", // Premier League
  "soccer_efl_champ", // Championship
  "soccer_england_league1",
  "soccer_england_league2",
  "soccer_fa_cup",
];

// Tennis: h2h is match winner (2-way).
const TENNIS_SPORTS = ["tennis_atp_wimbledon", "tennis_wta_wimbledon"];

function pad(str, len) {
  str = String(str);
  return str.length >= len ? str.slice(0, len) : str + " ".repeat(len - str.length);
}

async function getJson(url) {
  const res = await fetch(url);
  const remaining = res.headers.get("x-requests-remaining");
  const used = res.headers.get("x-requests-used");
  let body;
  try {
    body = await res.json();
  } catch {
    body = await res.text();
  }
  return { status: res.status, ok: res.ok, body, remaining, used };
}

function hasAnchor(bookmakers) {
  if (!bookmakers) return "-";
  if (bookmakers.some((b) => b.key === "pinnacle")) return "pinnacle";
  if (bookmakers.some((b) => (b.key || "").startsWith("betfair_ex"))) return "betfair_ex";
  return "NONE";
}

async function probeSport(sportKey, markets) {
  const url =
    `${BASE}/sports/${sportKey}/odds/?apiKey=${API_KEY}` +
    `&regions=${REGIONS}&markets=${markets.join(",")}&oddsFormat=decimal`;
  const result = await getJson(url);

  if (!result.ok) {
    console.log(pad(sportKey, 42) + `FAILED (${result.status}): ${result.body && result.body.message}`);
    return;
  }

  const events = result.body;
  if (events.length === 0) {
    console.log(pad(sportKey, 42) + `0 events (credits used: ${result.used}, remaining: ${result.remaining})`);
    return;
  }

  // Check anchor presence across all returned events, not just the first.
  const anchorCounts = { pinnacle: 0, betfair_ex: 0, NONE: 0, "-": 0 };
  for (const ev of events) {
    anchorCounts[hasAnchor(ev.bookmakers)]++;
  }
  const marketsSeen = new Set();
  for (const ev of events) {
    for (const bk of ev.bookmakers || []) {
      for (const mk of bk.markets || []) marketsSeen.add(mk.key);
    }
  }

  console.log(
    pad(sportKey, 42) +
      `${events.length} events | pinnacle:${anchorCounts.pinnacle} betfair:${anchorCounts.betfair_ex} none:${anchorCounts.NONE} | markets seen: ${[...marketsSeen].join(",")}`
  );
}

async function main() {
  console.log("=== PHASE 2 PROBE: soccer + tennis odds/anchor availability ===\n");

  console.log("--- Soccer (h2h=3-way, totals=2-way) ---");
  for (const sport of SOCCER_SPORTS) {
    await probeSport(sport, ["h2h", "totals"]);
  }

  console.log("\n--- Tennis (h2h=match winner) ---");
  for (const sport of TENNIS_SPORTS) {
    await probeSport(sport, ["h2h"]);
  }

  console.log("\n=== PROBE COMPLETE ===");
}

main().catch((err) => {
  console.error("Probe crashed:", err);
  process.exit(1);
});
