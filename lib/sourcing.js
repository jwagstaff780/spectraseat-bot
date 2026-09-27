// Automated product research + import, and catalogue upkeep.
//
// runSourcing(): for each niche keyword, pull supplier candidates, keep only
// the ones that are in stock, ship within MAX_SHIPPING_DAYS and clear every
// margin guardrail, write on-brand copy with Claude, and import them.
//
// syncCatalog(): re-check every listed product's stock, supplier cost and
// shipping quote. Reprice on cost drift, pause anything that stops passing
// the guardrails, resume it when it passes again.

const config = require("./config");
const db = require("./db");
const { getSupplier, enabledSuppliers } = require("./supplier");
const { importSupplierReviews } = require("./reviews");
const { priceProduct, needsReprice } = require("./pricing");
const { writeCopy } = require("./copywriter");

const MIN_STOCK = 20;

function slugify(s) {
  return String(s)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 60);
}

// Evaluate one supplier variant against every guardrail. Pure apart from
// supplier calls. Returns { ok, reasons[], quote, pricing }.
async function evaluateVariant(supplier, variant) {
  const stock = await supplier.getStock(variant.variantId);
  if (stock < MIN_STOCK) return { ok: false, reasons: [`stock ${stock} < ${MIN_STOCK}`] };

  const quote = await supplier.quoteShipping(variant.variantId, config.PRIMARY_MARKET, config.MAX_SHIPPING_DAYS);
  if (!quote) return { ok: false, reasons: [`no shipping option within ${config.MAX_SHIPPING_DAYS} days`] };

  const pricing = priceProduct({ productCost: variant.price, shippingCost: quote.cost });
  return { ok: pricing.ok, reasons: pricing.reasons, quote, pricing, stock };
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
  // One listing per supplier product: pick the cheapest variant that
  // passes. (Multi-variant listings are a deliberate non-goal for now.)
  const variants = [...product.variants].sort((a, b) => a.price - b.price);
  let chosen = null;
  for (const v of variants.slice(0, 3)) {
    const verdict = await evaluateVariant(supplier, v);
    if (verdict.ok) {
      chosen = { variant: v, ...verdict };
      break;
    }
  }
  if (!chosen) {
    summary.rejected++;
    return false;
  }

  const copy = await writeCopy(product, chosen.variant);
  const images = [...new Set([chosen.variant.image, ...product.images].filter(Boolean))].slice(0, 8);
  const status = config.AUTO_PUBLISH ? "active" : "draft";
  const { quote, pricing } = chosen;

  const { rows } = await db.query(
    `INSERT INTO products (slug, supplier, supplier_product_id, supplier_variant_id, source_keyword,
       title, description, bullets, seo_description, images,
       product_cost, shipping_cost, landed_cost, price, compare_at_price,
       shipping_method, shipping_days_min, shipping_days_max, ship_from, status, last_synced_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20, now())
     ON CONFLICT (supplier, supplier_variant_id) DO NOTHING
     RETURNING id, title, price`,
    [
      `${slugify(copy.title)}-${String(product.productId).slice(-6).toLowerCase()}`,
      supplier.name,
      product.productId,
      chosen.variant.variantId,
      keyword,
      copy.title,
      copy.description,
      copy.bullets,
      copy.seo_description,
      images,
      chosen.variant.price,
      quote.cost,
      pricing.economics.landedCost,
      pricing.retail,
      pricing.compareAt,
      quote.method,
      quote.days.min,
      quote.days.max,
      quote.origin || "CN",
      status,
    ]
  );
  if (!rows[0]) return false;

  let reviews = 0;
  try {
    reviews = await importSupplierReviews(supplier, rows[0].id, product.productId);
  } catch (err) {
    summary.errors.push(`reviews ${product.productId}: ${err.message}`);
  }
  summary.imported.push({
    ...rows[0],
    supplier: supplier.name,
    status,
    margin: pricing.economics.grossMarginPct,
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

async function syncCatalog() {
  const { rows: products } = await db.query(
    `SELECT * FROM products WHERE status IN ('active','paused','draft')
     ORDER BY last_synced_at NULLS FIRST LIMIT 40`
  );
  const summary = { checked: 0, repriced: 0, paused: 0, resumed: 0, errors: [] };

  for (const p of products) {
    summary.checked++;
    try {
      const supplier = getSupplier(p.supplier);
      const detail = await supplier.getProduct(p.supplier_product_id);
      const variant = detail.variants.find((v) => String(v.variantId) === String(p.supplier_variant_id));
      if (!variant) {
        await db.query(`UPDATE products SET status='archived', status_reason='variant removed by supplier', updated_at=now() WHERE id=$1`, [p.id]);
        summary.paused++;
        continue;
      }
      const verdict = await evaluateVariant(supplier, variant);

      if (!verdict.ok) {
        if (p.status === "active") {
          await db.query(
            `UPDATE products SET status='paused', status_reason=$2, in_stock=$3, updated_at=now(), last_synced_at=now() WHERE id=$1`,
            [p.id, verdict.reasons.join("; "), !(verdict.reasons[0] || "").startsWith("stock")]
          );
          summary.paused++;
        } else {
          // Keep a human's 'manual' pause marker so it's never auto-resumed.
          await db.query(
            `UPDATE products SET status_reason = CASE WHEN status_reason LIKE 'manual%' THEN status_reason ELSE $2 END,
               last_synced_at = now() WHERE id = $1`,
            [p.id, verdict.reasons.join("; ")]
          );
        }
        continue;
      }

      const { pricing, quote } = verdict;
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
        [p.id, variant.price, quote.cost, pricing.economics.landedCost, reprice, pricing.retail, pricing.compareAt,
         quote.method, quote.days.min, quote.days.max, resume, quote.origin || "CN"]
      );
      if (reprice) summary.repriced++;
      await importSupplierReviews(supplier, p.id, p.supplier_product_id).catch(() => 0);
      if (resume) summary.resumed++;
    } catch (err) {
      summary.errors.push(`${p.id}: ${err.message}`);
    }
  }
  return summary;
}

module.exports = { runSourcing, syncCatalog, slugify, supplierHealth, supplierIsHealthy };
