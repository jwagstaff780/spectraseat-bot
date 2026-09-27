#!/usr/bin/env node
// Offline regression tests for the money paths: pricing guardrails, cart
// validation, Stripe webhook signatures, Stripe form encoding, checkout
// session parsing and supplier payload parsing. No network, no DB.
// Run with `npm run selftest`.

const crypto = require("crypto");
const { charmRound, priceProduct, unitEconomics, needsReprice, paymentFee } = require("../lib/pricing");
const { validateCart } = require("../lib/cart");
const { verifyWebhook, formEncode } = require("../lib/stripe");
const { extractShipping, parseCartMetadata } = require("../lib/fulfilment");
const cj = require("../lib/supplier/cj");
const { slugify } = require("../lib/sourcing");
const { publicProduct } = require("../lib/http");
const { fallbackCopy } = require("../lib/copywriter");
const config = require("../lib/config");

let failures = 0;
function assert(cond, msg) {
  if (!cond) {
    failures++;
    console.error(`FAIL: ${msg}`);
  } else console.log(`ok: ${msg}`);
}
const approx = (a, b, tol = 0.005) => Math.abs(a - b) < tol;

console.log("--- pricing ---");
assert(charmRound(23.1) === 23.99, "charmRound 23.10 -> 23.99");
assert(charmRound(23.99) === 23.99, "charmRound keeps 23.99");
assert(charmRound(24.0) === 24.99, "charmRound 24.00 -> 24.99");
assert(approx(paymentFee(100), 3.2), "Stripe fee on $100 is $3.20");
{
  const r = priceProduct({ productCost: 6, shippingCost: 4 });
  assert(r.ok, `$10 landed item passes guardrails (${r.reasons})`);
  assert(r.retail === 28.99, `$10 landed -> $28.99 retail (got ${r.retail})`);
  assert(r.economics.grossMarginPct >= config.PRICING.MIN_GROSS_MARGIN_PCT, "margin above floor");
  assert(r.compareAt > r.retail, "compare-at above retail");
  const e = unitEconomics(r.retail, 10);
  assert(approx(e.grossProfit, 28.99 - 10 - paymentFee(28.99)), "gross profit = retail - landed - fee");
  assert(e.breakEvenRoas > 1, "break-even ROAS computed");
}
{
  const r = priceProduct({ productCost: 1, shippingCost: 1 });
  assert(r.retail === config.PRICING.MIN_RETAIL, "cheap items lifted to MIN_RETAIL");
}
{
  const r = priceProduct({ productCost: 30, shippingCost: 10 });
  assert(!r.ok && r.reasons.some((x) => x.includes("MAX_RETAIL")), "expensive items rejected by MAX_RETAIL");
}
{
  const tight = { ...config.PRICING, MARKUP_MULTIPLIER: 1.3 };
  const r = priceProduct({ productCost: 8, shippingCost: 4 }, tight);
  assert(!r.ok && r.reasons.some((x) => x.includes("margin")), "thin-margin items rejected");
}
assert(!priceProduct({ productCost: 0, shippingCost: 0 }).ok, "zero landed cost rejected");
assert(needsReprice(10, 10.6) && !needsReprice(10, 10.4), "reprice only on >5% drift");

console.log("\n--- cart ---");
{
  const products = [
    { id: "1", status: "active", in_stock: true, price: "19.99" },
    { id: "2", status: "paused", in_stock: true, price: "9.99" },
    { id: "3", status: "active", in_stock: false, price: "9.99" },
  ];
  const ok = validateCart([{ productId: 1, quantity: 2 }, { productId: 1, quantity: 1 }], products);
  assert(ok.ok && ok.lines.length === 1 && ok.lines[0].quantity === 3, "duplicate lines merged");
  assert(ok.subtotal === 59.97 && ok.lines[0].unitPriceCents === 1999, "subtotal/cents from DB price");
  assert(!validateCart([{ productId: 2, quantity: 1 }], products).ok, "paused product rejected");
  assert(!validateCart([{ productId: 3, quantity: 1 }], products).ok, "out-of-stock product rejected");
  assert(!validateCart([{ productId: 9, quantity: 1 }], products).ok, "unknown product rejected");
  assert(!validateCart([{ productId: 1, quantity: 0 }], products).ok, "zero quantity rejected");
  assert(!validateCart([{ productId: 1, quantity: 1.5 }], products).ok, "fractional quantity rejected");
  assert(!validateCart([{ productId: 1, quantity: 11 }], products).ok, "quantity cap enforced");
  assert(!validateCart([], products).ok, "empty cart rejected");
  const spoof = validateCart([{ productId: 1, quantity: 1, price: 0.01, unitPrice: 0.01 }], products);
  assert(spoof.ok && spoof.lines[0].unitPrice === 19.99, "client-supplied price ignored");
}

console.log("\n--- stripe webhook signature ---");
{
  const secret = "whsec_test";
  const body = JSON.stringify({ id: "evt_1", type: "checkout.session.completed" });
  const t = 1_700_000_000;
  const sig = crypto.createHmac("sha256", secret).update(`${t}.${body}`).digest("hex");
  assert(verifyWebhook(body, `t=${t},v1=${sig}`, secret, 300, t + 10), "valid signature accepted");
  assert(verifyWebhook(body, `t=${t},v1=deadbeef,v1=${sig}`, secret, 300, t), "any matching v1 accepted");
  assert(!verifyWebhook(body + " ", `t=${t},v1=${sig}`, secret, 300, t), "tampered body rejected");
  assert(!verifyWebhook(body, `t=${t},v1=${sig}`, "whsec_other", 300, t), "wrong secret rejected");
  assert(!verifyWebhook(body, `t=${t},v1=${sig}`, secret, 300, t + 301), "stale timestamp rejected");
  assert(!verifyWebhook(body, undefined, secret), "missing header rejected");
}

console.log("\n--- stripe form encoding ---");
{
  const s = decodeURIComponent(
    formEncode({ mode: "payment", line_items: [{ quantity: 2, price_data: { unit_amount: 1999 } }], x: undefined })
  );
  assert(s === "mode=payment&line_items[0][quantity]=2&line_items[0][price_data][unit_amount]=1999", `nested encoding (${s})`);
}

console.log("\n--- checkout session parsing ---");
{
  const newShape = {
    customer_details: { email: "a@b.co", name: "Card Name", phone: "+1555" },
    collected_information: { shipping_details: { name: "Ship Name", address: { line1: "1 Main", city: "X", country: "US", postal_code: "10001" } } },
    metadata: { cart: "[[5,2,2499]]" },
  };
  const s = extractShipping(newShape);
  assert(s.name === "Ship Name" && s.address.country === "US" && s.address.phone === "+1555", "new-API shipping shape");
  const legacy = extractShipping({ customer_details: { email: "a@b.co" }, shipping_details: { name: "L", address: { country: "GB" } } });
  assert(legacy.name === "L" && legacy.address.country === "GB", "legacy shipping shape");
  const cart = parseCartMetadata(newShape);
  assert(cart[0].productId === 5 && cart[0].quantity === 2 && cart[0].unitPrice === 24.99, "cart metadata parsed");
  let threw = false;
  try {
    parseCartMetadata({ metadata: {} });
  } catch {
    threw = true;
  }
  assert(threw, "missing cart metadata throws");
}

console.log("\n--- supplier parsing ---");
{
  assert(JSON.stringify(cj._parseAging("7-15")) === '{"min":7,"max":15}', "aging range");
  assert(JSON.stringify(cj._parseAging("12")) === '{"min":12,"max":12}', "aging single");
  assert(cj._parseAging("").max === null, "aging missing");
  assert(cj._parseImages('["a","b"]').length === 2, "images JSON string");
  assert(cj._parseImages(["a", ""]).length === 1, "images array");
  assert(cj._parseImages("a, b").length === 2, "images CSV");
}

console.log("\n--- misc ---");
assert(slugify("  Ergonomic Seat — Cushion!! ") === "ergonomic-seat-cushion", "slugify");
{
  const pub = publicProduct({
    id: "7", slug: "s", title: "T", description: "D", bullets: [], images: [], price: "19.99",
    compare_at_price: null, shipping_days_min: 7, shipping_days_max: 12, landed_cost: "5", supplier_variant_id: "secret",
  });
  assert(!("landed_cost" in pub) && !("supplier_variant_id" in pub) && !JSON.stringify(pub).includes("secret"), "public product hides cost/supplier");
  assert(pub.deliveryDays.max === 12 + config.SHIPPING_PROMISE_BUFFER_DAYS, "delivery promise includes buffer");
}
{
  const c = fallbackCopy({ title: "x".repeat(200), description: "desc" });
  assert(c.title.length === 70 && c.description === "desc", "fallback copy trims title");
}

console.log(failures ? `\n${failures} FAILED` : "\nall passed");
process.exit(failures ? 1 : 0);
