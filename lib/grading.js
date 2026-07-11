const { devigAll } = require("./devig");
const config = require("./config");

// Turns a captured closing-line snapshot (our outcome's anchor price + every
// other outcome in the same market group, all from the same poll) into the
// graded CLV row fields. closeOtherPrices is 1 price for a two-way market,
// up to N-1 for an N-way market like soccer's Home/Draw/Away. Pure function
// — no I/O — so it's easy to reason about and test independently of the
// cron/DB plumbing.
function gradeSnapshot({ oddsTaken, closeRaw, closeOtherPrices, kickoffAt, capturedAt }) {
  const devig = devigAll([closeRaw, ...closeOtherPrices]);
  const lagSeconds = Math.round((new Date(kickoffAt).getTime() - new Date(capturedAt).getTime()) / 1000);

  const pCloseMult = devig.multiplicative[0];
  const pClosePower = devig.power[0];
  const pCloseShin = devig.shin[0];

  const powerShinSpreadPct = Math.abs(pClosePower - pCloseShin) * 100;
  const unresolvable = powerShinSpreadPct > config.CLOSE_UNRESOLVABLE_SPREAD_PCT;

  const clv = unresolvable ? null : oddsTaken * pClosePower - 1;
  const highLag = lagSeconds > config.HIGH_LAG_SECONDS;

  return {
    pCloseMult,
    pClosePower,
    pCloseShin,
    overroundPct: devig.overroundPct,
    lagSeconds,
    unresolvable,
    powerShinSpreadPct,
    clv,
    highLag,
  };
}

module.exports = { gradeSnapshot };
