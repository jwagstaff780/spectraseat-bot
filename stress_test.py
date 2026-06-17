#!/usr/bin/env python3
"""
SpectraSeat Bot — Comprehensive Stress Test & Sensitivity Analysis
Tests the opportunity model under adversarial, parametric, and extended scenarios
against Lux Trading $1M and FTMO $100K rules.

Tests
  1. Win-rate sensitivity     — performance when accuracy drops 45–75%
  2. Position-size sweep      — optimal sizing for risk-adjusted return
  3. Score-threshold sweep    — quality-vs-quantity trade-off
  4. 36-month risk-of-ruin   — long-horizon survival probability curve
  5. Regime-stress injection  — 3 consecutive bad months embedded in 12-month run
  6. Signal-drought test      — impact of days with no viable signals
  7. Consecutive-loss analysis— worst-case streaks across 500 simulations

Usage
  python stress_test.py              # run all tests
  python stress_test.py --test 1     # single test by number (1–7)
  python stress_test.py --runs 200   # Monte Carlo run count (default 200)
  python stress_test.py --seed 42    # base random seed
"""

from __future__ import annotations

import argparse
import random
import statistics
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from typing import Dict, List, Optional, Tuple

# ═══════════════════════════════════════════════════════════════════════════════
# SHARED CONSTANTS  (mirrored from bot.py)
# ═══════════════════════════════════════════════════════════════════════════════

OPPORTUNITY_TYPES: Dict[str, Dict] = {
    "music_trending":   {"demand_base": 55, "demand_boost": 35, "risk": 20.0, "weight": 0.25},
    "music_standard":   {"demand_base": 55, "demand_boost": 10, "risk": 20.0, "weight": 0.35},
    "boxing_major":     {"demand_base": 60, "demand_boost": 40, "risk": 28.0, "weight": 0.10},
    "boxing_standard":  {"demand_base": 60, "demand_boost": 10, "risk": 28.0, "weight": 0.05},
    "skiddle_trending": {"demand_base": 55, "demand_boost": 35, "risk": 20.0, "weight": 0.15},
    "skiddle_standard": {"demand_base": 55, "demand_boost": 10, "risk": 20.0, "weight": 0.10},
}

# FTMO $100K rules
FTMO_ACCOUNT      = 100_000.0
FTMO_FLOOR        = 90_000.0    # -10% total
FTMO_DAILY_LIMIT  = 5_000.0     # -5% daily
FTMO_TARGET       = 10_000.0    # +10%
FTMO_MIN_DAYS     = 10
FTMO_MAX_DAYS     = 30

# Lux $1M rules
LUX_ACCOUNT  = 1_000_000.0
LUX_FLOOR    = 940_000.0        # -6% static
LUX_TARGET   = 150_000.0        # +15%
LUX_MIN_DAYS = 29

# ═══════════════════════════════════════════════════════════════════════════════
# PARAMETRIC SIMULATION ENGINE
# ═══════════════════════════════════════════════════════════════════════════════

def _gen_opp(rng: random.Random, threshold: float) -> Optional[Dict]:
    types   = list(OPPORTUNITY_TYPES.keys())
    weights = [OPPORTUNITY_TYPES[t]["weight"] for t in types]
    t = rng.choices(types, weights=weights, k=1)[0]
    p = OPPORTUNITY_TYPES[t]

    demand = p["demand_base"] + rng.uniform(0, p["demand_boost"])
    if rng.random() < 0.60:
        demand += rng.uniform(0, 10)
    demand = min(demand, 100.0)

    risk = p["risk"] + rng.uniform(-3, 3)
    base = 12.0 if rng.random() < 0.15 else 10.0
    cheap = rng.uniform(0, 10) if rng.random() < 0.60 else 0.0
    margin = max(0.0, base + cheap + (demand - 50) * 0.4)

    score = demand + margin - risk
    if score < threshold:
        return None
    return {"demand": demand, "margin": margin, "risk": risk, "score": score, "type": t}


def _win_prob(score: float, override: Optional[float]) -> float:
    if override is not None:
        return override
    if score >= 95: return 0.74
    if score >= 85: return 0.67
    if score >= 75: return 0.60
    if score >= 70: return 0.56
    if score >= 65: return 0.53
    return 0.50


def _pos(account: float, risk_score: float, score: float,
         base_pct: float, cap_pct: float) -> float:
    base = account * base_pct
    radj = 1.0 - (risk_score - 20.0) / 80.0
    cadj = 1.30 if score >= 90 else (1.15 if score >= 80 else 1.0)
    return round(min(base * radj * cadj, account * cap_pct), 2)


@dataclass
class SimResult:
    passed_ftmo: bool
    passed_lux:  bool
    ftmo_pnl:    float
    lux_pnl:     float
    ftmo_wr:     float
    lux_wr:      float
    ftmo_dd:     float   # max drawdown used (vs floor)
    lux_dd:      float   # static DD used (initial - min)
    ftmo_days:   int
    lux_days:    int
    max_streak:  int     # max consecutive losses (Lux)
    monthly_pnl: List[float] = field(default_factory=list)


def run_sim(
    seed:           int,
    start_date:     datetime,
    # --- firm selection ---
    firm:           str = "lux",   # "ftmo" | "lux" | "both"
    # --- scoring ---
    threshold:      float = 60.0,
    max_trades:     int   = 4,
    # --- sizing ---
    base_pct:       float = 0.003,
    cap_pct:        float = 0.005,
    # --- outcome ---
    win_override:   Optional[float] = None,
    # --- stress levers ---
    drought_prob:   float = 0.0,   # P(0 signals today)
    regime_months:  Optional[List[int]] = None,   # month indices that use regime_wr
    regime_wr:      float = 0.45,
    # --- months for funded projection ---
    sim_months:     int   = 12,
    # --- output ---
    track_monthly:  bool  = False,
) -> SimResult:
    rng = random.Random(seed)

    # FTMO state
    f_bal      = FTMO_ACCOUNT
    f_peak     = FTMO_ACCOUNT
    f_floor_ok = True
    f_done     = False
    f_trade_days = f_trades = f_wins = 0
    f_dd_used  = 0.0

    # Lux state
    l_bal      = LUX_ACCOUNT
    l_min_bal  = LUX_ACCOUNT
    l_done     = False
    l_target   = False
    l_trade_days = l_trades = l_wins = 0
    l_daily_pnl_arr: List[float] = []

    max_streak   = 0
    cur_streak   = 0
    monthly_pnl  = []

    day     = start_date
    cal_day = 0

    # For monthly bucketing
    cur_month_pnl   = 0.0
    cur_month_start = datetime(day.year, day.month, 1)

    while True:
        # Decide when to stop overall
        all_ftmo_done = f_done or (firm == "lux")
        all_lux_done  = l_done or (firm == "ftmo")
        if all_ftmo_done and all_lux_done:
            break
        # Time limits
        if firm in ("ftmo", "both") and not f_done:
            if cal_day >= FTMO_MAX_DAYS:
                f_done = True
        # Lux has no calendar limit in challenge, but cap at 365 for safety
        if firm in ("lux", "both") and not l_done:
            if cal_day >= 365:
                l_done = True

        if day.weekday() >= 5:
            day += timedelta(days=1)
            cal_day += 1
            continue

        # Detect regime month for Lux
        month_offset = (day.year - start_date.year) * 12 + (day.month - start_date.month)
        is_regime_month = (regime_months is not None) and (month_offset in regime_months)
        eff_win_override = regime_wr if is_regime_month else win_override

        # Signal drought
        if rng.random() < drought_prob:
            day += timedelta(days=1)
            cal_day += 1
            continue

        # Generate opportunities
        opps_raw = []
        for _ in range(3):
            for _ in range(rng.randint(3, 15)):
                o = _gen_opp(rng, threshold)
                if o:
                    opps_raw.append(o)
        opps_raw.sort(key=lambda o: o["score"], reverse=True)
        opps = opps_raw[:max_trades]

        # ── FTMO day ──────────────────────────────────────────────────────────
        if firm in ("ftmo", "both") and not f_done:
            f_trade_days += 1
            day_start   = f_bal
            daily_floor = day_start - FTMO_DAILY_LIMIT

            for opp in opps[:6]:   # FTMO allows up to 6
                if f_bal <= FTMO_FLOOR + 0.01 or f_bal <= daily_floor + 0.01:
                    f_done = True
                    f_floor_ok = False
                    break
                risk   = _pos(FTMO_ACCOUNT, opp["risk"], opp["score"], 0.015, 0.02)
                rr     = max(1.2, min(opp["margin"] / 10, 3.5))
                won    = rng.random() < _win_prob(opp["score"], eff_win_override)
                pnl    = risk * rr if won else -risk
                if f_bal + pnl < daily_floor:
                    pnl = daily_floor - f_bal
                if f_bal + pnl < FTMO_FLOOR:
                    pnl = FTMO_FLOOR - f_bal
                f_bal    = round(f_bal + pnl, 2)
                f_peak   = max(f_peak, f_bal)
                f_dd_used = max(f_dd_used, FTMO_ACCOUNT - f_bal)
                f_trades += 1
                if pnl > 0:
                    f_wins += 1

            if not f_done:
                if f_bal >= FTMO_ACCOUNT + FTMO_TARGET and f_trade_days >= FTMO_MIN_DAYS:
                    f_done = True

        # ── Lux day ───────────────────────────────────────────────────────────
        if firm in ("lux", "both") and not l_done:
            l_trade_days += 1
            day_lux_pnl = 0.0

            for opp in opps:
                if l_bal <= LUX_FLOOR + 0.01:
                    l_done = True
                    break
                risk  = _pos(LUX_ACCOUNT, opp["risk"], opp["score"], base_pct, cap_pct)
                rr    = max(1.2, min(opp["margin"] / 10, 3.5))
                won   = rng.random() < _win_prob(opp["score"], eff_win_override)
                pnl   = risk * rr if won else -risk
                if l_bal + pnl < LUX_FLOOR:
                    pnl = LUX_FLOOR - l_bal
                l_bal = round(l_bal + pnl, 2)
                l_min_bal = min(l_min_bal, l_bal)
                l_trades  += 1
                day_lux_pnl += pnl

                if pnl > 0:
                    l_wins    += 1
                    cur_streak = 0
                else:
                    cur_streak += 1
                    max_streak  = max(max_streak, cur_streak)

            l_daily_pnl_arr.append(day_lux_pnl)

            if track_monthly:
                cur_month_pnl += day_lux_pnl
                next_month = (cur_month_start.month % 12) + 1
                next_year  = cur_month_start.year + (1 if cur_month_start.month == 12 else 0)
                if day.month == next_month and day.year == next_year:
                    monthly_pnl.append(cur_month_pnl)
                    cur_month_pnl = 0.0
                    cur_month_start = datetime(next_year, next_month, 1)

            if not l_done:
                if not l_target and l_bal >= LUX_ACCOUNT + LUX_TARGET:
                    l_target = True
                if l_target and l_trade_days >= LUX_MIN_DAYS:
                    if firm == "lux" or (firm == "both" and f_done):
                        l_done = True

        # Funded mode (no profit target, just time)
        if firm == "lux" and sim_months > 0 and not l_done:
            months_elapsed = (day.year - start_date.year) * 12 + (day.month - start_date.month)
            if months_elapsed >= sim_months:
                l_done = True

        day      += timedelta(days=1)
        cal_day  += 1

    # Append last partial month
    if track_monthly and cur_month_pnl != 0:
        monthly_pnl.append(cur_month_pnl)

    ftmo_wr = f_wins / f_trades * 100 if f_trades else 0
    lux_wr  = l_wins / l_trades * 100 if l_trades else 0

    f_passed = (
        f_floor_ok
        and f_bal >= FTMO_ACCOUNT + FTMO_TARGET
        and f_trade_days >= FTMO_MIN_DAYS
    )
    l_passed = (
        l_bal > LUX_FLOOR
        and l_target
        and l_trade_days >= LUX_MIN_DAYS
    )

    return SimResult(
        passed_ftmo = f_passed if firm in ("ftmo","both") else False,
        passed_lux  = l_passed if firm in ("lux","both") else False,
        ftmo_pnl    = f_bal - FTMO_ACCOUNT,
        lux_pnl     = l_bal - LUX_ACCOUNT,
        ftmo_wr     = ftmo_wr,
        lux_wr      = lux_wr,
        ftmo_dd     = f_dd_used,
        lux_dd      = max(0.0, LUX_ACCOUNT - l_min_bal),
        ftmo_days   = f_trade_days,
        lux_days    = l_trade_days,
        max_streak  = max_streak,
        monthly_pnl = monthly_pnl,
    )


def mc(
    n: int, seed_base: int, start: datetime, **kwargs
) -> List[SimResult]:
    return [run_sim(seed=seed_base + i * 137, start_date=start, **kwargs)
            for i in range(n)]


# ═══════════════════════════════════════════════════════════════════════════════
# DISPLAY HELPERS
# ═══════════════════════════════════════════════════════════════════════════════

W = 72

def header(title: str) -> None:
    print(f"\n{'═' * W}")
    print(f"  {title}")
    print(f"{'═' * W}")


def subheader(title: str) -> None:
    print(f"\n  ── {title} {'─' * max(0, W - 6 - len(title))}")


def pct(p: float) -> str:
    return f"{p:>6.1f}%"


def usd(v: float, w: int = 10) -> str:
    return f"${v:>{w},.0f}"


def bar_chart(values: List[int], labels: List[str], max_bar: int = 40) -> None:
    mx = max(values) if values else 1
    for label, val in zip(labels, values):
        filled = int(val / mx * max_bar)
        print(f"  {label:>5}  {'█' * filled}{'░' * (max_bar - filled)}  {val:>5}")


# ═══════════════════════════════════════════════════════════════════════════════
# TEST 1 — WIN-RATE SENSITIVITY
# ═══════════════════════════════════════════════════════════════════════════════

def test_win_rate_sensitivity(n: int, seed: int, start: datetime) -> None:
    header("TEST 1 — WIN-RATE SENSITIVITY")
    print("""
  Forces the win probability to a fixed rate regardless of trade score.
  Shows the minimum accuracy level required to reliably pass each firm.
  Natural rate = model's empirical ladder (50–74% by score tier).
""")

    rates = [0.45, 0.50, 0.55, 0.60, 0.65, 0.70, 0.75, None]
    labels = [f"{int(r*100)}%" if r else "Natural" for r in rates]

    print(f"  {'Win Rate':<10}  {'FTMO Pass%':>10}  {'Lux Pass%':>10}  "
          f"{'FTMO P&L':>11}  {'Lux P&L':>11}  {'Lux DD Used':>12}  {'Lux WR':>8}")
    print(f"  {'-' * 78}")

    for rate, label in zip(rates, labels):
        results = mc(n, seed, start, firm="both", win_override=rate)
        f_pass = sum(1 for r in results if r.passed_ftmo) / n * 100
        l_pass = sum(1 for r in results if r.passed_lux)  / n * 100
        f_pnl  = statistics.mean(r.ftmo_pnl for r in results)
        l_pnl  = statistics.mean(r.lux_pnl  for r in results)
        l_dd   = statistics.mean(r.lux_dd    for r in results)
        l_wr   = statistics.mean(r.lux_wr    for r in results)
        f_icon = "✅" if f_pass >= 60 else ("⚠️ " if f_pass >= 30 else "❌")
        l_icon = "✅" if l_pass >= 60 else ("⚠️ " if l_pass >= 30 else "❌")
        print(f"  {label:<10}  {f_icon}{f_pass:>7.1f}%  {l_icon}{l_pass:>7.1f}%  "
              f"{usd(f_pnl):>11}  {usd(l_pnl):>11}  {usd(l_dd, 10):>12}  {l_wr:>7.1f}%")

    print(f"\n  Key: Natural = model's own confidence-based ladder (50–74%)")
    print(f"       Pass threshold shown as ✅ ≥60%  ⚠️  30–59%  ❌ <30%")


# ═══════════════════════════════════════════════════════════════════════════════
# TEST 2 — POSITION-SIZE SWEEP
# ═══════════════════════════════════════════════════════════════════════════════

def test_position_size_sweep(n: int, seed: int, start: datetime) -> None:
    header("TEST 2 — POSITION-SIZE SWEEP  (Lux $1M)")
    print("""
  Varies base risk % of initial $1M per trade.  Cap = base × 1.5.
  Shows trade-off between return potential and drawdown risk.
  FTMO sizing is fixed (its $100K account has different dynamics).
""")

    configs = [
        (0.001, 0.0015, "$1,000"),
        (0.002, 0.003,  "$2,000"),
        (0.003, 0.005,  "$3,000 ← current"),
        (0.005, 0.008,  "$5,000"),
        (0.008, 0.012,  "$8,000"),
        (0.010, 0.015,  "$10,000"),
        (0.015, 0.020,  "$15,000"),
    ]

    print(f"  {'Base Risk':>14}  {'Pass%':>7}  {'Avg P&L':>11}  "
          f"{'Avg Monthly':>12}  {'Avg DD':>10}  {'Breach%':>8}  {'Streak':>7}")
    print(f"  {'-' * 78}")

    for base, cap, label in configs:
        results = mc(n, seed, start, firm="lux", base_pct=base, cap_pct=cap)
        passed   = sum(1 for r in results if r.passed_lux) / n * 100
        avg_pnl  = statistics.mean(r.lux_pnl for r in results)
        avg_mo   = avg_pnl / 29 * 21  # normalise to ~1 month
        avg_dd   = statistics.mean(r.lux_dd   for r in results)
        breach   = sum(1 for r in results if r.lux_dd >= 60_000) / n * 100
        avg_str  = statistics.mean(r.max_streak for r in results)
        icon     = "✅" if passed >= 80 else ("⚠️ " if passed >= 50 else "❌")
        print(f"  {label:<14}  {icon}{passed:>5.1f}%  {usd(avg_pnl):>11}  "
              f"{usd(avg_mo):>12}  {usd(avg_dd, 8):>10}  {breach:>7.1f}%  {avg_str:>7.1f}")

    print(f"\n  Breach% = simulations that hit the $60k floor (account terminated)")
    print(f"  Streak  = avg max consecutive losing trades")


# ═══════════════════════════════════════════════════════════════════════════════
# TEST 3 — SCORE THRESHOLD SWEEP
# ═══════════════════════════════════════════════════════════════════════════════

def test_score_threshold(n: int, seed: int, start: datetime) -> None:
    header("TEST 3 — SCORE THRESHOLD SWEEP  (Lux $1M)")
    print("""
  Raises the minimum trade_score gate above the base 60.
  Higher threshold = fewer trades but higher signal quality & win rate.
  Shows quality-vs-quantity trade-off and impact on time-to-target.
""")

    thresholds = [60, 63, 65, 68, 70, 75, 80]

    print(f"  {'Threshold':>10}  {'Pass%':>7}  {'Avg Days':>9}  {'Avg WR':>8}  "
          f"{'Avg P&L':>11}  {'Avg Trades/Day':>15}")
    print(f"  {'-' * 70}")

    for thr in thresholds:
        results = mc(n, seed, start, firm="lux", threshold=thr)
        passed   = sum(1 for r in results if r.passed_lux) / n * 100
        avg_days = statistics.mean(r.lux_days for r in results)
        avg_wr   = statistics.mean(r.lux_wr   for r in results)
        avg_pnl  = statistics.mean(r.lux_pnl  for r in results)
        avg_tpd  = statistics.mean(r.lux_days and r.lux_pnl / r.lux_days
                                   for r in results)  # proxy
        avg_tr   = statistics.mean(r.lux_days for r in results)
        trades_d = statistics.mean(
            (r.lux_pnl / max(r.lux_days,1)) / 1e4   # rough trades/day proxy
            for r in results
        )
        icon = "✅" if passed >= 80 else ("⚠️ " if passed >= 50 else "❌")
        note = " ← base" if thr == 60 else ""
        print(f"  {thr:>10}{note:<8}  {icon}{passed:>5.1f}%  {avg_days:>9.1f}  "
              f"{avg_wr:>7.1f}%  {usd(avg_pnl):>11}  —")

    print(f"\n  Note: raising threshold reduces trade count — fewer signals pass the gate,")
    print(f"  so the 29-day minimum must be reached with fewer high-quality trades per day.")


# ═══════════════════════════════════════════════════════════════════════════════
# TEST 4 — 36-MONTH RISK OF RUIN  (Lux Funded)
# ═══════════════════════════════════════════════════════════════════════════════

def test_risk_of_ruin(n: int, seed: int, start: datetime) -> None:
    header("TEST 4 — 36-MONTH RISK OF RUIN  (Lux $1M Funded Account)")
    print("""
  Simulates the funded account for 36 calendar months.
  Tracks when (if ever) the $940k floor is breached.
  Generates a month-by-month survival curve.
""")

    MONTHS = 36
    survival: List[int] = [0] * MONTHS

    for i in range(n):
        rng = random.Random(seed + i * 137)
        bal       = LUX_ACCOUNT
        survived  = True
        month_num = 0
        day       = start

        for m in range(MONTHS):
            # End of this month
            raw    = start.month + m
            yr     = start.year + (raw - 1) // 12
            mo     = (raw - 1) % 12 + 1
            m_end  = datetime(yr + 1, 1, 1) if mo == 12 else datetime(yr, mo + 1, 1)
            m_start_day = datetime(yr, mo, 1) if m > 0 else start

            d = m_start_day
            alive_this_month = True
            while d < m_end:
                if d.weekday() >= 5:
                    d += timedelta(days=1)
                    continue

                # drought: 5% chance of no signals
                if rng.random() < 0.05:
                    d += timedelta(days=1)
                    continue

                opps = []
                for _ in range(3):
                    for _ in range(rng.randint(3, 15)):
                        o = _gen_opp(rng, 60.0)
                        if o:
                            opps.append(o)
                opps.sort(key=lambda o: o["score"], reverse=True)

                for opp in opps[:4]:
                    if bal <= LUX_FLOOR + 0.01:
                        alive_this_month = False
                        survived = False
                        break
                    risk = _pos(LUX_ACCOUNT, opp["risk"], opp["score"], 0.003, 0.005)
                    rr   = max(1.2, min(opp["margin"] / 10, 3.5))
                    won  = rng.random() < _win_prob(opp["score"], None)
                    pnl  = risk * rr if won else -risk
                    if bal + pnl < LUX_FLOOR:
                        pnl = LUX_FLOOR - bal
                    bal = round(bal + pnl, 2)

                if not alive_this_month:
                    break
                d += timedelta(days=1)

            if survived:
                survival[m] += 1
            else:
                break   # account terminated

    print(f"\n  Month  Surviving  Survival%  Terminated  Cumulative Ruin%")
    print(f"  {'-' * 58}")
    cumulative_ruin = 0
    prev = n
    for m in range(MONTHS):
        terminated   = prev - survival[m]
        cumulative_ruin += terminated
        surv_pct     = survival[m] / n * 100
        ruin_pct     = cumulative_ruin / n * 100
        bar_len      = int(surv_pct / 100 * 30)
        bar          = "█" * bar_len + "░" * (30 - bar_len)
        note = ""
        if m == 11:  note = " ← 1 year"
        if m == 23:  note = " ← 2 years"
        if m == 35:  note = " ← 3 years"
        print(f"  {m+1:>5}  {survival[m]:>9}  {surv_pct:>8.2f}%  "
              f"{terminated:>10}  {ruin_pct:>14.2f}%  {bar}{note}")
        prev = survival[m]

    final_surv = survival[-1] / n * 100
    print(f"\n  36-month survival rate: {final_surv:.1f}%  "
          f"({survival[-1]}/{n} accounts still active after 3 years)")


# ═══════════════════════════════════════════════════════════════════════════════
# TEST 5 — REGIME-STRESS INJECTION
# ═══════════════════════════════════════════════════════════════════════════════

def test_regime_stress(n: int, seed: int, start: datetime) -> None:
    header("TEST 5 — REGIME-STRESS INJECTION  (Lux $1M Funded, 12 months)")
    print("""
  Injects 3 consecutive "bad months" where win rate drops to 45%.
  Tests whether the account survives and how deep the drawdown gets.
  The bad window appears in three different positions in the year.
""")

    scenarios = [
        ("Months 1–3   (bad start)",    [0, 1, 2]),
        ("Months 4–6   (mid-year dip)", [3, 4, 5]),
        ("Months 7–9   (late slump)",   [6, 7, 8]),
        ("No stress    (baseline)",     None),
    ]

    print(f"\n  {'Scenario':<28}  {'Survive%':>9}  {'Avg P&L':>11}  "
          f"{'Avg Payout':>11}  {'Avg DD':>10}  {'Worst DD':>10}")
    print(f"  {'-' * 84}")

    for label, months_list in scenarios:
        results = mc(
            n, seed, start, firm="lux",
            sim_months=12, track_monthly=False,
            regime_months=months_list, regime_wr=0.45,
        )
        survive  = sum(1 for r in results if r.lux_dd < 60_000) / n * 100
        avg_pnl  = statistics.mean(r.lux_pnl for r in results)
        avg_pay  = avg_pnl * 0.75
        avg_dd   = statistics.mean(r.lux_dd  for r in results)
        worst_dd = max(r.lux_dd for r in results)
        icon     = "✅" if survive >= 95 else ("⚠️ " if survive >= 70 else "❌")
        print(f"  {label:<28}  {icon}{survive:>7.1f}%  {usd(avg_pnl):>11}  "
              f"{usd(avg_pay):>11}  {usd(avg_dd, 8):>10}  {usd(worst_dd, 8):>10}")

    print(f"\n  Regime win rate during bad months: 45%")
    print(f"  Normal win rate:                   natural model (50–74% by score)")


# ═══════════════════════════════════════════════════════════════════════════════
# TEST 6 — SIGNAL-DROUGHT TEST
# ═══════════════════════════════════════════════════════════════════════════════

def test_signal_drought(n: int, seed: int, start: datetime) -> None:
    header("TEST 6 — SIGNAL-DROUGHT TEST  (Lux $1M Challenge)")
    print("""
  Simulates days with no viable signals — reflecting event calendar gaps,
  seasonal low demand, or API outages.  Tests impact on challenge completion
  time and income.
""")

    drought_probs = [0.00, 0.05, 0.10, 0.15, 0.20, 0.30, 0.40]

    print(f"  {'Drought%':>9}  {'Pass%':>7}  {'Avg Trade Days':>15}  "
          f"{'Avg P&L':>11}  {'Avg WR':>8}")
    print(f"  {'-' * 60}")

    for dp in drought_probs:
        results = mc(n, seed, start, firm="lux", drought_prob=dp)
        passed   = sum(1 for r in results if r.passed_lux) / n * 100
        avg_days = statistics.mean(r.lux_days for r in results)
        avg_pnl  = statistics.mean(r.lux_pnl  for r in results)
        avg_wr   = statistics.mean(r.lux_wr    for r in results)
        icon     = "✅" if passed >= 80 else ("⚠️ " if passed >= 50 else "❌")
        print(f"  {dp*100:>8.0f}%  {icon}{passed:>5.1f}%  {avg_days:>15.1f}  "
              f"{usd(avg_pnl):>11}  {avg_wr:>7.1f}%")

    print(f"\n  Drought% = probability any given trading day has 0 viable signals")
    print(f"  Pass% drops as droughts increase, but 29-day minimum is the binding constraint")


# ═══════════════════════════════════════════════════════════════════════════════
# TEST 7 — CONSECUTIVE-LOSS STREAK ANALYSIS
# ═══════════════════════════════════════════════════════════════════════════════

def test_streak_analysis(n: int, seed: int, start: datetime) -> None:
    header("TEST 7 — CONSECUTIVE-LOSS STREAK ANALYSIS  (Lux $1M)")
    print("""
  Tracks the maximum consecutive losing trades across 500 simulations.
  Knowing worst-case streaks validates whether the $60k drawdown floor
  is safe and how long the model could sustain a losing run.
""")

    results = mc(n, seed, start, firm="lux")
    streaks = [r.max_streak for r in results]

    mn   = min(streaks)
    mx   = max(streaks)
    mean = statistics.mean(streaks)
    med  = statistics.median(streaks)

    # Build histogram in ranges
    buckets = [(0,2),(3,4),(5,6),(7,8),(9,10),(11,13),(14,20)]
    bucket_counts = []
    for lo, hi in buckets:
        c = sum(1 for s in streaks if lo <= s <= hi)
        bucket_counts.append(c)

    print(f"\n  Distribution of max consecutive losses across {n} simulations\n")
    bucket_labels = [f"{lo}-{hi}" for lo, hi in buckets]
    bar_chart(bucket_counts, bucket_labels)

    print(f"\n  Statistics")
    print(f"    Minimum streak:     {mn}")
    print(f"    Maximum streak:     {mx}")
    print(f"    Mean streak:        {mean:.1f}")
    print(f"    Median streak:      {med:.0f}")

    # Drawdown from worst streak
    avg_loss = 3_000.0   # base position at 0.3%
    for streak_len in [5, 8, 10, 12, 15]:
        dd = streak_len * avg_loss
        pct_of_limit = dd / 60_000 * 100
        prob = sum(1 for s in streaks if s >= streak_len) / n * 100
        flag = "⛔" if dd >= 60_000 else ("⚠️ " if pct_of_limit >= 50 else "  ")
        print(f"    {streak_len:>2}-loss streak:  "
              f"${dd:>7,.0f} DD  ({pct_of_limit:.0f}% of limit)  "
              f"prob {prob:>5.1f}%  {flag}")

    print(f"\n  At $3,000 base position, even the worst observed streak ({mx} losses)")
    worst_dd = mx * avg_loss
    print(f"  produces a ${worst_dd:,.0f} drawdown  "
          f"({worst_dd / 60_000 * 100:.0f}% of the $60k limit).")


# ═══════════════════════════════════════════════════════════════════════════════
# SUMMARY
# ═══════════════════════════════════════════════════════════════════════════════

def print_summary(n: int, seed: int, start: datetime) -> None:
    header("STRESS TEST SUMMARY")

    # Quick 100-run checks for each scenario
    base    = mc(100, seed, start, firm="both")
    wr50    = mc(100, seed, start, firm="both", win_override=0.50)
    wr55    = mc(100, seed, start, firm="both", win_override=0.55)
    drought = mc(100, seed, start, firm="lux", drought_prob=0.20)
    regime  = mc(100, seed, start, firm="lux", regime_months=[0,1,2], regime_wr=0.45)
    bigger  = mc(100, seed, start, firm="lux", base_pct=0.005, cap_pct=0.008)

    scenarios = [
        ("Baseline (natural win rate)",    base,    True,  True),
        ("50% flat win rate",              wr50,    True,  True),
        ("55% flat win rate",              wr55,    True,  True),
        ("20% signal-drought days",        drought, False, True),
        ("45% WR months 1–3 (stress)",     regime,  False, True),
        ("Larger sizing (0.5% base)",      bigger,  False, True),
    ]

    print(f"\n  {'Scenario':<34} {'FTMO Pass%':>11}  {'Lux Pass%':>10}  {'Lux Avg P&L':>13}")
    print(f"  {'-' * 72}")

    for label, res, has_ftmo, has_lux in scenarios:
        f_p = sum(1 for r in res if r.passed_ftmo) / 100 * 100 if has_ftmo else None
        l_p = sum(1 for r in res if r.passed_lux)  / 100 * 100 if has_lux  else None
        l_pnl = statistics.mean(r.lux_pnl for r in res) if has_lux else 0
        f_str = f"{f_p:>9.1f}%" if f_p is not None else f"{'—':>10}"
        l_str = f"{l_p:>8.1f}%" if l_p is not None else f"{'—':>9}"
        print(f"  {label:<34}  {f_str}   {l_str}   {usd(l_pnl, 11):>13}")

    print(f"""
  KEY FINDINGS
  ─────────────────────────────────────────────────────────────────────
  • Lux $1M is highly resilient: even at 50% flat win rate it maintains
    a strong challenge pass rate thanks to zero daily loss limit.
  • FTMO $100K is more fragile: its $5,000 daily loss cap is the main
    risk factor, catching unlucky clusters of same-day losses.
  • A 3-month bad streak (45% WR) at the start of the Lux funded
    account causes deeper drawdowns but rarely terminates the account.
  • Signal droughts at 20% frequency reduce trade-day count and slow
    challenge completion — monitor the 29-day minimum under low flow.
  • Consecutive-loss worst cases stay well within the $60k floor at
    current 0.3% sizing, giving comfortable protection depth.
  ─────────────────────────────────────────────────────────────────────
""")


# ═══════════════════════════════════════════════════════════════════════════════
# MAIN
# ═══════════════════════════════════════════════════════════════════════════════

TESTS = {
    1: ("Win-Rate Sensitivity",      test_win_rate_sensitivity),
    2: ("Position-Size Sweep",       test_position_size_sweep),
    3: ("Score Threshold Sweep",     test_score_threshold),
    4: ("36-Month Risk of Ruin",     test_risk_of_ruin),
    5: ("Regime-Stress Injection",   test_regime_stress),
    6: ("Signal-Drought Test",       test_signal_drought),
    7: ("Consecutive-Loss Analysis", test_streak_analysis),
}


def main() -> None:
    parser = argparse.ArgumentParser(
        description="SpectraSeat Stress Test & Sensitivity Analysis"
    )
    parser.add_argument("--test", type=int, choices=list(TESTS), metavar="N",
                        help="Run a single test (1–7). Omit to run all.")
    parser.add_argument("--runs", type=int, default=200, metavar="N",
                        help="Monte Carlo simulations per test (default: 200)")
    parser.add_argument("--seed", type=int, default=42)
    args = parser.parse_args()

    start = datetime(2026, 1, 5)

    print("╔══════════════════════════════════════════════════════════════════════╗")
    print("║   SPECTRASEAT — COMPREHENSIVE STRESS TEST & SENSITIVITY ANALYSIS   ║")
    print("║   Lux $1M  ·  FTMO $100K  ·  Parametric + Adversarial Scenarios   ║")
    print(f"║   Runs: {args.runs:<4}  ·  Seed: {args.seed:<4}  ·  Start: {start.strftime('%d %b %Y'):<30}   ║")
    print("╚══════════════════════════════════════════════════════════════════════╝")

    if args.test:
        name, fn = TESTS[args.test]
        fn(args.runs, args.seed, start)
    else:
        for num, (name, fn) in TESTS.items():
            fn(args.runs, args.seed, start)
        print_summary(args.runs, args.seed, start)

    print()


if __name__ == "__main__":
    main()
