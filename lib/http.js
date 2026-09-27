// Small helpers shared by the API routes.

function methodNotAllowed(res, allowed) {
  res.setHeader("Allow", allowed.join(", "));
  res.status(405).json({ error: "method not allowed" });
}

// Log the real error; never send internals (SQL, API keys in URLs, stack
// details) to the browser.
function serverError(res, err) {
  console.error(err);
  res.status(500).json({ error: "Something went wrong on our side. Please try again." });
}

// Raw request body as a string. Needed for Stripe signature checks, which
// must see the exact bytes Stripe signed — so don't touch req.body before
// calling this.
async function readRawBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  if (chunks.length) return Buffer.concat(chunks).toString("utf8");
  if (typeof req.body === "string") return req.body;
  if (Buffer.isBuffer(req.body)) return req.body.toString("utf8");
  return "";
}

// Public, cacheable product shape (never leaks cost/margin/supplier ids).
function publicProduct(p, variants = []) {
  const config = require("./config");
  const { allowedQtyDiscounts } = require("./pricing");
  const mine = variants
    .filter((v) => String(v.product_id) === String(p.id))
    .sort((a, b) => a.position - b.position)
    .map((v) => ({ id: Number(v.id), name: v.name, image: v.image || null, inStock: v.in_stock }));
  return {
    id: Number(p.id),
    slug: p.slug,
    title: p.title,
    description: p.description,
    bullets: p.bullets,
    seoDescription: p.seo_description || null,
    images: p.images,
    price: Number(p.price),
    compareAtPrice: p.compare_at_price ? Number(p.compare_at_price) : null,
    category: p.source_keyword || null,
    productType: p.product_type || "gear",
    // Mandatory food/supplement information, shown before purchase.
    ...(p.product_type && p.product_type !== "gear"
      ? {
          health: {
            netQuantity: p.net_quantity || null,
            ingredients: p.ingredients || [],
            ingredientsText: p.ingredients_text || null,
            allergens: p.allergens || [],
            directions: p.directions || null,
            warnings: require("./compliance/claims").warningsFor(p),
          },
        }
      : {}),
    variants: mine,
    qtyDiscounts: p.landed_cost != null ? allowedQtyDiscounts(Number(p.price), Number(p.landed_cost)) : [],
    deliveryDays:
      p.shipping_days_max != null
        ? { min: (p.shipping_days_min ?? p.shipping_days_max) + 2, max: p.shipping_days_max + config.SHIPPING_PROMISE_BUFFER_DAYS }
        : null,
  };
}

module.exports = { methodNotAllowed, serverError, readRawBody, publicProduct };
