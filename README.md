# SpectraSeat — automated faceless dropshipping store

A dropshipping store run by a team of AI agents. The agents source products,
write the listings, run the ads, publish content, answer customers and report
to you each day. Orders are bought from the supplier automatically once the
customer has paid, and shipped straight to the customer. There's no founder
persona and in the normal case no human in the loop.

**Runs on free tiers.** The store is hosted on Cloudflare Pages, the agents
run on GitHub Actions, the database is Neon Postgres and email is Resend.
There's no monthly platform fee: you pay only per sale, per AI call and for
ad spend (see [What it costs](#what-it-costs)).

**The one design rule:** AI agents *write, talk and report*. Anything that
*moves money* (ad budgets, refunds, pausing products) is decided by fixed
rules in code, each with a hard cap. A model mistake can't spend past a limit.

## The team

| Agent | Schedule | What it does | Hard limits (in `lib/config.js`) |
|---|---|---|---|
| **Sourcing agent** `lib/sourcing.js` | every 6h | Searches every connected supplier for your niche keywords and quotes shipping from each supplier warehouse (US and China for CJ). Keeps only products that are in stock, arrive within `MAX_SHIPPING_DAYS` and clear the margin floors. Claude writes the listing and the product is imported with its supplier reviews. It re-checks the whole catalogue every run: reprices on cost drift, pauses products that stop passing the checks and resumes them when they pass again. Suppliers with a bad track record on your orders are dropped automatically. | 40% margin / $8 profit floors, retail price band, shipping-day ceiling, supplier failure rate |
| **Product scout** `lib/agents/productScout.js` | before every import | Claude reviews each candidate's listing **and photos** like a buyer would: commercial appeal, perceived value, shipping and return risk. It hard-rejects **trademark / knock-off** and **regulated** goods, and keeps only clean photos (no watermarks, foreign text or other shops' logos). Its score also decides which products the ads agent tests first. | score ≥ 60 and no legal red flags |
| **Fulfilment** `lib/fulfilment.js` | on payment + every 15 min | As soon as Stripe confirms payment, buys the exact variant from the supplier (paid from your CJ wallet), shipped straight to the customer under a neutral label. Retries failures, syncs tracking, emails the customer, and sends a **delay notice with a cancel option** if there's no tracking after 5 days (US mail-order rule). Anything stuck goes to your queue and alerts you. | retry cap; an interrupted placement is never blindly retried, so nothing is ordered twice |
| **Ad creative agent** `lib/agents/adCreative.js` | per test | Writes 3 Facebook/Instagram ad variants per product, each testing a different angle. Uses only facts from the listing and follows Meta ad policy. | no invented claims or fake urgency |
| **Ads manager** `lib/ads/manager.js` + `rules.js` | every 6h | Pulls Meta results, then applies fixed rules: stop a test that spent 1.5× a sale's profit with no sales, stop anything below its break-even ROAS, raise the budget 20% on proven winners. Launches new product tests within the caps. Stop-loss: if 7-day profit *after ad spend* drops below −$150, every ad is paused until you resume. | $10/day per test, max 3 tests, $60/day total, $40/day per ad set, stop-loss |
| **Content agent** `lib/agents/content.js` | daily quota | Publishes an SEO guide on the store's blog (`/blog.html`) and posts product photos to your Facebook Page and Instagram. | 1 article + 2 posts per day |
| **Support agent** `lib/agents/support.js` | live chat | Chat widget on every page, labelled as an AI assistant. Tracks orders (needs the customer's email *and* order number), answers product questions, escalates to tickets. | refunds only by policy: the order is past its delivery promise plus 5 days, not delivered, and ≤ $60; everything else becomes a ticket |
| **Chargeback defence** `lib/disputes.js` | on dispute | When a customer disputes a charge and the order has tracking, the store submits the evidence to Stripe automatically: tracking, carrier, ship date, address, product and refund policy. Otherwise you're alerted to decide. | never submits without tracking |
| **Recovery + reviews** | on events | Abandoned-checkout emails, sent only to shoppers who opted in at Stripe Checkout. Review requests go out 5 days after delivery. | consent-gated, one email per cart |
| **Sales manager** `lib/agents/salesManager.js` | daily 07:53 UTC | Gathers profit and loss after ads, refunds per product, ad results, the supplier scorecard and the support queue. Pauses products whose refund rate is over 15%, then writes you a plain-English briefing (admin page + email). | products it pauses stay paused until you look at them |

Everything a human needs to see lands in `/admin.html`: profit after ads,
MER, the daily briefing, orders needing attention, support tickets, ad tests
with every budget decision and its reason, content output, the catalogue,
and the automation log. Buttons: Retry / Refund / Placed manually for
orders, Resolve for tickets, and **Halt all ads / Resume ads**.

## The storefront

Built to convert, and verified on desktop and mobile:
- **Home page:** hero with the best seller, category filters, product cards with honest savings badges, value props, guides, FAQ teaser.
- **Product page:** photo gallery, **variant swatches** (colours/sizes), **multi-buy offer** (2 for 10% off, 3+ for 15%, mixed options count; only offered where margin stays ≥ 35%), a real **delivery-date estimate**, trust assurances, shipping/returns accordions, both review sections, and a **sticky add-to-cart bar** on mobile.
- **Cart:** variant-aware quantity controls, live multi-buy savings, and an "add 1 more to save 15%" nudge.
- **Checkout** (Stripe): Apple/Google Pay, discount codes you create in Stripe, optional Stripe Tax (`STRIPE_TAX=true`).
- **Trust and support pages:** About, Contact (form → ticket queue), FAQ, Terms, Policies, **Track your order** (email + order number), 404, and your legal business name and address in the footer (`BUSINESS_NAME`, `BUSINESS_ADDRESS`).
- **SEO:** clean `/p/<product>` URLs, with server-rendered title and description, social-share preview tags and Google product structured data (price, free shipping, 30-day returns, and a rating **only** from verified buyers). Plus `sitemap.xml` and `robots.txt`.
- **AI support chat** on every page, clearly labelled as an AI assistant.

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

## What it costs

| Item | Cost | Notes |
|---|---|---|
| Storefront hosting: Cloudflare Pages | **$0** | Free plan allows commercial use. Vercel's free Hobby plan does *not*, so a store there needs Pro ($20/month). |
| Agents / scheduler: GitHub Actions | **$0** | Unlimited minutes on a public repo. A private repo gets about 2,000 free minutes/month; change the `fulfil` schedule to hourly to fit. |
| Database: Neon Postgres | **$0** | Free plan (0.5 GB) is plenty for thousands of orders. |
| Email: Resend | **$0** | Free up to 3,000 emails/month (100/day). |
| Card payments: Stripe | 2.9% + 30¢ per sale | No monthly fee. Already included in the store's margin maths. |
| AI agents: Claude API | usage-based, typically a few $/month | Listings, ads, articles, chat replies and the briefing. Heavy chat use costs more. |
| Ads: Meta | whatever the ads manager spends | Capped at `ADS.MAX_TOTAL_DAILY_BUDGET` ($60/day by default) with a 7-day stop-loss. `dry_run` spends $0. |
| Domain name | ~$10–15/year, optional | A free `*.pages.dev` address works, but your own domain earns more trust and better email delivery. |

Shopify is the paid alternative (a monthly plan after its trial, plus
transaction fees if you don't use Shopify Payments). It buys you a polished
checkout and app store, but none of that is needed for this store to run.

## Setup (all free)

You do these once. Nothing here can be automated, because each provider
needs *you* to create and verify the account.

1. **Accounts.**
   - [Stripe](https://stripe.com) (activate payments; needs identity and business details)
   - [CJdropshipping](https://cjdropshipping.com) (API key, then fund the wallet)
   - [Neon](https://neon.tech) (create a database and copy its connection string)
   - [Resend](https://resend.com) (verify a sending domain)
   - [Anthropic Console](https://console.anthropic.com) (API key)
   - [Cloudflare](https://dash.cloudflare.com)
   - Meta Business Manager, optional until you want ads: ad account, Page, Pixel, a linked Instagram account, and a System User token with `ads_management`, `pages_manage_posts` and `instagram_content_publish`
2. **Deploy the storefront (Cloudflare Pages).** Workers & Pages → Create → Pages → connect this GitHub repo. Framework preset **None**, build command **empty**, output directory **`public`**. `wrangler.toml` already sets `nodejs_compat`. Then add environment variables (Settings → Variables and Secrets):
   - `DATABASE_URL`, `APP_URL` (your `https://…pages.dev` or own domain), `STORE_NAME`, `SUPPORT_EMAIL`, `ADMIN_TOKEN`
   - `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`
   - `ANTHROPIC_API_KEY` (support chat), `RESEND_API_KEY`, `EMAIL_FROM`
   - `META_ACCESS_TOKEN`, `META_PIXEL_ID` (purchase tracking)
   - `REVIEW_SECRET`
   - `BUSINESS_NAME`, `BUSINESS_ADDRESS` (shown in the footer; legally required in the EU/UK and expected by card networks)
   - `STRIPE_TAX=true` once Stripe Tax is activated
3. **Stripe webhook** → `APP_URL/api/webhooks/stripe` for `checkout.session.completed`, `checkout.session.async_payment_succeeded`, `checkout.session.expired`, `charge.dispute.created` and `charge.dispute.closed`. Put its signing secret in `STRIPE_WEBHOOK_SECRET`.
4. **GitHub → Settings → Secrets and variables → Actions** (the agents run here):
   - **Secrets:** `DATABASE_URL`, `APP_URL`, `CJ_API_KEY`, `ANTHROPIC_API_KEY`, `STRIPE_SECRET_KEY`, `RESEND_API_KEY`, `EMAIL_FROM`, `OWNER_EMAIL`, `REVIEW_SECRET`, and the `META_*` values
   - **Variables:** `STORE_NAME`, `SUPPORT_EMAIL`, `BUSINESS_NAME`, `BUSINESS_ADDRESS`, `ADS_MODE` (start with `dry_run`), `AUTO_PUBLISH`, `SUPPLIERS`
5. **Create the tables:** Actions → *Store automation* → Run workflow → `migrate`.
6. **Verify the live integrations with the read-only probes.** The CJ and Meta code was written from their documentation and tested against fakes, not live accounts.
   - *Probe supplier API* workflow (or `npm run probe:supplier`)
   - *Probe Meta ads setup* workflow (or `npm run probe:meta`)
7. **Seed the catalogue:** run *Store automation* → `source`, then review the drafts in `/admin.html` (sign in with `ADMIN_TOKEN`). Set `AUTO_PUBLISH=true` once you trust it.
8. **Ads: stay in `ADS_MODE=dry_run` first.** The ads manager makes and logs every decision but spends nothing. Switch the variable to `live` when the decisions look sane, and also set an **account spending limit inside Meta Ads Manager** as an independent safety net.
9. **Place one real order** end to end with your own card, then refund it from `/admin.html`.

From then on it runs by itself: the schedule in `.github/workflows/store-automation.yml` drives every agent, and you read the daily briefing email.

**Other hosts:** `api/` + `vercel.json` still deploy to Vercel (Pro plan for commercial use). `functions/api/[[path]].js` is the Cloudflare entry point. Both call the same `routes/`.

**Local development:** `npm install`, put your variables in `.dev.vars`, then `npm run dev` (Cloudflare's local runtime on http://localhost:8788). `npm run job -- <name>` runs any agent job once.

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

CI runs both on every push, with the end-to-end test against a real Postgres service.

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
- **Variants share one price.** Each product sells all its colours/sizes at a single price. Variants costing more than 15% above the cheapest are left out rather than dragging the price up.
- **Owner alerts need `OWNER_EMAIL`**, plus Resend configured. Alerts cover stop-loss trips, stuck orders, chargebacks and failed jobs, and are de-duplicated for 12 hours.
- **Meta Conversions API is US/CA/AU/NZ only by default** (`ADS.CAPI_COUNTRIES`). EU/UK privacy law needs consent to share purchase data; add those countries only once you collect it.
- **Ad attribution uses Meta's own reporting** (fed by the Conversions API). The stop-loss uses the store's real profit figures, not Meta's.
- **An automatic refund doesn't recall the parcel**. It's only issued once delivery is well overdue, when the parcel is probably lost.
- **Scheduler**: GitHub Actions cron is best-effort and can run a few minutes late under load. Payments trigger fulfilment instantly; the cron is the safety net. On public repos, GitHub disables scheduled workflows after 60 days without a commit. It emails you first; one click in the Actions tab (or any commit) turns them back on. If the daily briefing emails stop, check there first.
- **Cloudflare free plan CPU limit** is 10 ms of CPU time per request (time spent waiting on the database or APIs doesn't count). The storefront's requests are I/O-bound and stay well under it. If you ever see error 1102 on busy admin pages, Workers Paid is $5/month.
- **Compliance is still yours.** Adapt `public/policies.html` to your jurisdiction. Keep delivery promises honest (US mail-order rules). Don't auto-publish regulated, trademarked or safety-certified goods. EU and UK law require trader identity details on the site even for a "faceless" brand.
