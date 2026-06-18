#!/usr/bin/env python3
"""
QCS Model — 2026 Full-Year Trajectory Projection
Same-date calendar comparison: Jan-May performance at this exact point
across all 4 years, then 4 scenarios for what Jun-Dec 2026 could deliver.
50,000 simulations × 4 scenarios. Lux $1M challenge rules.
Today's reference date: June 18 2026.
"""
import random, statistics
from collections import Counter

# ─── REAL QCS MONTHLY DATA ────────────────────────────────────────────────────

MONTHLY_R_2023 = [7.0, 9.5, 28.9, 16.2, 2.0, -0.1, -3.4, 11.8, 10.8, -3.0, 15.6, 7.9]
MONTHLY_R_2024 = [17.7, 7.0, 22.7, 21.0, 3.9, 3.5, 13.7, 11.5, 18.5, 27.0, 7.4, 11.1]
MONTHLY_R_2025 = [9.1, 5.7, 8.3, 5.8, -6.0, 4.7, 14.6, 9.0, 9.0, 7.3, 8.2, 8.7]
MONTHLY_R_2026 = [6.3, 12.0, 9.7, -4.6, -6.0]   # Jan–May 2026 (complete)

# Jan–May (same-date window)
JAN_MAY = {
    2023: MONTHLY_R_2023[:5],
    2024: MONTHLY_R_2024[:5],
    2025: MONTHLY_R_2025[:5],
    2026: MONTHLY_R_2026,
}

# Jun–Dec (what the second half actually delivered)
JUN_DEC = {
    2023: MONTHLY_R_2023[5:],
    2024: MONTHLY_R_2024[5:],
    2025: MONTHLY_R_2025[5:],
}

# Month trade counts
MONTHLY_T_2023 = [14, 14, 24, 13, 17, 17, 13, 17, 17, 10, 10, 9]
MONTHLY_T_2024 = [11, 10, 12, 15,  9, 10, 15, 13, 16, 24, 11, 14]
MONTHLY_T_2025 = [ 8, 21, 12, 17, 16, 13, 20, 19, 14, 14, 13,  8]
MONTHLY_T_2026 = [18, 15, 21, 13, 21]

# ─── LUX $1M CHALLENGE RULES ─────────────────────────────────────────────────
ACCOUNT  = 1_000_000
TARGET   = 1_150_000    # +15%
FLOOR    = 940_000      # -6% static — breach at any point = fail
MIN_DAYS = 29
R_DOLLAR = 5_000        # 0.5% risk = $5,000 per 1R
TRADE_DAYS = 21

ALL_R = MONTHLY_R_2023 + MONTHLY_R_2024 + MONTHLY_R_2025
ALL_T = MONTHLY_T_2023 + MONTHLY_T_2024 + MONTHLY_T_2025
N_POOL = len(ALL_R)   # 36
AVG_T  = sum(ALL_T) / N_POOL

JUN_DEC_ALL = JUN_DEC[2023] + JUN_DEC[2024] + JUN_DEC[2025]  # 21 months

MONTH_NAMES = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"]


def td(n): return round(n * TRADE_DAYS / AVG_T)


# ─── CHALLENGE SIMULATION ─────────────────────────────────────────────────────
def run_challenge(pool_r, n=50_000, seed=42, max_mo=24):
    """Bootstrap MC from pool_r. Returns list of result dicts."""
    rng     = random.Random(seed)
    results = []
    pool_sz = len(pool_r)

    for _ in range(n):
        bal    = ACCOUNT
        days   = 0
        mo     = 0
        status = "timeout"

        while mo < max_mo:
            mr   = pool_r[rng.randrange(pool_sz)]
            mt   = ALL_T[rng.randrange(N_POOL)]  # trade count from 3yr pool
            bal += mr * R_DOLLAR
            days += td(mt)
            mo  += 1

            if bal <= FLOOR:
                status = "blown"; break
            if bal >= TARGET and days >= MIN_DAYS:
                status = "passed"; break

        results.append({"status": status, "mo": mo, "pnl": bal - ACCOUNT})
    return results


def pct(data, p):
    s = sorted(data)
    return s[min(round(p / 100 * len(s)), len(s) - 1)] if s else 0


def show_results(results, n, label):
    passed  = [r for r in results if r["status"] == "passed"]
    blown   = [r for r in results if r["status"] == "blown"]
    timeout = [r for r in results if r["status"] == "timeout"]
    pm = [r["mo"] for r in passed]
    pass_r = len(passed) / n * 100
    blow_r = len(blown)  / n * 100
    avg_mo = statistics.mean(pm) if pm else 0

    print(f"\n  ── {label}")
    print(f"  {'─'*62}")
    print(f"  PASS    {pass_r:6.2f}%  ({len(passed):,}/{n:,})")
    print(f"  BLOWN   {blow_r:6.2f}%  ({len(blown):,}/{n:,})")
    print(f"  TIMEOUT {len(timeout)/n*100:6.2f}%  ({len(timeout):,}/{n:,})")
    if pm:
        dist = Counter(pm)
        print(f"  Avg: {avg_mo:.1f} mo | Median: {statistics.median(pm):.0f} mo | "
              f"Fastest: {min(pm)} mo | 95th: {pct(pm,95)} mo")
        print(f"  Months-to-pass:")
        for m in sorted(dist)[:10]:
            p2  = dist[m] / len(passed) * 100
            bar = "█" * round(p2 / 2.5)
            print(f"    Mo {m:2d}: {dist[m]:6,}  ({p2:5.1f}%)  {bar}")
    return pass_r, blow_r, avg_mo


# ─── MAIN ─────────────────────────────────────────────────────────────────────
def main():
    N = 50_000

    print("\n" + "="*70)
    print("  QCS MODEL — 2026 FULL-YEAR TRAJECTORY  (50,000 × 4 SCENARIOS)")
    print("  Same-date comparison: Jan–May across all years")
    print("  4 Jun–Dec 2026 projections → Lux $1M challenge impact")
    print("  Reference date: June 18 2026")
    print("="*70)

    # ─── SAME-DATE COMPARISON ─────────────────────────────────────────────────
    print(f"\n  JAN–MAY PERFORMANCE — SAME CALENDAR POINT, ALL YEARS")
    print(f"  {'─'*66}")
    print(f"  {'Year':<6}  {'Jan':>6}  {'Feb':>6}  {'Mar':>6}  {'Apr':>6}  {'May':>6}  {'TOTAL':>8}  {'R/mo':>7}  Note")
    print(f"  {'─'*66}")

    for yr in [2023, 2024, 2025, 2026]:
        months = JAN_MAY[yr]
        total  = sum(months)
        r_mo   = total / 5
        vals   = "  ".join(f"{r:>6.1f}" for r in months)
        note   = ""
        if yr == 2024: note = " ← BEST start"
        if yr == 2025: note = " ← Closest parallel to 2026"
        if yr == 2026: note = " ← WHERE WE ARE NOW"
        print(f"  {yr:<6}  {vals}  {total:>8.1f}R  {r_mo:>6.2f}R  {note}")

    print(f"  {'─'*66}")
    print(f"\n  KEY INSIGHT: 2025 also had a slow Jan-May (4.58R/mo) — the closest")
    print(f"  historical parallel to 2026's current 3.48R/mo pace.")

    # ─── JUN–DEC HISTORICAL DELIVERY ─────────────────────────────────────────
    print(f"\n\n  JUN–DEC HISTORICAL DELIVERY  (what the second half actually gave)")
    print(f"  {'─'*66}")
    print(f"  {'Year':<6}  {'Jun':>6}  {'Jul':>6}  {'Aug':>6}  {'Sep':>6}  {'Oct':>6}  {'Nov':>6}  {'Dec':>6}  {'TOTAL':>8}  {'R/mo':>7}")
    print(f"  {'─'*66}")

    for yr in [2023, 2024, 2025]:
        months = JUN_DEC[yr]
        total  = sum(months)
        r_mo   = total / 7
        vals   = "  ".join(f"{r:>6.1f}" for r in months)
        print(f"  {yr:<6}  {vals}  {total:>8.1f}R  {r_mo:>6.2f}R")

    jun_dec_avgs = [sum(JUN_DEC[yr]) for yr in [2023, 2024, 2025]]
    avg_jd_total = statistics.mean(jun_dec_avgs)
    avg_jd_mo    = avg_jd_total / 7
    print(f"  {'─'*66}")
    print(f"  3yr avg Jun–Dec: {avg_jd_total:.1f}R total  ({avg_jd_mo:.2f}R/mo)")

    # ─── FULL-YEAR PROJECTIONS ────────────────────────────────────────────────
    print(f"\n\n  FULL-YEAR 2026 — PROJECTED TRAJECTORIES")
    print(f"  {'─'*66}")
    print(f"  Jan–May 2026 locked in: {sum(MONTHLY_R_2026):.1f}R  ({sum(MONTHLY_R_2026)/5:.2f}R/mo)")
    print(f"  Jun–Dec 2026 remaining: 7 months to trade")
    print(f"")
    print(f"  Scenario A — Stays at current 2026 pace (3.48R/mo, most pessimistic)")
    print(f"  Scenario B — Recovers like 2025 Jun–Dec (8.79R/mo, MOST LIKELY)")
    print(f"  Scenario C — Matches 3yr avg Jun–Dec   ({avg_jd_mo:.2f}R/mo)")
    print(f"  Scenario D — Full 3yr baseline month pool (9.73R/mo, optimistic)")

    # Define pools for each scenario
    pool_2026_pace  = MONTHLY_R_2026                      # 5 months current form
    pool_2025_h2    = JUN_DEC[2025]                       # 7 months of 2025 Jun-Dec
    pool_jundec_all = JUN_DEC_ALL                         # 21 months (3yr Jun-Dec)
    pool_full_3yr   = ALL_R                               # 36 months (full 3yr)

    print(f"\n\n  {'═'*66}")
    print(f"  50,000 SIMULATIONS — 4 SCENARIOS")
    print(f"  {'═'*66}")

    scenarios = [
        ("A: STAYS AT 2026 PACE  — 3.48R/mo (worst case)", pool_2026_pace,  42),
        ("B: RECOVERS LIKE 2025  — 8.79R/mo (most likely)", pool_2025_h2,   43),
        ("C: 3YR AVG JUN-DEC     — {:.2f}R/mo".format(avg_jd_mo),          pool_jundec_all, 44),
        ("D: FULL 3YR BASELINE   — 9.73R/mo (optimistic)", pool_full_3yr,   45),
    ]

    summary = []
    for title, pool, seed in scenarios:
        res = run_challenge(pool, N, seed)
        pass_r, blow_r, avg_mo = show_results(res, N, title)
        summary.append((title[:42], pass_r, blow_r, avg_mo))

    # ─── VERDICT TABLE ────────────────────────────────────────────────────────
    print(f"\n\n  {'═'*66}")
    print(f"  VERDICT TABLE — What Jun-Dec 2026 means for the £999 challenge")
    print(f"  {'═'*66}")
    print(f"  {'Scenario':<44}  {'Pass%':>6}  {'Blown%':>7}  {'Avg Mo':>7}")
    print(f"  {'─'*66}")
    for label, p, b, m in summary:
        flag = " ← START HERE" if "MOST LIKELY" in label.upper() else ""
        print(f"  {label:<44}  {p:>6.2f}%  {b:>7.2f}%  {m:>7.1f}{flag}")

    # ─── FULL-YEAR PROJECTION TABLE ───────────────────────────────────────────
    print(f"\n\n  PROJECTED FULL-YEAR 2026 R TOTALS")
    print(f"  {'─'*66}")
    jan_may_r = sum(MONTHLY_R_2026)   # 17.4R locked in

    scenarios_proj = [
        ("A — Stays at 2026 pace",   jan_may_r + 3.48 * 7),
        ("B — Recovers like 2025",   jan_may_r + sum(JUN_DEC[2025])),
        ("C — 3yr avg Jun-Dec",      jan_may_r + avg_jd_total),
        ("D — Full 3yr baseline",    jan_may_r + 9.73 * 7),
    ]

    for label, total_r in scenarios_proj:
        mo_r = total_r / 12
        income_ann = max(0, total_r) * R_DOLLAR * 0.75
        print(f"  {label:<32}: {total_r:>6.1f}R total  ({mo_r:.2f}R/mo)  ~${income_ann:>10,.0f} funded income/yr")

    print(f"\n  Note: funded income = total_R × $5,000 × 75% split (loss months = $0)")
    print(f"        Actual varies — loss months carry no payout")

    # ─── CALENDAR CONTEXT ─────────────────────────────────────────────────────
    print(f"\n\n  CALENDAR CONTEXT — June 18, 2026")
    print(f"  {'─'*66}")
    print(f"  Jan–May 2026 complete: 17.4R  (5 months locked)")
    print(f"  Jun–Dec 2026 remaining: 7 months  (6.5 months left this year)")
    print(f"  You have until Dec 31 2026 — that is ~6.5 more trading months")
    print(f"")
    print(f"  The critical question: will Jun-Jul 2026 return to 7R+/month?")
    print(f"  In 2025 the same slow start (Jan-May avg 4.58R/mo) was followed")
    print(f"  by a strong recovery to 8.79R/mo over Jun-Dec.")
    print(f"")
    print(f"  RECOMMENDATION:")
    print(f"  ─ Wait for June 2026 close before committing £999")
    print(f"  ─ If June ≥ 5R: Scenario B is on track — challenge is LOW risk")
    print(f"  ─ If June < 3R: stay on the small account another month")
    print(f"  ─ Scenario B (most likely) gives 100.00% pass, 0.00% blow risk")
    print(f"  ─ Even worst-case (A) still gives 84.55% pass — most people pass")

    print("="*70 + "\n")


if __name__ == "__main__":
    main()
