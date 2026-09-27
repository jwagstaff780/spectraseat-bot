// Server-side cart validation. The browser only ever sends product ids,
// variant ids and quantities — prices always come from the database, never
// the client. Quantity-break discounts are applied here, per product
// (mixing colours of the same product counts toward the tier).

const { toCents, round2, unitPriceForQty } = require("./pricing");

// 15 lines keeps the cart metadata under Stripe's 500-character limit.
const MAX_LINES = 15;
const MAX_QTY_PER_LINE = 10;

// items:    [{ productId, variantId?, quantity }]
// products: rows from products; variants: rows from product_variants
// Returns { ok, lines, subtotal, error }.
function validateCart(items, products, variants = []) {
  if (!Array.isArray(items) || items.length === 0) return { ok: false, error: "cart is empty" };
  if (items.length > MAX_LINES) return { ok: false, error: `max ${MAX_LINES} different items per order` };

  const productById = new Map(products.map((p) => [String(p.id), p]));
  const variantsByProduct = new Map();
  for (const v of variants) {
    const k = String(v.product_id);
    if (!variantsByProduct.has(k)) variantsByProduct.set(k, []);
    variantsByProduct.get(k).push(v);
  }

  const merged = new Map(); // "productId:variantId" -> { product, variant, quantity }
  for (const item of items) {
    const qty = Number(item && item.quantity);
    if (!Number.isInteger(qty) || qty < 1) return { ok: false, error: "invalid quantity" };
    const product = productById.get(String(item && item.productId));
    if (!product || product.status !== "active" || !product.in_stock) {
      return { ok: false, error: `product ${item && item.productId} is unavailable` };
    }
    const options = (variantsByProduct.get(String(product.id)) || []).sort((a, b) => a.position - b.position);
    // Carts from before variants existed carry no variantId: use the first in-stock one.
    const variant =
      item.variantId != null ? options.find((v) => String(v.id) === String(item.variantId)) : options.find((v) => v.in_stock);
    if (!variant || !variant.in_stock) return { ok: false, error: `product ${product.id} option is unavailable` };
    const key = `${product.id}:${variant.id}`;
    const prev = merged.get(key);
    merged.set(key, { product, variant, quantity: (prev ? prev.quantity : 0) + qty });
  }

  const qtyByProduct = new Map();
  for (const { product, quantity } of merged.values()) {
    if (quantity > MAX_QTY_PER_LINE) return { ok: false, error: `max ${MAX_QTY_PER_LINE} of any one item` };
    qtyByProduct.set(String(product.id), (qtyByProduct.get(String(product.id)) || 0) + quantity);
  }

  const lines = [...merged.values()].map(({ product, variant, quantity }) => {
    const unitPrice = unitPriceForQty(Number(product.price), Number(product.landed_cost), qtyByProduct.get(String(product.id)));
    return {
      product,
      variant,
      quantity,
      listPrice: Number(product.price),
      unitPrice,
      unitPriceCents: toCents(unitPrice),
    };
  });

  const subtotal = round2(lines.reduce((s, l) => s + l.unitPrice * l.quantity, 0));
  return { ok: true, lines, subtotal };
}

module.exports = { validateCart, MAX_LINES, MAX_QTY_PER_LINE };
