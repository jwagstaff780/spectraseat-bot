#!/usr/bin/env node
// Answers one specific question: which real bookmakers does The Odds API
// actually return for uk/eu regions? Checked directly rather than assumed,
// so we can decide honestly whether a separate Oddschecker integration is
// even necessary, or whether the named UK high-street books (Bet365,
// William Hill, Ladbrokes, Sky Bet, Paddy Power, Coral, etc.) are already
// covered through the existing feed.

const API_KEY = process.env.ODDS_API_KEY;
if (!API_KEY) {
  console.error("ODDS_API_KEY is not set. Aborting — no synthetic data will be used.");
  process.exit(1);
}

const BASE = "https://api.the-odds-api.com/v4";

// basketball_wnba/totals is known-good from Step 0 — reusing it here just
// as a reliable source of real bookmaker data, not because this is about
// basketball.
const SPORT = "basketball_wnba";
const REGIONS = "uk,eu,us,us2,au";

const NAMED_UK_BOOKS_TO_CHECK = [
  "bet365",
  "williamhill",
  "ladbrokes_uk",
  "coral",
  "skybet",
  "paddypower",
  "betfair_sb_uk",
  "betfair_ex_uk",
  "boylesports",
  "virginbet",
  "unibet_uk",
  "betway",
  "888sport",
  "matchbook",
  "livescorebet",
];

async function main() {
  const url =
    `${BASE}/sports/${SPORT}/odds/?apiKey=${API_KEY}` +
    `&regions=${REGIONS}&markets=totals&oddsFormat=decimal`;
  const res = await fetch(url);
  const remaining = res.headers.get("x-requests-remaining");
  const used = res.headers.get("x-requests-used");
  const body = await res.json();

  if (!res.ok) {
    console.error(`FAILED: status ${res.status}`);
    console.error(JSON.stringify(body, null, 2));
    process.exit(1);
  }

  console.log(`Credits used: ${used}  remaining: ${remaining}\n`);

  const seen = new Map();
  for (const ev of body) {
    for (const bk of ev.bookmakers || []) {
      seen.set(bk.key, bk.title);
    }
  }

  console.log(`=== ALL BOOKMAKERS RETURNED (regions=${REGIONS}) ===`);
  console.log(`Total distinct bookmakers: ${seen.size}\n`);
  const sortedKeys = [...seen.keys()].sort();
  for (const key of sortedKeys) {
    console.log(`  ${key}  —  ${seen.get(key)}`);
  }

  console.log(`\n=== Named UK high-street books — present or not? ===`);
  for (const key of NAMED_UK_BOOKS_TO_CHECK) {
    console.log(`  ${key.padEnd(18)} ${seen.has(key) ? "YES — " + seen.get(key) : "not in this response"}`);
  }
}

main().catch((err) => {
  console.error("Probe crashed:", err);
  process.exit(1);
});
