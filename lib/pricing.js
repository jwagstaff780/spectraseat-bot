// Pure pricing + unit-economics math. No I/O, fully covered by
// scripts/selftest.js. Every product the store sells goes through
// priceProduct(); anything that fails a guardrail is never listed.

const config = require("./config");

function round2(n) {
  return Math.round(n * 100) / 100;
}

// Charm pricing: round up to the next x.99 (e.g. 23.10 -> 23.99).
function charmRound(n) {
  const whole = Math.floor(n);
  const candidate = whole + 0.99;
  return round2(candidate >= n ? candidate : candidate + 1);
}

function paymentFee(retail, p = config.PRICING) {
  return round2(retail * (p.PAYMENT_FEE_PCT / 100) + p.PAYMENT_FEE_FIXED);
}

// Unit economics for one unit sold at `retail` with the given landed cost
// (supplier product cost + shipping to customer).
function unitEconomics(retail, landedCost, p = config.PRICING) {
  const fee = paymentFee(retail, p);
  const grossProfit = round2(retail - landedCost - fee);
  const grossMarginPct = retail > 0 ? round2((grossProfit / retail) * 100) : 0;
  // Break-even return-on-ad-spend: the ROAS at which ad spend eats the
  // entire gross profit. Anything below this on a paid channel loses money.
  const breakEvenRoas = grossProfit > 0 ? round2(retail / grossProfit) : null;
  return { retail, landedCost: round2(landedCost), fee, grossProfit, grossMarginPct, breakEvenRoas };
}

// Returns { ok, retail, compareAt, economics, reasons[] }.
function priceProduct({ productCost, shippingCost }, p = config.PRICING) {
  const reasons = [];
  const landed = round2(Number(productCost) + Number(shippingCost));
  if (!(landed > 0)) {
    return { ok: false, reasons: ["landed cost unknown or zero"] };
  }

  let retail = charmRound(landed * p.MARKUP_MULTIPLIER);
  if (retail < p.MIN_RETAIL) retail = p.MIN_RETAIL;

  const economics = unitEconomics(retail, landed, p);

  if (retail > p.MAX_RETAIL) reasons.push(`retail ${retail} above MAX_RETAIL ${p.MAX_RETAIL}`);
  if (economics.grossMarginPct < p.MIN_GROSS_MARGIN_PCT)
    reasons.push(`margin ${economics.grossMarginPct}% below ${p.MIN_GROSS_MARGIN_PCT}%`);
  if (economics.grossProfit < p.MIN_GROSS_PROFIT)
    reasons.push(`profit ${economics.grossProfit} below ${p.MIN_GROSS_PROFIT}`);

  const compareAt = charmRound(retail * p.COMPARE_AT_MULTIPLIER);

  return { ok: reasons.length === 0, retail, compareAt, economics, reasons };
}

// Has supplier cost moved enough that the listed price should change?
function needsReprice(oldLanded, newLanded, p = config.PRICING) {
  if (!(oldLanded > 0)) return true;
  return (Math.abs(newLanded - oldLanded) / oldLanded) * 100 > p.REPRICE_DRIFT_PCT;
}

function toCents(amount) {
  return Math.round(Number(amount) * 100);
}

module.exports = { round2, charmRound, paymentFee, unitEconomics, priceProduct, needsReprice, toCents };
