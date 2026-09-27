// Pure, deterministic ad-budget rules. The AI writes ads; these rules alone
// decide what spends money. Every number is a config knob with a hard cap.

const config = require("../config");
const { unitEconomics, round2 } = require("../pricing");

function sum(rows, key) {
  return rows.reduce((s, r) => s + Number(r[key] || 0), 0);
}

// campaign: { daily_budget, created_at }
// metrics:  daily rows [{ day, spend, purchases, purchase_value }], oldest..newest
// product:  { price, landed_cost }
// Returns { action: 'keep'|'kill'|'scale', newBudget?, reason }
function decide(campaign, metrics, product, cfg = config.ADS) {
  const econ = unitEconomics(Number(product.price), Number(product.landed_cost));
  const breakEven = econ.breakEvenRoas || Infinity;

  const spend = sum(metrics, "spend");
  const purchases = sum(metrics, "purchases");
  const value = sum(metrics, "purchase_value");
  const roas = spend > 0 ? value / spend : 0;

  const noSaleLimit = cfg.KILL_NO_SALE_SPEND_MULTIPLE * Math.max(econ.grossProfit, 1);
  if (purchases === 0 && spend >= noSaleLimit) {
    return { action: "kill", reason: `spent $${round2(spend)} (≥ $${round2(noSaleLimit)}) with no purchases` };
  }
  if (spend >= cfg.MIN_SPEND_TO_JUDGE && roas < breakEven) {
    return { action: "kill", reason: `ROAS ${round2(roas)} below break-even ${breakEven} after $${round2(spend)}` };
  }

  const recent = metrics.slice(-3);
  const rSpend = sum(recent, "spend");
  const rPurchases = sum(recent, "purchases");
  const rRoas = rSpend > 0 ? sum(recent, "purchase_value") / rSpend : 0;
  const budget = Number(campaign.daily_budget);
  if (
    rPurchases >= cfg.MIN_PURCHASES_TO_SCALE &&
    rRoas >= cfg.SCALE_ROAS_MULTIPLE * breakEven &&
    budget < cfg.MAX_ADSET_DAILY_BUDGET
  ) {
    const newBudget = Math.min(round2(budget * (1 + cfg.SCALE_STEP_PCT / 100)), cfg.MAX_ADSET_DAILY_BUDGET);
    return { action: "scale", newBudget, reason: `3-day ROAS ${round2(rRoas)} ≥ ${cfg.SCALE_ROAS_MULTIPLE}× break-even ${breakEven} on ${rPurchases} sales` };
  }
  return { action: "keep", reason: `spend $${round2(spend)}, ${purchases} sales, ROAS ${round2(roas)} (break-even ${breakEven})` };
}

// Clamp a scale-up so the sum of all daily budgets never exceeds the cap.
function capScale(currentTotal, oldBudget, newBudget, cfg = config.ADS) {
  const headroom = cfg.MAX_TOTAL_DAILY_BUDGET - (currentTotal - oldBudget);
  return round2(Math.max(oldBudget, Math.min(newBudget, headroom)));
}

function canLaunch(activeCount, currentTotal, cfg = config.ADS) {
  return activeCount < cfg.MAX_CONCURRENT_TESTS && currentTotal + cfg.TEST_DAILY_BUDGET <= cfg.MAX_TOTAL_DAILY_BUDGET;
}

function stopLossTripped(profitAfterAds7d, cfg = config.ADS) {
  return profitAfterAds7d < cfg.STOP_LOSS_7D;
}

module.exports = { decide, capScale, canLaunch, stopLossTripped };
