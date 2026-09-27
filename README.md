# SpectraSeat — automated faceless dropshipping store

A dropshipping store run by a team of AI agents. The agents source products,
write the listings, run the ads, publish content, answer customers and report
to you each day. Orders are bought from the supplier automatically once the
customer has paid, and shipped straight to the customer. There's no founder
persona and in the normal case no human in the loop. Built on a static
frontend, Vercel serverless functions, Postgres, and GitHub Actions as the
scheduler.

**The one design rule:** AI agents *write, talk and report*. Anything that
*moves money* (ad budgets, refunds, pausing products) is decided by fixed
rules in code, each with a hard cap. A model mistake can't spend past a limit.

## The team

| Agent | Schedule | What it does | Hard limits (in `lib/config.js`) |
|---|---|---|---|
| **Sourcing agent** `lib/sourcing.js` | every 6h | Searches every connected supplier for your niche keywords and quotes shipping from each supplier warehouse (US and China for CJ). Keeps only products that are in stock, arrive within `MAX_SHIPPING_DAYS` and clear the margin floors. Claude writes the listing and the product is imported with its supplier reviews. It re-checks the whole catalogue every run: reprices on cost drift, pauses products that stop passing the checks and resumes them when they pass again. Suppliers with a bad track record on your orders are dropped automatically. | 40% margin / $8 profit floors, retail price band, shipping-day ceiling, supplier failure rate |
| **Fulfilment** `lib/fulfilment.js` | on payment + every 15 min | As soon as Stripe confirms payment, buys the goods from the supplier (paid from your CJ wallet), shipped straight to the customer under a neutral label. Retries failures, syncs tracking, emails the customer, marks deliveries. Anything stuck goes to your queue. | retry cap; an interrupted placement is never blindly retried, so nothing is ordered twice |
| **Ad creative agent** `lib/agents/adCreative.js` | per test | Writes 3 Facebook/Instagram ad variants per product, each testing a different angle. Uses only facts from the listing and follows Meta ad policy. | no invented claims or fake urgency |
| **Ads manager** `lib/ads/manager.js` + `rules.js` | every 6h | Pulls Meta results, then applies fixed rules: stop a test that spent 1.5× a sale's profit with no sales, stop anything below its break-even ROAS, raise the budget 20% on proven winners. Launches new product tests within the caps. Stop-loss: if 7-day profit *after ad spend* drops below −$150, every ad is paused until you resume. | $10/day per test, max 3 tests, $60/day total, $40/day per ad set, stop-loss |
| **Content agent** `lib/agents/content.js` | daily quota | Publishes an SEO guide on the store's blog (`/blog.html`) and posts product photos to your Facebook Page and Instagram. | 1 article + 2 posts per day |
| **Support agent** `lib/agents/support.js` | live chat | Chat widget on every page, labelled as an AI assistant. Tracks orders (needs the customer's email *and* order number), answers product questions, escalates to tickets. | refunds only by policy: the order is past its delivery promise plus 5 days, not delivered, and ≤ $60; everything else becomes a ticket |
| **Recovery + reviews** | on events | Abandoned-checkout emails, sent only to shoppers who opted in at Stripe Checkout. Review requests go out 5 days after delivery. | consent-gated, one email per cart |
| **Sales manager** `lib/agents/salesManager.js` | daily 07:53 UTC | Gathers profit and loss after ads, refunds per product, ad results, the supplier scorecard and the support queue. Pauses products whose refund rate is over 15%, then writes you a plain-English briefing (admin page + email). | products it pauses stay paused until you look at them |

Everything a human needs to see lands in `/admin.html`: profit after ads,
MER, the daily briefing, orders needing attention, support tickets, ad tests
with every budget decision and its reason, content output, the catalogue,
and the automation log. Buttons: Retry / Refund / Placed manually for
orders, Resolve for tickets, and **Halt all ads / Resume ads**.

## Reviews: automated, and lawful

You asked for the supplier's product reviews to be used as the store's
reviews. They can't be shown as *our customers'* reviews. The FTC's rule on
fake reviews (16 CFR Part 465, in force since October 2024) bans presenting
reviews as coming from people who weren't your customers, and bans hiding
negative ones. Penalties are about $53k per violation, and Stripe and Meta
also shut down stores that do it. What the store does instead:

- **Supplier reviews** for the *same item* are imported automatically. They're
  shown in a separate section labelled as coming from another marketplace,
  never counted in our star rating, and never filtered by rating.
- **Verified reviews**: every buyer gets a signed review link after delivery.
  Reviews are published as written. Only contact details, links and abuse are
  hidden, never negative opinions. These alone make up the store's rating.

## Setup

1. **Deploy to Vercel** with a Postgres database (Vercel Postgres or Neon). The schema creates itself.
2. **Environment variables**: see `.env.example`. The groups are core (database, app URL, admin and cron secrets), Stripe, CJ, Anthropic, Resend, `OWNER_EMAIL`, and Meta.
3. **Stripe webhook** → `APP_URL/api/webhooks/stripe` for `checkout.session.completed`, `checkout.session.async_payment_succeeded` and `checkout.session.expired`.
4. **GitHub repo secrets**: `APP_URL`, `CRON_SECRET`; `CJ_API_KEY` and the `META_*` values for the probe workflows.
5. **Verify integrations with read-only probes before trusting them.** The CJ and Meta code was written from their documentation and tested against fakes, not live accounts.
   - *Probe supplier API* workflow (or `npm run probe:supplier`)
   - *Probe Meta ads setup* workflow (or `npm run probe:meta`)
6. **Seed the catalogue.** Run *Store automation* → `source`, then review the drafts in `/admin.html`. `AUTO_PUBLISH=true` makes this hands-off.
7. **Ads: run in `ADS_MODE=dry_run` first.** In dry run the manager makes every decision and logs it on the dashboard, but spends nothing. Switch to `live` once the numbers look sane. Also set an **account spending limit inside Meta Ads Manager** as a second, independent safety net.
8. **Place one real order** end to end.

Meta needs a Business Manager with an ad account, Page, Pixel and (optionally)
a linked Instagram account. You also need a System User token with
`ads_management`, `pages_manage_posts` and `instagram_content_publish`.

## Money: read this before going live

As your advisor: **automation removes labour, not risk.** The guardrails make
losses slow and bounded, not impossible.

- Unit economics per product: $10 landed → **$28.99** retail → **$17.85 gross profit** after card fees → **break-even ROAS ≈ 1.6×**. The ads manager uses this per product to decide what lives and dies.
- **Worst case with the defaults:** about $60/day of ad spend before the 7-day stop-loss (−$150) halts everything. Budget at least **$500–1,000** of test spend you can afford to lose before expecting a winner. Most product tests fail, and that's normal.
- Keep a separate cash buffer in the **CJ wallet** (orders are paid from it) and for **refunds and chargebacks** (plan on 3–8% of revenue).
- Sales tax and VAT aren't calculated. Turn on Stripe Tax, or get advice for the places you sell to.
- Watch **MER** (revenue ÷ ad spend) and **net profit after ads** on the dashboard, not the ROAS Meta reports.

## Tests

```
npm run selftest                          # offline: pricing, cart, Stripe signatures, ad rules, refund policy, review tokens, CAPI
DATABASE_URL=postgres://… npm run e2e     # full pipeline on a THROWAWAY db (drops tables)
```

`e2e` runs the real API handlers against real Postgres. Supplier, Stripe,
Resend, Meta and the Claude API are faked at the HTTP layer. It covers:
sourcing (AI copy + supplier reviews) → publish → checkout → webhook (bad
signature, duplicate) → supplier order + Meta Conversions API → tracking →
delivered → P&L → reviews (1★ supplier review not suppressed, verified review
via signed link, forged token rejected) → support agent tool loop,
email-gated lookups, capped auto-refund, no double refund → consent-gated
cart recovery → content agent quota → ads dry run is read-only → live launch
→ kill rule pauses on Meta → stop-loss halt and admin resume → sales manager
refund rule + emailed briefing.

## Limits and risks (documented, not hidden)

- **Live integrations need the probes** (setup step 5). The CJ and Meta API field mappings haven't been exercised against real accounts.
- **Only CJ is connected.** The supplier registry (`lib/supplier/index.js`) takes more adapters and sourcing compares them all. CJ itself covers thousands of factories plus US and EU warehouses.
- **One variant per listing.** No size or colour choices yet.
- **Ad attribution uses Meta's own reporting** (fed by the Conversions API). The stop-loss uses the store's real profit figures, not Meta's.
- **An automatic refund doesn't recall the parcel**. It's only issued once delivery is well overdue, when the parcel is probably lost.
- **Scheduler**: GitHub Actions cron is best-effort. Payments trigger fulfilment instantly; the cron is the safety net. Cron functions can run up to 300s (needs Fluid compute, the default on new Vercel projects).
- **Compliance is still yours.** Adapt `public/policies.html` to your jurisdiction. Keep delivery promises honest (US mail-order rules). Don't auto-publish regulated, trademarked or safety-certified goods. EU and UK law require trader identity details on the site even for a "faceless" brand.
