const db = require("../lib/db");
const config = require("../lib/config");
const stripe = require("../lib/stripe");
const { validateCart } = require("../lib/cart");
const { methodNotAllowed, serverError } = require("../lib/http");

// POST /api/checkout { items: [{ productId, variantId, quantity }], attribution? } -> { url }
// Prices (including quantity breaks) are computed server-side; the client
// only chooses what and how many.
module.exports = async (req, res) => {
  if (req.method !== "POST") return methodNotAllowed(res, ["POST"]);
  try {
    const items = (req.body && req.body.items) || [];
    const ids = items.map((i) => Number(i && i.productId)).filter(Number.isInteger);
    const [{ rows: products }, { rows: variants }] = await Promise.all([
      db.query(`SELECT * FROM products WHERE id = ANY($1::bigint[])`, [ids]),
      db.query(`SELECT * FROM product_variants WHERE product_id = ANY($1::bigint[])`, [ids]),
    ]);
    const cart = validateCart(items, products, variants);
    if (!cart.ok) return res.status(400).json({ error: cart.error });

    const origin = process.env.APP_URL || `https://${req.headers.host}`;
    const session = await stripe.createCheckoutSession({
      mode: "payment",
      success_url: `${origin}/success.html?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${origin}/#cart`,
      shipping_address_collection: { allowed_countries: config.SHIP_TO_COUNTRIES },
      phone_number_collection: { enabled: true },
      shipping_options: [
        {
          shipping_rate_data: {
            display_name: "Free tracked shipping",
            type: "fixed_amount",
            fixed_amount: { amount: 0, currency: config.CURRENCY },
          },
        },
      ],
      line_items: cart.lines.map((l) => ({
        quantity: l.quantity,
        price_data: {
          currency: config.CURRENCY,
          unit_amount: l.unitPriceCents,
          product_data: {
            name: l.variant.name ? `${l.product.title} — ${l.variant.name}` : l.product.title,
            images: [l.variant.image || (l.product.images || [])[0]].filter(Boolean),
            ...(l.unitPrice < l.listPrice ? { description: `Multi-buy price (was ${config.CURRENCY_SYMBOL}${l.listPrice.toFixed(2)} each)` } : {}),
          },
        },
      })),
      // Ask for marketing consent so abandoned carts can be recovered by
      // email — only shoppers who opt in are ever emailed.
      consent_collection: { promotions: "auto" },
      // Discount codes you create in the Stripe dashboard work at checkout.
      allow_promotion_codes: true,
      // Sales tax / VAT via Stripe Tax (activate it in Stripe first).
      ...(process.env.STRIPE_TAX === "true" ? { automatic_tax: { enabled: true } } : {}),
      after_expiration: { recovery: { enabled: true } },
      metadata: {
        cart: JSON.stringify(cart.lines.map((l) => [Number(l.product.id), Number(l.variant.id), l.quantity, l.unitPriceCents])),
        attribution: String((req.body && req.body.attribution) || "").slice(0, 100) || undefined,
      },
    });
    res.status(200).json({ url: session.url });
  } catch (err) {
    serverError(res, err);
  }
};
