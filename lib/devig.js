// De-vigging: convert raw bookmaker prices (which sum to > 100% implied
// probability because of the vig) into a fair probability distribution.
//
// Three methods, all operating on an array of decimal odds for a single
// two-way (or n-way) market:
//   - multiplicative: naive proportional scaling. Verified to systematically
//     UNDERSTATE heavy favourites relative to power/Shin (matches the
//     documented favourite-longshot bias — Ali 1977, Shin 1992/1993) —
//     never use as the default. See scripts/selftest.js for the check.
//   - power: solves for exponent k such that sum(p_i^k) = 1. Default method.
//   - shin: solves for insider-trading fraction z (Shin, 1992/1993).

function impliedProbs(decimalOdds) {
  return decimalOdds.map((o) => 1 / o);
}

function overroundPct(decimalOdds) {
  const sum = impliedProbs(decimalOdds).reduce((a, b) => a + b, 0);
  return (sum - 1) * 100;
}

function multiplicative(decimalOdds) {
  const probs = impliedProbs(decimalOdds);
  const total = probs.reduce((a, b) => a + b, 0);
  return probs.map((p) => p / total);
}

function power(decimalOdds) {
  const probs = impliedProbs(decimalOdds);
  const total = probs.reduce((a, b) => a + b, 0);
  if (Math.abs(total - 1) < 1e-12) return probs.slice();

  let lo = 1;
  let hi = 1;
  let sumAtHi = probs.reduce((a, p) => a + Math.pow(p, hi), 0);
  while (sumAtHi > 1 && hi < 200) {
    hi *= 2;
    sumAtHi = probs.reduce((a, p) => a + Math.pow(p, hi), 0);
  }

  for (let i = 0; i < 200; i++) {
    const mid = (lo + hi) / 2;
    const sum = probs.reduce((a, p) => a + Math.pow(p, mid), 0);
    if (sum > 1) lo = mid;
    else hi = mid;
  }

  const k = (lo + hi) / 2;
  return probs.map((p) => Math.pow(p, k));
}

function shin(decimalOdds) {
  const probs = impliedProbs(decimalOdds);
  const total = probs.reduce((a, b) => a + b, 0);
  if (Math.abs(total - 1) < 1e-12) return probs.slice();

  function sumAtZ(z) {
    return probs.reduce((acc, p) => {
      const val = (Math.sqrt(z * z + (4 * (1 - z) * p * p) / total) - z) / (2 * (1 - z));
      return acc + val;
    }, 0);
  }

  let lo = 0;
  let hi = 0.999999;

  for (let i = 0; i < 200; i++) {
    const mid = (lo + hi) / 2;
    const s = sumAtZ(mid);
    if (s > 1) lo = mid;
    else hi = mid;
  }

  const z = (lo + hi) / 2;
  return probs.map((p) => (Math.sqrt(z * z + (4 * (1 - z) * p * p) / total) - z) / (2 * (1 - z)));
}

// Runs all three methods and reports the max pairwise disagreement (in
// percentage points) across every outcome. Used by the main engine to grey
// out bets where the de-vig methods can't agree on a fair price.
function devigAll(decimalOdds) {
  const mult = multiplicative(decimalOdds);
  const pow = power(decimalOdds);
  const shn = shin(decimalOdds);

  let maxSpreadPct = 0;
  for (let i = 0; i < decimalOdds.length; i++) {
    const vals = [mult[i], pow[i], shn[i]];
    const spread = (Math.max(...vals) - Math.min(...vals)) * 100;
    if (spread > maxSpreadPct) maxSpreadPct = spread;
  }

  return {
    multiplicative: mult,
    power: pow,
    shin: shn,
    overroundPct: overroundPct(decimalOdds),
    maxSpreadPct,
    unresolvable: maxSpreadPct > 1.5,
  };
}

module.exports = { impliedProbs, overroundPct, multiplicative, power, shin, devigAll };
