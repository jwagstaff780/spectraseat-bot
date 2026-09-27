// Ads manager: the autopilot loop for paid social.
//  1. pull yesterday/today's metrics for every live test from Meta
//  2. store-wide stop-loss: if profit after ad spend over 7 days is below
//     the limit, pause everything and halt until a human resumes
//  3. apply the kill / keep / scale rules (lib/ads/rules.js) to each test
//  4. launch new product tests while under the concurrency + budget caps,
//     with copy written by the ad creative agent
// ADS.MODE 'dry_run' runs every decision and logs it, but never calls Meta
// write endpoints and never spends.

const config = require("../config");
const db = require("../db");
const meta = require("./meta");
const rules = require("./rules");
const { writeAds } = require("../agents/adCreative");
const { toCents, round2 } = require("../pricing");
const { notifyOwner } = require("../alerts");

const HALT_KEY = "ads_halted";

async function isHalted() {
  const { rows } = await db.query(`SELECT value FROM kv WHERE key = $1`, [HALT_KEY]);
  return rows[0] ? rows[0].value : null;
}

async function setHalted(reason) {
  if (reason) {
    await db.query(
      `INSERT INTO kv (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
      [HALT_KEY, { reason, at: new Date().toISOString() }]
    );
  } else {
    await db.query(`DELETE FROM kv WHERE key = $1`, [HALT_KEY]);
  }
}

async function log(campaignId, action, reason, dryRun) {
  await db.query(`INSERT INTO ad_decisions (campaign_id, action, reason, dry_run) VALUES ($1,$2,$3,$4)`, [
    campaignId,
    action,
    reason,
    dryRun,
  ]);
}

function isoDay(d) {
  return d.toISOString().slice(0, 10);
}

async function syncMetrics(campaigns) {
  const until = isoDay(new Date());
  for (const c of campaigns) {
    if (c.dry_run || !c.external_adset_id) continue;
    const since = isoDay(new Date(c.created_at));
    const rows = await meta.dailyInsights(c.external_adset_id, since, until);
    for (const r of rows) {
      await db.query(
        `INSERT INTO ad_metrics_daily (campaign_id, day, spend, impressions, clicks, purchases, purchase_value)
         VALUES ($1,$2,$3,$4,$5,$6,$7)
         ON CONFLICT (campaign_id, day) DO UPDATE SET spend=EXCLUDED.spend, impressions=EXCLUDED.impressions,
           clicks=EXCLUDED.clicks, purchases=EXCLUDED.purchases, purchase_value=EXCLUDED.purchase_value`,
        [c.id, r.day, r.spend, r.impressions, r.clicks, r.purchases, r.purchaseValue]
      );
    }
  }
}

// Store profit over 7 days after refunds and ad spend.
async function profitAfterAds7d() {
  const { rows } = await db.query(
    `SELECT
       (SELECT coalesce(sum(total - cogs - payment_fee), 0) FROM orders
          WHERE created_at > now() - interval '7 days' AND status <> 'cancelled')
     - (SELECT coalesce(sum(total), 0) FROM orders
          WHERE created_at > now() - interval '7 days' AND status = 'refunded')
     - (SELECT coalesce(sum(spend), 0) FROM ad_metrics_daily WHERE day > current_date - 7) AS profit`
  );
  return Number(rows[0].profit);
}

async function pauseCampaign(c, status, reason, dryRun) {
  if (!dryRun && c.external_adset_id) await meta.setStatus(c.external_adset_id, "PAUSED");
  await db.query(`UPDATE ad_campaigns SET status=$2, status_reason=$3, updated_at=now() WHERE id=$1`, [c.id, status, reason]);
  await log(c.id, status === "killed" ? "kill" : "pause", reason, dryRun);
}

async function runAds() {
  const mode = config.ADS.MODE;
  if (mode === "off") return { mode, note: "ads disabled" };
  const live = mode === "live";
  if (live && !meta.enabled()) throw new Error("ADS_MODE=live but META_ACCESS_TOKEN / META_AD_ACCOUNT_ID are not set");
  const dryRun = !live;
  const summary = { mode, launched: [], killed: [], scaled: [], kept: 0, errors: [] };

  // Leftover dry-run tests never spent anything; retire them once live.
  if (live) {
    await db.query(`UPDATE ad_campaigns SET status='paused', status_reason='dry run only' WHERE dry_run AND status='active'`);
  }

  const { rows: campaigns } = await db.query(
    `SELECT c.*, p.price, p.landed_cost, p.status AS product_status, p.title
     FROM ad_campaigns c JOIN products p ON p.id = c.product_id
     WHERE c.status = 'active' AND c.dry_run = $1`,
    [dryRun]
  );

  if (live) {
    try {
      await syncMetrics(campaigns);
    } catch (err) {
      summary.errors.push(`metrics: ${err.message}`);
    }
  }

  const halted = await isHalted();
  if (halted) return { ...summary, halted };

  const profit7d = await profitAfterAds7d();
  summary.profitAfterAds7d = round2(profit7d);
  if (rules.stopLossTripped(profit7d)) {
    const reason = `stop-loss: 7-day profit after ads $${round2(profit7d)} < $${config.ADS.STOP_LOSS_7D}`;
    for (const c of campaigns) await pauseCampaign(c, "paused", reason, dryRun);
    if (live) {
      await setHalted(reason);
      await notifyOwner("ads-stop-loss", "Ads halted by stop-loss", `${reason}.\nEvery ad is paused. Review the dashboard, then press "Resume ads" when you're ready.`).catch(() => {});
    }
    return { ...summary, halted: { reason } };
  }

  let totalBudget = campaigns.reduce((s, c) => s + Number(c.daily_budget), 0);
  for (const c of campaigns) {
    try {
      if (c.product_status !== "active") {
        await pauseCampaign(c, "paused", `product is ${c.product_status}`, dryRun);
        totalBudget -= Number(c.daily_budget);
        continue;
      }
      const { rows: metrics } = await db.query(
        `SELECT * FROM ad_metrics_daily WHERE campaign_id = $1 ORDER BY day`,
        [c.id]
      );
      const d = rules.decide(c, metrics, c);
      if (d.action === "kill") {
        await pauseCampaign(c, "killed", d.reason, dryRun);
        totalBudget -= Number(c.daily_budget);
        summary.killed.push({ id: c.id, title: c.title, reason: d.reason });
      } else if (d.action === "scale") {
        const newBudget = rules.capScale(totalBudget, Number(c.daily_budget), d.newBudget);
        if (newBudget > Number(c.daily_budget)) {
          if (live) await meta.setDailyBudget(c.external_adset_id, toCents(newBudget));
          await db.query(`UPDATE ad_campaigns SET daily_budget=$2, updated_at=now() WHERE id=$1`, [c.id, newBudget]);
          totalBudget += newBudget - Number(c.daily_budget);
          await log(c.id, `scale ${c.daily_budget}→${newBudget}`, d.reason, dryRun);
          summary.scaled.push({ id: c.id, title: c.title, from: Number(c.daily_budget), to: newBudget });
        } else summary.kept++;
      } else summary.kept++;
    } catch (err) {
      summary.errors.push(`campaign ${c.id}: ${err.message}`);
    }
  }

  // Launch new tests for untested active products: the scout's strongest
  // picks first, then best margin.
  let active = campaigns.length - summary.killed.length;
  const { rows: candidates } = await db.query(
    `SELECT p.* FROM products p
     WHERE p.status = 'active' AND p.in_stock AND array_length(p.images, 1) > 0
       AND NOT EXISTS (SELECT 1 FROM ad_campaigns c WHERE c.product_id = p.id AND c.dry_run = $1)
     ORDER BY p.scout_score DESC NULLS LAST, (p.price - p.landed_cost) / p.price DESC LIMIT 10`,
    [dryRun]
  );
  for (const p of candidates) {
    if (!rules.canLaunch(active, totalBudget)) break;
    try {
      const variants = await writeAds(p);
      const budget = config.ADS.TEST_DAILY_BUDGET;
      let ext = { campaignId: null, adsetId: null, adIds: [] };
      if (live) {
        const link = `${process.env.APP_URL}/p/${encodeURIComponent(p.slug)}?utm_source=meta&utm_medium=paid&utm_campaign=p${p.id}`;
        ext = await meta.launchProductTest({
          name: `${config.BRAND.name} · ${p.title}`.slice(0, 100),
          dailyBudgetCents: toCents(budget),
          countries: config.ADS.COUNTRIES,
          link,
          imageUrl: p.images[0],
          variants,
        });
      }
      const { rows } = await db.query(
        `INSERT INTO ad_campaigns (product_id, external_campaign_id, external_adset_id, external_ad_ids, creative, daily_budget, dry_run)
         VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
        [p.id, ext.campaignId, ext.adsetId, ext.adIds, { variants }, budget, dryRun]
      );
      await log(rows[0].id, "launch", `new product test at ${config.CURRENCY_SYMBOL}${budget}/day with ${variants.length} variants`, dryRun);
      summary.launched.push({ id: rows[0].id, title: p.title, budget });
      active++;
      totalBudget += budget;
    } catch (err) {
      summary.errors.push(`launch ${p.id}: ${err.message}`);
    }
  }
  summary.totalDailyBudget = round2(totalBudget);
  return summary;
}

module.exports = { runAds, setHalted, isHalted, profitAfterAds7d };
