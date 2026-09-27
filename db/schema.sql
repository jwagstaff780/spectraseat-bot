-- Store schema. Applied automatically (CREATE TABLE IF NOT EXISTS) by
-- lib/db.js on first connection, so there is no manual migration step.

CREATE TABLE IF NOT EXISTS products (
  id BIGSERIAL PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,

  -- supplier identity (what we order when a customer buys)
  supplier TEXT NOT NULL,
  supplier_product_id TEXT NOT NULL,
  supplier_variant_id TEXT NOT NULL,
  source_keyword TEXT,

  -- storefront copy (AI-written, brand voice)
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  bullets TEXT[] NOT NULL DEFAULT '{}',
  seo_description TEXT,
  images TEXT[] NOT NULL DEFAULT '{}',

  -- economics, re-checked on every sourcing run
  product_cost NUMERIC NOT NULL,
  shipping_cost NUMERIC NOT NULL,
  landed_cost NUMERIC NOT NULL,
  price NUMERIC NOT NULL,
  compare_at_price NUMERIC,
  shipping_method TEXT,
  shipping_days_min INTEGER,
  shipping_days_max INTEGER,

  status TEXT NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'active', 'paused', 'archived')),
  status_reason TEXT,
  in_stock BOOLEAN NOT NULL DEFAULT TRUE,

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_synced_at TIMESTAMPTZ,

  UNIQUE (supplier, supplier_variant_id)
);

CREATE INDEX IF NOT EXISTS products_status_idx ON products (status);

CREATE TABLE IF NOT EXISTS orders (
  id BIGSERIAL PRIMARY KEY,
  -- idempotency key: Stripe retries webhooks, we must never double-order
  stripe_session_id TEXT NOT NULL UNIQUE,
  stripe_payment_intent TEXT,

  email TEXT NOT NULL,
  customer_name TEXT,
  shipping_address JSONB NOT NULL,

  currency TEXT NOT NULL,
  subtotal NUMERIC NOT NULL,
  shipping_charged NUMERIC NOT NULL DEFAULT 0,
  total NUMERIC NOT NULL,
  -- snapshot of cost at time of sale so profit reporting is exact even if
  -- supplier prices move later
  cogs NUMERIC NOT NULL,
  payment_fee NUMERIC NOT NULL,

  status TEXT NOT NULL DEFAULT 'paid'
    CHECK (status IN ('paid', 'placing', 'placed', 'shipped', 'delivered', 'needs_attention', 'refunded', 'cancelled')),
  status_reason TEXT,

  supplier_order_id TEXT,
  fulfilment_attempts INTEGER NOT NULL DEFAULT 0,
  last_fulfilment_error TEXT,
  placed_at TIMESTAMPTZ,

  tracking_number TEXT,
  tracking_url TEXT,
  carrier TEXT,
  shipped_at TIMESTAMPTZ,
  delivered_at TIMESTAMPTZ,

  confirmation_emailed_at TIMESTAMPTZ,
  shipping_emailed_at TIMESTAMPTZ,

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS orders_status_idx ON orders (status);
CREATE INDEX IF NOT EXISTS orders_created_idx ON orders (created_at);

CREATE TABLE IF NOT EXISTS order_items (
  id BIGSERIAL PRIMARY KEY,
  order_id BIGINT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  product_id BIGINT NOT NULL REFERENCES products(id),
  supplier_variant_id TEXT NOT NULL,
  title TEXT NOT NULL,
  quantity INTEGER NOT NULL CHECK (quantity > 0),
  unit_price NUMERIC NOT NULL,
  unit_landed_cost NUMERIC NOT NULL
);

CREATE INDEX IF NOT EXISTS order_items_order_idx ON order_items (order_id);

-- Audit log of every automated job run, surfaced on the admin dashboard.
CREATE TABLE IF NOT EXISTS automation_runs (
  id BIGSERIAL PRIMARY KEY,
  job TEXT NOT NULL,
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at TIMESTAMPTZ,
  ok BOOLEAN,
  summary JSONB NOT NULL DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS automation_runs_job_idx ON automation_runs (job, started_at DESC);

-- Tiny key/value store for things that must survive cold starts, e.g. the
-- supplier access token (CJ rate-limits token issuance, so we can't mint a
-- fresh one per lambda instance).
CREATE TABLE IF NOT EXISTS kv (
  key TEXT PRIMARY KEY,
  value JSONB NOT NULL,
  expires_at TIMESTAMPTZ
);

-- ---- Reviews ---------------------------------------------------------------
-- source='verified': written by a customer of ours via a signed review link.
-- source='supplier': imported from the supplier's marketplace. Always shown
-- separately and labelled — never counted in our rating or presented as our
-- customers' reviews (FTC 16 CFR Part 465).
CREATE TABLE IF NOT EXISTS reviews (
  id BIGSERIAL PRIMARY KEY,
  product_id BIGINT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  source TEXT NOT NULL CHECK (source IN ('verified', 'supplier')),
  external_id TEXT,
  order_id BIGINT REFERENCES orders(id),
  author TEXT,
  country TEXT,
  rating INTEGER CHECK (rating BETWEEN 1 AND 5),
  body TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'published' CHECK (status IN ('published', 'hidden')),
  hidden_reason TEXT,
  reviewed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (product_id, source, external_id)
);
CREATE INDEX IF NOT EXISTS reviews_product_idx ON reviews (product_id, source);
CREATE UNIQUE INDEX IF NOT EXISTS reviews_one_per_order_item ON reviews (order_id, product_id) WHERE source = 'verified';

-- ---- Ads -------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ad_campaigns (
  id BIGSERIAL PRIMARY KEY,
  product_id BIGINT NOT NULL REFERENCES products(id),
  platform TEXT NOT NULL DEFAULT 'meta',
  external_campaign_id TEXT,
  external_adset_id TEXT,
  external_ad_ids TEXT[] NOT NULL DEFAULT '{}',
  creative JSONB NOT NULL DEFAULT '{}',
  daily_budget NUMERIC NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused', 'killed')),
  status_reason TEXT,
  dry_run BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ad_campaigns_status_idx ON ad_campaigns (status);

CREATE TABLE IF NOT EXISTS ad_metrics_daily (
  campaign_id BIGINT NOT NULL REFERENCES ad_campaigns(id) ON DELETE CASCADE,
  day DATE NOT NULL,
  spend NUMERIC NOT NULL DEFAULT 0,
  impressions INTEGER NOT NULL DEFAULT 0,
  clicks INTEGER NOT NULL DEFAULT 0,
  purchases INTEGER NOT NULL DEFAULT 0,
  purchase_value NUMERIC NOT NULL DEFAULT 0,
  PRIMARY KEY (campaign_id, day)
);

-- Every budget decision the optimiser makes, with its reason.
CREATE TABLE IF NOT EXISTS ad_decisions (
  id BIGSERIAL PRIMARY KEY,
  campaign_id BIGINT REFERENCES ad_campaigns(id) ON DELETE CASCADE,
  action TEXT NOT NULL,
  reason TEXT NOT NULL,
  dry_run BOOLEAN NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---- Content ---------------------------------------------------------------
CREATE TABLE IF NOT EXISTS content (
  id BIGSERIAL PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('blog', 'social')),
  product_id BIGINT REFERENCES products(id) ON DELETE SET NULL,
  slug TEXT UNIQUE,
  title TEXT,
  body TEXT NOT NULL,
  image TEXT,
  status TEXT NOT NULL DEFAULT 'published' CHECK (status IN ('queued', 'published', 'failed')),
  channels JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  published_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS content_kind_idx ON content (kind, created_at DESC);

-- ---- Sales team ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS support_tickets (
  id BIGSERIAL PRIMARY KEY,
  order_id BIGINT REFERENCES orders(id),
  email TEXT,
  category TEXT NOT NULL,
  summary TEXT NOT NULL,
  transcript JSONB NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved')),
  resolution TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS support_tickets_status_idx ON support_tickets (status);

CREATE TABLE IF NOT EXISTS checkout_recoveries (
  stripe_session_id TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  sent_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS agent_reports (
  id BIGSERIAL PRIMARY KEY,
  agent TEXT NOT NULL,
  body TEXT NOT NULL,
  metrics JSONB NOT NULL DEFAULT '{}',
  actions JSONB NOT NULL DEFAULT '[]',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE orders ADD COLUMN IF NOT EXISTS review_requested_at TIMESTAMPTZ;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS refund_reason TEXT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS supplier TEXT;
-- Warehouse country the supplier ships this product from (CJ has US/EU
-- warehouses as well as China; closer stock = faster delivery).
ALTER TABLE products ADD COLUMN IF NOT EXISTS ship_from TEXT NOT NULL DEFAULT 'CN';
ALTER TABLE orders ADD COLUMN IF NOT EXISTS attribution TEXT;

-- Fixed-window rate limiting for public endpoints (support chat).
CREATE TABLE IF NOT EXISTS rate_limits (
  key TEXT NOT NULL,
  window_start TIMESTAMPTZ NOT NULL,
  count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (key, window_start)
);
