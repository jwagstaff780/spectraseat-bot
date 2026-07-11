const { devigAll } = require("./devig");
const { selectAnchor, findMarket } = require("./anchor");
const { computeEV, suggestedStake } = require("./ev");
const config = require("./config");

function mergeBookmakers(...bookmakerLists) {
  const byKey = new Map();
  for (const list of bookmakerLists) {
    for (const bk of list || []) {
      if (!byKey.has(bk.key)) {
        byKey.set(bk.key, { key: bk.key, title: bk.title, last_update: bk.last_update, markets: [] });
      }
      const merged = byKey.get(bk.key);
      for (const m of bk.markets || []) {
        merged.markets.push(m);
        // bookmaker-level last_update is sometimes only present on one of the
        // two calls (core vs per-event) — keep the most recent.
        if (!merged.last_update || new Date(bk.last_update) > new Date(merged.last_update)) {
          merged.last_update = bk.last_update;
        }
      }
    }
  }
  return [...byKey.values()];
}

function outcomeGroupKey(outcome) {
  return `${outcome.point ?? ""}|${outcome.description ?? ""}`;
}

function groupTwoWayOutcomes(market) {
  const groups = new Map();
  for (const o of market.outcomes || []) {
    const key = outcomeGroupKey(o);
    if (!groups.has(key)) groups.set(key, {});
    groups.get(key)[o.name] = o;
  }
  const result = [];
  for (const [key, sides] of groups) {
    if (sides.Over && sides.Under) {
      result.push({ key, over: sides.Over, under: sides.Under });
    }
  }
  return result;
}

function findOutcome(bookmaker, marketKey, groupKey, name) {
  const market = findMarket(bookmaker, marketKey);
  if (!market) return null;
  return (market.outcomes || []).find((o) => outcomeGroupKey(o) === groupKey && o.name === name) || null;
}

function bestOtherBookPrice(bookmakers, anchorKey, marketKey, groupKey, name) {
  let best = null;
  for (const bk of bookmakers) {
    if (bk.key === anchorKey) continue;
    const outcome = findOutcome(bk, marketKey, groupKey, name);
    if (outcome && (best === null || outcome.price > best.price)) {
      const market = findMarket(bk, marketKey);
      best = {
        price: outcome.price,
        book: bk.key,
        lastUpdate: (market && market.last_update) || bk.last_update || null,
      };
    }
  }
  return best;
}

// Evaluates one event across all configured markets. Returns a flat list of
// "opportunity" rows — one per (market, group, side) — each fully resolved
// to either a computed EV or an explicit reason it couldn't be computed.
// Never fabricates a number: every numeric field traces back to a real
// bookmaker price from this event's feed data.
function evaluateEvent({ event, sportKey, league, stakeSettings }) {
  const bookmakers = event.bookmakers || [];
  const anchor = selectAnchor(bookmakers);
  const opportunities = [];

  const allMarkets = [...config.CORE_MARKETS, ...config.ADDITIONAL_MARKETS];

  for (const marketKey of allMarkets) {
    const base = {
      eventId: event.id,
      sportKey,
      league,
      homeTeam: event.home_team,
      awayTeam: event.away_team,
      commenceTime: event.commence_time,
      market: marketKey,
    };

    if (!anchor) {
      opportunities.push({ ...base, status: "no_sharp_reference", reason: "NO SHARP REFERENCE — edge cannot be computed." });
      continue;
    }

    const anchorMarket = findMarket(anchor.bookmaker, marketKey);
    if (!anchorMarket) {
      opportunities.push({
        ...base,
        status: "no_sharp_reference",
        reason: "NO SHARP REFERENCE — edge cannot be computed.",
        anchorBook: anchor.bookmaker.key,
      });
      continue;
    }

    const groups = groupTwoWayOutcomes(anchorMarket);
    if (groups.length === 0) {
      opportunities.push({ ...base, status: "no_data", reason: "Anchor lists this market but no two-way price data." });
      continue;
    }

    for (const group of groups) {
      const decimalOdds = [group.over.price, group.under.price];
      const devig = devigAll(decimalOdds);

      const overroundBanner = devig.overroundPct > config.OVERROUND_BANNER_PCT;

      const shared = {
        ...base,
        linePoint: group.over.point ?? null,
        selectionGroup: group.over.description || "",
        anchorBook: anchor.bookmaker.key,
        anchorSource: anchor.source,
        anchorOverroundPct: devig.overroundPct,
        overroundBanner,
        bookLastUpdate: anchorMarket.last_update || anchor.bookmaker.last_update || null,
        devigMultiplicative: { over: devig.multiplicative[0], under: devig.multiplicative[1] },
        devigPower: { over: devig.power[0], under: devig.power[1] },
        devigShin: { over: devig.shin[0], under: devig.shin[1] },
        maxSpreadPct: devig.maxSpreadPct,
        unresolvable: devig.unresolvable,
      };

      for (const [sideName, sideIdx, outcome] of [
        ["Over", 0, group.over],
        ["Under", 1, group.under],
      ]) {
        if (devig.unresolvable) {
          opportunities.push({
            ...shared,
            selection: sideName,
            status: "unresolvable",
            reason: `De-vig methods disagree by ${devig.maxSpreadPct.toFixed(2)}pp (> 1.5pp threshold) — greyed out.`,
            anchorOdds: outcome.price,
          });
          continue;
        }

        const fairProb = devig.power[sideIdx];
        const best = bestOtherBookPrice(bookmakers, anchor.bookmaker.key, marketKey, group.key, sideName);

        if (!best) {
          opportunities.push({
            ...shared,
            selection: sideName,
            status: "no_comparison",
            reason: "Only the sharp anchor offers this side — no second book to shop for an edge.",
            anchorOdds: outcome.price,
            fairProb,
          });
          continue;
        }

        const ev = computeEV(fairProb, best.price);
        const stake = suggestedStake({
          fairProb,
          decimalOdds: best.price,
          bankroll: stakeSettings?.bankroll ?? null,
          kellyMultiplier: stakeSettings?.kellyMultiplier ?? config.DEFAULT_KELLY_MULTIPLIER,
          hardCapPct: stakeSettings?.hardCapPct ?? config.DEFAULT_HARD_CAP_PCT,
        });

        opportunities.push({
          ...shared,
          selection: sideName,
          status: "evaluated",
          anchorOdds: outcome.price,
          fairProb,
          bestBook: best.book,
          bestOdds: best.price,
          bestBookLastUpdate: best.lastUpdate,
          ev,
          kelly: stake,
        });
      }
    }
  }

  return opportunities;
}

module.exports = { evaluateEvent, mergeBookmakers, groupTwoWayOutcomes, outcomeGroupKey };
