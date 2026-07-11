// Central knobs. Edit this file to add sports/markets — nothing else
// should need to change.

module.exports = {
  ODDS_API_BASE: "https://api.the-odds-api.com/v4",

  // Sport keys confirmed live via scripts/probe*.js. Add more here once
  // they're probed and confirmed to return real data — never add a sport
  // speculatively. bulkMarkets are fetched via the cheap bulk /odds
  // endpoint; perEventMarkets require the per-event endpoint (see
  // lib/oddsApi.js) and are skipped entirely (no extra API call) when empty.
  TRACKED_SPORTS: [
    { key: "basketball_wnba", league: "WNBA", bulkMarkets: ["totals"], perEventMarkets: ["team_totals", "totals_h1", "team_totals_h1"] },
    { key: "basketball_nba_summer_league", league: "NBA Summer League", bulkMarkets: ["totals"], perEventMarkets: ["team_totals", "totals_h1", "team_totals_h1"] },
    { key: "soccer_epl", league: "Premier League", bulkMarkets: ["h2h", "totals"], perEventMarkets: [] },
    { key: "soccer_efl_champ", league: "Championship", bulkMarkets: ["h2h", "totals"], perEventMarkets: [] },
    { key: "soccer_england_league1", league: "League One", bulkMarkets: ["h2h", "totals"], perEventMarkets: [] },
    { key: "soccer_england_league2", league: "League Two", bulkMarkets: ["h2h", "totals"], perEventMarkets: [] },
    { key: "soccer_fa_cup", league: "FA Cup", bulkMarkets: ["h2h", "totals"], perEventMarkets: [] },
    { key: "soccer_fifa_world_cup", league: "FIFA World Cup", bulkMarkets: ["h2h", "totals"], perEventMarkets: [] },
    { key: "tennis_atp_wimbledon", league: "ATP Wimbledon", bulkMarkets: ["h2h"], perEventMarkets: [] },
    { key: "tennis_wta_wimbledon", league: "WTA Wimbledon", bulkMarkets: ["h2h"], perEventMarkets: [] },
  ],

  // Market "shape" determines how evaluateEvent.js groups and reads
  // outcomes. grouped-two-way = paired Over/Under by (point, description).
  // flat-n-way = every outcome in the market is one mutually-exclusive
  // group (soccer h2h is 3-way Home/Draw/Away, tennis h2h is 2-way).
  MARKET_SHAPES: {
    totals: "grouped-two-way",
    team_totals: "grouped-two-way",
    totals_h1: "grouped-two-way",
    team_totals_h1: "grouped-two-way",
    h2h: "flat-n-way",
  },

  REGIONS: "uk,eu",

  ODDS_CACHE_TTL_MS: 60_000,

  UNRESOLVABLE_SPREAD_PCT: 1.5, // main engine: 3-way devig disagreement gate
  CLOSE_UNRESOLVABLE_SPREAD_PCT: 1.5, // CLV: power vs shin disagreement gate
  HIGH_LAG_SECONDS: 10 * 60, // close_capture_lag_s above this gets flagged

  DEFAULT_KELLY_MULTIPLIER: 0.25,
  DEFAULT_HARD_CAP_PCT: 2, // % of bankroll, hard ceiling regardless of Kelly

  OVERROUND_BANNER_PCT: 6,
};
