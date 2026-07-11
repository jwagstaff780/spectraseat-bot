const config = require("../lib/config");
const oddsApi = require("../lib/oddsApi");
const { evaluateEvent, mergeBookmakers } = require("../lib/evaluateEvent");
const { logFlaggedBet } = require("../lib/logBet");

// Module-scope cache — persists across invocations on a warm lambda
// instance, reset on cold start. Cache-aside with a 60s TTL: never calls
// the upstream API more than once per 60s no matter how many requests hit
// this endpoint. (True background stale-while-revalidate isn't reliable on
// standard Node serverless lifecycle, since the function can be frozen the
// instant a response is sent — this cache-aside version gives the same
// practical 60s-staleness guarantee without relying on that.)
let cache = { data: null, fetchedAt: 0 };

async function fetchAndEvaluate(stakeSettings) {
  const allOpportunities = [];
  let creditsUsed = null;
  let creditsRemaining = null;

  for (const sport of config.TRACKED_SPORTS) {
    let coreResult;
    try {
      coreResult = await oddsApi.getCoreOdds(sport.key, sport.bulkMarkets);
    } catch (err) {
      // A dead/unknown sport key or upstream outage — skip it, don't fake data.
      allOpportunities.push({
        sportKey: sport.key,
        league: sport.league,
        status: "fetch_error",
        reason: `Could not fetch ${sport.league}: ${err.message}`,
      });
      continue;
    }
    creditsUsed = coreResult.used;
    creditsRemaining = coreResult.remaining;

    const events = coreResult.body || [];

    for (const event of events) {
      let mergedBookmakers = event.bookmakers;

      if (sport.perEventMarkets.length > 0) {
        let eventResult;
        try {
          eventResult = await oddsApi.getEventOdds(sport.key, event.id, sport.perEventMarkets);
        } catch (err) {
          eventResult = { body: null };
        }
        if (eventResult.used) creditsUsed = eventResult.used;
        if (eventResult.remaining) creditsRemaining = eventResult.remaining;
        mergedBookmakers = mergeBookmakers(event.bookmakers, eventResult.body ? eventResult.body.bookmakers : []);
      }

      const opps = evaluateEvent({
        event: { ...event, bookmakers: mergedBookmakers },
        sportKey: sport.key,
        league: sport.league,
        markets: [...sport.bulkMarkets, ...sport.perEventMarkets],
        stakeSettings,
      });

      allOpportunities.push(...opps);
    }
  }

  return { opportunities: allOpportunities, creditsUsed, creditsRemaining };
}

module.exports = async (req, res) => {
  if (req.method !== "GET") {
    res.status(405).json({ error: "GET only" });
    return;
  }

  const bankroll = req.query.bankroll ? Number(req.query.bankroll) : null;
  const kellyMultiplier = req.query.kellyMultiplier ? Number(req.query.kellyMultiplier) : config.DEFAULT_KELLY_MULTIPLIER;
  const hardCapPct = req.query.hardCapPct ? Number(req.query.hardCapPct) : config.DEFAULT_HARD_CAP_PCT;
  const stakeSettings = { bankroll, kellyMultiplier, hardCapPct };

  const age = Date.now() - cache.fetchedAt;

  try {
    if (!cache.data || age >= config.ODDS_CACHE_TTL_MS) {
      const result = await fetchAndEvaluate(stakeSettings);
      cache = { data: result, fetchedAt: Date.now() };

      // Auto-log every genuinely flagged (+EV, fully resolved) opportunity.
      // Best-effort: a logging failure must never break the board response.
      const flagged = result.opportunities.filter((o) => o.status === "evaluated" && o.ev > 0);
      await Promise.all(
        flagged.map((opp) =>
          logFlaggedBet(opp).catch((err) => {
            console.error("logFlaggedBet failed", err.message);
          })
        )
      );
    }

    const evaluated = cache.data.opportunities
      .filter((o) => o.status === "evaluated")
      .sort((a, b) => b.ev - a.ev);
    const excluded = cache.data.opportunities.filter((o) => o.status !== "evaluated");

    res.setHeader("Cache-Control", "no-store");
    res.status(200).json({
      generatedAt: new Date(cache.fetchedAt).toISOString(),
      cacheAgeMs: Date.now() - cache.fetchedAt,
      credits: { used: cache.data.creditsUsed, remaining: cache.data.creditsRemaining },
      board: evaluated,
      excluded,
    });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
};
