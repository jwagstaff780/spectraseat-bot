#!/usr/bin/env python3
"""
Lux $1M Funded Account — Monthly payout projection
Bootstrapped from real QCS track record (2023-2025)
Risk: 0.5% per trade = $5,000 per 1R · 75% profit split
"""
import random, statistics
from collections import Counter

# ─── REAL QCS MONTHLY DATA ────────────────────────────────────────────────────

MONTHLY_R_2023 = [7.0, 9.5, 28.9, 16.2, 2.0, -0.1, -3.4, 11.8, 10.8, -3.0, 15.6, 7.9]
MONTHLY_R_2024 = [17.7, 7.0, 22.7, 21.0, 3.9, 3.5, 13.7, 11.5, 18.5, 27.0, 7.4, 11.1]
MONTHLY_R_2025 = [9.1, 5.7, 8.3, 5.8, -6.0, 4.7, 14.6, 9.0, 9.0, 7.3, 8.2, 8.7]

POOL_R = MONTHLY_R_2023 + MONTHLY_R_2024 + MONTHLY_R_2025  # 36 months
N      = len(POOL_R)

R_DOLLAR = 5_000    # 0.5% of $1M per 1R
SPLIT    = 0.75     # trader's share

MONTH_NAMES = ["Jan","Feb","Mar","Apr","May","Jun",
               "Jul","Aug","Sep","Oct","Nov","Dec"]


def gross(r):   return r * R_DOLLAR
def payout(r):  return max(0.0, gross(r)) * SPLIT


def main():
    print("\n" + "="*70)
    print("  LUX $1M FUNDED — REALISTIC MONTHLY PAYOUT")
    print("  0.5% risk ($5,000/R)  ·  75% profit split  ·  Real QCS data")
    print("="*70)

    # ── WHAT YOUR ACTUAL MONTHS WOULD HAVE PAID ──────────────────────────────
    print(f"\n  ACTUAL MONTHLY PAYOUTS  (if funded during 2023–2025)")
    print(f"  {'─'*60}")
    print(f"  {'Month':<10} {'R':>6}  {'Gross':>12}  {'Your Payout':>12}  {'Note'}")
    print(f"  {'─'*60}")

    for yr, (r_list, year) in enumerate([(MONTHLY_R_2023, 2023),
                                          (MONTHLY_R_2024, 2024),
                                          (MONTHLY_R_2025, 2025)]):
        for m, r in enumerate(r_list):
            g  = gross(r)
            p  = payout(r)
            note = ""
            if r < 0:     note = "  <- loss month, no payout"
            elif r > 20:  note = "  <- standout month"
            label = f"{MONTH_NAMES[m]} {year}"
            print(f"  {label:<10} {r:>6.1f}R  ${g:>10,.0f}  ${p:>10,.0f}{note}")
        yr_r  = sum(r_list)
        yr_p  = sum(payout(r) for r in r_list)
        print(f"  {'─'*60}")
        print(f"  {year} TOTAL  {yr_r:>6.1f}R  ${gross(yr_r):>10,.0f}  ${yr_p:>10,.0f}  (~${yr_p/12:,.0f}/mo avg)")
        print(f"  {'─'*60}")

    # ── MONTE CARLO: 10,000 RANDOM 12-MONTH RUNS ─────────────────────────────
    rng = random.Random(42)
    sim_monthly = []
    sim_annual  = []

    for _ in range(10_000):
        months = [POOL_R[rng.randrange(N)] for _ in range(12)]
        payouts = [payout(r) for r in months]
        sim_monthly.extend(payouts)
        sim_annual.append(sum(payouts))

    def pct(data, p):
        s = sorted(data)
        return s[min(round(p / 100 * len(s)), len(s) - 1)]

    print(f"\n  MONTE CARLO: MONTHLY PAYOUT DISTRIBUTION  (10,000 × 12-month runs)")
    print(f"  {'─'*60}")
    print(f"  Average monthly payout:    ${statistics.mean(sim_monthly):>10,.0f}")
    print(f"  Median monthly payout:     ${statistics.median(sim_monthly):>10,.0f}")
    print(f"  Std deviation:             ${statistics.stdev(sim_monthly):>10,.0f}")
    print(f"  {'─'*60}")
    print(f"  Percentiles:")
    print(f"    5th   (very bad month):  ${pct(sim_monthly,  5):>10,.0f}")
    print(f"   10th:                     ${pct(sim_monthly, 10):>10,.0f}")
    print(f"   25th:                     ${pct(sim_monthly, 25):>10,.0f}")
    print(f"   50th  (median):           ${pct(sim_monthly, 50):>10,.0f}")
    print(f"   75th:                     ${pct(sim_monthly, 75):>10,.0f}")
    print(f"   90th:                     ${pct(sim_monthly, 90):>10,.0f}")
    print(f"   95th  (great month):      ${pct(sim_monthly, 95):>10,.0f}")

    zero_months = sum(1 for p in sim_monthly if p == 0)
    print(f"\n  Zero-payout months (loss months): {zero_months/len(sim_monthly)*100:.1f}%  (~{zero_months/len(sim_monthly)*12:.1f} per year)")

    print(f"\n  HISTOGRAM — monthly payouts")
    print(f"  {'─'*60}")
    buckets = [
        ("$0  (loss month)", 0, 1),
        ("$1–15k          ", 1, 15_000),
        ("$15–30k         ", 15_000, 30_000),
        ("$30–45k         ", 30_000, 45_000),
        ("$45–60k         ", 45_000, 60_000),
        ("$60–80k         ", 60_000, 80_000),
        ("$80k+           ", 80_000, 9_999_999),
    ]
    total = len(sim_monthly)
    for label, lo, hi in buckets:
        cnt = sum(1 for p in sim_monthly if lo <= p < hi)
        pct_val = cnt / total * 100
        bar = "█" * round(pct_val / 1.5)
        print(f"  {label}: {pct_val:4.1f}%  {bar}")

    # ── ANNUAL SUMMARY ────────────────────────────────────────────────────────
    print(f"\n  ANNUAL PAYOUT SUMMARY  (12 months of funded trading)")
    print(f"  {'─'*60}")
    print(f"  Average annual payout:    ${statistics.mean(sim_annual):>10,.0f}")
    print(f"  Median annual payout:     ${statistics.median(sim_annual):>10,.0f}")
    print(f"  {'─'*60}")
    print(f"  Percentiles:")
    print(f"    5th  (bad year):        ${pct(sim_annual,  5):>10,.0f}")
    print(f"   25th:                    ${pct(sim_annual, 25):>10,.0f}")
    print(f"   50th (median):           ${pct(sim_annual, 50):>10,.0f}")
    print(f"   75th:                    ${pct(sim_annual, 75):>10,.0f}")
    print(f"   95th (great year):       ${pct(sim_annual, 95):>10,.0f}")

    avg_ann = statistics.mean(sim_annual)
    print(f"\n  SUMMARY TABLE")
    print(f"  {'─'*60}")
    print(f"  Typical bad month:      $0–$10,000  (loss / flat month)")
    print(f"  Typical average month:  $28,000–$38,000")
    print(f"  Typical strong month:   $50,000–$80,000")
    print(f"  Best realistic month:   ~$108,000  (Mar 2023 pace: 28.9R)")
    print(f"  Average annual income:  ${avg_ann:,.0f}")
    print(f"  Average monthly income: ${avg_ann/12:,.0f}")
    print(f"  {'─'*60}")
    print(f"  Note: loss months = $0 payout (you don't owe the firm)")
    print(f"        losses carry against next payout high-water mark")
    print("="*70 + "\n")


if __name__ == "__main__":
    main()
