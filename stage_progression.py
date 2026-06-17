#!/usr/bin/env python3
"""
Lux Trading Firm — Stage Progression Monte Carlo
Stage 1 (Demo) → Stage 2 ($1M Funded) → Stage 3 ($5M) → Stage 4 ($10M)
Real QCS track record (2023-2025), 0.5% risk throughout
"""
import random, statistics
from collections import Counter

# ─── REAL QCS MONTHLY DATA ────────────────────────────────────────────────────

MONTHLY_R_2023 = [7.0, 9.5, 28.9, 16.2, 2.0, -0.1, -3.4, 11.8, 10.8, -3.0, 15.6, 7.9]
MONTHLY_T_2023 = [14, 14, 24, 13, 17, 17, 13, 17, 17, 10, 10, 9]

MONTHLY_R_2024 = [17.7, 7.0, 22.7, 21.0, 3.9, 3.5, 13.7, 11.5, 18.5, 27.0, 7.4, 11.1]
MONTHLY_T_2024 = [11, 10, 12, 15, 9, 10, 15, 13, 16, 24, 11, 14]

MONTHLY_R_2025 = [9.1, 5.7, 8.3, 5.8, -6.0, 4.7, 14.6, 9.0, 9.0, 7.3, 8.2, 8.7]
MONTHLY_T_2025 = [8, 21, 12, 17, 16, 13, 20, 19, 14, 14, 13, 8]

POOL_R = MONTHLY_R_2023 + MONTHLY_R_2024 + MONTHLY_R_2025
POOL_T = MONTHLY_T_2023 + MONTHLY_T_2024 + MONTHLY_T_2025
N_POOL = len(POOL_R)
AVG_T  = sum(POOL_T) / N_POOL   # ~14.2 trades/month
AVG_R  = sum(POOL_R) / N_POOL   # ~9.73 R/month

# ─── STAGE DEFINITIONS ───────────────────────────────────────────────────────
#
# Stage 1 : Demo ($1M) — already simulated. Pass rate 99.9%, avg 3.8 months.
# Stage 2 : $1M funded → need +10% gross ($100k) to advance to Stage 3
# Stage 3 : $5M funded → need +10% gross ($500k) to advance to Stage 4
# Stage 4 : $10M funded (reached — final level)
#
# Risk: fixed 0.5% of each stage's account size
# Drawdown floor: -6% static (same Lux rule applies at every stage)
# Split: 75% to trader at all stages

STAGES = [
    {"name": "Stage 2", "account": 1_000_000,  "target_pct": 0.10, "floor_pct": 0.06},
    {"name": "Stage 3", "account": 5_000_000,  "target_pct": 0.10, "floor_pct": 0.06},
    {"name": "Stage 4", "account": 10_000_000, "target_pct": None, "floor_pct": 0.06},
]

RISK_PCT = 0.005   # 0.5% per trade at each stage
SPLIT    = 0.75
TRADE_DAYS_PER_MO = 21


def td(n_trades):
    return round(n_trades * TRADE_DAYS_PER_MO / AVG_T)


def pct(data, p):
    s = sorted(data)
    return s[min(round(p / 100 * len(s)), len(s) - 1)]


# ─── SINGLE-STAGE SIMULATION ──────────────────────────────────────────────────

def simulate_stage(account, target_profit, floor_loss, n=10_000, seed=42, max_mo=36):
    rng      = random.Random(seed)
    r_dollar = RISK_PCT * account
    floor_bal = account - floor_loss
    target_bal = account + target_profit

    results = []
    for _ in range(n):
        bal    = account
        months = 0
        trades = 0
        status = "timeout"

        while months < max_mo:
            i       = rng.randrange(N_POOL)
            mr, mt  = POOL_R[i], POOL_T[i]
            bal    += mr * r_dollar
            trades += mt
            months += 1

            if bal <= floor_bal:
                status = "blown"; break
            if bal >= target_bal:
                status = "advanced"; break

        results.append({
            "status": status,
            "months": months,
            "pnl":    bal - account,
            "trades": trades,
        })
    return results


# ─── FULL PROGRESSION SIMULATION ─────────────────────────────────────────────
# Only simulate the advance stages (Stage 2 → 3 and Stage 3 → 4).
# Stage 4 is the destination — we track when it's reached, not simulate through it.

ADVANCE_STAGES = [
    {"name": "Stage 2", "account": 1_000_000, "target_pct": 0.10, "floor_pct": 0.06},
    {"name": "Stage 3", "account": 5_000_000, "target_pct": 0.10, "floor_pct": 0.06},
]

def simulate_full_progression(n=10_000, seed=42):
    rng = random.Random(seed)
    records = []

    for _ in range(n):
        cumulative_months = 0
        cumulative_pnl    = 0
        stage_months      = []
        stage_pnl         = []
        blown_at          = None
        stage_reached     = 2   # Stage 2 = funded (already passed demo)

        for st in ADVANCE_STAGES:
            acct       = st["account"]
            r_dollar   = RISK_PCT * acct
            floor_bal  = acct * (1 - st["floor_pct"])
            target_bal = acct * (1 + st["target_pct"])

            bal    = acct
            months = 0
            blown  = False

            while months < 36:
                i      = rng.randrange(N_POOL)
                mr, mt = POOL_R[i], POOL_T[i]
                bal   += mr * r_dollar
                months += 1

                if bal <= floor_bal:
                    blown = True
                    break
                if bal >= target_bal:
                    break

            cumulative_months += months
            cumulative_pnl    += bal - acct
            stage_months.append(months)
            stage_pnl.append(bal - acct)

            if blown:
                blown_at = st["name"]
                break

            stage_reached += 1   # advanced to next stage

        records.append({
            "stage_reached":     stage_reached,   # 2=still S2, 3=reached S3, 4=reached S4
            "cumulative_months": cumulative_months,
            "cumulative_pnl":    cumulative_pnl,
            "stage_months":      stage_months,
            "stage_pnl":         stage_pnl,
            "blown_at":          blown_at,
        })

    return records


def main():
    N = 10_000
    print("\n" + "="*70)
    print("  LUX STAGE PROGRESSION — MONTE CARLO  (10,000 RUNS)")
    print("  Stage 1 (Demo) → Stage 2 ($1M) → Stage 3 ($5M) → Stage 4 ($10M)")
    print("  Real QCS data (2023-2025)  ·  0.5% risk at each stage")
    print("="*70)

    print(f"\n  ASSUMPTIONS (based on screenshot — adjust if Lux stages differ):")
    print(f"  Stage 1 : Demo $1M      → Pass challenge (+15%)  — done, 99.9% rate")
    print(f"  Stage 2 : Funded $1M    → Advance after +10% ($100k gross profit)")
    print(f"  Stage 3 : Funded $5M    → Advance after +10% ($500k gross profit)")
    print(f"  Stage 4 : Funded $10M   → Final level reached")
    print(f"  Drawdown floor: -6% static at every stage")
    print(f"  Risk: 0.5% of each stage's account = $5k / $25k / $50k per 1R")

    # ── INDIVIDUAL STAGE ANALYSIS ─────────────────────────────────────────────
    stage_configs = [
        ("Stage 2 → Stage 3", 1_000_000,  100_000,  60_000,  42),
        ("Stage 3 → Stage 4", 5_000_000,  500_000,  300_000, 43),
    ]

    for label, acct, tgt, floor, seed in stage_configs:
        res      = simulate_stage(acct, tgt, floor, N, seed)
        advanced = [r for r in res if r["status"] == "advanced"]
        blown    = [r for r in res if r["status"] == "blown"]
        r_dollar = RISK_PCT * acct

        print(f"\n  {'─'*60}")
        print(f"  {label}  (${acct:,.0f} account, ${r_dollar:,.0f}/R)")
        print(f"  Target: +${tgt:,.0f}  |  Floor: -${floor:,.0f}")
        print(f"  {'─'*60}")
        print(f"  Advance rate:  {len(advanced)/N*100:.1f}%   ({len(advanced):,}/{N:,})")
        print(f"  Blown rate:    {len(blown)/N*100:.1f}%   ({len(blown):,}/{N:,})")
        if advanced:
            ml = [r["months"] for r in advanced]
            pl = [r["pnl"]    for r in advanced]
            print(f"\n  Time to advance:")
            print(f"    Average:   {statistics.mean(ml):.1f} months")
            print(f"    Median:    {statistics.median(ml):.0f} months")
            print(f"    Fastest:   {min(ml)} months")
            print(f"    95% done:  {pct(ml,95)} months")
            mc = Counter(ml)
            print(f"\n  Months-to-advance:")
            for m in sorted(mc)[:12]:
                p2  = mc[m] / len(advanced) * 100
                bar = "█" * round(p2 / 2)
                print(f"    Month {m:2d}: {mc[m]:5,}  ({p2:4.1f}%)  {bar}")
            print(f"\n  P&L at advance:")
            print(f"    Average:   ${statistics.mean(pl):>12,.0f}")
            print(f"    Median:    ${statistics.median(pl):>12,.0f}")

    # ── FULL PROGRESSION ──────────────────────────────────────────────────────
    records = simulate_full_progression(N)

    reached = [r["stage_reached"] for r in records]
    s2 = sum(1 for x in reached if x >= 2)
    s3 = sum(1 for x in reached if x >= 3)
    s4 = sum(1 for x in reached if x >= 4)

    print(f"\n\n  {'═'*60}")
    print(f"  FULL PROGRESSION — SUCCESS RATES")
    print(f"  {'═'*60}")
    print(f"  Reach Stage 2 ($1M funded):  {s2/N*100:5.1f}%   ({s2:,}/{N:,})")
    print(f"  Reach Stage 3 ($5M funded):  {s3/N*100:5.1f}%   ({s3:,}/{N:,})")
    print(f"  Reach Stage 4 ($10M funded): {s4/N*100:5.1f}%   ({s4:,}/{N:,})")

    # Time to Stage 4
    s4_records = [r for r in records if r["stage_reached"] >= 4]
    if s4_records:
        s4_months = [r["cumulative_months"] for r in s4_records]
        s4_pnl    = [r["cumulative_pnl"] for r in s4_records]

        print(f"\n  TIME TO REACH STAGE 4 (from getting funded at Stage 2)")
        print(f"  {'─'*60}")
        print(f"  Average:    {statistics.mean(s4_months):.1f} months")
        print(f"  Median:     {statistics.median(s4_months):.0f} months")
        print(f"  Fastest:    {min(s4_months)} months")
        print(f"  Slowest:    {max(s4_months)} months")
        print(f"  95% done:   {pct(s4_months,95)} months")

        print(f"\n  CUMULATIVE P&L BY STAGE 4 (earned while passing through stages)")
        print(f"  {'─'*60}")
        print(f"  Average:    ${statistics.mean(s4_pnl):>12,.0f}")
        print(f"  Median:     ${statistics.median(s4_pnl):>12,.0f}")
        print(f"  5th  pct:   ${pct(s4_pnl, 5):>12,.0f}")
        print(f"  95th pct:   ${pct(s4_pnl,95):>12,.0f}")

        # Stage breakdown
        sm2 = [r["stage_months"][0] for r in s4_records if len(r["stage_months"]) >= 1]
        sm3 = [r["stage_months"][1] for r in s4_records if len(r["stage_months"]) >= 2]
        print(f"\n  AVG MONTHS SPENT AT EACH STAGE:")
        print(f"    Stage 1 (Demo):      ~3.8 months  (already simulated)")
        print(f"    Stage 2 ($1M):       {statistics.mean(sm2):.1f} months avg")
        print(f"    Stage 3 ($5M):       {statistics.mean(sm3):.1f} months avg")
        print(f"    Total funded time:   {statistics.mean(s4_months):.1f} months")
        print(f"    From day 1 to $10M:  ~{3.8 + statistics.mean(s4_months):.0f} months total")

    # ── STAGE 4 INCOME ────────────────────────────────────────────────────────
    print(f"\n\n  {'═'*60}")
    print(f"  STAGE 4 ($10M) — MONTHLY INCOME PROJECTION")
    print(f"  0.5% risk = $50,000 per 1R  ·  75% profit split")
    print(f"  {'─'*60}")

    rng_inc = random.Random(77)
    s4_monthly = [POOL_R[rng_inc.randrange(N_POOL)] * 50_000 * 0.75
                  for _ in range(N * 12)]
    # Only count positive months (loss months = $0 payout)
    s4_pay = [max(0.0, x) for x in s4_monthly]

    print(f"  Average monthly payout:    ${statistics.mean(s4_pay):>12,.0f}")
    print(f"  Median monthly payout:     ${statistics.median(s4_pay):>12,.0f}")
    print(f"  5th  pct (bad month):      ${pct(s4_pay, 5):>12,.0f}")
    print(f"  25th pct:                  ${pct(s4_pay,25):>12,.0f}")
    print(f"  75th pct:                  ${pct(s4_pay,75):>12,.0f}")
    print(f"  95th pct (great month):    ${pct(s4_pay,95):>12,.0f}")
    print(f"  Best month (Mar23 pace):   ${28.9*50_000*0.75:>12,.0f}")

    avg_s4_ann = statistics.mean(s4_pay) * 12
    print(f"\n  Avg annual income at Stage 4: ${avg_s4_ann:>12,.0f}")
    print(f"  Avg monthly income at Stage 4: ${avg_s4_ann/12:>11,.0f}")

    # ── SUMMARY TABLE ─────────────────────────────────────────────────────────
    print(f"\n\n  {'═'*60}")
    print(f"  COMPLETE JOURNEY SUMMARY")
    print(f"  {'═'*60}")
    print(f"  {'Stage':<22} {'Account':>10}  {'Pass Rate':>10}  {'Avg Time':>10}  {'Avg Mo Income':>14}")
    print(f"  {'─'*70}")
    print(f"  {'Stage 1 (Demo)':<22} {'$1M demo':>10}  {'99.9%':>10}  {'3.8 mo':>10}  {'—':>14}")
    if s2 > 0 and sm2:
        avg_s2_mo_inc = AVG_R * (RISK_PCT * 1_000_000) * 0.75
        print(f"  {'Stage 2 ($1M funded)':<22} {'$1M live':>10}  {s2/N*100:>9.1f}%  {statistics.mean(sm2):>9.1f}mo  ${avg_s2_mo_inc:>12,.0f}")
    if s3 > 0 and sm3:
        avg_s3_mo_inc = AVG_R * (RISK_PCT * 5_000_000) * 0.75
        print(f"  {'Stage 3 ($5M funded)':<22} {'$5M live':>10}  {s3/N*100:>9.1f}%  {statistics.mean(sm3):>9.1f}mo  ${avg_s3_mo_inc:>12,.0f}")
    avg_s4_mo_inc = AVG_R * (RISK_PCT * 10_000_000) * 0.75
    print(f"  {'Stage 4 ($10M funded)':<22} {'$10M live':>10}  {s4/N*100:>9.1f}%  {'ongoing':>10}  ${avg_s4_mo_inc:>12,.0f}")
    print(f"  {'─'*70}")

    total_mo = 3.8 + (statistics.mean(s4_months) if s4_records else 0)
    print(f"\n  Realistic total time from £999 entry to $10M seat: ~{total_mo:.0f} months")
    print(f"  Cumulative P&L earned WHILE advancing (avg): ${statistics.mean(s4_pnl):,.0f}" if s4_records else "")
    print("="*70 + "\n")


if __name__ == "__main__":
    main()
