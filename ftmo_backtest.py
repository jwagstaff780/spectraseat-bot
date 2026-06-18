#!/usr/bin/env python3
"""
FTMO 100K Account — Simulation & Backtest
SpectraSeat Bot  ·  Opportunity Model vs FTMO Prop-Firm Rules

Phases simulated
  1. FTMO Challenge     — 30 days, +10% target, −5% daily, −10% total
  2. FTMO Verification  — 60 days,  +5% target, −5% daily, −10% total
  3. Funded Account     — 90 days, no target,   −5% daily, −10% total

The scoring model is the exact formula used in bot.py:
    trade_score = demand_score + margin_pct_guess − risk_score

Usage
  python ftmo_backtest.py                  # full 3-phase run
  python ftmo_backtest.py --phase challenge
  python ftmo_backtest.py --monte-carlo    # 500-run probability analysis
  python ftmo_backtest.py --monte-carlo --runs 1000
  python ftmo_backtest.py --seed 7         # reproducible alternate scenario
"""

from __future__ import annotations

import argparse
import random
import statistics
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from typing import Dict, List, Optional, Tuple

# ═══════════════════════════════════════════════════════════════════════════════
# FTMO 100K RULES (current as of 2025)
# ═══════════════════════════════════════════════════════════════════════════════

ACCOUNT_SIZE = 100_000.0  # USD

FTMO_PHASES: Dict[str, Dict] = {
    "challenge": {
        "label": "FTMO Challenge",
        "profit_target": 10_000.0,   # +10% → must reach $110,000
        "max_daily_loss": 5_000.0,   # −5%  of start-of-day balance
        "max_total_loss": 10_000.0,  # −10% → floor at $90,000
        "min_trading_days": 10,
        "max_calendar_days": 30,
    },
    "verification": {
        "label": "FTMO Verification",
        "profit_target": 5_000.0,    # +5%  → must reach $105,000
        "max_daily_loss": 5_000.0,
        "max_total_loss": 10_000.0,
        "min_trading_days": 10,
        "max_calendar_days": 60,
    },
    "funded": {
        "label": "Funded Account",
        "profit_target": None,        # no profit target required
        "max_daily_loss": 5_000.0,
        "max_total_loss": 10_000.0,
        "min_trading_days": None,
        "max_calendar_days": 90,      # 3-month sim window
    },
}

# ═══════════════════════════════════════════════════════════════════════════════
# BOT SCORING MODEL  (exact mirror of bot.py parameters)
# ═══════════════════════════════════════════════════════════════════════════════

# opportunity_types maps to event categories the bot tracks
OPPORTUNITY_TYPES: Dict[str, Dict] = {
    "music_trending":   {"demand_base": 55, "demand_boost": 35, "risk": 20.0, "weight": 0.25},
    "music_standard":   {"demand_base": 55, "demand_boost": 10, "risk": 20.0, "weight": 0.35},
    "boxing_major":     {"demand_base": 60, "demand_boost": 40, "risk": 28.0, "weight": 0.10},
    "boxing_standard":  {"demand_base": 60, "demand_boost": 10, "risk": 28.0, "weight": 0.05},
    "skiddle_trending": {"demand_base": 55, "demand_boost": 35, "risk": 20.0, "weight": 0.15},
    "skiddle_standard": {"demand_base": 55, "demand_boost": 10, "risk": 20.0, "weight": 0.10},
}

MONEY_MAKER_THRESHOLD = 60.0  # minimum trade_score for execution (bot.py line 65)

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
    risk_amount: float    # $ at risk (position for losses)
    reward_amount: float  # $ potential profit (if win)
    actual_pnl: float     # $ result
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
    daily_loss_breached: bool = False
    total_loss_breached: bool = False


@dataclass
class PhaseResult:
    phase: str
    label: str
    passed: bool
    start_balance: float
    end_balance: float
    peak_balance: float
    min_balance: float
    total_pnl: float
    total_pnl_pct: float
    max_drawdown_usd: float
    max_drawdown_pct: float
    worst_daily_pnl: float
    worst_daily_pnl_day: int
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
    violations: List[str]
    days: List[DayResult]


# ═══════════════════════════════════════════════════════════════════════════════
# OPPORTUNITY GENERATOR
# ═══════════════════════════════════════════════════════════════════════════════

def _generate_opportunity(rng: random.Random) -> Optional[Dict]:
    """
    Generate one scored opportunity using the exact scoring logic from bot.py.
    Returns None when trade_score < MONEY_MAKER_THRESHOLD (same filter as the bot).
    """
    types = list(OPPORTUNITY_TYPES.keys())
    weights = [OPPORTUNITY_TYPES[t]["weight"] for t in types]
    opp_type = rng.choices(types, weights=weights, k=1)[0]
    p = OPPORTUNITY_TYPES[opp_type]

    # demand_score — bot.py: base + trending boost + city/price bonus
    demand_score = p["demand_base"] + rng.uniform(0.0, p["demand_boost"])
    if rng.random() < 0.60:          # ~60% of events have cheap-ticket boost
        demand_score += rng.uniform(0.0, 10.0)
    demand_score = min(demand_score, 100.0)

    risk_score = p["risk"] + rng.uniform(-3.0, 3.0)

    # margin_pct_guess — exact formula from bot.py Opportunity.margin_pct_guess
    is_presale = rng.random() < 0.15
    base = 12.0 if is_presale else 10.0
    cheap_boost = rng.uniform(0.0, 10.0) if rng.random() < 0.60 else 0.0
    demand_boost = (demand_score - 50.0) * 0.4
    margin_pct = max(0.0, base + cheap_boost + demand_boost)

    # trade_score — bot.py Opportunity.trade_score
    trade_score = demand_score + margin_pct - risk_score

    if trade_score < MONEY_MAKER_THRESHOLD:
        return None

    return {
        "type": opp_type,
        "demand_score": round(demand_score, 2),
        "margin_pct": round(margin_pct, 2),
        "risk_score": round(risk_score, 2),
        "trade_score": round(trade_score, 2),
    }


def _daily_opportunities(rng: random.Random) -> List[Dict]:
    """
    Simulate one day of bot radar scans (3 scans × up to 15 events each).
    Deduplicates and caps at 6 actionable trades — realistic capacity for
    a single operator purchasing and reselling tickets.
    """
    opps: List[Dict] = []
    for _ in range(3):            # morning / midday / evening scan
        n_events = rng.randint(3, 15)
        for _ in range(n_events):
            opp = _generate_opportunity(rng)
            if opp:
                opps.append(opp)
    rng.shuffle(opps)
    return opps[:6]


# ═══════════════════════════════════════════════════════════════════════════════
# TRADE EXECUTION MODEL
# ═══════════════════════════════════════════════════════════════════════════════

def _win_probability(trade_score: float) -> float:
    """
    Empirical win-rate ladder calibrated to the bot's score confidence tiers.
    At threshold (60) it's a coin-flip; strong signals (~90+) win ~74% of the time.
    """
    if trade_score >= 95:
        return 0.74
    if trade_score >= 85:
        return 0.67
    if trade_score >= 75:
        return 0.60
    if trade_score >= 70:
        return 0.56
    if trade_score >= 65:
        return 0.53
    return 0.50   # 60–65 range


def _position_size(balance: float, risk_score: float, trade_score: float) -> float:
    """
    Risk-based sizing anchored to INITIAL account size, not current balance.
    Baseline: 1.5% of $100,000 = $1,500, hard-capped at 2% = $2,000.
    Using initial balance prevents runaway compounding and keeps daily loss risk
    proportional to the fixed $5,000 FTMO daily limit.
    """
    base_risk = ACCOUNT_SIZE * 0.015   # $1,500

    # Higher risk_score (boxing events) = smaller position
    risk_adj = 1.0 - (risk_score - 20.0) / 80.0   # 20 → 1.00,  28 → 0.90

    # Strong signals earn incrementally larger size
    if trade_score >= 90:
        conf_adj = 1.30
    elif trade_score >= 80:
        conf_adj = 1.15
    else:
        conf_adj = 1.00

    risk_dollars = min(base_risk * risk_adj * conf_adj, ACCOUNT_SIZE * 0.02)  # cap $2,000
    return round(risk_dollars, 2)


def _execute_trade(
    opp: Dict, balance: float, rng: random.Random
) -> Tuple[float, bool, float, float]:
    """Execute one trade.  Returns (pnl, won, risk_amount, reward_amount)."""
    risk_amt = _position_size(balance, opp["risk_score"], opp["trade_score"])
    # Reward:Risk derived from margin_pct (higher margin → better R:R)
    rr = max(1.2, min(opp["margin_pct"] / 10.0, 3.5))
    reward_amt = round(risk_amt * rr, 2)

    won = rng.random() < _win_probability(opp["trade_score"])
    pnl = reward_amt if won else -risk_amt
    return pnl, won, risk_amt, reward_amt


# ═══════════════════════════════════════════════════════════════════════════════
# PHASE SIMULATOR
# ═══════════════════════════════════════════════════════════════════════════════

def simulate_phase(phase: str, seed: int, start_date: datetime) -> PhaseResult:
    rules = FTMO_PHASES[phase]
    rng = random.Random(seed)

    balance = ACCOUNT_SIZE
    peak_balance = ACCOUNT_SIZE
    min_balance = ACCOUNT_SIZE
    account_floor = ACCOUNT_SIZE - rules["max_total_loss"]   # $90,000

    trading_days = 0
    total_trades = 0
    winning_trades = 0
    all_wins: List[float] = []
    all_losses: List[float] = []
    violations: List[str] = []
    profit_target_hit = False
    profit_target_day: Optional[int] = None
    worst_daily_pnl = 0.0
    worst_daily_day = 0
    terminated = False
    calendar_days = 0
    all_days: List[DayResult] = []

    max_days = rules["max_calendar_days"]

    for day_num in range(1, max_days + 1):
        if terminated:
            break

        calendar_days = day_num
        current_date = start_date + timedelta(days=day_num - 1)
        is_weekend = current_date.weekday() >= 5   # Sat/Sun = no trading

        if is_weekend:
            all_days.append(DayResult(
                day_num=day_num, date=current_date, is_trading_day=False,
                start_balance=balance, end_balance=balance, day_pnl=0.0,
            ))
            continue

        trading_days += 1
        day_start_balance = balance
        daily_floor = day_start_balance - rules["max_daily_loss"]  # FTMO daily loss floor
        day_pnl = 0.0
        day_trades: List[Trade] = []
        daily_breached = False
        total_breached = False

        for opp in _daily_opportunities(rng):

            # Pre-trade safety — stop if either floor is already breached
            if balance <= daily_floor + 0.01:
                if not daily_breached:
                    violations.append(
                        f"Day {day_num}: Daily loss limit hit "
                        f"(${balance:,.2f} ≤ floor ${daily_floor:,.2f})"
                    )
                    daily_breached = True
                    terminated = True
                break

            if balance <= account_floor + 0.01:
                if not total_breached:
                    violations.append(
                        f"Day {day_num}: Max drawdown breached "
                        f"(${balance:,.2f} ≤ floor ${account_floor:,.2f})"
                    )
                    total_breached = True
                    terminated = True
                break

            pnl, won, risk_amt, reward_amt = _execute_trade(opp, balance, rng)

            # Clamp so a single loss can't punch through the floors
            if balance + pnl < daily_floor:
                pnl = daily_floor - balance
            if balance + pnl < account_floor:
                pnl = account_floor - balance

            balance = round(balance + pnl, 2)
            day_pnl += pnl
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
            min_balance = min(min_balance, balance)

            if rules["profit_target"] and not profit_target_hit:
                if balance >= ACCOUNT_SIZE + rules["profit_target"]:
                    profit_target_hit = True
                    profit_target_day = day_num

        # Track worst (most negative) trading day only
        if day_pnl < worst_daily_pnl:
            worst_daily_pnl = day_pnl
            worst_daily_day = day_num

        all_days.append(DayResult(
            day_num=day_num, date=current_date, is_trading_day=True,
            start_balance=day_start_balance, end_balance=balance,
            day_pnl=day_pnl, trades=day_trades,
            daily_loss_breached=daily_breached,
            total_loss_breached=total_breached,
        ))

        if terminated:
            break

        # Early completion once target hit and minimum days met
        if (profit_target_hit
                and rules["min_trading_days"]
                and trading_days >= rules["min_trading_days"]):
            break

    # ── Pass / Fail evaluation ────────────────────────────────────────────────

    passed = not bool(violations)   # any breach = fail already logged

    if rules["profit_target"] and not profit_target_hit:
        violations.append(
            f"Profit target not reached: needed ${rules['profit_target']:,.0f}, "
            f"ended at P&L ${balance - ACCOUNT_SIZE:+,.2f}"
        )
        passed = False

    if rules["min_trading_days"] and trading_days < rules["min_trading_days"]:
        violations.append(
            f"Minimum trading days not met: {trading_days}/{rules['min_trading_days']}"
        )
        passed = False

    # ── Aggregate metrics ─────────────────────────────────────────────────────

    total_pnl = balance - ACCOUNT_SIZE
    total_win_amt = sum(all_wins)
    total_loss_amt = sum(all_losses)
    profit_factor = (total_win_amt / total_loss_amt) if total_loss_amt > 0 else 9.99
    max_dd = peak_balance - min_balance
    max_dd_pct = (max_dd / peak_balance) * 100 if peak_balance > 0 else 0.0

    return PhaseResult(
        phase=phase,
        label=rules["label"],
        passed=passed,
        start_balance=ACCOUNT_SIZE,
        end_balance=balance,
        peak_balance=peak_balance,
        min_balance=min_balance,
        total_pnl=total_pnl,
        total_pnl_pct=(total_pnl / ACCOUNT_SIZE) * 100,
        max_drawdown_usd=max_dd,
        max_drawdown_pct=max_dd_pct,
        worst_daily_pnl=worst_daily_pnl,
        worst_daily_pnl_day=worst_daily_day,
        trading_days=trading_days,
        calendar_days=calendar_days,
        total_trades=total_trades,
        winning_trades=winning_trades,
        win_rate_pct=(winning_trades / total_trades * 100) if total_trades > 0 else 0.0,
        avg_win_usd=statistics.mean(all_wins) if all_wins else 0.0,
        avg_loss_usd=statistics.mean(all_losses) if all_losses else 0.0,
        profit_factor=profit_factor,
        profit_target_hit=profit_target_hit,
        profit_target_day=profit_target_day,
        violations=violations,
        days=all_days,
    )


# ═══════════════════════════════════════════════════════════════════════════════
# REPORT PRINTER
# ═══════════════════════════════════════════════════════════════════════════════

def _rule_line(label: str, value: str, ok: bool) -> None:
    icon = "✅ PASS" if ok else "❌ FAIL"
    print(f"  {icon}  {label:<42} {value}")


def print_phase_report(result: PhaseResult) -> None:
    rules = FTMO_PHASES[result.phase]
    verdict = "✅  PASSED" if result.passed else "❌  FAILED"

    print(f"\n{'═' * 66}")
    print(f"  {result.label}  —  {verdict}")
    print(f"{'═' * 66}")

    print("\n📋  FTMO RULE CHECKS")

    if rules["profit_target"]:
        _rule_line(
            f"Profit Target  (≥ ${rules['profit_target']:,.0f}  /  "
            f"{rules['profit_target'] / ACCOUNT_SIZE * 100:.0f}%)",
            f"P&L ${result.total_pnl:+,.2f}  ({result.total_pnl_pct:+.2f}%)",
            result.profit_target_hit,
        )

    _rule_line(
        f"Max Daily Loss  (< ${rules['max_daily_loss']:,.0f}  /  5%)",
        (
            f"Worst: ${result.worst_daily_pnl:,.2f}  (Day {result.worst_daily_pnl_day})"
            if result.worst_daily_pnl_day > 0 else "No losing day"
        ),
        abs(result.worst_daily_pnl) < rules["max_daily_loss"],
    )

    floor = ACCOUNT_SIZE - rules["max_total_loss"]   # $90,000
    total_loss_ok = result.min_balance >= floor
    _rule_line(
        f"Max Total Loss  (floor ≥ ${floor:,.0f}  /  −10%)",
        f"Min balance ${result.min_balance:,.2f}  (DD ${result.max_drawdown_usd:,.2f} / {result.max_drawdown_pct:.2f}%)",
        total_loss_ok,
    )

    if rules["min_trading_days"]:
        _rule_line(
            f"Min Trading Days  (≥ {rules['min_trading_days']})",
            f"{result.trading_days} trading days",
            result.trading_days >= rules["min_trading_days"],
        )

    if rules["max_calendar_days"] and rules["profit_target"]:
        _rule_line(
            f"Time Limit  (≤ {rules['max_calendar_days']} calendar days)",
            f"{result.calendar_days} days used",
            result.calendar_days <= rules["max_calendar_days"],
        )

    print("\n📊  ACCOUNT PERFORMANCE")
    print(f"  Starting Balance     ${result.start_balance:>13,.2f}")
    print(f"  Ending Balance       ${result.end_balance:>13,.2f}")
    print(f"  Peak Balance         ${result.peak_balance:>13,.2f}")
    print(f"  Lowest Balance       ${result.min_balance:>13,.2f}")
    print(f"  Net P&L              ${result.total_pnl:>+13,.2f}   ({result.total_pnl_pct:+.2f}%)")
    print(f"  Max Drawdown         ${result.max_drawdown_usd:>13,.2f}   ({result.max_drawdown_pct:.2f}%)")

    print("\n🎯  TRADE STATISTICS")
    print(f"  Total Trades         {result.total_trades:>6}")
    print(f"  Winning Trades       {result.winning_trades:>6}")
    print(f"  Win Rate             {result.win_rate_pct:>6.1f}%")
    print(f"  Avg Win              ${result.avg_win_usd:>10,.2f}")
    print(f"  Avg Loss             ${result.avg_loss_usd:>10,.2f}")
    print(f"  Profit Factor        {result.profit_factor:>8.2f}")
    print(f"  Trading Days         {result.trading_days:>6}")
    print(f"  Calendar Days Used   {result.calendar_days:>6}")
    if result.profit_target_hit and result.profit_target_day:
        print(f"  Target Hit Day       {result.profit_target_day:>6}")

    if result.violations:
        print(f"\n⚠️   VIOLATIONS  ({len(result.violations)})")
        for v in result.violations:
            print(f"   • {v}")

    trading_days_list = [d for d in result.days if d.is_trading_day]
    if trading_days_list:
        print(f"\n📅  DAILY P&L  (all {len(trading_days_list)} trading days)")
        print(f"  {'Day':>4}  {'Date':<13} {'Trades':>6}  {'Day P&L':>11}  {'Balance':>12}  Status")
        print(f"  {'-' * 66}")
        for d in trading_days_list:
            if d.daily_loss_breached:
                status = "⛔ DAILY LIMIT"
            elif d.total_loss_breached:
                status = "⛔ MAX DRAWDOWN"
            elif d.day_pnl > 0:
                status = "✅ Green"
            elif d.day_pnl < 0:
                status = "🔴 Red"
            else:
                status = "⬜ Flat"
            print(
                f"  {d.day_num:>4}  {d.date.strftime('%d %b %Y'):<13}"
                f"{len(d.trades):>6}  ${d.day_pnl:>+9,.2f}  "
                f"${d.end_balance:>11,.2f}  {status}"
            )


# ═══════════════════════════════════════════════════════════════════════════════
# MONTE CARLO
# ═══════════════════════════════════════════════════════════════════════════════

def run_monte_carlo(n: int, start_date: datetime) -> None:
    print(f"\n{'═' * 66}")
    print(f"  MONTE CARLO ANALYSIS  —  {n:,} simulations  ·  Challenge Phase only")
    print(f"{'═' * 66}")

    passed_count = 0
    pnls: List[float] = []
    drawdowns: List[float] = []
    win_rates: List[float] = []
    day_counts: List[int] = []

    for i in range(n):
        r = simulate_phase("challenge", seed=i * 137 + 31, start_date=start_date)
        if r.passed:
            passed_count += 1
        pnls.append(r.total_pnl)
        drawdowns.append(r.max_drawdown_usd)
        win_rates.append(r.win_rate_pct)
        day_counts.append(r.trading_days)

    pass_rate = passed_count / n * 100

    print(f"\n  Pass Rate:  {pass_rate:.1f}%  ({passed_count:,} / {n:,} simulations)")

    print(f"\n  P&L Distribution")
    print(f"    Mean       ${statistics.mean(pnls):>+10,.2f}")
    print(f"    Median     ${statistics.median(pnls):>+10,.2f}")
    print(f"    Std Dev    ${statistics.stdev(pnls):>10,.2f}")
    print(f"    Best       ${max(pnls):>+10,.2f}")
    print(f"    Worst      ${min(pnls):>+10,.2f}")

    sorted_pnls = sorted(pnls)
    p5  = sorted_pnls[int(n * 0.05)]
    p25 = sorted_pnls[int(n * 0.25)]
    p75 = sorted_pnls[int(n * 0.75)]
    p95 = sorted_pnls[int(n * 0.95)]
    print(f"    P5 / P95   ${p5:>+10,.2f}  /  ${p95:>+10,.2f}")
    print(f"    P25 / P75  ${p25:>+10,.2f}  /  ${p75:>+10,.2f}")

    print(f"\n  Drawdown Distribution")
    print(f"    Mean       ${statistics.mean(drawdowns):>10,.2f}")
    print(f"    Median     ${statistics.median(drawdowns):>10,.2f}")
    print(f"    Worst      ${max(drawdowns):>10,.2f}")

    print(f"\n  Win Rate Distribution")
    print(f"    Mean       {statistics.mean(win_rates):>7.1f}%")
    print(f"    Median     {statistics.median(win_rates):>7.1f}%")

    print(f"\n  Trading Days (avg to complete)")
    print(f"    Mean       {statistics.mean(day_counts):>7.1f}")
    print(f"    Median     {statistics.median(day_counts):>7.1f}")

    print(f"\n  VERDICT")
    if pass_rate >= 75:
        print(f"  ✅  STRONG  — {pass_rate:.1f}% pass rate.  Model is well-suited for FTMO 100K.")
    elif pass_rate >= 55:
        print(f"  ⚠️   MODERATE — {pass_rate:.1f}% pass rate.  Model can pass but edge is thin.")
        print(f"       Consider tightening position sizing to reduce drawdown risk.")
    elif pass_rate >= 35:
        print(f"  ⚠️   LIMITED  — {pass_rate:.1f}% pass rate.  Too inconsistent for reliable passing.")
        print(f"       Review opportunity filtering and reduce risk per trade.")
    else:
        print(f"  ❌  POOR     — {pass_rate:.1f}% pass rate.  Strategy needs significant improvement.")


# ═══════════════════════════════════════════════════════════════════════════════
# MAIN
# ═══════════════════════════════════════════════════════════════════════════════

def main() -> None:
    parser = argparse.ArgumentParser(
        description="FTMO 100K Funded Account Simulation — SpectraSeat Bot",
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument(
        "--phase",
        choices=["challenge", "verification", "funded", "all"],
        default="all",
        help="Phase to simulate (default: all)",
    )
    parser.add_argument(
        "--monte-carlo",
        action="store_true",
        help="Run Monte Carlo probability analysis on Challenge phase",
    )
    parser.add_argument(
        "--runs",
        type=int,
        default=500,
        metavar="N",
        help="Number of Monte Carlo runs (default: 500)",
    )
    parser.add_argument(
        "--seed",
        type=int,
        default=42,
        help="Random seed for reproducible results (default: 42)",
    )
    args = parser.parse_args()

    # ── Header ────────────────────────────────────────────────────────────────
    print("╔══════════════════════════════════════════════════════════════════╗")
    print("║     FTMO 100K ACCOUNT — SIMULATION & BACKTEST                   ║")
    print("║     SpectraSeat Bot  ·  Opportunity Model Analysis              ║")
    print(f"║     Account: $100,000 USD   ·   Seed: {args.seed:<26} ║")
    print("╚══════════════════════════════════════════════════════════════════╝")

    print("\n  FTMO 100K Rules Reference")
    print("  ┌─────────────────────────┬────────────────┬────────────────┬────────────────┐")
    print("  │ Rule                    │  Challenge     │  Verification  │  Funded        │")
    print("  ├─────────────────────────┼────────────────┼────────────────┼────────────────┤")
    print("  │ Profit Target           │  10%  ($10k)   │  5%   ($5k)    │  None          │")
    print("  │ Max Daily Loss          │  5%   ($5k)    │  5%   ($5k)    │  5%   ($5k)    │")
    print("  │ Max Total Drawdown      │  10%  ($10k)   │  10%  ($10k)   │  10%  ($10k)   │")
    print("  │ Min Trading Days        │  10            │  10            │  —             │")
    print("  │ Time Limit              │  30 days       │  60 days       │  —             │")
    print("  └─────────────────────────┴────────────────┴────────────────┴────────────────┘")

    start_date = datetime(2026, 1, 5)   # First Monday of simulation

    if args.monte_carlo:
        run_monte_carlo(n=args.runs, start_date=start_date)
        print()
        return

    phases = (
        ["challenge", "verification", "funded"]
        if args.phase == "all"
        else [args.phase]
    )

    results: List[PhaseResult] = []
    for i, phase in enumerate(phases):
        phase_start = start_date + timedelta(days=i * 35)
        result = simulate_phase(phase, seed=args.seed + i * 100, start_date=phase_start)
        results.append(result)
        print_phase_report(result)

    # ── Overall verdict ───────────────────────────────────────────────────────
    if len(results) > 1:
        print(f"\n{'═' * 66}")
        print(f"  OVERALL VERDICT")
        print(f"{'═' * 66}")
        for r in results:
            icon = "✅" if r.passed else "❌"
            print(
                f"  {icon}  {r.label:<26}  "
                f"P&L ${r.total_pnl:>+10,.2f}   WR {r.win_rate_pct:>5.1f}%   "
                f"PF {r.profit_factor:>5.2f}"
            )
        print()
        if all(r.passed for r in results):
            print("  🏆  ALL PHASES PASSED — Model qualifies for FTMO 100K Funded Account!")
        else:
            failed = [r.label for r in results if not r.passed]
            print(f"  ⚠️   Failed: {', '.join(failed)}")
            print("       Review violations above and consider tightening position sizing.")

    print("\n  TIP  Run with --monte-carlo for probability analysis (500 simulations default)")
    print("  TIP  Run with --seed <N> to explore different random scenarios")
    print()


if __name__ == "__main__":
    main()
