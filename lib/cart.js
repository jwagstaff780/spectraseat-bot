// Server-side cart validation. The browser only ever sends product ids and
// quantities — prices always come from the database, never the client.

const { toCents, round2 } = require("./pricing");

const MAX_LINES = 20;
const MAX_QTY_PER_LINE = 10;

// items: [{ productId, quantity }]; products: rows from the products table.
// Returns { ok, lines, subtotal, error }.
function validateCart(items, products) {
  if (!Array.isArray(items) || items.length === 0) return { ok: false, error: "cart is empty" };
  if (items.length > MAX_LINES) return { ok: false, error: `max ${MAX_LINES} different items per order` };

  const byId = new Map(products.map((p) => [String(p.id), p]));
  const merged = new Map();
  for (const item of items) {
    const id = String(item && item.productId);
    const qty = Number(item && item.quantity);
    if (!Number.isInteger(qty) || qty < 1) return { ok: false, error: "invalid quantity" };
    merged.set(id, (merged.get(id) || 0) + qty);
  }

  const lines = [];
  for (const [id, quantity] of merged) {
    const product = byId.get(id);
    if (!product || product.status !== "active" || !product.in_stock) {
      return { ok: false, error: `product ${id} is unavailable` };
    }
    if (quantity > MAX_QTY_PER_LINE) return { ok: false, error: `max ${MAX_QTY_PER_LINE} of any one item` };
    lines.push({
      product,
      quantity,
      unitPrice: Number(product.price),
      unitPriceCents: toCents(product.price),
    });
  }

  const subtotal = round2(lines.reduce((s, l) => s + l.unitPrice * l.quantity, 0));
  return { ok: true, lines, subtotal };
}

module.exports = { validateCart, MAX_LINES, MAX_QTY_PER_LINE };
