const config = require("../lib/config");

// GET /api/store — public brand settings for the storefront.
module.exports = (req, res) => {
  res.setHeader("Cache-Control", "s-maxage=300");
  res.status(200).json({
    name: config.BRAND.name,
    tagline: config.BRAND.tagline,
    supportEmail: config.BRAND.supportEmail,
    currency: config.CURRENCY,
    currencySymbol: config.CURRENCY_SYMBOL,
    shipTo: config.SHIP_TO_COUNTRIES,
  });
};
