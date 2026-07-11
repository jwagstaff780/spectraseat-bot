#!/usr/bin/env node
// Step 0 probe: verifies real data availability before any product code is written.
// Reads ODDS_API_KEY from the environment only. Never hardcode a key in this file.

const API_KEY = process.env.ODDS_API_KEY;
if (!API_KEY) {
  console.error("ODDS_API_KEY is not set. Aborting probe — no synthetic data will be used.");
  process.exit(1);
}

const BASE = "https://api.the-odds-api.com/v4";
const WNBA_MARKETS = ["totals", "team_totals", "totals_h1", "team_totals_h1"];
const REGIONS = "uk,eu";

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

function pad(str, len) {
  str = String(str);
  return str.length >= len ? str.slice(0, len) : str + " ".repeat(len - str.length);
}

async function main() {
  console.log("=== STEP 0 PROBE: The Odds API ===\n");

  // --- 1. GET /sports — look for any Summer League key ---
  console.log("--- GET /sports ---");
  const sportsUrl = `${BASE}/sports/?apiKey=${API_KEY}&all=true`;
  const sportsResult = await getJson(sportsUrl);

  if (!sportsResult.ok) {
    console.error(`FAILED: status ${sportsResult.status}`);
    console.error(JSON.stringify(sportsResult.body, null, 2));
    process.exit(1);
  }

  const sports = sportsResult.body;
  console.log(`Total sports/leagues returned: ${sports.length}`);
  console.log(`Credits used: ${sportsResult.used}  remaining: ${sportsResult.remaining}\n`);

  const summerLeagueMatches = sports.filter(
    (s) =>
      /summer/i.test(s.key) ||
      /summer/i.test(s.title) ||
      /summer/i.test(s.description || "")
  );

  console.log("Summer League matches in /sports:");
  if (summerLeagueMatches.length === 0) {
    console.log("  NONE FOUND.");
  } else {
    console.log(pad("key", 40) + pad("title", 30) + "active");
    for (const s of summerLeagueMatches) {
      console.log(pad(s.key, 40) + pad(s.title, 30) + s.active);
    }
  }

  // Also show all basketball_* keys for reference (useful context, not a substitution)
  const basketballKeys = sports.filter((s) => s.key.startsWith("basketball"));
  console.log("\nAll basketball_* keys currently in /sports:");
  console.log(pad("key", 40) + pad("title", 30) + "active");
  for (const s of basketballKeys) {
    console.log(pad(s.key, 40) + pad(s.title, 30) + s.active);
  }

  // --- 2. GET /sports/basketball_wnba/odds with the four markets ---
  console.log("\n--- GET /sports/basketball_wnba/odds ---");
  console.log(`markets=${WNBA_MARKETS.join(",")}  regions=${REGIONS}\n`);

  const oddsUrl =
    `${BASE}/sports/basketball_wnba/odds/?apiKey=${API_KEY}` +
    `&regions=${REGIONS}&markets=${WNBA_MARKETS.join(",")}&oddsFormat=decimal`;
  const oddsResult = await getJson(oddsUrl);

  console.log(`HTTP status: ${oddsResult.status}`);
  console.log(`Credits used: ${oddsResult.used}  remaining: ${oddsResult.remaining}\n`);

  if (!oddsResult.ok) {
    console.log("Request failed. Response body:");
    console.log(JSON.stringify(oddsResult.body, null, 2));
  } else {
    const events = oddsResult.body;
    console.log(`Events returned: ${events.length}`);

    // Tally which markets actually appear, per bookmaker, across all events.
    const marketPresence = new Map(WNBA_MARKETS.map((m) => [m, new Set()]));
    let totalBookmakerMarketEntries = 0;

    for (const ev of events) {
      for (const bk of ev.bookmakers || []) {
        for (const mk of bk.markets || []) {
          totalBookmakerMarketEntries++;
          if (marketPresence.has(mk.key)) {
            marketPresence.get(mk.key).add(bk.key);
          }
        }
      }
    }

    console.log("\nMarket availability across returned events:");
    console.log(pad("market", 20) + pad("present?", 12) + "bookmakers offering it");
    for (const m of WNBA_MARKETS) {
      const books = [...marketPresence.get(m)];
      console.log(
        pad(m, 20) + pad(books.length > 0 ? "YES" : "no", 12) + (books.join(", ") || "-")
      );
    }

    if (events.length === 0) {
      console.log(
        "\n(No events returned at all — this is likely off-season / no games scheduled" +
          " rather than a market-support issue. Re-run during an active slate.)"
      );
    }
  }

  console.log("\n=== PROBE COMPLETE ===");
}

main().catch((err) => {
  console.error("Probe crashed:", err);
  process.exit(1);
});
