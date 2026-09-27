// Supplier adapter for UK private-label supplement makers that dropship
// but don't offer an ordering API (e.g. Specialist Supplements Ltd).
//
// - Catalogue: suppliers/<name>.json — the products you've set up with the
//   supplier under your own label, with costs and the legally required
//   information (ingredients per daily dose, allergens, directions,
//   warnings) copied from the supplier's specification sheets.
// - Orders: emailed automatically to the supplier's order address, with a
//   CSV attachment, the moment the customer pays. The order reference is
//   ours (e.g. SS-1234), so the supplier can quote it back.
// - Tracking: the supplier emails tracking numbers; enter them under
//   "Awaiting tracking" on /admin.html and the customer is emailed. If the
//   supplier later offers an API or CSV feed, extend getOrderStatus().

const fs = require("fs");
const path = require("path");
const config = require("../config");

function loadCatalogue(file) {
  if (!fs.existsSync || !fs.existsSync(file)) return { products: [], shipping: null };
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function csvCell(v) {
  const s = String(v ?? "");
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function orderCsv(order, items) {
  const a = order.shipping_address || {};
  const header = ["order_ref", "sku", "quantity", "name", "address_1", "address_2", "city", "county", "postcode", "country", "phone", "email"];
  const rows = items.map((i) => [
    `${config.BRAND.name.slice(0, 3).toUpperCase()}-${order.id}`,
    i.supplier_variant_id,
    i.quantity,
    order.customer_name || "",
    a.line1,
    a.line2,
    a.city,
    a.state,
    a.postal_code,
    a.country,
    a.phone,
    order.email,
  ]);
  return [header, ...rows].map((r) => r.map(csvCell).join(",")).join("\n") + "\n";
}

function makeEmailDropshipSupplier({ name, displayName, catalogueFile, orderEmailEnv }) {
  // Resolved lazily: the catalogue is only read by Node jobs (import/sync).
  // The Cloudflare storefront only calls createOrder(), and Workers have no
  // __dirname or project files.
  const catalogue = () => {
    const root = typeof __dirname !== "undefined" ? path.resolve(__dirname, "..", "..") : process.cwd();
    return loadCatalogue(path.resolve(root, catalogueFile));
  };
  const find = (sku) => {
    for (const p of catalogue().products || []) {
      if (p.sku === sku) return { product: p, variant: null };
      const v = (p.variants || []).find((x) => x.sku === sku);
      if (v) return { product: p, variant: v };
    }
    return null;
  };

  return {
    name,
    displayName,
    searchable: false, // imported from the catalogue file, not keyword-searched
    catalogue,
    async searchProducts() {
      return [];
    },
    async getProduct(sku) {
      const hit = find(sku);
      if (!hit) throw new Error(`${displayName}: SKU ${sku} not in ${catalogueFile}`);
      const p = hit.product;
      const variants = p.variants && p.variants.length ? p.variants : [{ sku: p.sku, name: "", cost: p.cost, image: (p.images || [])[0] }];
      return {
        productId: p.sku,
        title: p.title,
        description: p.description || "",
        images: p.images || [],
        variants: variants.map((v) => ({ variantId: v.sku, name: v.name || "", price: Number(v.cost), image: v.image || null })),
      };
    },
    async getStock(sku) {
      const hit = find(sku);
      if (!hit) return 0;
      const inStock = (hit.variant || hit.product).in_stock !== false;
      return inStock ? 999 : 0;
    },
    async quoteShipping(_sku, country, maxDays) {
      const s = catalogue().shipping;
      if (!s || country !== "GB" || s.days.max > maxDays) return null;
      return { origin: "GB", method: s.method, cost: Number(s.cost), days: s.days };
    },
    async createOrder(order, items) {
      const to = process.env[orderEmailEnv];
      if (!to) throw new Error(`${orderEmailEnv} is not set — can't send the order to ${displayName}`);
      const ref = `${config.BRAND.name.slice(0, 3).toUpperCase()}-${order.id}`;
      const a = order.shipping_address || {};
      const lines = items.map((i) => `  ${i.quantity} × ${i.supplier_variant_id}  ${i.title}${i.variant_name ? ` (${i.variant_name})` : ""}`).join("\n");
      const text =
        `New dropship order ${ref} from ${config.BRAND.name}${config.BRAND.businessName ? ` (${config.BRAND.businessName})` : ""}.\n\n` +
        `Items:\n${lines}\n\nShip to:\n  ${order.customer_name || ""}\n  ${[a.line1, a.line2, a.city, a.state, a.postal_code, a.country].filter(Boolean).join("\n  ")}\n` +
        `  Phone: ${a.phone || "-"}\n\nPlease reply to this email with the tracking number and carrier when dispatched, quoting ${ref}.\n`;
      const key = process.env.RESEND_API_KEY;
      if (!key || !process.env.EMAIL_FROM) throw new Error("RESEND_API_KEY / EMAIL_FROM not set — can't email the order");
      const res = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          from: process.env.EMAIL_FROM,
          to,
          reply_to: config.BRAND.supportEmail,
          subject: `Dropship order ${ref}`,
          text,
          attachments: [{ filename: `${ref}.csv`, content: Buffer.from(orderCsv(order, items)).toString("base64") }],
        }),
      });
      if (!res.ok) throw new Error(`order email failed: ${res.status} ${(await res.text()).slice(0, 200)}`);
      return { supplierOrderId: ref };
    },
    async getOrderStatus() {
      // No API: tracking arrives by email and is entered on the dashboard.
      return { status: "processing", trackingNumber: null, carrier: null };
    },
  };
}

module.exports = { makeEmailDropshipSupplier, orderCsv, loadCatalogue };
