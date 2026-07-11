// Central knobs. Edit this file to add sports/markets — nothing else
// should need to change.

module.exports = {
  ODDS_API_BASE: "https://api.the-odds-api.com/v4",

  // Sport keys confirmed live via scripts/probe.js. Add more here once
  // they're probed and confirmed to return real data — never add a sport
  // speculatively.
  TRACKED_SPORTS: [
    { key: "basketball_wnba", league: "WNBA" },
    { key: "basketball_nba_summer_league", league: "NBA Summer League" },
  ],

  CORE_MARKETS: ["totals"],
  ADDITIONAL_MARKETS: ["team_totals", "totals_h1", "team_totals_h1"],
  REGIONS: "uk,eu",

  ODDS_CACHE_TTL_MS: 60_000,

  UNRESOLVABLE_SPREAD_PCT: 1.5, // main engine: 3-way devig disagreement gate
  CLOSE_UNRESOLVABLE_SPREAD_PCT: 1.5, // CLV: power vs shin disagreement gate
  HIGH_LAG_SECONDS: 10 * 60, // close_capture_lag_s above this gets flagged

  DEFAULT_KELLY_MULTIPLIER: 0.25,
  DEFAULT_HARD_CAP_PCT: 2, // % of bankroll, hard ceiling regardless of Kelly

  OVERROUND_BANNER_PCT: 6,
};
