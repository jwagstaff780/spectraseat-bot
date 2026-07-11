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

  function tallyMarkets(events, markets) {
    const marketPresence = new Map(markets.map((m) => [m, new Set()]));
    for (const ev of events) {
      for (const bk of ev.bookmakers || []) {
        for (const mk of bk.markets || []) {
          if (marketPresence.has(mk.key)) marketPresence.get(mk.key).add(bk.key);
        }
      }
    }
    return marketPresence;
  }

  function printMarketTable(markets, presence) {
    console.log(pad("market", 20) + pad("present?", 12) + "bookmakers offering it");
    for (const m of markets) {
      const books = [...presence.get(m)];
      console.log(
        pad(m, 20) + pad(books.length > 0 ? "YES" : "no", 12) + (books.join(", ") || "-")
      );
    }
  }

  // --- 2a. GET /sports/basketball_wnba/odds — core market only (bulk endpoint) ---
  console.log("\n--- GET /sports/basketball_wnba/odds (bulk, core markets) ---");
  console.log(`markets=totals  regions=${REGIONS}\n`);

  const coreUrl =
    `${BASE}/sports/basketball_wnba/odds/?apiKey=${API_KEY}` +
    `&regions=${REGIONS}&markets=totals&oddsFormat=decimal`;
  const coreResult = await getJson(coreUrl);

  console.log(`HTTP status: ${coreResult.status}`);
  console.log(`Credits used: ${coreResult.used}  remaining: ${coreResult.remaining}\n`);

  let events = [];
  if (!coreResult.ok) {
    console.log("Request failed. Response body:");
    console.log(JSON.stringify(coreResult.body, null, 2));
  } else {
    events = coreResult.body;
    console.log(`Events returned: ${events.length}`);
    if (events.length > 0) {
      printMarketTable(["totals"], tallyMarkets(events, ["totals"]));
    } else {
      console.log(
        "(No WNBA events currently on the board — cannot test per-event markets below" +
          " until there is a live/upcoming event.)"
      );
    }
  }

  // --- 2b. GET /sports/basketball_wnba/events/{id}/odds — additional markets, per-event ---
  const ADDITIONAL_MARKETS = ["team_totals", "totals_h1", "team_totals_h1"];
  console.log("\n--- GET /sports/basketball_wnba/events/{id}/odds (per-event, additional markets) ---");
  console.log(`markets=${ADDITIONAL_MARKETS.join(",")}  regions=${REGIONS}\n`);

  if (events.length === 0) {
    console.log("SKIPPED — no event id available to test against.");
  } else {
    const testEvent = events[0];
    console.log(`Testing against event: ${testEvent.away_team} @ ${testEvent.home_team} (${testEvent.id})\n`);

    const eventUrl =
      `${BASE}/sports/basketball_wnba/events/${testEvent.id}/odds/?apiKey=${API_KEY}` +
      `&regions=${REGIONS}&markets=${ADDITIONAL_MARKETS.join(",")}&oddsFormat=decimal`;
    const eventResult = await getJson(eventUrl);

    console.log(`HTTP status: ${eventResult.status}`);
    console.log(`Credits used: ${eventResult.used}  remaining: ${eventResult.remaining}\n`);

    if (!eventResult.ok) {
      console.log("Request failed. Response body:");
      console.log(JSON.stringify(eventResult.body, null, 2));
    } else {
      const ev = eventResult.body;
      const presence = tallyMarkets([ev], ADDITIONAL_MARKETS);
      printMarketTable(ADDITIONAL_MARKETS, presence);
    }
  }

  console.log("\n=== PROBE COMPLETE ===");
}

main().catch((err) => {
  console.error("Probe crashed:", err);
  process.exit(1);
});
