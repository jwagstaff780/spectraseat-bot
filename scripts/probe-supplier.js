#!/usr/bin/env node
// Read-only live check of the CJ API: auth, search, product detail, stock
// and a freight quote for the first result. Verifies the field mapping in
// lib/supplier/cj.js against real data before you trust the automation.
// Usage: CJ_API_KEY=... node scripts/probe-supplier.js "seat cushion"

const config = require("../lib/config");
const { getSupplier } = require("../lib/supplier");
const { priceProduct } = require("../lib/pricing");

(async () => {
  const keyword = process.argv[2] || config.NICHE_KEYWORDS[0];
  const supplier = getSupplier();
  console.log(`Searching '${keyword}'…`);
  const results = await supplier.searchProducts(keyword, 5);
  console.table(results.map((r) => ({ id: r.productId, price: r.price, title: String(r.title).slice(0, 60) })));
  if (!results.length) return;

  const product = await supplier.getProduct(results[0].productId);
  console.log(`\nProduct ${product.productId}: ${product.title}`);
  console.log(`  images: ${product.images.length}, variants: ${product.variants.length}`);
  const v = product.variants[0];
  if (!v) return console.log("  no variants returned — check field mapping");
  console.log(`  first variant ${v.variantId} '${v.name}' @ ${v.price}`);

  console.log(`  stock: ${await supplier.getStock(v.variantId)}`);
  const quote = await supplier.quoteShipping(v.variantId, config.PRIMARY_MARKET, config.MAX_SHIPPING_DAYS);
  console.log(`  cheapest shipping ≤${config.MAX_SHIPPING_DAYS}d to ${config.PRIMARY_MARKET}:`, quote);
  if (quote) {
    const pricing = priceProduct({ productCost: v.price, shippingCost: quote.cost });
    console.log("  pricing verdict:", pricing);
  }
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
