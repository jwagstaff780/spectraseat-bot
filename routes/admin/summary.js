const db = require("../../lib/db");
const { requireBearer } = require("../../lib/auth");
const { methodNotAllowed, serverError } = require("../../lib/http");

// GET /api/admin/summary?days=30 — P&L after ad spend, pipeline health and automation log.
module.exports = async (req, res) => {
  if (req.method !== "GET") return methodNotAllowed(res, ["GET"]);
  if (!requireBearer(req, res, "ADMIN_TOKEN")) return;
  try {
    const days = Math.min(Math.max(Number(req.query.days) || 30, 1), 365);

    const [pnl, statuses, attention, topProducts, runs, products, daily, ads, tickets] = await Promise.all([
      db.query(
        `SELECT count(*)::int AS orders,
                coalesce(sum(total),0)::float AS revenue,
                coalesce(sum(cogs),0)::float AS cogs,
                coalesce(sum(payment_fee),0)::float AS fees,
                coalesce(sum(total - cogs - payment_fee),0)::float AS gross_profit,
                coalesce(sum(total) FILTER (WHERE status='refunded'),0)::float AS refunded
         FROM orders WHERE created_at > now() - make_interval(days => $1) AND status <> 'cancelled'`,
        [days]
      ),
      db.query(`SELECT status, count(*)::int AS n FROM orders GROUP BY status`),
      db.query(`SELECT id, email, total, status_reason, last_fulfilment_error, created_at FROM orders WHERE status='needs_attention' ORDER BY created_at`),
      db.query(
        `SELECT p.id, p.title, sum(oi.quantity)::int AS units,
                sum(oi.quantity * (oi.unit_price - oi.unit_landed_cost))::float AS profit
         FROM order_items oi JOIN orders o ON o.id = oi.order_id JOIN products p ON p.id = oi.product_id
         WHERE o.created_at > now() - make_interval(days => $1) AND o.status NOT IN ('refunded','cancelled')
         GROUP BY p.id, p.title ORDER BY profit DESC LIMIT 10`,
        [days]
      ),
      db.query(`SELECT job, started_at, finished_at, ok, summary FROM automation_runs ORDER BY started_at DESC LIMIT 20`),
      db.query(
        `SELECT id, slug, title, status, status_reason, in_stock, price::float, landed_cost::float,
                shipping_days_max, images[1] AS image, last_synced_at, scout_score, scout_summary,
                (SELECT count(*)::int FROM product_variants v WHERE v.product_id = products.id AND v.in_stock) AS variants
         FROM products WHERE status <> 'archived' ORDER BY status, created_at DESC`
      ),
      db.query(
        `SELECT to_char(date_trunc('day', created_at), 'YYYY-MM-DD') AS day, count(*)::int AS orders,
                sum(total)::float AS revenue, sum(total - cogs - payment_fee)::float AS profit
         FROM orders WHERE created_at > now() - make_interval(days => $1) AND status NOT IN ('refunded','cancelled')
         GROUP BY 1 ORDER BY 1`,
        [days]
      ),
      db.query(
        `SELECT coalesce(sum(spend),0)::float AS spend FROM ad_metrics_daily WHERE day > current_date - $1::int`,
        [days]
      ),
      db.query(`SELECT count(*)::int AS open FROM support_tickets WHERE status='open'`),
    ]);

    const p = pnl.rows[0];
    // Refunded orders: revenue is returned but goods were usually already
    // bought, so COGS stays a cost. Net it out explicitly.
    const adSpend = ads.rows[0].spend;
    const netProfit = p.gross_profit - p.refunded - adSpend;
    res.status(200).json({
      days,
      pnl: {
        ...p,
        ad_spend: adSpend,
        mer: adSpend > 0 ? p.revenue / adSpend : null,
        net_profit: netProfit,
        margin_pct: p.revenue > 0 ? (netProfit / p.revenue) * 100 : 0,
        aov: p.orders > 0 ? p.revenue / p.orders : 0,
      },
      openTickets: tickets.rows[0].open,
      statuses: Object.fromEntries(statuses.rows.map((r) => [r.status, r.n])),
      attention: attention.rows,
      topProducts: topProducts.rows,
      runs: runs.rows,
      products: products.rows,
      daily: daily.rows,
    });
  } catch (err) {
    serverError(res, err);
  }
};
