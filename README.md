# SpectraSeat — automated faceless dropshipping store

A dropshipping store that runs itself. There's no founder persona and no manual
product listing, and in the normal case nobody touches an order. Built on the
same stack as before: a static frontend, Vercel serverless functions,
Postgres, and GitHub Actions as the scheduler.

```
              every 6h                      customer                      every 15 min
┌──────────────────────────┐   ┌───────────────────────────────┐   ┌──────────────────────────────┐
│ /api/cron/source         │   │ storefront → /api/checkout    │   │ /api/cron/fulfil             │
│ • search supplier by     │   │ → Stripe Checkout (hosted)    │   │ • retry failed placements    │
│   niche keyword          │──▶│ → /api/webhooks/stripe        │──▶│ • pull tracking → email      │
│ • stock / ship-time /    │   │   • record order (idempotent) │   │   customer                   │
│   margin guardrails      │   │   • email confirmation        │   │ • mark delivered             │
│ • Claude writes on-brand │   │   • place supplier order      │   │ • flag stuck orders for you  │
│   copy → import          │   │     (ships under a neutral    │   │                              │
│ • reprice / pause / resume│  │     label to the customer)    │   │                              │
└──────────────────────────┘   └───────────────────────────────┘   └──────────────────────────────┘
                                   /admin.html: P&L, exceptions, catalogue, automation log
```

## What's automated

| Stage | How |
|---|---|
| **Product research** | `lib/sourcing.js` searches the supplier (CJdropshipping) for each keyword in `config.NICHE_KEYWORDS`, then keeps only products that are in stock, ship within `MAX_SHIPPING_DAYS`, and pass every margin guardrail. |
| **Pricing** | `lib/pricing.js` works from landed cost (product + shipping). It applies the markup, charm-rounds (x.99), deducts Stripe fees, and rejects anything below the margin or profit floor or outside the retail price band. |
| **Listings** | `lib/copywriter.js` has Claude rewrite the raw supplier text in one consistent brand voice, using structured JSON output. Hard rules: no invented claims, no supplier mentions. If `ANTHROPIC_API_KEY` isn't set, it falls back to cleaned-up supplier text. |
| **Catalogue upkeep** | Every sourcing run re-checks stock, cost and shipping for every listed product. A product is repriced when landed cost drifts more than 5%. It is **auto-paused** when it stops meeting the guardrails and auto-resumed when it meets them again. Products you pause yourself are never auto-resumed. |
| **Checkout** | Stripe Checkout, hosted by Stripe, so card data never touches this app. Prices are always read from the database, never taken from the browser. |
| **Fulfilment** | The Stripe webhook places the supplier order immediately, paid from your CJ wallet balance. The cron retries failures up to `MAX_FULFILMENT_ATTEMPTS`, then flags the order for you. |
| **Customer comms** | Order confirmation and shipping/tracking emails are sent via Resend, from the brand. |
| **Exceptions** | Anything that needs a person lands in **Needs attention** on `/admin.html`, with **Retry**, **Placed manually…** and **Refund** buttons. |

## Setup

1. **Deploy to Vercel** and create a Postgres database (Vercel Postgres or Neon). The schema creates itself on first request.
2. **Set environment variables** in Vercel (see `.env.example`):

| Variable | Notes |
|---|---|
| `DATABASE_URL` | Postgres connection string |
| `APP_URL` | Your deployed URL, e.g. `https://spectraseat.vercel.app` |
| `STORE_NAME`, `SUPPORT_EMAIL` | Brand name and the support inbox shown to customers |
| `ADMIN_TOKEN` | Long random string; the password for `/admin.html` |
| `CRON_SECRET` | Long random string shared with GitHub Actions |
| `STRIPE_SECRET_KEY` | Stripe secret key |
| `STRIPE_WEBHOOK_SECRET` | Signing secret for a webhook endpoint at `APP_URL/api/webhooks/stripe`, subscribed to `checkout.session.completed` and `checkout.session.async_payment_succeeded` |
| `CJ_API_KEY` | CJdropshipping API key. **Keep the CJ wallet funded**: orders are paid from its balance automatically. |
| `ANTHROPIC_API_KEY` | Optional; enables the AI copywriter |
| `RESEND_API_KEY`, `EMAIL_FROM` | Transactional email from a verified sending domain |
| `AUTO_PUBLISH` | `false` (the default) imports new products as drafts that you publish with one click. `true` makes the store fully hands-off. |

3. **GitHub repo secrets** (Settings → Secrets and variables → Actions): `APP_URL`, `CRON_SECRET`, and `CJ_API_KEY` for the probe workflow.
4. **Verify the supplier integration against live data.** Run the *Probe supplier API* workflow, or `CJ_API_KEY=... npm run probe:supplier "seat cushion"`. It makes read-only calls and prints the search results, a product, its stock, a freight quote and the pricing verdict. The CJ field mapping in `lib/supplier/cj.js` was written from CJ's API docs, not from a live key, so check it here first.
5. **Seed the catalogue.** Run *Store automation* manually with `job: source`, then review the drafts in `/admin.html`.
6. **Place one real test order** end to end before spending anything on traffic.

Rebranding or changing niche means editing `lib/config.js`: brand, voice, keywords, markup, guardrails and shipping limits all live there.

## Tests

```
npm run selftest                          # offline: pricing, cart, Stripe signatures, parsers
DATABASE_URL=postgres://… npm run e2e     # full pipeline on a THROWAWAY db (drops tables)
```

`e2e` runs the real API handlers against real Postgres, with the supplier,
Stripe and email faked. It covers sourcing → publish → checkout (including a
spoofed client price) → webhook (bad signature, duplicate redelivery) →
supplier order → tracking email → delivered → failure escalation and admin
retry → P&L → auto-pause on a cost spike, auto-resume on recovery → a manual
pause being respected.

## Unit economics: read before you spend on ads

The guardrails protect **gross** margin. They don't cover **customer
acquisition cost**, which is where most dropshipping stores lose money.

- Default markup: $10 landed → **$28.99** retail → about **$17.85 gross profit (62%)** after Stripe fees.
- The admin P&L reports **net profit before ads**. Your break-even ROAS is `retail ÷ gross profit`, about **1.6×** in the example above. `unitEconomics()` in `lib/pricing.js` calculates it per product. Any paid channel returning less than that is losing money on every order.
- Budget for returns, refunds and chargebacks (often 3–8% of revenue in this model), platform subscriptions, and sales tax/VAT. The P&L doesn't include tax: turn on Stripe Tax or get advice for your jurisdictions.
- Scale spend only on products with proven ROAS. Treat the first few hundred dollars of ad spend as research, not revenue.

## Known limitations and risks (documented, not hidden)

- **The CJ integration needs a live check** (setup step 4). The parsers are defensive, but CJ's payloads vary by endpoint and API version.
- **One variant per listing.** Sourcing picks the cheapest variant that passes the guardrails. Multi-variant listings (sizes and colours) aren't built yet.
- **Single supplier per order.** Adapters are pluggable (`lib/supplier/index.js`), but an order is placed with one supplier using the first line's shipping method.
- **An interrupted placement is flagged, not retried.** If a function dies mid-call, the store can't tell whether CJ accepted the order. It flags the order instead of risking a duplicate purchase. Check CJ, then use *Retry* or *Placed manually…*.
- **Scheduler granularity.** GitHub Actions cron is best-effort (runs can be delayed during busy periods). Most orders are placed instantly by the webhook, so the cron is the safety net, not the main path.
- **Cron duration.** `vercel.json` gives cron functions up to 300s, which needs Fluid compute (the default on new projects) or a Pro plan. On a legacy 60s limit, lower `MAX_NEW_PRODUCTS_PER_RUN`.
- **Compliance is on you.** Keep the delivery estimates honest. The store shows the supplier's estimate plus a buffer, and US mail-order rules require you to notify customers of delays. Adapt `public/policies.html` to your jurisdiction. Don't let the automation list regulated, trademarked or safety-certified goods (electrical items, children's products, cosmetics) without checking them yourself. That's the reason `AUTO_PUBLISH` defaults to `false`.
- **Faceless doesn't mean anonymous to regulators.** Payment processors, tax authorities and consumer-protection laws (for example the EU and UK trader-identity rules) may still require a registered business name and address on the site.
