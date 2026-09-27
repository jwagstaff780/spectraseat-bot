// Automated product research + import, and catalogue upkeep.
//
// runSourcing(): for each niche keyword, pull candidates from every healthy
// supplier. A product is listed only if it has in-stock variants, ships
// within MAX_SHIPPING_DAYS, clears every margin guardrail, AND passes the
// AI product scout (appeal, shipping/return risk, trademark and regulated-
// goods screening, clean photos). Claude then writes on-brand copy.
//
// syncCatalog(): re-check every listed product's variants, stock, supplier
// cost and shipping quote. Reprice on cost drift, pause anything that stops
// passing the guardrails, resume it when it passes again.

const config = require("./config");
const db = require("./db");
const { getSupplier, enabledSuppliers } = require("./supplier");
const { importSupplierReviews } = require("./reviews");
const { priceProduct, needsReprice, planVariants, round2 } = require("./pricing");
const { writeCopy } = require("./copywriter");
const { scout } = require("./agents/productScout");

function slugify(s) {
  return String(s)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 60);
}

// Supplier scorecard from our own order history. A supplier that cancels
// or fails too often is dropped from sourcing automatically.
async function supplierHealth() {
  const { rows } = await db.query(
    `SELECT supplier,
            count(*)::int AS orders,
            count(*) FILTER (WHERE status_reason ILIKE '%supplier cancelled%' OR status_reason ILIKE '%failed repeatedly%')::int AS failures,
            avg(EXTRACT(EPOCH FROM (shipped_at - placed_at)) / 86400) FILTER (WHERE shipped_at IS NOT NULL)::float AS avg_days_to_ship
     FROM orders WHERE supplier IS NOT NULL AND created_at > now() - interval '90 days' GROUP BY supplier`
  );
  return Object.fromEntries(
    rows.map((r) => [r.supplier, { ...r, failureRatePct: r.orders ? (r.failures / r.orders) * 100 : 0 }])
  );
}

function supplierIsHealthy(h) {
  return !h || h.orders < 10 || h.failureRatePct <= config.MAX_SUPPLIER_FAILURE_RATE_PCT;
}

async function importCandidate(supplier, keyword, productId, summary) {
  const product = await supplier.getProduct(productId);
  const reject = (reason) => {
    summary.rejected++;
    summary.rejections = summary.rejections || {};
    summary.rejections[reason] = (summary.rejections[reason] || 0) + 1;
    return false;
  };
  const candidates = [...product.variants].sort((a, b) => a.price - b.price).slice(0, config.VARIANTS.MAX_PER_PRODUCT + 4);
  if (!candidates.length) return reject("no variants");

  // Variants of one listing share a weight class: one shipping quote.
  const quote = await supplier.quoteShipping(candidates[0].variantId, config.PRIMARY_MARKET, config.MAX_SHIPPING_DAYS);
  if (!quote) return reject("shipping too slow");
  for (const v of candidates) v.stock = await supplier.getStock(v.variantId);
  const plan = planVariants(candidates, quote.cost);
  if (!plan) return reject("stock or margin");

  const verdict = await scout(
    { ...product, images: [...product.images, ...plan.variants.map((v) => v.image)].filter(Boolean) },
    plan.pricing.retail
  );
  if (!verdict.ok) return reject(`scout: ${verdict.reasons[0] || "rejected"}`);

  const { pricing } = plan;
  const copy = await writeCopy(product, plan.variants[0]);
  const clean = new Set(verdict.images);
  const images = verdict.images.slice(0, 8);
  const status = config.AUTO_PUBLISH ? "active" : "draft";

  const inserted = await db.tx(async (client) => {
    const { rows } = await client.query(
      `INSERT INTO products (slug, supplier, supplier_product_id, supplier_variant_id, source_keyword,
         title, description, bullets, seo_description, images,
         product_cost, shipping_cost, landed_cost, price, compare_at_price,
         shipping_method, shipping_days_min, shipping_days_max, ship_from, status, last_synced_at,
         scout_score, scout_summary)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20, now(), $21, $22)
       ON CONFLICT (supplier, supplier_variant_id) DO NOTHING
       RETURNING id, title, price`,
      [
        `${slugify(copy.title)}-${String(product.productId).slice(-6).toLowerCase()}`,
        supplier.name,
        product.productId,
        plan.variants[0].variantId,
        keyword,
        copy.title,
        copy.description,
        copy.bullets,
        copy.seo_description,
        images,
        plan.variants[plan.variants.length - 1].price,
        quote.cost,
        pricing.economics.landedCost,
        pricing.retail,
        pricing.compareAt,
        quote.method,
        quote.days.min,
        quote.days.max,
        quote.origin || "CN",
        status,
        verdict.score,
        verdict.summary,
      ]
    );
    if (!rows[0]) return null;
    for (const [i, v] of plan.variants.entries()) {
      await client.query(
        `INSERT INTO product_variants (product_id, supplier_variant_id, name, image, product_cost, landed_cost, position)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        // A variant photo is used only if the scout judged it clean.
        [rows[0].id, v.variantId, v.name || "", clean.has(v.image) ? v.image : null, v.price, round2(v.price + quote.cost), i]
      );
    }
    return rows[0];
  });
  if (!inserted) return false;

  let reviews = 0;
  try {
    reviews = await importSupplierReviews(supplier, inserted.id, product.productId);
  } catch (err) {
    summary.errors.push(`reviews ${product.productId}: ${err.message}`);
  }
  summary.imported.push({
    ...inserted,
    supplier: supplier.name,
    status,
    margin: pricing.economics.grossMarginPct,
    variants: plan.variants.length,
    scoutScore: verdict.score,
    shipFrom: quote.origin || "CN",
    supplierReviews: reviews,
  });
  return true;
}

async function runSourcing() {
  const summary = { scanned: 0, imported: [], rejected: 0, skippedExisting: 0, skippedSuppliers: [], errors: [] };

  const { rows: countRows } = await db.query(`SELECT count(*)::int AS n FROM products WHERE status IN ('active','draft')`);
  let room = Math.min(config.MAX_NEW_PRODUCTS_PER_RUN, config.MAX_ACTIVE_PRODUCTS - countRows[0].n);
  if (room <= 0) return { ...summary, note: "catalogue full" };

  const health = await supplierHealth();
  const suppliers = enabledSuppliers().filter((sup) => {
    if (supplierIsHealthy(health[sup.name])) return true;
    summary.skippedSuppliers.push(sup.name);
    return false;
  });

  const { rows: existing } = await db.query(`SELECT supplier, supplier_product_id FROM products`);
  const known = new Set(existing.map((r) => `${r.supplier}:${r.supplier_product_id}`));

  for (const keyword of config.NICHE_KEYWORDS) {
    for (const supplier of suppliers) {
      if (room <= 0) return summary;
      let candidates;
      try {
        candidates = await supplier.searchProducts(keyword, config.SOURCING_RESULTS_PER_KEYWORD);
      } catch (err) {
        summary.errors.push(`${supplier.name}/${keyword}: ${err.message}`);
        continue;
      }
      for (const c of candidates) {
        if (room <= 0) return summary;
        summary.scanned++;
        const key = `${supplier.name}:${c.productId}`;
        if (known.has(key)) {
          summary.skippedExisting++;
          continue;
        }
        known.add(key);
        try {
          if (await importCandidate(supplier, keyword, c.productId, summary)) room--;
        } catch (err) {
          summary.errors.push(`${supplier.name}/${c.productId}: ${err.message}`);
        }
      }
    }
  }
  return summary;
}

async function pauseProduct(p, reason, inStock) {
  if (p.status === "active") {
    await db.query(
      `UPDATE products SET status='paused', status_reason=$2, in_stock=$3, updated_at=now(), last_synced_at=now() WHERE id=$1`,
      [p.id, reason, inStock]
    );
    return true;
  }
  // Keep a human's 'manual' pause marker so it's never auto-resumed.
  await db.query(
    `UPDATE products SET status_reason = CASE WHEN status_reason LIKE 'manual%' THEN status_reason ELSE $2 END,
       in_stock = $3, last_synced_at = now() WHERE id = $1`,
    [p.id, reason, inStock]
  );
  return false;
}

async function syncCatalog() {
  const { rows: products } = await db.query(
    `SELECT * FROM products WHERE status IN ('active','paused','draft')
     ORDER BY last_synced_at NULLS FIRST LIMIT 25`
  );
  const summary = { checked: 0, repriced: 0, paused: 0, resumed: 0, errors: [] };

  for (const p of products) {
    summary.checked++;
    try {
      const supplier = getSupplier(p.supplier);
      const detail = await supplier.getProduct(p.supplier_product_id);
      const byId = new Map(detail.variants.map((v) => [String(v.variantId), v]));
      const { rows: ours } = await db.query(`SELECT * FROM product_variants WHERE product_id = $1 ORDER BY position`, [p.id]);

      const live = [];
      for (const ov of ours) {
        const sv = byId.get(String(ov.supplier_variant_id));
        const stock = sv ? await supplier.getStock(sv.variantId) : 0;
        live.push({ ov, price: sv ? sv.price : null, inStock: Boolean(sv) && stock >= config.MIN_VARIANT_STOCK });
      }
      const sellable = live.filter((l) => l.inStock);
      if (!sellable.length) {
        await db.query(`UPDATE product_variants SET in_stock = FALSE WHERE product_id = $1`, [p.id]);
        if (await pauseProduct(p, "all variants out of stock", false)) summary.paused++;
        continue;
      }

      const quote = await supplier.quoteShipping(sellable[0].ov.supplier_variant_id, config.PRIMARY_MARKET, config.MAX_SHIPPING_DAYS);
      if (!quote) {
        if (await pauseProduct(p, `no shipping option within ${config.MAX_SHIPPING_DAYS} days`, true)) summary.paused++;
        continue;
      }
      const maxCost = Math.max(...sellable.map((l) => l.price));
      const pricing = priceProduct({ productCost: maxCost, shippingCost: quote.cost });
      if (!pricing.ok) {
        if (await pauseProduct(p, pricing.reasons.join("; "), true)) summary.paused++;
        continue;
      }

      for (const l of live) {
        await db.query(
          `UPDATE product_variants SET in_stock=$2, product_cost=coalesce($3, product_cost),
             landed_cost=coalesce($3 + $4, landed_cost) WHERE id=$1`,
          [l.ov.id, l.inStock, l.price, quote.cost]
        );
      }
      const reprice = needsReprice(Number(p.landed_cost), pricing.economics.landedCost);
      // Only auto-resume products the automation paused, never ones a human paused.
      const resume = p.status === "paused" && p.status_reason && !p.status_reason.startsWith("manual");
      await db.query(
        `UPDATE products SET
           product_cost=$2, shipping_cost=$3, landed_cost=$4,
           price=CASE WHEN $5 THEN $6 ELSE price END,
           compare_at_price=CASE WHEN $5 THEN $7 ELSE compare_at_price END,
           shipping_method=$8, shipping_days_min=$9, shipping_days_max=$10, ship_from=$12,
           in_stock=TRUE,
           status=CASE WHEN $11 THEN 'active' ELSE status END,
           status_reason=CASE WHEN $11 THEN NULL ELSE status_reason END,
           updated_at=now(), last_synced_at=now()
         WHERE id=$1`,
        [p.id, maxCost, quote.cost, pricing.economics.landedCost, reprice, pricing.retail, pricing.compareAt,
         quote.method, quote.days.min, quote.days.max, resume, quote.origin || "CN"]
      );
      if (reprice) summary.repriced++;
      if (resume) summary.resumed++;
      await importSupplierReviews(supplier, p.id, p.supplier_product_id).catch(() => 0);
    } catch (err) {
      summary.errors.push(`${p.id}: ${err.message}`);
    }
  }
  return summary;
}

module.exports = { runSourcing, syncCatalog, slugify, supplierHealth, supplierIsHealthy };
