#!/usr/bin/env python3
"""
Lux $1M Challenge Monte Carlo — bootstrapped from real QCS track record
2023 (full) · 2024 (full) · 2025 (full) · 2026 YTD Jan–May
"""
import random, statistics, sys
from collections import Counter

# ─── REAL QCS MONTHLY DATA ────────────────────────────────────────────────────

MONTHLY_R_2023 = [7.0, 9.5, 28.9, 16.2, 2.0, -0.1, -3.4, 11.8, 10.8, -3.0, 15.6, 7.9]
MONTHLY_T_2023 = [14,  14,  24,   13,   17,  17,   13,   17,   17,   10,   10,   9  ]

MONTHLY_R_2024 = [17.7, 7.0, 22.7, 21.0, 3.9, 3.5, 13.7, 11.5, 18.5, 27.0, 7.4, 11.1]
MONTHLY_T_2024 = [11,   10,  12,   15,   9,   10,  15,   13,   16,   24,   11,  14  ]

MONTHLY_R_2025 = [9.1, 5.7, 8.3, 5.8, -6.0, 4.7, 14.6, 9.0, 9.0, 7.3, 8.2, 8.7]
MONTHLY_T_2025 = [8,   21,  12,  17,  16,   13,  20,   19,  14,  14,  13,  8  ]

MONTHLY_R_2026 = [6.3, 12.0, 9.7, -4.6, -6.0]   # Jan–May 2026
MONTHLY_T_2026 = [18,  15,   21,  13,   21  ]

# Combined 3-year pool (2023-2025)
POOL_R_3YR = MONTHLY_R_2023 + MONTHLY_R_2024 + MONTHLY_R_2025   # 36 months
POOL_T_3YR = MONTHLY_T_2023 + MONTHLY_T_2024 + MONTHLY_T_2025

# Conservative pool (adds 2026 YTD to capture recent soft patch)
POOL_R_CON = POOL_R_3YR + MONTHLY_R_2026   # 41 months
POOL_T_CON = POOL_T_3YR + MONTHLY_T_2026

N_3YR = len(POOL_R_3YR)   # 36
N_CON = len(POOL_R_CON)   # 41

AVG_R_3YR  = sum(POOL_R_3YR) / N_3YR          # ~9.73 R/mo
AVG_R_CON  = sum(POOL_R_CON) / N_CON          # lower (2026 drags)
AVG_T_3YR  = sum(POOL_T_3YR) / N_3YR          # ~14.2 trades/mo

# ─── LUX $1M CHALLENGE RULES ─────────────────────────────────────────────────
ACCOUNT    = 1_000_000
TARGET     = 1_150_000   # +15% profit target
FLOOR      = 940_000     # -6% static drawdown (never breach)
MIN_DAYS   = 29          # minimum trading days
FEE_GBP    = 999
FEE_USD    = round(FEE_GBP * 1.27)

TRADE_DAYS = 21          # trading days in a month


def trading_days(n_trades):
    return round(n_trades * TRADE_DAYS / AVG_T_3YR)


# ─── CHALLENGE SIMULATION ────────────────────────────────────────────────────

def run_challenge(risk_pct, pool_r, pool_t, n=10_000, seed=42, max_mo=18):
    rng      = random.Random(seed)
    r_dollar = risk_pct * ACCOUNT
    pool_n   = len(pool_r)
    results  = []

    for _ in range(n):
        bal    = ACCOUNT
        days   = 0
        mo     = 0
        status = "timeout"

        while mo < max_mo:
            i    = rng.randrange(pool_n)
            mr   = pool_r[i]
            mt   = pool_t[i]
            bal += mr * r_dollar
            days += trading_days(mt)
            mo   += 1

            if bal <= FLOOR:
                status = "blown"
                break
            if bal >= TARGET and days >= MIN_DAYS:
                status = "passed"
                break

        results.append((status, mo, bal, days))
    return results


def print_challenge(results, risk_pct, n, label=""):
    passed  = [o for o in results if o[0] == "passed"]
    blown   = [o for o in results if o[0] == "blown"]
    timeout = [o for o in results if o[0] == "timeout"]
    rd      = risk_pct * ACCOUNT

    tag = f"  [{label}]" if label else ""
    print(f"\n  {'─'*66}")
    print(f"  RISK  {risk_pct*100:.2f}%/trade  =  ${rd:>10,.0f} per 1R{tag}")
    print(f"  {'─'*66}")
    print(f"  Pass rate:           {len(passed)/n*100:6.1f}%   ({len(passed):,} / {n:,})")
    print(f"  Blown (floor hit):   {len(blown)/n*100:6.1f}%   ({len(blown):,} / {n:,})")
    print(f"  Timeout (>18 mo):    {len(timeout)/n*100:6.1f}%   ({len(timeout):,} / {n:,})")

    if passed:
        pm = [o[1] for o in passed]
        print(f"\n  TIME TO PASS (months):")
        print(f"    Average  : {statistics.mean(pm):.1f} months")
        print(f"    Median   : {statistics.median(pm):.0f} months")
        print(f"    Fastest  : {min(pm)} months")
        print(f"    Slowest  : {max(pm)} months")

        dist  = Counter(pm)
        total = len(passed)
        print(f"\n  MONTHS-TO-PASS DISTRIBUTION:")
        for m in sorted(dist):
            pct = dist[m] / total * 100
            bar = "█" * round(pct / 2.5)
            print(f"    Month {m:2d} :  {dist[m]:5,}  ({pct:4.1f}%)  {bar}")


# ─── FUNDED ACCOUNT 3-YEAR INCOME PROJECTION ─────────────────────────────────

def funded_income(risk_pct, pool_r, n=10_000, seed=77):
    rng      = random.Random(seed)
    r_dollar = risk_pct * ACCOUNT
    pool_n   = len(pool_r)

    annual = [[], [], []]
    for _ in range(n):
        for yr in range(3):
            gross = sum(pool_r[rng.randrange(pool_n)] * r_dollar for _ in range(12))
            annual[yr].append(gross)
    return annual


def print_income(annual_gross, risk_pct, n):
    rd = risk_pct * ACCOUNT

    yr_avgs = [statistics.mean(g) for g in annual_gross]
    yr_meds = [statistics.median(g) for g in annual_gross]

    three_yr_gross = [sum(annual_gross[yr][i] for yr in range(3)) for i in range(n)]
    three_avg      = statistics.mean(three_yr_gross)
    three_med      = statistics.median(three_yr_gross)

    payouts = sorted(x * 0.75 for x in three_yr_gross)
    def pct(p): return payouts[min(round(p / 100 * n), n - 1)]

    print(f"\n  {'─'*66}")
    print(f"  FUNDED $1M  —  3-YEAR INCOME PROJECTION")
    print(f"  Risk: {risk_pct*100:.2f}%/trade  ·  ${rd:,.0f}/R  ·  75% profit split")
    print(f"  {'─'*66}")
    for yr in range(3):
        payout_avg = yr_avgs[yr] * 0.75
        print(f"  Year {yr+1} avg gross: ${yr_avgs[yr]:>12,.0f}  →  trader payout: ${payout_avg:>10,.0f}  (~${payout_avg/12:>8,.0f}/mo)")

    print(f"  {'─'*66}")
    print(f"  3-yr avg gross:    ${three_avg:>12,.0f}  →  trader payout: ${three_avg*0.75:>10,.0f}")
    print(f"  3-yr median gross: ${three_med:>12,.0f}  →  trader payout: ${three_med*0.75:>10,.0f}")
    print(f"  Avg monthly payout: ${three_avg*0.75/36:>9,.0f}")
    print(f"\n  3-YEAR PAYOUT PERCENTILE RANGE:")
    print(f"    5th  pct (very bad year):   ${pct(5):>12,.0f}")
    print(f"   25th  pct:                   ${pct(25):>12,.0f}")
    print(f"   50th  pct (median):          ${pct(50):>12,.0f}")
    print(f"   75th  pct:                   ${pct(75):>12,.0f}")
    print(f"   95th  pct (great run):       ${pct(95):>12,.0f}")


# ─── MAIN ─────────────────────────────────────────────────────────────────────

def main():
    N = 10_000

    total_r   = sum(POOL_R_3YR)
    total_t   = sum(POOL_T_3YR)
    neg_months = sum(1 for r in POOL_R_3YR if r < 0)

    print("\n" + "="*70)
    print("  LUX $1M CHALLENGE — MONTE CARLO ON REAL QCS DATA  (10,000 RUNS)")
    print("="*70)

    print(f"\n  TRACK RECORD  (3 full years: Jan 2023 – Dec 2025)")
    print(f"  {'─'*66}")
    print(f"  Year    Trades    Total R    Avg R/mo    Best mo     Worst mo")
    print(f"  {'─'*66}")
    for yr, (r_list, t_list, label) in enumerate([
        (MONTHLY_R_2023, MONTHLY_T_2023, "2023"),
        (MONTHLY_R_2024, MONTHLY_T_2024, "2024"),
        (MONTHLY_R_2025, MONTHLY_T_2025, "2025"),
    ], 1):
        print(f"  {label}    {sum(t_list):>4}       {sum(r_list):>6.1f}R     "
              f"{sum(r_list)/12:>4.1f}R/mo    {max(r_list):>5.1f}R     {min(r_list):>6.1f}R")
    print(f"  {'─'*66}")
    print(f"  TOTAL   {total_t:>4}      {total_r:>7.1f}R     {total_r/36:>4.1f}R/mo")
    print(f"  Negative months: {neg_months}/36 ({neg_months/36*100:.0f}%)")

    print(f"\n  2026 YTD  (Jan–May, most recent 5 months)")
    print(f"  {'─'*66}")
    print(f"  Trades: {sum(MONTHLY_T_2026)}   Total R: {sum(MONTHLY_R_2026):.1f}R   "
          f"Avg: {sum(MONTHLY_R_2026)/5:.1f}R/mo   "
          f"Best: {max(MONTHLY_R_2026):.1f}R   Worst: {min(MONTHLY_R_2026):.1f}R")

    print(f"\n  LUX $1M RULES")
    print(f"  {'─'*66}")
    print(f"  Account: $1,000,000  |  Target: +15% (+$150,000 = $1,150,000)")
    print(f"  Floor:   -6%  (balance must stay above $940,000 at all times)")
    print(f"  Min trading days: {MIN_DAYS}  |  Fee: £{FEE_GBP} (~${FEE_USD})  — refunded on pass")

    # ── CHALLENGE PASS RATE ──────────────────────────────────────────────────
    print(f"\n\n  {'═'*66}")
    print(f"  CHALLENGE PASS RATE  —  3-YEAR DATA POOL (2023-2025)")
    print(f"  {'═'*66}")

    for risk in [0.005, 0.0075, 0.01]:
        res = run_challenge(risk, POOL_R_3YR, POOL_T_3YR, N)
        print_challenge(res, risk, N)

    # ── CONSERVATIVE (includes 2026 soft patch) ──────────────────────────────
    print(f"\n\n  {'═'*66}")
    print(f"  CONSERVATIVE SCENARIO  —  incl. 2026 YTD (weaker recent data)")
    print(f"  {'═'*66}")
    res_con = run_challenge(0.005, POOL_R_CON, POOL_T_CON, N)
    print_challenge(res_con, 0.005, N, label="2023-2026 pool, 0.5% risk")

    # ── FUNDED ACCOUNT INCOME ─────────────────────────────────────────────────
    print(f"\n\n  {'═'*66}")
    print(f"  FUNDED $1M ACCOUNT — INCOME PROJECTION")
    print(f"  Based on 3-year QCS data, 0.5% risk per trade")
    print(f"  {'═'*66}")
    ag = funded_income(0.005, POOL_R_3YR, N)
    print_income(ag, 0.005, N)

    # ── YEAR-BY-YEAR INCOME REALITY CHECK ────────────────────────────────────
    print(f"\n\n  {'═'*66}")
    print(f"  YEAR-BY-YEAR REALITY CHECK  (actual R × $5,000 × 75%)")
    print(f"  {'═'*66}")
    actuals = [
        ("2023", sum(MONTHLY_R_2023)),
        ("2024", sum(MONTHLY_R_2024)),
        ("2025", sum(MONTHLY_R_2025)),
        ("2026*", sum(MONTHLY_R_2026)),
    ]
    for label, total in actuals:
        gross   = total * 5_000
        payout  = gross * 0.75
        monthly = payout / (5 if "2026" in label else 12)
        note    = " * 5 months only" if "2026" in label else ""
        print(f"  {label}: {total:>6.1f}R  →  gross ${gross:>10,.0f}  →  payout ${payout:>10,.0f}  (~${monthly:>8,.0f}/mo){note}")

    print(f"\n  {'─'*66}")
    print(f"  NOTE: All projections assume fixed 0.5% risk on $1M initial account")
    print(f"        (=$5,000 per 1R). Past results do not guarantee future returns.")
    print("="*70 + "\n")


if __name__ == "__main__":
    main()
