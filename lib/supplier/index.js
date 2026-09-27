// Supplier registry. Every adapter implements the same interface:
//   searchProducts(keyword, pageSize) -> [{ productId, title, image, price }]
//   getProduct(productId)             -> { productId, title, description, images[], variants[] }
//   getStock(variantId)               -> number
//   quoteShipping(variantId, country, maxDays) -> { method, cost, days: {min,max} } | null
//   createOrder(order, items, shippingMethod)  -> { supplierOrderId }
//   getOrderStatus(supplierOrderId)   -> { status, trackingNumber, carrier }
// To add another supplier, drop an adapter next to cj.js and register it.

const adapters = {
  cj: require("./cj"),
};

function getSupplier(name = process.env.SUPPLIER || "cj") {
  const adapter = adapters[name];
  if (!adapter) throw new Error(`Unknown supplier '${name}'`);
  return adapter;
}

module.exports = { getSupplier };
