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

// VAT inside a VAT-inclusive price (UK: 20% -> 1/6 of the price).
function vatIncluded(gross, vat = config.VAT) {
  return vat && vat.REGISTERED ? round2((gross * vat.RATE_PCT) / (100 + vat.RATE_PCT)) : 0;
}

// Unit economics for one unit sold at `retail` (VAT-inclusive shelf price)
// with the given landed cost (supplier product cost + shipping to customer).
// When VAT-registered, the VAT slice is HMRC's, so profit and margin are
// computed on the net price. The card fee is charged on the full amount.
function unitEconomics(retail, landedCost, p = config.PRICING, vat = config.VAT) {
  const fee = paymentFee(retail, p);
  const vatAmount = vatIncluded(retail, vat);
  const net = round2(retail - vatAmount);
  const grossProfit = round2(net - landedCost - fee);
  const grossMarginPct = net > 0 ? round2((grossProfit / net) * 100) : 0;
  // Break-even return-on-ad-spend: the ROAS at which ad spend eats the
  // entire gross profit. Anything below this on a paid channel loses money.
  const breakEvenRoas = grossProfit > 0 ? round2(retail / grossProfit) : null;
  return { retail, landedCost: round2(landedCost), fee, vat: vatAmount, grossProfit, grossMarginPct, breakEvenRoas };
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

// Which variants of a product to list, and at what single price.
// variants: [{ variantId, price, stock }] (price = supplier unit cost)
// Returns { variants, pricing } or null if nothing passes.
function planVariants(variants, shippingCost, cfg = config) {
  const inStock = variants.filter((v) => v.stock >= cfg.MIN_VARIANT_STOCK).sort((a, b) => a.price - b.price);
  if (!inStock.length) return null;
  const ceiling = inStock[0].price * (1 + cfg.VARIANTS.MAX_PRICE_SPREAD_PCT / 100);
  let chosen = inStock.filter((v) => v.price <= ceiling).slice(0, cfg.VARIANTS.MAX_PER_PRODUCT);
  // Price on the most expensive included variant; drop the priciest until
  // the guardrails pass.
  while (chosen.length) {
    const maxCost = chosen[chosen.length - 1].price;
    const pricing = priceProduct({ productCost: maxCost, shippingCost }, cfg.PRICING);
    if (pricing.ok) return { variants: chosen, pricing };
    chosen = chosen.slice(0, -1);
  }
  return null;
}

// Quantity-break tiers a product can safely offer, given its landed cost.
function allowedQtyDiscounts(price, landedCost, p = config.PRICING) {
  return p.QTY_DISCOUNTS.filter((t) => {
    const unit = round2(price * (1 - t.pct / 100));
    return unitEconomics(unit, landedCost, p).grossMarginPct >= p.QTY_DISCOUNT_MIN_MARGIN_PCT;
  });
}

// Unit price for a cart line of `qty` units (best allowed tier applies).
function unitPriceForQty(price, landedCost, qty, p = config.PRICING) {
  const tier = allowedQtyDiscounts(price, landedCost, p)
    .filter((t) => qty >= t.minQty)
    .sort((a, b) => b.pct - a.pct)[0];
  return tier ? round2(price * (1 - tier.pct / 100)) : round2(Number(price));
}

function toCents(amount) {
  return Math.round(Number(amount) * 100);
}

module.exports = {
  round2,
  charmRound,
  paymentFee,
  unitEconomics,
  vatIncluded,
  priceProduct,
  needsReprice,
  planVariants,
  allowedQtyDiscounts,
  unitPriceForQty,
  toCents,
};
