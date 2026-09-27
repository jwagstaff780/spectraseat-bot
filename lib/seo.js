// Server-rendered SEO for product pages: <title>, meta description,
// Open Graph / Twitter cards (so links shared on social show the product),
// canonical URL, and schema.org Product JSON-LD with offer, free shipping,
// return policy and — only when real verified reviews exist — the rating.

const config = require("./config");

function escAttr(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

function productJsonLd(p, url, rating) {
  const data = {
    "@context": "https://schema.org",
    "@type": "Product",
    name: p.title,
    description: p.seo_description || String(p.description || "").slice(0, 300),
    image: (p.images || []).slice(0, 5),
    sku: String(p.id),
    brand: { "@type": "Brand", name: config.BRAND.name },
    offers: {
      "@type": "Offer",
      url,
      priceCurrency: config.CURRENCY.toUpperCase(),
      price: Number(p.price).toFixed(2),
      availability: p.in_stock ? "https://schema.org/InStock" : "https://schema.org/OutOfStock",
      itemCondition: "https://schema.org/NewCondition",
      shippingDetails: {
        "@type": "OfferShippingDetails",
        shippingRate: { "@type": "MonetaryAmount", value: 0, currency: config.CURRENCY.toUpperCase() },
        shippingDestination: { "@type": "DefinedRegion", addressCountry: config.PRIMARY_MARKET },
        deliveryTime: {
          "@type": "ShippingDeliveryTime",
          handlingTime: { "@type": "QuantitativeValue", minValue: 1, maxValue: 3, unitCode: "DAY" },
          transitTime: {
            "@type": "QuantitativeValue",
            minValue: p.shipping_days_min ?? p.shipping_days_max ?? 7,
            maxValue: (p.shipping_days_max ?? 12) + config.SHIPPING_PROMISE_BUFFER_DAYS,
            unitCode: "DAY",
          },
        },
      },
      hasMerchantReturnPolicy: {
        "@type": "MerchantReturnPolicy",
        applicableCountry: config.PRIMARY_MARKET,
        returnPolicyCategory: "https://schema.org/MerchantReturnFiniteReturnWindow",
        merchantReturnDays: 30,
        returnMethod: "https://schema.org/ReturnByMail",
      },
    },
  };
  // Only our own verified buyers' reviews count — never supplier reviews.
  if (rating && rating.count > 0) {
    data.aggregateRating = { "@type": "AggregateRating", ratingValue: Number(rating.average).toFixed(1), reviewCount: rating.count };
  }
  // Safe inside <script>: no "</script>" breakout.
  return JSON.stringify(data).replace(/</g, "\\u003c");
}

function productHeadTags(p, url, rating) {
  const title = `${p.title} · ${config.BRAND.name}`;
  const desc = p.seo_description || String(p.description || "").slice(0, 155);
  const img = (p.images || [])[0] || "";
  return {
    title,
    description: desc,
    headHtml: [
      `<link rel="canonical" href="${escAttr(url)}">`,
      `<meta property="og:type" content="product">`,
      `<meta property="og:site_name" content="${escAttr(config.BRAND.name)}">`,
      `<meta property="og:title" content="${escAttr(p.title)}">`,
      `<meta property="og:description" content="${escAttr(desc)}">`,
      `<meta property="og:url" content="${escAttr(url)}">`,
      img ? `<meta property="og:image" content="${escAttr(img)}">` : "",
      `<meta property="product:price:amount" content="${Number(p.price).toFixed(2)}">`,
      `<meta property="product:price:currency" content="${config.CURRENCY.toUpperCase()}">`,
      `<meta name="twitter:card" content="summary_large_image">`,
      `<script type="application/ld+json">${productJsonLd(p, url, rating)}</script>`,
    ].join("\n"),
  };
}

module.exports = { productHeadTags, productJsonLd, escAttr };
