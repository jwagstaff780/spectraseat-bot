const db = require("../lib/db");
const stats = require("../lib/stats");

// The home-screen data source: verdict, ROI projection vs realised P&L,
// and the segmentation tables that stop aggregate CLV from hiding where
// the edge (or the bleed) actually lives.
module.exports = async (req, res) => {
  try {
    const excludeHighLag = req.query.excludeHighLag === "true";

    const { rows: graded } = await db.query(
      `SELECT * FROM bets WHERE status = 'graded' ORDER BY placed_at ASC`
    );
    const usable = excludeHighLag ? graded.filter((r) => !(r.quality_flag || []).includes("high_lag")) : graded;

    const clvValues = usable.map((r) => Number(r.clv));
    const verdict = stats.computeVerdict(clvValues);

    const oddsBandTable = stats.groupStats(usable, (r) => stats.oddsBand(Number(r.odds_taken)), (r) => Number(r.clv));
    const marketTable = stats.groupStats(usable, (r) => r.market, (r) => Number(r.clv));
    const bookTable = stats.groupStats(usable, (r) => r.book, (r) => Number(r.clv));
    const leagueTable = stats.groupStats(usable, (r) => r.league, (r) => Number(r.clv));
    const timeBeforeKickoffTable = stats.groupStats(
      usable,
      (r) => {
        const minutes = (new Date(r.kickoff_at).getTime() - new Date(r.placed_at).getTime()) / 60000;
        return stats.minutesBeforeKickoffBucket(minutes);
      },
      (r) => Number(r.clv)
    );

    // "Is this edge or is this latency?" — CLV segmented by how stale the
    // taken book's price was at the moment we placed the bet.
    const staleLineRows = usable.filter((r) => r.book_last_update_at_placement);
    const staleLineTable = stats.groupStats(
      staleLineRows,
      (r) => {
        const staleMinutes = (new Date(r.placed_at).getTime() - new Date(r.book_last_update_at_placement).getTime()) / 60000;
        if (staleMinutes < 1) return "<1m since book updated";
        if (staleMinutes < 5) return "1-5m since book updated";
        if (staleMinutes < 15) return "5-15m since book updated";
        return "15m+ since book updated";
      },
      (r) => Number(r.clv)
    );
    const staleBucketMeans = staleLineTable.filter((g) => g.n > 0).sort((a, b) => b.mean - a.mean);
    const staleLineWarning =
      staleBucketMeans.length > 1 &&
      staleBucketMeans[0].key.startsWith("<1m") &&
      staleBucketMeans[0].mean > 0 &&
      staleBucketMeans[0].mean > (staleBucketMeans[staleBucketMeans.length - 1].mean || 0) * 1.5;

    // Realised P&L — real money only, settled bets only. Independent of the
    // CLV verdict above (which needs no outcome data at all, by design).
    const { rows: realSettled } = await db.query(
      `SELECT * FROM bets WHERE paper = FALSE AND result IS NOT NULL AND stake IS NOT NULL`
    );
    let totalStaked = 0;
    let totalPnl = 0;
    for (const r of realSettled) {
      const stake = Number(r.stake);
      const odds = Number(r.odds_taken);
      totalStaked += stake;
      if (r.result === "win") totalPnl += stake * (odds - 1);
      else if (r.result === "loss") totalPnl -= stake;
      // push: 0
    }
    const realizedRoiPct = totalStaked > 0 ? (totalPnl / totalStaked) * 100 : null;

    const { rows: statusCounts } = await db.query(
      `SELECT status, count(*) AS n FROM bets GROUP BY status`
    );

    res.setHeader("Cache-Control", "no-store");
    res.status(200).json({
      verdict,
      minNForVerdict: stats.MIN_N_FOR_VERDICT,
      projectedRoi: verdict.type === "insufficient" ? null : { mean: verdict.mean, ci: verdict.ci },
      realized: { totalStaked, totalPnl, roiPct: realizedRoiPct, settledCount: realSettled.length },
      segments: {
        oddsBand: oddsBandTable,
        market: marketTable,
        book: bookTable,
        league: leagueTable,
        timeBeforeKickoff: timeBeforeKickoffTable,
      },
      staleLineEdge: { table: staleLineTable, warning: staleLineWarning },
      statusCounts: Object.fromEntries(statusCounts.map((r) => [r.status, Number(r.n)])),
      excludedHighLagCount: excludeHighLag ? graded.length - usable.length : 0,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};
