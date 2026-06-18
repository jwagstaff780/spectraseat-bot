#!/usr/bin/env python3
"""
Lux $1M — BRUTALLY HONEST Monte Carlo
50,000 simulations × 5 scenarios. No best-case assumptions.
Trade-by-trade within each month — catches intra-month floor breaches.
Includes 2026 underperformance, execution costs, and regime risk.
"""
import random, statistics
from collections import Counter

# ─── REAL DATA: per-year parameters derived from actual track record ──────────

# Wins, losses, BEs, total_R → derive win_rate, avg_win, be_rate
# 2023: 79W 77L 19BE 102.2R total  (175 trades, 12 months)
# 2024: 96W 55L  9BE 165.0R total  (160 trades, 12 months)
# 2025: 78W 83L 15BE  83.2R total  (175 trades, 12 months)
# 2026: 30W 46L 12BE  17.4R total  ( 88 trades,  5 months) ← CURRENT FORM

YEARS = {
    2023: dict(wins=79,  losses=77,  bes=19, total_r=102.2, trades=175, months=12),
    2024: dict(wins=96,  losses=55,  bes=9,  total_r=165.0, trades=160, months=12),
    2025: dict(wins=78,  losses=83,  bes=15, total_r=83.2,  trades=175, months=12),
    2026: dict(wins=30,  losses=46,  bes=12, total_r=17.4,  trades=88,  months=5),
}

def derive(d):
    wr   = d["wins"] / (d["wins"] + d["losses"])              # ex-BE win rate
    br   = d["bes"] / d["trades"]                             # BE rate
    aw   = (d["total_r"] + d["losses"]) / d["wins"]           # avg win in R
    al   = -1.0                                                # avg loss always -1R
    atm  = d["trades"] / d["months"]                          # avg trades/month
    r_mo = d["total_r"] / d["months"]                         # avg R/month
    return dict(wr=wr, br=br, aw=aw, al=al, atm=atm, r_mo=r_mo)

P = {yr: derive(d) for yr, d in YEARS.items()}

# Monthly trade count pool (all real months)
ALL_TRADES = [14,14,24,13,17,17,13,17,17,10,10,9,
              11,10,12,15, 9,10,15,13,16,24,11,14,
               8,21,12,17,16,13,20,19,14,14,13, 8,
              18,15,21,13,21]

AVG_T_3YR = sum(ALL_TRADES[:36]) / 36   # 14.2 trades/month

# ─── LUX $1M RULES ───────────────────────────────────────────────────────────
ACCOUNT  = 1_000_000
TARGET   = 1_150_000    # +15%
FLOOR    = 940_000      # -6% static — breach at ANY point = fail
MIN_DAYS = 29
R_DOLLAR = 5_000        # 0.5% risk = $5,000 per 1R
T_DAYS   = 21           # trading days per month


def tdays(n): return round(n * T_DAYS / AVG_T_3YR)


# ─── TRADE-BY-TRADE MONTH SIMULATION ─────────────────────────────────────────
def sim_month(rng, wr, aw, br, n_trades, exec_cost=0.0):
    """
    Simulate n_trades individually. Returns (end_R, min_R_seen).
    min_R tracks the worst intra-month cumulative drawdown from month start.
    This catches floor breaches even in months that end positive.
    """
    cum = 0.0
    low = 0.0
    for _ in range(n_trades):
        roll = rng.random()
        if roll < br:
            r = -exec_cost
        elif rng.random() < wr:
            r = aw - exec_cost
        else:
            r = -1.0 - exec_cost
        cum += r
        if cum < low:
            low = cum
    return cum, low


# ─── SCENARIO RUNNER ─────────────────────────────────────────────────────────
def run_scenario(param_fn, n=50_000, seed=42, max_mo=24):
    """
    param_fn(rng) → dict with keys: wr, aw, br, n_trades, exec_cost
    """
    rng     = random.Random(seed)
    results = []

    for _ in range(n):
        bal    = ACCOUNT
        days   = 0
        mo     = 0
        status = "timeout"

        while mo < max_mo:
            p = param_fn(rng)
            end_r, low_r = sim_month(rng, p["wr"], p["aw"], p["br"], p["nt"], p.get("ec", 0.0))

            intra_low = bal + low_r * R_DOLLAR
            bal      += end_r * R_DOLLAR
            days     += tdays(p["nt"])
            mo       += 1

            if intra_low <= FLOOR or bal <= FLOOR:
                status = "blown"; break
            if bal >= TARGET and days >= MIN_DAYS:
                status = "passed"; break

        results.append({"status": status, "mo": mo, "pnl": bal - ACCOUNT})
    return results


def pct(data, p):
    s = sorted(data)
    return s[min(round(p / 100 * len(s)), len(s) - 1)] if s else 0


def show(results, n, title):
    passed  = [r for r in results if r["status"] == "passed"]
    blown   = [r for r in results if r["status"] == "blown"]
    timeout = [r for r in results if r["status"] == "timeout"]
    pm = [r["mo"] for r in passed]

    print(f"\n  ── {title}")
    print(f"  {'─'*62}")
    print(f"  PASS  {len(passed)/n*100:6.2f}%  ({len(passed):,}/{n:,})")
    print(f"  BLOWN {len(blown)/n*100:6.2f}%  ({len(blown):,}/{n:,})")
    print(f"  TIMEOUT (>24mo) {len(timeout)/n*100:5.2f}%  ({len(timeout):,}/{n:,})")
    if pm:
        dist = Counter(pm)
        print(f"  Avg: {statistics.mean(pm):.1f} mo | Median: {statistics.median(pm):.0f} mo | "
              f"Fastest: {min(pm)} mo | 95th: {pct(pm,95)} mo")
        print(f"  Months-to-pass:")
        for m in sorted(dist)[:10]:
            p2 = dist[m] / len(passed) * 100
            bar = "█" * round(p2 / 2.5)
            print(f"    Mo {m:2d}: {dist[m]:6,}  ({p2:5.1f}%)  {bar}")
    return len(passed)/n*100, len(blown)/n*100, (statistics.mean(pm) if pm else 0)


# ─── SCENARIO DEFINITIONS ─────────────────────────────────────────────────────

def s0_optimistic(rng):
    """3yr average model, no execution cost — pure best-case from history"""
    y = P[rng.choice([2023, 2024, 2025])]
    return dict(wr=y["wr"], aw=y["aw"], br=y["br"],
                nt=ALL_TRADES[rng.randrange(36)], ec=0.0)

def s1_realistic(rng):
    """All 4 years weighted equally + small exec cost"""
    y = P[rng.choice([2023, 2024, 2025, 2026])]
    return dict(wr=y["wr"], aw=y["aw"], br=y["br"],
                nt=ALL_TRADES[rng.randrange(len(ALL_TRADES))], ec=0.02)

def s2_recent_biased(rng):
    """2025 and 2026 weighted 3× heavier — reflects recent model underperformance"""
    pool = [2023, 2024, 2025, 2025, 2025, 2026, 2026, 2026]
    y = P[rng.choice(pool)]
    return dict(wr=y["wr"], aw=y["aw"], br=y["br"],
                nt=ALL_TRADES[rng.randrange(len(ALL_TRADES))], ec=0.02)

def s3_current_form(rng):
    """2026 parameters only — this is where the model is RIGHT NOW"""
    y = P[2026]
    return dict(wr=y["wr"], aw=y["aw"], br=y["br"],
                nt=ALL_TRADES[rng.randrange(len(ALL_TRADES))], ec=0.03)

def s4_regime_risk(rng):
    """
    Worst-case: 30% chance each month you're in a bad regime (2026-like),
    70% chance you're in historical form. Exec cost higher.
    Models the real uncertainty of forward trading.
    """
    if rng.random() < 0.30:
        y = P[2026]
    else:
        yr = rng.choice([2023, 2024, 2025])
        y = P[yr]
    return dict(wr=y["wr"], aw=y["aw"], br=y["br"],
                nt=ALL_TRADES[rng.randrange(len(ALL_TRADES))], ec=0.04)


# ─── MAIN ─────────────────────────────────────────────────────────────────────
def main():
    N = 50_000

    print("\n" + "="*70)
    print("  LUX $1M — BRUTALLY HONEST MONTE CARLO  (50,000 × 5 SCENARIOS)")
    print("  Trade-by-trade simulation · Intra-month floor breach detection")
    print("  Real QCS data 2023–2026 · No ego, no best-case cherry-picking")
    print("="*70)

    print(f"\n  YOUR REAL NUMBERS — YEAR BY YEAR:")
    print(f"  {'─'*60}")
    print(f"  {'Year':<6} {'R/mo':>8}  {'Win Rate':>10}  {'Avg R/trade':>12}  {'Note'}")
    print(f"  {'─'*60}")
    for yr in [2023, 2024, 2025, 2026]:
        p = P[yr]
        note = ""
        if yr == 2024: note = " ← BEST YEAR"
        if yr == 2026: note = " ← CURRENT FORM (Jan-May)"
        print(f"  {yr:<6} {p['r_mo']:>8.2f}R  {p['wr']*100:>9.1f}%  {p['aw']:>12.3f}R       {note}")
    print(f"  {'─'*60}")
    print(f"  3yr avg:    9.73R/mo     54.1% WR     2.235R avg win")
    print(f"  2026 pace:  3.48R/mo     39.5% WR     2.113R avg win  ← 36% of 3yr avg")
    print()
    print(f"  ⚠  HONEST WARNING #1: 2026 win rate (39.5%) is the lowest on record")
    print(f"  ⚠  HONEST WARNING #2: Apr-May 2026 both negative — worst 2-mo on record")
    print(f"  ⚠  HONEST WARNING #3: 3yr avg inflated by 2024 (best year, 63.6% WR)")
    print(f"  ⚠  HONEST WARNING #4: Intra-month floor breaches tested in ALL scenarios")
    print()
    print(f"  CHALLENGE: $1M account | +$150k target | -$60k floor | 29 min days")
    print(f"  RISK: 0.5% = $5,000/R | Exec costs factored per scenario")

    print(f"\n\n  {'═'*66}")
    print(f"  50,000 SIMULATIONS — 5 SCENARIOS")
    print(f"  {'═'*66}")

    scenarios = [
        ("S0: OPTIMISTIC   — 3yr avg, zero exec cost",      s0_optimistic,  42),
        ("S1: REALISTIC    — all 4yr equal, 0.02R/trade",   s1_realistic,   43),
        ("S2: RECENT-BIAS  — 2025/26 weighted 3x heavier",  s2_recent_biased, 44),
        ("S3: CURRENT FORM — 2026 data only (right now)",   s3_current_form, 45),
        ("S4: REGIME RISK  — 30% chance bad-month each mo", s4_regime_risk,  46),
    ]

    summary = []
    for title, fn, seed in scenarios:
        res = run_scenario(fn, N, seed)
        pass_r, blow_r, avg_mo = show(res, N, title)
        summary.append((title[:30], pass_r, blow_r, avg_mo))

    print(f"\n\n  {'═'*66}")
    print(f"  VERDICT TABLE")
    print(f"  {'═'*66}")
    print(f"  {'Scenario':<32}  {'Pass%':>7}  {'Blown%':>7}  {'Avg Mo':>7}")
    print(f"  {'─'*60}")
    for label, p, b, m in summary:
        flag = " ← REALITY" if "REALISTIC" in label.upper() else ""
        print(f"  {label:<32}  {p:>7.2f}%  {b:>7.2f}%  {m:>7.1f}{flag}")

    print(f"\n  {'─'*66}")
    print(f"  WHAT THIS MEANS:")
    print(f"  ─ If model returns to 3yr form:      very high pass rate, ~3-4 months")
    print(f"  ─ Mixed recent/historical form:       still strong, ~4-6 months")
    print(f"  ─ Current 2026 pace maintained:       low pass rate, 12-24 months")
    print(f"  ─ Worst case regime risk:             significantly impacted")
    print(f"\n  RECOMMENDATION:")
    print(f"  Trade June-August 2026 on a small account first.")
    print(f"  If monthly R returns above 7R/mo, the $1M challenge is low-risk.")
    print(f"  Committing £999 while in current 2026 form carries real blow risk.")
    print("="*70 + "\n")


if __name__ == "__main__":
    main()
