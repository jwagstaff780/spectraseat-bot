// Supplier registry. Every adapter implements the same interface:
//   searchProducts(keyword, pageSize) -> [{ productId, title, image, price }]
//   getProduct(productId)             -> { productId, title, description, images[], variants[] }
//   getStock(variantId)               -> number
//   quoteShipping(variantId, country, maxDays) -> { method, cost, days: {min,max} } | null
//   createOrder(order, items, shippingMethod)  -> { supplierOrderId }
//   getOrderStatus(supplierOrderId)   -> { status, trackingNumber, carrier }
//   getReviews(productId)             -> [{ externalId, author, country, rating, body, reviewedAt }] (optional)
// To add another supplier, drop an adapter next to cj.js and register it.

const { makeEmailDropshipSupplier } = require("./emailDropship");

const adapters = {
  // Fitness gear (keyword-searched). CJ never supplies supplements/foods:
  // the product scout rejects regulated goods from it.
  cj: require("./cj"),
  // UK-made own-label supplements and health foods, dropshipped by the
  // manufacturer. Catalogue file + emailed orders.
  specialist: makeEmailDropshipSupplier({
    name: "specialist",
    displayName: "Specialist Supplements",
    catalogueFile: "suppliers/specialist-supplements.json",
    orderEmailEnv: "SPECIALIST_ORDER_EMAIL",
  }),
};

function getSupplier(name = process.env.SUPPLIER || "cj") {
  const adapter = adapters[name];
  if (!adapter) throw new Error(`Unknown supplier '${name}'`);
  return adapter;
}

// Every supplier with credentials configured. Sourcing queries all of them
// and keeps the cheapest landed offer for each product idea.
function enabledSuppliers() {
  const names = (process.env.SUPPLIERS || process.env.SUPPLIER || "cj").split(",").map((s) => s.trim()).filter(Boolean);
  return names.map((n) => getSupplier(n)).filter((s) => s.searchable !== false);
}

// Catalogue-file suppliers (imported, not searched).
function catalogueSuppliers() {
  return Object.values(adapters).filter((s) => s.searchable === false);
}

module.exports = { getSupplier, enabledSuppliers, catalogueSuppliers, adapters };
