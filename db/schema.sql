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
