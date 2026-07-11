// Statistics for the CLV verdict. Bootstrap-based — CLV distributions are
// skewed (long right tail from longshot misses/hits), so we never assume
// normality for the confidence interval.

function mean(arr) {
  if (arr.length === 0) return null;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

function sampleStdDev(arr) {
  if (arr.length < 2) return null;
  const m = mean(arr);
  const sumSq = arr.reduce((a, x) => a + (x - m) * (x - m), 0);
  return Math.sqrt(sumSq / (arr.length - 1));
}

function standardError(arr) {
  const sd = sampleStdDev(arr);
  if (sd === null) return null;
  return sd / Math.sqrt(arr.length);
}

function tStat(arr) {
  const m = mean(arr);
  const se = standardError(arr);
  if (m === null || !se) return null;
  return m / se;
}

// Percentile bootstrap, 10,000 resamples by default.
function bootstrapCI(arr, resamples = 10000, alpha = 0.05) {
  if (arr.length === 0) return null;
  const n = arr.length;
  const means = new Array(resamples);
  for (let i = 0; i < resamples; i++) {
    let sum = 0;
    for (let j = 0; j < n; j++) {
      sum += arr[Math.floor(Math.random() * n)];
    }
    means[i] = sum / n;
  }
  means.sort((a, b) => a - b);
  const loIdx = Math.floor((alpha / 2) * resamples);
  const hiIdx = Math.min(Math.floor((1 - alpha / 2) * resamples), resamples - 1);
  return { lo: means[loIdx], hi: means[hiIdx] };
}

function formatSignedPct(fraction, decimals = 1) {
  const pct = fraction * 100;
  const sign = pct >= 0 ? "+" : "";
  return `${sign}${pct.toFixed(decimals)}%`;
}

const MIN_N_FOR_VERDICT = 100;

// clvValues: array of CLV fractions (e.g. 0.018 = +1.8%) from graded,
// non-unresolvable, non-void bets. Returns the single verdict shown on the
// home screen — exactly one of four outcomes, plain English, no hedging.
function computeVerdict(clvValues) {
  const n = clvValues.length;

  if (n < MIN_N_FOR_VERDICT) {
    return {
      type: "insufficient",
      n,
      mean: n > 0 ? mean(clvValues) : null,
      ci: null,
      text: `n = ${n}. Too early. Need ~100 graded bets before this means anything.`,
    };
  }

  const m = mean(clvValues);
  const ci = bootstrapCI(clvValues);

  const meanStr = formatSignedPct(m);
  const ciLoStr = formatSignedPct(ci.lo);
  const ciHiStr = formatSignedPct(ci.hi);
  const ciClause = `(95% CI: ${ciLoStr} to ${ciHiStr}, n=${n})`;

  if (ci.lo > 0 && ci.hi > 0) {
    return {
      type: "positive",
      n,
      mean: m,
      ci,
      text: `Mean CLV ${meanStr} ${ciClause}. CI excludes zero. This is evidence of a real edge.`,
    };
  }

  if (ci.lo < 0 && ci.hi < 0) {
    return {
      type: "negative",
      n,
      mean: m,
      ci,
      text: `Mean CLV ${meanStr} ${ciClause}. CI excludes zero. You are systematically buying worse-than-fair prices. Stop.`,
    };
  }

  return {
    type: "inconclusive",
    n,
    mean: m,
    ci,
    text: `Mean CLV ${meanStr} ${ciClause}. CI includes zero. No evidence of edge. This is indistinguishable from luck.`,
  };
}

// Groups `rows` by keyFn(row) and computes CLV stats per group using
// valueFn(row) as the CLV fraction. Used for the odds-band / market / book /
// league / time-before-kickoff segmentation tables.
function groupStats(rows, keyFn, valueFn) {
  const groups = new Map();
  for (const row of rows) {
    const key = keyFn(row);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(valueFn(row));
  }
  const result = [];
  for (const [key, values] of groups) {
    result.push({
      key,
      n: values.length,
      mean: mean(values),
      sd: sampleStdDev(values),
      se: standardError(values),
    });
  }
  return result;
}

function oddsBand(decimalOdds) {
  if (decimalOdds < 1.1) return "1.01–1.10";
  if (decimalOdds < 1.5) return "1.10–1.50";
  if (decimalOdds < 2.5) return "1.50–2.50";
  return "2.50+";
}

function minutesBeforeKickoffBucket(minutes) {
  if (minutes < 15) return "<15m";
  if (minutes < 60) return "15–60m";
  if (minutes < 360) return "1–6h";
  if (minutes < 1440) return "6–24h";
  return "24h+";
}

module.exports = {
  mean,
  sampleStdDev,
  standardError,
  tStat,
  bootstrapCI,
  formatSignedPct,
  computeVerdict,
  groupStats,
  oddsBand,
  minutesBeforeKickoffBucket,
  MIN_N_FOR_VERDICT,
};
