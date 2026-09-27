// Imports products from catalogue-file suppliers (UK own-label supplements
// and health foods, see lib/supplier/emailDropship.js) into the store.
//
// Health products are always imported as DRAFTS: a person must check the
// listing and label before anything regulated goes on sale. Each product gets:
//  - price from the usual guardrails (VAT-aware, UK shipping cost included)
//  - the authorised GB health claims it qualifies for (from its ingredient
//    amounts) and nothing else — copy that fails the checker is replaced
//  - mandatory supplement warnings + ingredient-specific warnings
// Re-running updates costs, stock and legal info without touching copy.

const config = require("./config");
const db = require("./db");
const { catalogueSuppliers } = require("./supplier");
const { planVariants, round2 } = require("./pricing");
const { writeCopy } = require("./copywriter");
const { allowedClaims, warningsFor } = require("./compliance/claims");
const { slugify } = require("./sourcing");

async function importSupplier(supplier, summary) {
  const cat = supplier.catalogue();
  for (const item of cat.products || []) {
    try {
      const product = await supplier.getProduct(item.sku);
      const variants = [];
      for (const v of product.variants) variants.push({ ...v, stock: await supplier.getStock(v.variantId) });
      const quote = await supplier.quoteShipping(item.sku, config.PRIMARY_MARKET, config.MAX_SHIPPING_DAYS);
      if (!quote) {
        summary.rejected.push({ sku: item.sku, reason: "no UK shipping quote" });
        continue;
      }
      const plan = planVariants(variants, quote.cost);
      if (!plan) {
        summary.rejected.push({ sku: item.sku, reason: "margin guardrails or out of stock" });
        continue;
      }
      const health = {
        product_type: item.type === "food" ? "food" : "supplement",
        ingredients: item.ingredients || [],
        net_quantity: item.net_quantity || null,
      };
      health.allowedClaims = allowedClaims(health);
      const warnings = warningsFor({ ...health, warnings: item.warnings || [] });
      const { pricing } = plan;

      const { rows: existing } = await db.query(`SELECT id FROM products WHERE supplier = $1 AND supplier_product_id = $2`, [supplier.name, item.sku]);
      if (existing[0]) {
        // Refresh costs/prices/legal info; keep human-reviewed copy.
        await db.query(
          `UPDATE products SET product_cost=$2, shipping_cost=$3, landed_cost=$4, price=$5, compare_at_price=NULL,
             ingredients=$6, ingredients_text=$7, allergens=$8, directions=$9, warnings=$10, net_quantity=$11,
             shipping_method=$12, shipping_days_min=$13, shipping_days_max=$14, in_stock=TRUE, last_synced_at=now(), updated_at=now()
           WHERE id=$1`,
          [existing[0].id, plan.variants.at(-1).price, quote.cost, pricing.economics.landedCost, pricing.retail,
           JSON.stringify(health.ingredients), item.ingredients_text || null, item.allergens || [], item.directions || null, warnings,
           health.net_quantity, quote.method, quote.days.min, quote.days.max]
        );
        summary.updated++;
        continue;
      }

      const copy = await writeCopy(product, plan.variants[0], health);
      await db.tx(async (client) => {
        const { rows } = await client.query(
          `INSERT INTO products (slug, supplier, supplier_product_id, supplier_variant_id, supplier_sku, source_keyword, product_type,
             title, description, bullets, seo_description, images,
             product_cost, shipping_cost, landed_cost, price, compare_at_price,
             shipping_method, shipping_days_min, shipping_days_max, ship_from, status, last_synced_at,
             ingredients, ingredients_text, allergens, directions, warnings, net_quantity)
           VALUES ($1,$2,$3,$4,$3,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,NULL,$16,$17,$18,'GB','draft',now(),$19,$20,$21,$22,$23,$24)
           RETURNING id`,
          [
            `${slugify(copy.title)}-${slugify(item.sku).slice(-8)}`, supplier.name, item.sku, plan.variants[0].variantId,
            health.product_type === "food" ? "sports nutrition" : "supplements", health.product_type,
            copy.title, copy.description, copy.bullets, copy.seo_description, product.images.slice(0, 8),
            plan.variants.at(-1).price, quote.cost, pricing.economics.landedCost, pricing.retail,
            quote.method, quote.days.min, quote.days.max,
            JSON.stringify(health.ingredients), item.ingredients_text || null, item.allergens || [], item.directions || null, warnings, health.net_quantity,
          ]
        );
        for (const [i, v] of plan.variants.entries()) {
          await client.query(
            `INSERT INTO product_variants (product_id, supplier_variant_id, name, image, product_cost, landed_cost, position)
             VALUES ($1,$2,$3,$4,$5,$6,$7)`,
            [rows[0].id, v.variantId, v.name || "", v.image || null, v.price, round2(v.price + quote.cost), i]
          );
        }
      });
      summary.imported.push({ sku: item.sku, title: copy.title, price: pricing.retail, claims: health.allowedClaims.length });
    } catch (err) {
      summary.errors.push(`${supplier.name}/${item.sku}: ${err.message}`);
    }
  }
}

async function runCatalogueImport() {
  const summary = { imported: [], updated: 0, rejected: [], errors: [] };
  for (const s of catalogueSuppliers()) await importSupplier(s, summary);
  return summary;
}

module.exports = { runCatalogueImport };
