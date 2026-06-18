#!/usr/bin/env python3
"""
$100k Funded Account — Challenge pass rate, P&L, time, trades, monthly income
Bootstrapped from real QCS track record (2023-2025)
"""
import random, statistics
from collections import Counter

# ─── REAL QCS MONTHLY DATA ────────────────────────────────────────────────────

MONTHLY_R_2023 = [7.0, 9.5, 28.9, 16.2, 2.0, -0.1, -3.4, 11.8, 10.8, -3.0, 15.6, 7.9]
MONTHLY_T_2023 = [14,  14,  24,   13,   17,  17,   13,   17,   17,   10,   10,   9  ]

MONTHLY_R_2024 = [17.7, 7.0, 22.7, 21.0, 3.9, 3.5, 13.7, 11.5, 18.5, 27.0, 7.4, 11.1]
MONTHLY_T_2024 = [11,   10,  12,   15,   9,   10,  15,   13,   16,   24,   11,  14  ]

MONTHLY_R_2025 = [9.1, 5.7, 8.3, 5.8, -6.0, 4.7, 14.6, 9.0, 9.0, 7.3, 8.2, 8.7]
MONTHLY_T_2025 = [8,   21,  12,  17,  16,   13,  20,   19,  14,  14,  13,  8  ]

POOL_R = MONTHLY_R_2023 + MONTHLY_R_2024 + MONTHLY_R_2025
POOL_T = MONTHLY_T_2023 + MONTHLY_T_2024 + MONTHLY_T_2025
N_POOL = len(POOL_R)         # 36 months
AVG_T  = sum(POOL_T) / N_POOL  # ~14.2 trades/month

# ─── $100k CHALLENGE RULES ────────────────────────────────────────────────────
ACCOUNT    = 100_000
TARGET     = 115_000   # +15% profit target
FLOOR      = 94_000    # -6% static drawdown
MIN_DAYS   = 29
RISK_PCT   = 0.005     # 0.5% per trade
R_DOLLAR   = RISK_PCT * ACCOUNT   # $500 per 1R
SPLIT      = 0.75
TRADE_DAYS = 21

MONTH_NAMES = ["Jan","Feb","Mar","Apr","May","Jun",
               "Jul","Aug","Sep","Oct","Nov","Dec"]


def td(n_trades):
    return round(n_trades * TRADE_DAYS / AVG_T)


def gross(r):  return r * R_DOLLAR
def payout(r): return max(0.0, gross(r)) * SPLIT


# ─── CHALLENGE SIMULATION ─────────────────────────────────────────────────────

def run_challenge(n=10_000, seed=42, max_mo=18):
    rng     = random.Random(seed)
    results = []

    for _ in range(n):
        bal    = ACCOUNT
        days   = 0
        trades = 0
        mo     = 0
        status = "timeout"

        while mo < max_mo:
            i       = rng.randrange(N_POOL)
            mr, mt  = POOL_R[i], POOL_T[i]
            bal    += mr * R_DOLLAR
            trades += mt
            days   += td(mt)
            mo     += 1

            if bal <= FLOOR:
                status = "blown"; break
            if bal >= TARGET and days >= MIN_DAYS:
                status = "passed"; break

        results.append({"status": status, "months": mo,
                        "pnl": bal - ACCOUNT, "trades": trades, "days": days})
    return results


# ─── MONTHLY INCOME SIMULATION ────────────────────────────────────────────────

def run_income(n=10_000, seed=77):
    rng         = random.Random(seed)
    sim_monthly = []
    sim_annual  = []

    for _ in range(n):
        months  = [POOL_R[rng.randrange(N_POOL)] for _ in range(12)]
        payouts = [payout(r) for r in months]
        sim_monthly.extend(payouts)
        sim_annual.append(sum(payouts))

    return sim_monthly, sim_annual


def pct(data, p):
    s = sorted(data)
    return s[min(round(p / 100 * len(s)), len(s) - 1)]


def main():
    N = 10_000

    print("\n" + "="*70)
    print("  $100k FUNDED — REAL QCS DATA MONTE CARLO  (10,000 RUNS)")
    print("  0.5% risk ($500/R)  ·  75% split  ·  2023-2025 track record")
    print("="*70)

    # ── CHALLENGE ─────────────────────────────────────────────────────────────
    results = run_challenge(N)
    passed  = [r for r in results if r["status"] == "passed"]
    blown   = [r for r in results if r["status"] == "blown"]

    pnl_l    = [r["pnl"]    for r in passed]
    months_l = [r["months"] for r in passed]
    trades_l = [r["trades"] for r in passed]

    print(f"\n  CHALLENGE RULES:")
    print(f"  Account: $100,000  |  Target: +15% (+$15,000 = $115,000)")
    print(f"  Floor:   -6% (stay above $94,000)  |  Min days: {MIN_DAYS}")

    print(f"\n  PASS / FAIL")
    print(f"  {'─'*60}")
    print(f"  Pass rate:      {len(passed)/N*100:.1f}%   ({len(passed):,} / {N:,})")
    print(f"  Blown rate:     {len(blown)/N*100:.1f}%   ({len(blown):,} / {N:,})")

    print(f"\n  P&L AT POINT OF PASSING")
    print(f"  {'─'*60}")
    print(f"  Minimum (just hits target):  $15,000")
    print(f"  Average profit at pass:      ${statistics.mean(pnl_l):>9,.0f}")
    print(f"  Median profit at pass:       ${statistics.median(pnl_l):>9,.0f}")
    print(f"  Best case (99th pct):        ${pct(pnl_l,99):>9,.0f}")

    print(f"\n  TIME TO PASS")
    print(f"  {'─'*60}")
    print(f"  Average:     {statistics.mean(months_l):.1f} months")
    print(f"  Median:      {statistics.median(months_l):.0f} months")
    print(f"  Fastest:     {min(months_l)} months")
    print(f"  95% done by: {pct(months_l,95)} months")

    mc = Counter(months_l)
    print(f"\n  MONTHS-TO-PASS:")
    for m in sorted(mc):
        p2  = mc[m] / len(passed) * 100
        bar = "█" * round(p2 / 2)
        print(f"  Month {m:2d}:  {mc[m]:5,}  ({p2:4.1f}%)  {bar}")

    print(f"\n  TRADES TO PASS")
    print(f"  {'─'*60}")
    print(f"  Average:   {statistics.mean(trades_l):.0f} trades")
    print(f"  Median:    {statistics.median(trades_l):.0f} trades")
    print(f"  Fewest:    {min(trades_l)} trades")
    print(f"  Most:      {max(trades_l)} trades")

    # ── ACTUAL MONTHLY PAYOUTS (real years) ───────────────────────────────────
    print(f"\n  ACTUAL MONTHLY PAYOUTS  (if funded $100k during 2023-2025)")
    print(f"  {'─'*60}")
    print(f"  {'Month':<10} {'R':>6}  {'Gross':>9}  {'Payout':>9}  Note")
    print(f"  {'─'*60}")

    for r_list, year in [(MONTHLY_R_2023, 2023),
                          (MONTHLY_R_2024, 2024),
                          (MONTHLY_R_2025, 2025)]:
        for m, r in enumerate(r_list):
            g    = gross(r)
            p    = payout(r)
            note = "  <- loss, $0 payout" if r < 0 else ("  <- standout" if r > 20 else "")
            print(f"  {MONTH_NAMES[m]} {year}  {r:>6.1f}R  ${g:>7,.0f}  ${p:>7,.0f}{note}")
        yr_r = sum(r_list)
        yr_p = sum(payout(r) for r in r_list)
        print(f"  {'─'*60}")
        print(f"  {year} TOTAL  {yr_r:>6.1f}R  ${gross(yr_r):>7,.0f}  ${yr_p:>7,.0f}  (~${yr_p/12:,.0f}/mo)")
        print(f"  {'─'*60}")

    # ── MC MONTHLY INCOME ─────────────────────────────────────────────────────
    sim_mo, sim_ann = run_income(N)

    print(f"\n  MONTE CARLO: MONTHLY PAYOUT DISTRIBUTION  (10,000 runs)")
    print(f"  {'─'*60}")
    print(f"  Average monthly:   ${statistics.mean(sim_mo):>8,.0f}")
    print(f"  Median monthly:    ${statistics.median(sim_mo):>8,.0f}")
    print(f"\n  Percentiles:")
    print(f"    5th  (bad month):   ${pct(sim_mo, 5):>8,.0f}")
    print(f"   25th:                ${pct(sim_mo,25):>8,.0f}")
    print(f"   50th (median):       ${pct(sim_mo,50):>8,.0f}")
    print(f"   75th:                ${pct(sim_mo,75):>8,.0f}")
    print(f"   90th:                ${pct(sim_mo,90):>8,.0f}")
    print(f"   95th (great month):  ${pct(sim_mo,95):>8,.0f}")

    zero_mo = sum(1 for p in sim_mo if p == 0)
    print(f"\n  Zero-payout months: {zero_mo/len(sim_mo)*100:.1f}%  (~{zero_mo/len(sim_mo)*12:.1f} per year)")

    print(f"\n  HISTOGRAM — monthly payouts")
    print(f"  {'─'*60}")
    buckets = [
        ("$0      (loss month)", 0, 1),
        ("$1–1.5k            ", 1, 1_500),
        ("$1.5–3k            ", 1_500, 3_000),
        ("$3–4.5k            ", 3_000, 4_500),
        ("$4.5–6k            ", 4_500, 6_000),
        ("$6–8k              ", 6_000, 8_000),
        ("$8–10k+            ", 8_000, 9_999_999),
    ]
    total = len(sim_mo)
    for label, lo, hi in buckets:
        cnt     = sum(1 for p in sim_mo if lo <= p < hi)
        pct_val = cnt / total * 100
        bar     = "█" * round(pct_val / 1.5)
        print(f"  {label}: {pct_val:4.1f}%  {bar}")

    print(f"\n  ANNUAL PAYOUT SUMMARY")
    print(f"  {'─'*60}")
    print(f"  Average annual:    ${statistics.mean(sim_ann):>9,.0f}")
    print(f"  Median annual:     ${statistics.median(sim_ann):>9,.0f}")
    print(f"  5th  pct (bad year):    ${pct(sim_ann, 5):>9,.0f}")
    print(f"  25th pct:               ${pct(sim_ann,25):>9,.0f}")
    print(f"  75th pct:               ${pct(sim_ann,75):>9,.0f}")
    print(f"  95th pct (great year):  ${pct(sim_ann,95):>9,.0f}")

    print(f"\n  $100k vs $1M — SIDE BY SIDE")
    print(f"  {'─'*60}")
    print(f"  {'':30} {'$100k':>12}  {'$1M':>12}")
    print(f"  {'─'*60}")
    print(f"  {'Risk/trade':30} {'$500':>12}  {'$5,000':>12}")
    print(f"  {'Avg monthly payout':30} {'~$3,784':>12}  {'~$37,840':>12}")
    print(f"  {'Median monthly payout':30} {'~$3,263':>12}  {'~$32,625':>12}")
    print(f"  {'Great month':30} {'~$10,800':>12}  {'~$108,000':>12}")
    print(f"  {'Avg annual income':30} {'~$45,408':>12}  {'~$454,077':>12}")
    print(f"  {'Challenge pass rate':30} {'99.9%':>12}  {'99.9%':>12}")
    print(f"  {'Avg time to pass':30} {'3.8 mo':>12}  {'3.8 mo':>12}")
    print(f"  {'Avg trades to pass':30} {'~55':>12}  {'~55':>12}")
    print("="*70 + "\n")


if __name__ == "__main__":
    main()
