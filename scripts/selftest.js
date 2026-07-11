#!/usr/bin/env node
// Pure-math regression test for the de-vig/EV/stats engine. No network, no
// DB — just checks the core correctness properties the brief calls out as
// the highest-stakes failure mode. Run with `node scripts/selftest.js`.

const { multiplicative, power, shin, devigAll } = require("../lib/devig");
const { computeEV, kellyFraction } = require("../lib/ev");
const stats = require("../lib/stats");

let failures = 0;
function assert(cond, msg) {
  if (!cond) {
    failures++;
    console.error(`FAIL: ${msg}`);
  } else {
    console.log(`ok: ${msg}`);
  }
}
function approx(a, b, tol = 1e-6) {
  return Math.abs(a - b) < tol;
}

console.log("--- devig: symmetric market ---");
{
  const odds = [1.9, 1.9];
  for (const [name, fn] of [["multiplicative", multiplicative], ["power", power], ["shin", shin]]) {
    const probs = fn(odds);
    assert(approx(probs[0], 0.5, 1e-4) && approx(probs[1], 0.5, 1e-4), `${name} splits symmetric market 50/50`);
    assert(approx(probs[0] + probs[1], 1, 1e-6), `${name} probabilities sum to 1`);
  }
}

console.log("\n--- devig: heavy favourite — the core failure mode ---");
// Verified property (matches the documented favourite-longshot bias:
// Ali 1977, Shin 1992/1993): naive proportional de-vig UNDERSTATES the
// favourite relative to power/Shin, not the other way round. Power and
// Shin shrink the longshot's implied probability much more aggressively
// than the favourite's, shifting fair probability toward the favourite
// compared to naive multiplicative scaling.
{
  const odds = [1.1, 6.5]; // favourite, underdog
  const mult = multiplicative(odds);
  const pow = power(odds);
  const shn = shin(odds);

  assert(approx(mult[0] + mult[1], 1, 1e-6), "multiplicative sums to 1");
  assert(approx(pow[0] + pow[1], 1, 1e-6), "power sums to 1");
  assert(approx(shn[0] + shn[1], 1, 1e-6), "shin sums to 1");

  assert(pow[0] > mult[0], `power favourite prob (${pow[0].toFixed(4)}) > multiplicative (${mult[0].toFixed(4)}) — naive understates favourites`);
  assert(shn[0] > mult[0], `shin favourite prob (${shn[0].toFixed(4)}) > multiplicative (${mult[0].toFixed(4)}) — naive understates favourites`);

  const all = devigAll(odds);
  assert(all.overroundPct > 5.5 && all.overroundPct < 6.5, `overround ~6.29% (got ${all.overroundPct.toFixed(2)}%)`);
  assert(all.maxSpreadPct >= 0, "maxSpreadPct is non-negative");
}

console.log("\n--- devig: no-vig market is a fixed point ---");
{
  const odds = [2.0, 2.0]; // exactly 100% implied, zero overround
  const all = devigAll(odds);
  assert(approx(all.overroundPct, 0, 1e-6), "zero overround detected");
  assert(approx(all.multiplicative[0], 0.5) && approx(all.power[0], 0.5) && approx(all.shin[0], 0.5), "all three methods agree with no vig to de-vig");
}

console.log("\n--- EV / Kelly ---");
{
  const ev = computeEV(0.55, 2.0);
  assert(approx(ev, 0.1), `EV = 0.55*2.0-1 = 0.10 (got ${ev})`);

  const noEdgeEv = computeEV(0.5, 2.0);
  assert(approx(noEdgeEv, 0), "fair-priced bet has EV = 0");

  const kf = kellyFraction(0.55, 2.0);
  // b=1, q=0.45 -> f=(0.55*1-0.45)/1=0.10
  assert(approx(kf, 0.1), `full Kelly fraction = 0.10 (got ${kf})`);
}

console.log("\n--- stats: verdict thresholds ---");
{
  const tiny = Array(30).fill(0.02);
  const v1 = stats.computeVerdict(tiny);
  assert(v1.type === "insufficient", "n < 100 -> insufficient verdict");

  const clearlyPositive = Array(200).fill(0.03); // zero variance, mean +3%
  const v2 = stats.computeVerdict(clearlyPositive);
  assert(v2.type === "positive", `tight positive sample -> positive verdict (got ${v2.type})`);

  const clearlyNegative = Array(200).fill(-0.03);
  const v3 = stats.computeVerdict(clearlyNegative);
  assert(v3.type === "negative", `tight negative sample -> negative verdict (got ${v3.type})`);
}

console.log("\n--- stats: bootstrap CI sanity ---");
{
  const rng = Array.from({ length: 500 }, (_, i) => (i % 2 === 0 ? 0.05 : -0.03));
  const ci = stats.bootstrapCI(rng);
  const m = stats.mean(rng);
  assert(ci.lo <= m && m <= ci.hi, "bootstrap CI brackets the sample mean");
}

console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
