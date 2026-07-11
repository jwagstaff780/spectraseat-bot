const config = require("./config");

function requireKey() {
  const key = process.env.ODDS_API_KEY;
  if (!key) throw new Error("ODDS_API_KEY is not set — refusing to fabricate odds data.");
  return key;
}

async function apiGet(url) {
  const res = await fetch(url);
  const remaining = res.headers.get("x-requests-remaining");
  const used = res.headers.get("x-requests-used");
  let body;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  if (!res.ok) {
    const err = new Error(`Odds API error ${res.status}: ${body && body.message}`);
    err.status = res.status;
    err.body = body;
    throw err;
  }
  return { body, remaining, used };
}

// Bulk endpoint: core markets only (h2h, spreads, totals).
async function getCoreOdds(sportKey) {
  const key = requireKey();
  const url =
    `${config.ODDS_API_BASE}/sports/${sportKey}/odds/?apiKey=${key}` +
    `&regions=${config.REGIONS}&markets=${config.CORE_MARKETS.join(",")}&oddsFormat=decimal`;
  return apiGet(url);
}

// Per-event endpoint: the only place additional markets (team_totals,
// totals_h1, team_totals_h1, etc.) are queryable.
async function getEventOdds(sportKey, eventId, markets) {
  const key = requireKey();
  const marketList = (markets || config.ADDITIONAL_MARKETS).join(",");
  const url =
    `${config.ODDS_API_BASE}/sports/${sportKey}/events/${eventId}/odds/?apiKey=${key}` +
    `&regions=${config.REGIONS}&markets=${marketList}&oddsFormat=decimal`;
  return apiGet(url);
}

// Best-effort completed-game lookup, used for void detection and settling
// real-money bets. Not guaranteed for every league/timeframe.
async function getScores(sportKey, daysFrom = 3) {
  const key = requireKey();
  const url = `${config.ODDS_API_BASE}/sports/${sportKey}/scores/?apiKey=${key}&daysFrom=${daysFrom}`;
  return apiGet(url);
}

module.exports = { getCoreOdds, getEventOdds, getScores };
