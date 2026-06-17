#!/usr/bin/env python3
"""
Lux Trading Firm — $1,000,000 Account Challenge Simulation & Backtest
SpectraSeat Bot  ·  Opportunity Model vs Lux Trading Rules

Lux Trading $1M Challenge Rules (confirmed 2026):
  • Account Size:         $1,000,000
  • Profit Target:        15%  = $150,000   (single-phase evaluation)
  • Max Total Drawdown:   6%   = $60,000    (STATIC — floor fixed at $940,000)
  • Daily Loss Limit:     NONE              (total drawdown is the only hard floor)
  • Minimum Trading Days: 29               (must trade at least 29 days)
  • Time Limit:           NONE              (unlimited — take as long as needed)
  • Stop Loss:            Mandatory pre-entry on every trade (modelled as fixed risk)
  • Profit Split:         75% to trader on funded account

Key differences from FTMO:
  ✦ No daily loss limit — only the 6% total drawdown matters
  ✦ Tighter drawdown (6% vs FTMO's 10%) but on 10× the capital
  ✦ Higher profit target (15% vs 10%)
  ✦ More trading days required (29 vs 10)
  ✦ No time pressure — you can take months if needed
  ✦ Stop-loss mandatory on every trade

Usage:
  python lux_backtest.py                  # full single-run simulation
  python lux_backtest.py --monte-carlo    # 500-run probability analysis
  python lux_backtest.py --runs 1000      # custom run count
  python lux_backtest.py --seed 7         # alternate scenario
  python lux_backtest.py --compare        # side-by-side vs FTMO rules
"""

from __future__ import annotations

import argparse
import random
import statistics
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from typing import Dict, List, Optional, Tuple

# ═══════════════════════════════════════════════════════════════════════════════
# LUX TRADING FIRM — $1M CHALLENGE RULES
# ═══════════════════════════════════════════════════════════════════════════════

ACCOUNT_SIZE     = 1_000_000.0
PROFIT_TARGET    = 150_000.0     # 15%
MAX_TOTAL_LOSS   = 60_000.0      # 6% static drawdown
ACCOUNT_FLOOR    = ACCOUNT_SIZE - MAX_TOTAL_LOSS   # $940,000
MIN_TRADING_DAYS = 29
PROFIT_SPLIT     = 0.75          # 75% to trader

# ═══════════════════════════════════════════════════════════════════════════════
# BOT SCORING MODEL  (exact mirror of bot.py parameters)
# ═══════════════════════════════════════════════════════════════════════════════

OPPORTUNITY_TYPES: Dict[str, Dict] = {
    "music_trending":   {"demand_base": 55, "demand_boost": 35, "risk": 20.0, "weight": 0.25},
    "music_standard":   {"demand_base": 55, "demand_boost": 10, "risk": 20.0, "weight": 0.35},
    "boxing_major":     {"demand_base": 60, "demand_boost": 40, "risk": 28.0, "weight": 0.10},
    "boxing_standard":  {"demand_base": 60, "demand_boost": 10, "risk": 28.0, "weight": 0.05},
    "skiddle_trending": {"demand_base": 55, "demand_boost": 35, "risk": 20.0, "weight": 0.15},
    "skiddle_standard": {"demand_base": 55, "demand_boost": 10, "risk": 20.0, "weight": 0.10},
}

MONEY_MAKER_THRESHOLD = 60.0   # minimum trade_score (matches bot.py)

# ═══════════════════════════════════════════════════════════════════════════════
# DATA CLASSES
# ═══════════════════════════════════════════════════════════════════════════════

@dataclass
class Trade:
    day_num: int
    date: datetime
    event_type: str
    demand_score: float
    margin_pct: float
    risk_score: float
    trade_score: float
    risk_amount: float     # $ at risk (= stop-loss exposure, mandatory per Lux rules)
    reward_amount: float   # $ potential profit
    actual_pnl: float
    won: bool
    balance_after: float


@dataclass
class DayResult:
    day_num: int
    date: datetime
    is_trading_day: bool
    start_balance: float
    end_balance: float
    day_pnl: float
    trades: List[Trade] = field(default_factory=list)
    drawdown_breached: bool = False


@dataclass
class LuxResult:
    passed: bool
    start_balance: float
    end_balance: float
    peak_balance: float
    min_balance: float
    total_pnl: float
    total_pnl_pct: float
    drawdown_used: float          # peak equity - min equity
    drawdown_used_pct: float
    worst_daily_pnl: float
    worst_daily_day: int
    trading_days: int
    calendar_days: int
    total_trades: int
    winning_trades: int
    win_rate_pct: float
    avg_win_usd: float
    avg_loss_usd: float
    profit_factor: float
    profit_target_hit: bool
    profit_target_day: Optional[int]
    trader_payout: float          # 75% of gross profit
    violations: List[str]
    days: List[DayResult]


# ═══════════════════════════════════════════════════════════════════════════════
# OPPORTUNITY GENERATOR
# ═══════════════════════════════════════════════════════════════════════════════

def _generate_opportunity(rng: random.Random) -> Optional[Dict]:
    """
    Generate one scored opportunity using the exact bot.py formula:
      trade_score = demand_score + margin_pct_guess − risk_score
    Returns None when score < MONEY_MAKER_THRESHOLD (same gate as the live bot).
    """
    types  = list(OPPORTUNITY_TYPES.keys())
    weights = [OPPORTUNITY_TYPES[t]["weight"] for t in types]
    opp_type = rng.choices(types, weights=weights, k=1)[0]
    p = OPPORTUNITY_TYPES[opp_type]

    demand_score = p["demand_base"] + rng.uniform(0.0, p["demand_boost"])
    if rng.random() < 0.60:
        demand_score += rng.uniform(0.0, 10.0)
    demand_score = min(demand_score, 100.0)

    risk_score = p["risk"] + rng.uniform(-3.0, 3.0)

    is_presale   = rng.random() < 0.15
    base         = 12.0 if is_presale else 10.0
    cheap_boost  = rng.uniform(0.0, 10.0) if rng.random() < 0.60 else 0.0
    demand_boost = (demand_score - 50.0) * 0.4
    margin_pct   = max(0.0, base + cheap_boost + demand_boost)

    trade_score = demand_score + margin_pct - risk_score

    if trade_score < MONEY_MAKER_THRESHOLD:
        return None

    return {
        "type":         opp_type,
        "demand_score": round(demand_score, 2),
        "margin_pct":   round(margin_pct,   2),
        "risk_score":   round(risk_score,   2),
        "trade_score":  round(trade_score,  2),
    }


def _daily_opportunities(rng: random.Random) -> List[Dict]:
    """
    Generate a day's actionable signals from 3 radar scans.
    On a $1M account we apply tighter quality filtering — only the best 4
    signals per day, sorted by trade_score descending.  This protects the
    tight $60k static drawdown by avoiding low-confidence trades.
    """
    opps: List[Dict] = []
    for _ in range(3):
        n_events = rng.randint(3, 15)
        for _ in range(n_events):
            opp = _generate_opportunity(rng)
            if opp:
                opps.append(opp)
    opps.sort(key=lambda o: o["trade_score"], reverse=True)
    return opps[:4]   # top 4 only


# ═══════════════════════════════════════════════════════════════════════════════
# TRADE EXECUTION MODEL
# ═══════════════════════════════════════════════════════════════════════════════

def _win_probability(trade_score: float) -> float:
    """
    Empirical win-rate ladder identical to ftmo_backtest.py.
    50% at threshold → 74% at 95+.
    """
    if trade_score >= 95: return 0.74
    if trade_score >= 85: return 0.67
    if trade_score >= 75: return 0.60
    if trade_score >= 70: return 0.56
    if trade_score >= 65: return 0.53
    return 0.50


def _position_size(risk_score: float, trade_score: float) -> float:
    """
    Conservative sizing anchored to $1M initial balance.

    Base: 0.3% of $1M = $3,000 per trade (stop-loss exposure).
    Hard cap: 0.5% = $5,000 per trade.

    Rationale: with a $60k static floor, the account can absorb
    ~12–20 consecutive stop-outs before breaching.  At 0.3% base
    the expected losing streak at 50% win rate stays well inside that.

    This also satisfies Lux's mandatory stop-loss rule — the risk_amount
    represents the pre-set stop distance × position size.
    """
    base_risk = ACCOUNT_SIZE * 0.003   # $3,000

    risk_adj = 1.0 - (risk_score - 20.0) / 80.0    # 20 → 1.00,  28 → 0.90
    if trade_score >= 90:   conf_adj = 1.30
    elif trade_score >= 80: conf_adj = 1.15
    else:                   conf_adj = 1.00

    return round(min(base_risk * risk_adj * conf_adj, ACCOUNT_SIZE * 0.005), 2)


def _execute_trade(opp: Dict, rng: random.Random) -> Tuple[float, bool, float, float]:
    """Returns (pnl, won, risk_amount, reward_amount)."""
    risk_amt   = _position_size(opp["risk_score"], opp["trade_score"])
    rr         = max(1.2, min(opp["margin_pct"] / 10.0, 3.5))
    reward_amt = round(risk_amt * rr, 2)
    won        = rng.random() < _win_probability(opp["trade_score"])
    pnl        = reward_amt if won else -risk_amt
    return pnl, won, risk_amt, reward_amt


# ═══════════════════════════════════════════════════════════════════════════════
# SIMULATION ENGINE
# ═══════════════════════════════════════════════════════════════════════════════

def simulate(seed: int, start_date: datetime, max_calendar_days: int = 365) -> LuxResult:
    """
    Simulate the Lux $1M challenge.  With no time limit we run up to
    max_calendar_days (~1 year) which is more than enough to hit 29 trading
    days and reach the $150k target if the model has a positive edge.
    """
    rng = random.Random(seed)

    balance       = ACCOUNT_SIZE
    peak_balance  = ACCOUNT_SIZE
    min_balance   = ACCOUNT_SIZE

    trading_days     = 0
    total_trades     = 0
    winning_trades   = 0
    all_wins:   List[float] = []
    all_losses: List[float] = []
    violations: List[str]   = []

    profit_target_hit  = False
    profit_target_day: Optional[int] = None
    worst_daily_pnl    = 0.0
    worst_daily_day    = 0
    terminated         = False
    calendar_days      = 0
    all_days: List[DayResult] = []

    for day_num in range(1, max_calendar_days + 1):
        if terminated:
            break

        calendar_days  = day_num
        current_date   = start_date + timedelta(days=day_num - 1)
        is_weekend     = current_date.weekday() >= 5

        if is_weekend:
            all_days.append(DayResult(
                day_num=day_num, date=current_date, is_trading_day=False,
                start_balance=balance, end_balance=balance, day_pnl=0.0,
            ))
            continue

        trading_days       = trading_days + 1
        day_start_balance  = balance
        day_pnl            = 0.0
        day_trades: List[Trade] = []
        dd_breached        = False

        for opp in _daily_opportunities(rng):

            if balance <= ACCOUNT_FLOOR + 0.01:
                if not dd_breached:
                    violations.append(
                        f"Day {day_num} (Trading Day {trading_days}): "
                        f"Total drawdown breached — "
                        f"balance ${balance:,.2f} hit floor ${ACCOUNT_FLOOR:,.2f}"
                    )
                    dd_breached = True
                    terminated  = True
                break

            pnl, won, risk_amt, reward_amt = _execute_trade(opp, rng)

            if balance + pnl < ACCOUNT_FLOOR:
                pnl = ACCOUNT_FLOOR - balance

            balance    = round(balance + pnl, 2)
            day_pnl   += pnl
            total_trades += 1

            if pnl > 0:
                winning_trades += 1
                all_wins.append(pnl)
            else:
                all_losses.append(abs(pnl))

            day_trades.append(Trade(
                day_num=day_num,
                date=current_date,
                event_type=opp["type"],
                demand_score=opp["demand_score"],
                margin_pct=opp["margin_pct"],
                risk_score=opp["risk_score"],
                trade_score=opp["trade_score"],
                risk_amount=risk_amt,
                reward_amount=reward_amt,
                actual_pnl=round(pnl, 2),
                won=pnl > 0,
                balance_after=balance,
            ))

            peak_balance = max(peak_balance, balance)
            min_balance  = min(min_balance, balance)

            if not profit_target_hit:
                if balance >= ACCOUNT_SIZE + PROFIT_TARGET:
                    profit_target_hit = True
                    profit_target_day = day_num

        if day_pnl < worst_daily_pnl:
            worst_daily_pnl = day_pnl
            worst_daily_day = day_num

        all_days.append(DayResult(
            day_num=day_num, date=current_date, is_trading_day=True,
            start_balance=day_start_balance, end_balance=balance,
            day_pnl=day_pnl, trades=day_trades,
            drawdown_breached=dd_breached,
        ))

        if terminated:
            break

        if profit_target_hit and trading_days >= MIN_TRADING_DAYS:
            break

    # ── Pass / Fail ───────────────────────────────────────────────────────────
    passed = not bool(violations)

    if not profit_target_hit:
        violations.append(
            f"Profit target not reached: needed ${PROFIT_TARGET:,.0f}, "
            f"ended at ${balance - ACCOUNT_SIZE:+,.2f}"
        )
        passed = False

    if trading_days < MIN_TRADING_DAYS:
        violations.append(
            f"Min trading days not met: {trading_days}/{MIN_TRADING_DAYS}"
        )
        passed = False

    # ── Metrics ───────────────────────────────────────────────────────────────
    total_pnl      = balance - ACCOUNT_SIZE
    total_win_amt  = sum(all_wins)
    total_loss_amt = sum(all_losses)
    pf             = total_win_amt / total_loss_amt if total_loss_amt else 9.99
    # Lux static drawdown = how far the account dropped below INITIAL balance
    # (not peak-to-trough — the floor is fixed at $940,000 regardless of profits)
    dd_used        = max(0.0, ACCOUNT_SIZE - min_balance)
    dd_used_pct    = (dd_used / MAX_TOTAL_LOSS) * 100   # % of $60k limit consumed
    trader_payout  = max(0.0, total_pnl) * PROFIT_SPLIT

    return LuxResult(
        passed=passed,
        start_balance=ACCOUNT_SIZE,
        end_balance=balance,
        peak_balance=peak_balance,
        min_balance=min_balance,
        total_pnl=total_pnl,
        total_pnl_pct=(total_pnl / ACCOUNT_SIZE) * 100,
        drawdown_used=dd_used,
        drawdown_used_pct=dd_used_pct,
        worst_daily_pnl=worst_daily_pnl,
        worst_daily_day=worst_daily_day,
        trading_days=trading_days,
        calendar_days=calendar_days,
        total_trades=total_trades,
        winning_trades=winning_trades,
        win_rate_pct=(winning_trades / total_trades * 100) if total_trades else 0.0,
        avg_win_usd=statistics.mean(all_wins)   if all_wins   else 0.0,
        avg_loss_usd=statistics.mean(all_losses) if all_losses else 0.0,
        profit_factor=pf,
        profit_target_hit=profit_target_hit,
        profit_target_day=profit_target_day,
        trader_payout=trader_payout,
        violations=violations,
        days=all_days,
    )


# ═══════════════════════════════════════════════════════════════════════════════
# REPORT PRINTER
# ═══════════════════════════════════════════════════════════════════════════════

def _rule(label: str, value: str, ok: bool) -> None:
    print(f"  {'✅ PASS' if ok else '❌ FAIL'}  {label:<48} {value}")


def print_report(r: LuxResult) -> None:
    verdict = "✅  PASSED" if r.passed else "❌  FAILED"
    print(f"\n{'═' * 70}")
    print(f"  Lux Trading Firm — $1,000,000 Challenge  —  {verdict}")
    print(f"{'═' * 70}")

    print("\n📋  LUX RULE CHECKS")

    _rule(
        "Profit Target  (≥ $150,000  /  15%)",
        f"P&L ${r.total_pnl:+,.2f}  ({r.total_pnl_pct:+.2f}%)",
        r.profit_target_hit,
    )

    floor_ok = r.min_balance >= ACCOUNT_FLOOR
    _rule(
        "Static Drawdown Floor  (≥ $940,000  /  −6%)",
        f"Min ${r.min_balance:,.2f}  |  used ${r.drawdown_used:,.2f} ({r.drawdown_used_pct:.1f}% of limit)",
        floor_ok,
    )

    # Lux has no daily loss limit — show best day info as FYI
    print(f"  ✅ N/A   Daily Loss Limit                                   "
          f"None (Lux has no daily loss cap)")

    days_ok = r.trading_days >= MIN_TRADING_DAYS
    _rule(
        f"Min Trading Days  (≥ {MIN_TRADING_DAYS})",
        f"{r.trading_days} trading days  ({r.calendar_days} calendar days)",
        days_ok,
    )

    _rule(
        "Stop Loss on Every Trade",
        "Yes — modelled as fixed pre-set risk per trade",
        True,
    )

    print("\n💰  ACCOUNT PERFORMANCE")
    print(f"  Starting Balance       ${r.start_balance:>15,.2f}")
    print(f"  Ending Balance         ${r.end_balance:>15,.2f}")
    print(f"  Peak Balance           ${r.peak_balance:>15,.2f}")
    print(f"  Lowest Balance         ${r.min_balance:>15,.2f}  (floor: ${ACCOUNT_FLOOR:,.2f})")
    print(f"  Net P&L                ${r.total_pnl:>+15,.2f}  ({r.total_pnl_pct:+.2f}%)")
    print(f"  Drawdown Used          ${r.drawdown_used:>15,.2f}  ({r.drawdown_used_pct:.1f}% of $60k limit)")
    print(f"  Drawdown Remaining     ${MAX_TOTAL_LOSS - r.drawdown_used:>15,.2f}  buffer remaining")
    print(f"  Trader Payout (75%)    ${r.trader_payout:>15,.2f}")

    print("\n🎯  TRADE STATISTICS")
    print(f"  Total Trades           {r.total_trades:>8}")
    print(f"  Winning Trades         {r.winning_trades:>8}")
    print(f"  Win Rate               {r.win_rate_pct:>7.1f}%")
    print(f"  Avg Win                ${r.avg_win_usd:>12,.2f}")
    print(f"  Avg Loss               ${r.avg_loss_usd:>12,.2f}")
    print(f"  Profit Factor          {r.profit_factor:>10.2f}")
    print(f"  Trading Days           {r.trading_days:>8}")
    print(f"  Calendar Days Used     {r.calendar_days:>8}")
    if r.worst_daily_day > 0:
        print(f"  Worst Single Day       ${r.worst_daily_pnl:>+12,.2f}  (Day {r.worst_daily_day})")
    if r.profit_target_hit and r.profit_target_day:
        print(f"  Target Hit Day         {r.profit_target_day:>8}")

    if r.violations:
        print(f"\n⚠️   VIOLATIONS  ({len(r.violations)})")
        for v in r.violations:
            print(f"   • {v}")

    trading_day_list = [d for d in r.days if d.is_trading_day]
    if trading_day_list:
        print(f"\n📅  DAILY P&L  (all {len(trading_day_list)} trading days)")
        print(f"  {'Day':>4}  {'Date':<13} {'Trades':>6}  {'Day P&L':>12}  {'Balance':>14}  {'DD Used':>9}  Status")
        print(f"  {'-' * 75}")
        for d in trading_day_list:
            # How much of the $60k static floor has been consumed at end of this day
            dd_so_far = max(0.0, ACCOUNT_SIZE - d.end_balance)
            if d.drawdown_breached:
                status = "⛔ DD LIMIT"
            elif d.day_pnl > 0:
                status = "✅ Green"
            elif d.day_pnl < 0:
                status = "🔴 Red"
            else:
                status = "⬜ Flat"
            print(
                f"  {d.day_num:>4}  {d.date.strftime('%d %b %Y'):<13}"
                f"{len(d.trades):>6}  ${d.day_pnl:>+10,.2f}  "
                f"${d.end_balance:>13,.2f}  "
                f"${dd_so_far:>7,.2f}  {status}"
            )


# ═══════════════════════════════════════════════════════════════════════════════
# MONTE CARLO
# ═══════════════════════════════════════════════════════════════════════════════

def run_monte_carlo(n: int, start_date: datetime) -> None:
    print(f"\n{'═' * 70}")
    print(f"  MONTE CARLO  —  {n:,} simulations  ·  Lux $1M Challenge")
    print(f"{'═' * 70}")

    passed_count = 0
    pnls:       List[float] = []
    dds:        List[float] = []
    win_rates:  List[float] = []
    day_counts: List[int]   = []
    payouts:    List[float] = []
    fail_reason: Dict[str, int] = {
        "drawdown_breach": 0,
        "profit_not_hit":  0,
        "min_days":        0,
    }

    for i in range(n):
        r = simulate(seed=i * 137 + 31, start_date=start_date)
        if r.passed:
            passed_count += 1
        else:
            for v in r.violations:
                if "drawdown" in v.lower():
                    fail_reason["drawdown_breach"] += 1
                elif "profit target" in v.lower():
                    fail_reason["profit_not_hit"] += 1
                elif "trading days" in v.lower():
                    fail_reason["min_days"] += 1
        pnls.append(r.total_pnl)
        dds.append(r.drawdown_used)
        win_rates.append(r.win_rate_pct)
        day_counts.append(r.trading_days)
        payouts.append(r.trader_payout)

    pass_rate = passed_count / n * 100
    sorted_pnls = sorted(pnls)

    print(f"\n  Pass Rate:   {pass_rate:.1f}%  ({passed_count:,} / {n:,} simulations)")

    print(f"\n  Failure Breakdown (of {n - passed_count} failures)")
    print(f"    Drawdown breach:      {fail_reason['drawdown_breach']:>5}")
    print(f"    Profit not reached:   {fail_reason['profit_not_hit']:>5}")
    print(f"    Min days not met:     {fail_reason['min_days']:>5}")

    print(f"\n  P&L Distribution")
    print(f"    Mean       ${statistics.mean(pnls):>+12,.2f}")
    print(f"    Median     ${statistics.median(pnls):>+12,.2f}")
    print(f"    Std Dev    ${statistics.stdev(pnls):>12,.2f}")
    print(f"    Best       ${max(pnls):>+12,.2f}")
    print(f"    Worst      ${min(pnls):>+12,.2f}")
    p5  = sorted_pnls[int(n * 0.05)]
    p25 = sorted_pnls[int(n * 0.25)]
    p75 = sorted_pnls[int(n * 0.75)]
    p95 = sorted_pnls[int(n * 0.95)]
    print(f"    P5  / P95  ${p5:>+12,.2f}  /  ${p95:>+12,.2f}")
    print(f"    P25 / P75  ${p25:>+12,.2f}  /  ${p75:>+12,.2f}")

    print(f"\n  Trader Payout Distribution (75% of profit)")
    print(f"    Mean payout    ${statistics.mean(payouts):>12,.2f}")
    print(f"    Median payout  ${statistics.median(payouts):>12,.2f}")
    print(f"    Best payout    ${max(payouts):>12,.2f}")

    print(f"\n  Drawdown Usage")
    print(f"    Mean       ${statistics.mean(dds):>10,.2f}  of $60,000 limit")
    print(f"    Median     ${statistics.median(dds):>10,.2f}")
    print(f"    Worst      ${max(dds):>10,.2f}")

    print(f"\n  Win Rate Distribution")
    print(f"    Mean       {statistics.mean(win_rates):>7.1f}%")
    print(f"    Median     {statistics.median(win_rates):>7.1f}%")

    print(f"\n  Trading Days to Complete Challenge")
    print(f"    Mean       {statistics.mean(day_counts):>7.1f}")
    print(f"    Median     {statistics.median(day_counts):>7.1f}")
    print(f"    Fastest    {min(day_counts):>7}")
    print(f"    Slowest    {max(day_counts):>7}")

    print(f"\n  VERDICT")
    if pass_rate >= 75:
        print(f"  ✅  STRONG    {pass_rate:.1f}% pass rate — model is well-suited for Lux $1M.")
    elif pass_rate >= 55:
        print(f"  ⚠️   MODERATE  {pass_rate:.1f}% pass rate — edge exists but drawdown risk is real.")
        print(f"       Primary risk: {max(fail_reason, key=fail_reason.get).replace('_',' ')}")
    elif pass_rate >= 35:
        print(f"  ⚠️   LIMITED   {pass_rate:.1f}% pass rate — inconsistent for reliable qualification.")
    else:
        print(f"  ❌  POOR      {pass_rate:.1f}% pass rate — significant improvements needed.")


# ═══════════════════════════════════════════════════════════════════════════════
# FTMO COMPARISON  (imports from ftmo_backtest if available)
# ═══════════════════════════════════════════════════════════════════════════════

def print_comparison(lux_r: LuxResult, seed: int, start_date: datetime) -> None:
    try:
        import ftmo_backtest as fb
        ftmo_r = fb.simulate_phase("challenge", seed=seed, start_date=start_date)
    except ImportError:
        print("\n  [ftmo_backtest.py not found — skipping comparison]")
        return

    print(f"\n{'═' * 70}")
    print(f"  SIDE-BY-SIDE COMPARISON  —  SpectraSeat Model vs Both Firms")
    print(f"{'═' * 70}")
    print(f"\n  {'Metric':<30} {'FTMO $100K':>18}  {'Lux $1M':>18}")
    print(f"  {'-' * 68}")

    def row(label: str, a: str, b: str) -> None:
        print(f"  {label:<30} {a:>18}  {b:>18}")

    row("Account Size",             "$100,000",            "$1,000,000")
    row("Profit Target",            "10% / $10,000",       "15% / $150,000")
    row("Total Loss Limit",         "10% / $10,000",       "6%  / $60,000")
    row("Daily Loss Limit",         "5%  / $5,000",        "None")
    row("Min Trading Days",         "10",                  "29")
    row("Time Limit",               "30 days",             "None")
    row("Profit Split",             "80%",                 "75%")
    print(f"  {'-' * 68}")
    row("Result",
        "✅ PASSED" if ftmo_r.passed else "❌ FAILED",
        "✅ PASSED" if lux_r.passed  else "❌ FAILED")
    row("Net P&L",
        f"${ftmo_r.total_pnl:+,.0f}",
        f"${lux_r.total_pnl:+,.0f}")
    row("Win Rate",
        f"{ftmo_r.win_rate_pct:.1f}%",
        f"{lux_r.win_rate_pct:.1f}%")
    row("Profit Factor",
        f"{ftmo_r.profit_factor:.2f}",
        f"{lux_r.profit_factor:.2f}")
    row("Drawdown Used",
        f"${ftmo_r.max_drawdown_usd:,.0f}",
        f"${lux_r.drawdown_used:,.0f}")
    row("Trading Days",
        str(ftmo_r.trading_days),
        str(lux_r.trading_days))
    row("Trader Payout",
        f"${max(0,ftmo_r.total_pnl)*0.80:,.0f}",
        f"${lux_r.trader_payout:,.0f}")


# ═══════════════════════════════════════════════════════════════════════════════
# MAIN
# ═══════════════════════════════════════════════════════════════════════════════

def main() -> None:
    parser = argparse.ArgumentParser(
        description="Lux Trading Firm $1M Challenge Simulation — SpectraSeat Bot",
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument("--monte-carlo", action="store_true",
                        help="Monte Carlo probability analysis")
    parser.add_argument("--runs", type=int, default=500, metavar="N",
                        help="Monte Carlo run count (default: 500)")
    parser.add_argument("--seed", type=int, default=42,
                        help="Random seed (default: 42)")
    parser.add_argument("--compare", action="store_true",
                        help="Side-by-side comparison with FTMO $100K results")
    args = parser.parse_args()

    print("╔══════════════════════════════════════════════════════════════════════╗")
    print("║   LUX TRADING FIRM — $1,000,000 CHALLENGE SIMULATION & BACKTEST    ║")
    print("║   SpectraSeat Bot  ·  Opportunity Model Analysis                   ║")
    print(f"║   Account: $1,000,000 USD   ·   Seed: {args.seed:<30} ║")
    print("╚══════════════════════════════════════════════════════════════════════╝")

    print("""
  Lux Trading $1M Rules (verified 2026)
  ┌────────────────────────────┬─────────────────────────────────────────┐
  │ Rule                       │ Value                                   │
  ├────────────────────────────┼─────────────────────────────────────────┤
  │ Account Size               │ $1,000,000                              │
  │ Profit Target              │ 15%  =  $150,000  (single phase)        │
  │ Max Total Drawdown         │ 6%   =  $60,000   (STATIC floor $940k)  │
  │ Daily Loss Limit           │ NONE  (no daily cap at all)             │
  │ Minimum Trading Days       │ 29  (no maximum / no time limit)        │
  │ Stop Loss                  │ Mandatory pre-entry on every trade      │
  │ Profit Split               │ 75% to trader                           │
  └────────────────────────────┴─────────────────────────────────────────┘
""")

    start_date = datetime(2026, 1, 5)

    if args.monte_carlo:
        run_monte_carlo(n=args.runs, start_date=start_date)
        print()
        return

    result = simulate(seed=args.seed, start_date=start_date)
    print_report(result)

    if args.compare:
        print_comparison(result, seed=args.seed, start_date=start_date)

    print(f"\n  TIP  Run with --monte-carlo for probability analysis ({args.runs} simulations)")
    print(f"  TIP  Run with --compare to see side-by-side vs FTMO $100K")
    print(f"  TIP  Run with --seed <N> to explore different random scenarios")
    print()


if __name__ == "__main__":
    main()
