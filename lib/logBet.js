const db = require("./db");

// Auto-logs a flagged (+EV) opportunity as a paper bet. Idempotent: the
// first time an opportunity is seen wins the row (ON CONFLICT DO NOTHING),
// so re-polling the same still-live edge doesn't overwrite the entry price
// we actually would have gotten.
async function logFlaggedBet(opp) {
  await db.query(
    `INSERT INTO bets (
      event_id, sport_key, league, home_team, away_team,
      market, selection, selection_group, line_point,
      book, odds_taken, paper,
      kickoff_at,
      anchor_book, anchor_odds_at_placement, anchor_p_at_placement,
      book_last_update_at_placement
    ) VALUES ($1,$2,$3,$4,$5, $6,$7,$8,$9, $10,$11,TRUE, $12, $13,$14,$15, $16)
    ON CONFLICT (event_id, market, selection, selection_group, line_point, book) DO NOTHING`,
    [
      opp.eventId,
      opp.sportKey,
      opp.league,
      opp.homeTeam,
      opp.awayTeam,
      opp.market,
      opp.selection,
      opp.selectionGroup,
      opp.linePoint,
      opp.bestBook,
      opp.bestOdds,
      opp.commenceTime,
      opp.anchorBook,
      opp.anchorOdds,
      opp.fairProb,
      opp.bestBookLastUpdate,
    ]
  );
}

module.exports = { logFlaggedBet };
