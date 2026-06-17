#!/usr/bin/env python3
"""
Lux $1M Challenge — detailed P&L, time, and trade count per simulation
Bootstrapped from real QCS track record (2023-2025 + 2026 YTD)
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

MONTHLY_R_2026 = [6.3, 12.0, 9.7, -4.6, -6.0]
MONTHLY_T_2026 = [18,  15,   21,  13,   21  ]

POOL_R = MONTHLY_R_2023 + MONTHLY_R_2024 + MONTHLY_R_2025
POOL_T = MONTHLY_T_2023 + MONTHLY_T_2024 + MONTHLY_T_2025
N_POOL = len(POOL_R)   # 36

AVG_T_PER_MO = sum(POOL_T) / N_POOL   # ~14.2

# ─── LUX RULES ───────────────────────────────────────────────────────────────
ACCOUNT  = 1_000_000
TARGET   = 1_150_000   # +15%
FLOOR    = 940_000     # -6% static
MIN_DAYS = 29
RISK_PCT = 0.005       # 0.5% — recommended safe level
R_DOLLAR = RISK_PCT * ACCOUNT   # $5,000 per 1R
TRADE_DAYS_PER_MONTH = 21


def run(n=10_000, seed=42, max_mo=18):
    rng     = random.Random(seed)
    results = []

    for _ in range(n):
        bal    = ACCOUNT
        days   = 0
        trades = 0
        mo     = 0
        status = "timeout"

        while mo < max_mo:
            i  = rng.randrange(N_POOL)
            mr = POOL_R[i]
            mt = POOL_T[i]

            bal    += mr * R_DOLLAR
            trades += mt
            days   += round(mt * TRADE_DAYS_PER_MONTH / AVG_T_PER_MO)
            mo     += 1

            if bal <= FLOOR:
                status = "blown"
                break
            if bal >= TARGET and days >= MIN_DAYS:
                status = "passed"
                break

        results.append({
            "status": status,
            "months": mo,
            "pnl":    bal - ACCOUNT,
            "trades": trades,
            "days":   days,
        })

    return results


def pct(data, p):
    s = sorted(data)
    return s[min(round(p / 100 * len(s)), len(s) - 1)]


def main():
    N = 10_000
    results = run(N)

    passed = [r for r in results if r["status"] == "passed"]
    blown  = [r for r in results if r["status"] == "blown"]

    pnl_list    = [r["pnl"]    for r in passed]
    months_list = [r["months"] for r in passed]
    trades_list = [r["trades"] for r in passed]
    days_list   = [r["days"]   for r in passed]

    print("\n" + "="*70)
    print("  LUX $1M CHALLENGE — P&L · TIME · TRADES  (10,000 simulations)")
    print("  Real QCS data  ·  0.5% risk ($5,000 per 1R)  ·  2023–2025 pool")
    print("="*70)

    print(f"\n  OUTCOME")
    print(f"  {'─'*60}")
    print(f"  Pass:   {len(passed):,} / {N:,}  ({len(passed)/N*100:.1f}%)")
    print(f"  Blown:  {len(blown):,} / {N:,}  ({len(blown)/N*100:.1f}%)")

    print(f"\n  P&L AT POINT OF PASSING  (challenge account profit)")
    print(f"  {'─'*60}")
    print(f"  Minimum possible:    $150,000  (just hits the +15% target)")
    print(f"  Average profit:      ${statistics.mean(pnl_list):>10,.0f}")
    print(f"  Median profit:       ${statistics.median(pnl_list):>10,.0f}")
    print(f"  Best case (99th):    ${pct(pnl_list, 99):>10,.0f}")
    print(f"  Worst case (1st):    ${pct(pnl_list, 1):>10,.0f}")
    print(f"\n  DISTRIBUTION:")
    buckets = [
        (" $150–175k", 150_000, 175_000),
        (" $175–200k", 175_000, 200_000),
        (" $200–250k", 200_000, 250_000),
        (" $250–300k", 250_000, 300_000),
        (" $300–400k", 300_000, 400_000),
        (" $400k+   ", 400_000, 9_999_999),
    ]
    for label, lo, hi in buckets:
        cnt = sum(1 for x in pnl_list if lo <= x < hi)
        pct_val = cnt / len(passed) * 100
        bar = "█" * round(pct_val / 2)
        print(f"  {label}: {cnt:5,}  ({pct_val:4.1f}%)  {bar}")

    print(f"\n  TIME TO PASS  (calendar months of trading)")
    print(f"  {'─'*60}")
    print(f"  Average:    {statistics.mean(months_list):.1f} months")
    print(f"  Median:     {statistics.median(months_list):.0f} months")
    print(f"  Fastest:    {min(months_list)} months")
    print(f"  Slowest:    {max(months_list)} months")
    print(f"  95% done within: {pct(months_list, 95)} months")

    mc = Counter(months_list)
    print(f"\n  MONTHS-TO-PASS:")
    for m in sorted(mc):
        p2 = mc[m] / len(passed) * 100
        bar = "█" * round(p2 / 2)
        print(f"  Month {m:2d}:  {mc[m]:5,}  ({p2:4.1f}%)  {bar}")

    print(f"\n  TRADES TO PASS")
    print(f"  {'─'*60}")
    print(f"  Average trades:   {statistics.mean(trades_list):.0f}")
    print(f"  Median trades:    {statistics.median(trades_list):.0f}")
    print(f"  Fewest trades:    {min(trades_list)}")
    print(f"  Most trades:      {max(trades_list)}")
    print(f"  25th percentile:  {pct(trades_list, 25)}")
    print(f"  75th percentile:  {pct(trades_list, 75)}")

    print(f"\n  TRADING DAYS AT PASS")
    print(f"  {'─'*60}")
    print(f"  Average:   {statistics.mean(days_list):.0f} trading days")
    print(f"  Median:    {statistics.median(days_list):.0f} trading days")
    print(f"  Min:       {min(days_list)} trading days  (min rule: {MIN_DAYS})")
    print(f"  Max:       {max(days_list)} trading days")

    print(f"\n  COST / ROI")
    print(f"  {'─'*60}")
    fee_usd = 999 * 1.27
    avg_pass_pnl = statistics.mean(pnl_list)
    print(f"  Entry fee:        £999  (~${fee_usd:,.0f})  — refunded on first payout")
    print(f"  Avg profit made:  ${avg_pass_pnl:,.0f}  on the challenge account")
    print(f"  Then funded:      75% of all future profits on real $1M account")
    print(f"  Avg monthly income (funded, 0.5% risk): ~$36,700/month")

    print("\n" + "="*70 + "\n")


if __name__ == "__main__":
    main()
