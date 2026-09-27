// Sales manager agent. Once a day it:
//  1. gathers the numbers (P&L after ads, conversion funnel, refunds by
//     product, ad performance, supplier scorecard, support load)
//  2. applies fixed business rules (e.g. pause products with a refund rate
//     above the limit) — rules act, the model doesn't
//  3. has Claude write a short briefing: what happened, what the rules did,
//     what needs a human, and recommendations
//  4. stores it for the admin dashboard and emails it to OWNER_EMAIL

const config = require("../config");
const db = require("../db");
const ai = require("../ai");
const email = require("../email");
const { supplierHealth } = require("../sourcing");
const { isHalted } = require("../ads/manager");

async function gatherMetrics() {
  const q = async (sql, params) => (await db.query(sql, params)).rows;
  const [pnl] = await q(
    `SELECT count(*)::int AS orders, coalesce(sum(total),0)::float AS revenue,
            coalesce(sum(total - cogs - payment_fee),0)::float AS gross_profit,
            coalesce(sum(total) FILTER (WHERE status='refunded'),0)::float AS refunded
     FROM orders WHERE created_at > now() - interval '7 days' AND status <> 'cancelled'`
  );
  const [ads] = await q(
    `SELECT coalesce(sum(spend),0)::float AS spend, coalesce(sum(purchases),0)::int AS purchases,
            coalesce(sum(purchase_value),0)::float AS purchase_value, coalesce(sum(clicks),0)::int AS clicks
     FROM ad_metrics_daily WHERE day > current_date - 7`
  );
  const refundsByProduct = await q(
    `SELECT p.id, p.title, p.status, count(DISTINCT o.id)::int AS orders,
            count(DISTINCT o.id) FILTER (WHERE o.status='refunded')::int AS refunds
     FROM order_items oi JOIN orders o ON o.id = oi.order_id JOIN products p ON p.id = oi.product_id
     WHERE o.created_at > now() - interval '30 days'
     GROUP BY p.id, p.title, p.status`
  );
  const statuses = await q(`SELECT status, count(*)::int AS n FROM orders GROUP BY status`);
  const [tickets] = await q(
    `SELECT count(*) FILTER (WHERE status='open')::int AS open,
            count(*) FILTER (WHERE created_at > now() - interval '1 day')::int AS new_24h
     FROM support_tickets`
  );
  const adDecisions = await q(
    `SELECT action, reason, dry_run FROM ad_decisions WHERE created_at > now() - interval '1 day' ORDER BY created_at DESC LIMIT 30`
  );
  const [catalogue] = await q(
    `SELECT count(*) FILTER (WHERE status='active')::int AS active, count(*) FILTER (WHERE status='draft')::int AS drafts,
            count(*) FILTER (WHERE status='paused')::int AS paused FROM products`
  );
  const [reviews] = await q(
    `SELECT count(*)::int AS verified_count, round(avg(rating)::numeric, 2)::float AS verified_avg
     FROM reviews WHERE source='verified' AND status='published'`
  );
  const profitAfterAds = pnl.gross_profit - pnl.refunded - ads.spend;
  return {
    last7d: {
      ...pnl,
      adSpend: ads.spend,
      profitAfterAds,
      mer: ads.spend > 0 ? pnl.revenue / ads.spend : null,
      adReportedRoas: ads.spend > 0 ? ads.purchase_value / ads.spend : null,
      adClicks: ads.clicks,
      clickToOrderPct: ads.clicks > 0 ? (pnl.orders / ads.clicks) * 100 : null,
    },
    orderStatuses: Object.fromEntries(statuses.map((s) => [s.status, s.n])),
    refundsByProduct,
    tickets,
    adDecisions,
    adsHalted: await isHalted(),
    catalogue,
    reviews,
    suppliers: await supplierHealth(),
  };
}

// Deterministic actions. Returns a list of what was done.
async function applyRules(metrics, cfg = config.SALES) {
  const actions = [];
  for (const p of metrics.refundsByProduct) {
    const rate = p.orders ? (p.refunds / p.orders) * 100 : 0;
    if (p.status === "active" && p.orders >= cfg.MIN_ORDERS_FOR_REFUND_RULE && rate > cfg.MAX_REFUND_RATE_PCT) {
      const reason = `refund rate ${rate.toFixed(0)}% over ${p.orders} orders (limit ${cfg.MAX_REFUND_RATE_PCT}%)`;
      // 'manual:' prefix so the catalogue sync won't auto-resume it: a
      // quality problem needs a human look, not just a better price.
      await db.query(`UPDATE products SET status='paused', status_reason=$2, updated_at=now() WHERE id=$1 AND status='active'`, [
        p.id,
        `manual: ${reason}`,
      ]);
      actions.push({ action: "paused_product", productId: p.id, title: p.title, reason });
    }
  }
  return actions;
}

function fallbackBriefing(m, actions) {
  const d = m.last7d;
  return [
    `Last 7 days: ${d.orders} orders, revenue $${d.revenue.toFixed(2)}, ad spend $${d.adSpend.toFixed(2)}, profit after ads $${d.profitAfterAds.toFixed(2)}.`,
    `Open support tickets: ${m.tickets.open}. Orders needing attention: ${m.orderStatuses.needs_attention || 0}.`,
    actions.length ? `Automatic actions: ${actions.map((a) => `${a.title} — ${a.reason}`).join("; ")}.` : "No automatic actions today.",
    m.adsHalted ? `ADS HALTED: ${m.adsHalted.reason}` : "",
  ].filter(Boolean).join("\n");
}

async function runDailyReport() {
  const metrics = await gatherMetrics();
  const actions = await applyRules(metrics);

  let body = null;
  if (ai.enabled()) {
    const out = await ai.generateJson({
      system:
        `You are the sales manager for ${config.BRAND.name}, a fully automated online store. Write the owner's daily briefing. ` +
        "Be direct and numerate, like a CFO. Only use the numbers provided; never invent data. Flag risks plainly " +
        "(negative profit after ads, rising refunds, supplier failures, open tickets, halted ads). Recommendations must be specific.",
      prompt: `Metrics (JSON):\n${JSON.stringify(metrics)}\n\nActions already taken automatically:\n${JSON.stringify(actions)}`,
      schema: {
        type: "object",
        properties: {
          headline: { type: "string", description: "One sentence verdict on the last 7 days." },
          sections: {
            type: "array",
            items: {
              type: "object",
              properties: { heading: { type: "string" }, points: { type: "array", items: { type: "string" } } },
              required: ["heading", "points"],
              additionalProperties: false,
            },
            description: "Performance, What the automation did, Needs a human, Recommendations.",
          },
        },
        required: ["headline", "sections"],
        additionalProperties: false,
      },
      effort: "medium",
    });
    if (out) body = [out.headline, ...out.sections.map((s) => `\n${s.heading}\n${s.points.map((p) => `• ${p}`).join("\n")}`)].join("\n");
  }
  if (!body) body = fallbackBriefing(metrics, actions);

  const { rows } = await db.query(
    `INSERT INTO agent_reports (agent, body, metrics, actions) VALUES ('sales_manager', $1, $2, $3) RETURNING id, created_at`,
    [body, metrics, JSON.stringify(actions)]
  );
  if (process.env.OWNER_EMAIL) {
    await email
      .send(process.env.OWNER_EMAIL, {
        subject: `${config.BRAND.name} daily briefing`,
        html: `<pre style="font:14px/1.5 system-ui,sans-serif;white-space:pre-wrap">${email.escapeHtml(body)}</pre>`,
      })
      .catch((err) => console.error(err));
  }
  return { reportId: rows[0].id, actions, headline: body.split("\n")[0] };
}

module.exports = { runDailyReport, gatherMetrics, applyRules };
