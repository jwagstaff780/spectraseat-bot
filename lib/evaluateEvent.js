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

// grouped-two-way markets (totals family): outcomes are paired into
// Over/Under by (point, description) — team_totals bundles both teams'
// Over/Under into one market object, disambiguated by description.
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

// Returns every outcome that belongs to the same mutually-exclusive group
// as (groupKey). groupKey === null means the whole market is one group
// (flat-n-way, e.g. soccer h2h's Home/Draw/Away) — otherwise only outcomes
// matching that (point, description) pair (grouped-two-way's Over/Under).
function outcomesInGroup(market, groupKey) {
  const outcomes = market.outcomes || [];
  if (groupKey === null) return outcomes;
  return outcomes.filter((o) => outcomeGroupKey(o) === groupKey);
}

// groupKey === null means "match by outcome name only" — used for
// flat-n-way markets (h2h) which have no point/description to group by.
function findOutcome(bookmaker, marketKey, groupKey, name) {
  const market = findMarket(bookmaker, marketKey);
  if (!market) return null;
  return (
    (market.outcomes || []).find((o) => (groupKey === null || outcomeGroupKey(o) === groupKey) && o.name === name) ||
    null
  );
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

// Shared by both market shapes: given the anchor's decimal odds for a
// mutually-exclusive set of outcomes, de-vigs them and produces one
// opportunity row per outcome — either fully evaluated or an explicit
// reason it couldn't be (no sharp reference already handled by the
// caller; this handles unresolvable / no_comparison / evaluated).
function evaluateOutcomeGroup({ base, bookmakers, anchor, marketKey, groupKey, linePoint, selectionGroup, outcomes, bookLastUpdate, stakeSettings }) {
  const opportunities = [];
  const decimalOdds = outcomes.map((o) => o.price);
  const devig = devigAll(decimalOdds);
  const overroundBanner = devig.overroundPct > config.OVERROUND_BANNER_PCT;

  const devigTable = outcomes.map((o, i) => ({
    name: o.name,
    multiplicative: devig.multiplicative[i],
    power: devig.power[i],
    shin: devig.shin[i],
  }));

  const shared = {
    ...base,
    linePoint,
    selectionGroup,
    anchorBook: anchor.bookmaker.key,
    anchorSource: anchor.source,
    anchorOverroundPct: devig.overroundPct,
    overroundBanner,
    bookLastUpdate,
    devigTable,
    maxSpreadPct: devig.maxSpreadPct,
    unresolvable: devig.unresolvable,
  };

  outcomes.forEach((outcome, i) => {
    if (devig.unresolvable) {
      opportunities.push({
        ...shared,
        selection: outcome.name,
        status: "unresolvable",
        reason: `Our two ways of estimating the real chance disagree by ${devig.maxSpreadPct.toFixed(2)} percentage points — too uncertain to trust, so this is greyed out.`,
        anchorOdds: outcome.price,
      });
      return;
    }

    const fairProb = devig.power[i];
    const best = bestOtherBookPrice(bookmakers, anchor.bookmaker.key, marketKey, groupKey, outcome.name);

    if (!best) {
      opportunities.push({
        ...shared,
        selection: outcome.name,
        status: "no_comparison",
        reason: "Only the trusted bookmaker offers this price — there's no second price to compare it against, so we can't tell if it's a good deal.",
        anchorOdds: outcome.price,
        fairProb,
      });
      return;
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
      selection: outcome.name,
      status: "evaluated",
      anchorOdds: outcome.price,
      fairProb,
      bestBook: best.book,
      bestOdds: best.price,
      bestBookLastUpdate: best.lastUpdate,
      ev,
      kelly: stake,
    });
  });

  return opportunities;
}

// Evaluates one event across the markets configured for its sport. Returns
// a flat list of "opportunity" rows, each fully resolved to either a
// computed EV or an explicit reason it couldn't be. Never fabricates a
// number: every numeric field traces back to a real bookmaker price from
// this event's feed data.
function evaluateEvent({ event, sportKey, league, markets, stakeSettings }) {
  const bookmakers = event.bookmakers || [];
  const anchor = selectAnchor(bookmakers);
  const opportunities = [];

  for (const marketKey of markets) {
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

    const shape = config.MARKET_SHAPES[marketKey];
    const bookLastUpdate = anchorMarket.last_update || anchor.bookmaker.last_update || null;

    if (shape === "flat-n-way") {
      const outcomes = anchorMarket.outcomes || [];
      if (outcomes.length < 2) {
        opportunities.push({ ...base, status: "no_data", reason: "The trusted bookmaker lists this market but hasn't posted prices for it yet." });
        continue;
      }
      opportunities.push(
        ...evaluateOutcomeGroup({
          base,
          bookmakers,
          anchor,
          marketKey,
          groupKey: null, // match by outcome name only — no point/description on h2h markets
          linePoint: 0, // sentinel: h2h has no line; keeps the DB column NOT NULL-safe
          selectionGroup: "",
          outcomes,
          bookLastUpdate,
          stakeSettings,
        })
      );
      continue;
    }

    // grouped-two-way (totals family)
    const groups = groupTwoWayOutcomes(anchorMarket);
    if (groups.length === 0) {
      opportunities.push({ ...base, status: "no_data", reason: "The trusted bookmaker lists this market but hasn't posted a price for it yet." });
      continue;
    }

    for (const group of groups) {
      opportunities.push(
        ...evaluateOutcomeGroup({
          base,
          bookmakers,
          anchor,
          marketKey,
          groupKey: group.key,
          linePoint: group.over.point ?? 0,
          selectionGroup: group.over.description || "",
          outcomes: [group.over, group.under],
          bookLastUpdate,
          stakeSettings,
        })
      );
    }
  }

  return opportunities;
}

module.exports = { evaluateEvent, mergeBookmakers, groupTwoWayOutcomes, outcomeGroupKey, outcomesInGroup };
