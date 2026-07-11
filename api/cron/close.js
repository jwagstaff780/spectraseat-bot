const db = require("../../lib/db");
const oddsApi = require("../../lib/oddsApi");
const config = require("../../lib/config");
const { findMarket } = require("../../lib/anchor");
const { outcomeGroupKey } = require("../../lib/evaluateEvent");
const { gradeSnapshot } = require("../../lib/grading");

// Triggered externally (GitHub Actions cron, ~5 min interval — see
// .github/workflows/close-line-poller.yml). Vercel Hobby cron only fires
// daily, which is useless for capturing a line close to kickoff, so this
// endpoint is designed to be hit by an outside scheduler instead.
//
// Every invocation does two things:
//  1. For bets not yet at kickoff: take a fresh snapshot of the SAME anchor
//     book recorded at placement. If that book still quotes the market,
//     overwrite the stored snapshot — so whatever we have when kickoff
//     arrives is, by construction, the last successful poll before the
//     market closed.
//  2. For bets past kickoff: grade using whatever snapshot survived.

function requireAuth(req) {
  const secret = process.env.CRON_SECRET;
  if (!secret) throw new Error("CRON_SECRET is not set");
  const header = req.headers.authorization || "";
  const provided = header.startsWith("Bearer ") ? header.slice(7) : req.query.secret;
  if (provided !== secret) {
    const err = new Error("unauthorized");
    err.status = 401;
    throw err;
  }
}

function groupBy(rows, keyFn) {
  const map = new Map();
  for (const row of rows) {
    const key = keyFn(row);
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(row);
  }
  return map;
}

function findOutcomeInMarket(market, linePoint, selectionGroup, name) {
  const targetKey = `${linePoint ?? ""}|${selectionGroup ?? ""}`;
  return (market.outcomes || []).find((o) => outcomeGroupKey(o) === targetKey && o.name === name) || null;
}

function otherSideName(selection) {
  return selection === "Over" ? "Under" : "Over";
}

async function pollPreKickoff(bets) {
  const byEvent = groupBy(bets, (b) => `${b.sport_key}::${b.event_id}`);
  let updated = 0;

  for (const [, group] of byEvent) {
    const { sport_key: sportKey, event_id: eventId } = group[0];
    const markets = [...new Set(group.map((b) => b.market))];

    let response;
    try {
      response = await oddsApi.getEventOdds(sportKey, eventId, markets);
    } catch (err) {
      continue; // event may have vanished from the board; skip this round
    }

    const bookmakers = (response.body && response.body.bookmakers) || [];

    for (const bet of group) {
      const book = bookmakers.find((b) => b.key === bet.anchor_book);
      if (!book) continue;
      const market = findMarket(book, bet.market);
      if (!market) continue;

      const ourOutcome = findOutcomeInMarket(market, bet.line_point, bet.selection_group, bet.selection);
      const otherOutcome = findOutcomeInMarket(market, bet.line_point, bet.selection_group, otherSideName(bet.selection));
      if (!ourOutcome || !otherOutcome) continue;

      await db.query(
        `UPDATE bets SET close_captured_at = now(), anchor_close_raw = $1, anchor_close_other_side_raw = $2 WHERE id = $3`,
        [ourOutcome.price, otherOutcome.price, bet.id]
      );
      updated++;
    }
  }

  return updated;
}

async function checkVoid(sportKey, eventId, scoresCache) {
  if (!scoresCache.has(sportKey)) {
    try {
      const res = await oddsApi.getScores(sportKey, 3);
      scoresCache.set(sportKey, res.body || []);
    } catch {
      scoresCache.set(sportKey, null);
    }
  }
  const scores = scoresCache.get(sportKey);
  if (!scores) return { checked: false, void: false, event: null };

  const event = scores.find((e) => e.id === eventId);
  if (!event) return { checked: true, void: false, event: null }; // no info either way — don't assume void
  return { checked: true, void: event.completed === false, event };
}

function settleFromScore(bet, scoreEvent) {
  if (!scoreEvent || !scoreEvent.completed || !Array.isArray(scoreEvent.scores)) return null;
  if (bet.market === "totals") {
    const total = scoreEvent.scores.reduce((sum, s) => sum + Number(s.score), 0);
    if (total === Number(bet.line_point)) return "push";
    const overWon = total > Number(bet.line_point);
    if (bet.selection === "Over") return overWon ? "win" : "loss";
    return overWon ? "loss" : "win";
  }
  if (bet.market === "team_totals") {
    const teamScore = scoreEvent.scores.find((s) => s.name === bet.selection_group);
    if (!teamScore) return null;
    const score = Number(teamScore.score);
    if (score === Number(bet.line_point)) return "push";
    const overWon = score > Number(bet.line_point);
    if (bet.selection === "Over") return overWon ? "win" : "loss";
    return overWon ? "loss" : "win";
  }
  // totals_h1 / team_totals_h1: the scores endpoint only exposes full-game
  // scores, so first-half markets can't be auto-settled. Left for manual
  // marking.
  return null;
}

async function gradePostKickoff(bets) {
  const scoresCache = new Map();
  const byEvent = groupBy(bets, (b) => `${b.sport_key}::${b.event_id}`);
  let graded = 0;
  let voided = 0;
  let unresolvable = 0;
  let settled = 0;

  for (const [, group] of byEvent) {
    const { sport_key: sportKey, event_id: eventId } = group[0];
    // Only bother checking void status once kickoff is well behind us —
    // scores take time to post, and checking too early just burns credits.
    const wellPastKickoff = Date.now() - new Date(group[0].kickoff_at).getTime() > 5 * 60 * 60 * 1000;
    const voidCheck = wellPastKickoff ? await checkVoid(sportKey, eventId, scoresCache) : { checked: false, void: false, event: null };

    for (const bet of group) {
      if (voidCheck.void) {
        await db.query(`UPDATE bets SET status = 'void', clv = NULL WHERE id = $1`, [bet.id]);
        voided++;
        continue;
      }

      if (!bet.close_captured_at) {
        await db.query(
          `UPDATE bets SET status = 'unresolvable', quality_flag = array_append(quality_flag, 'no_close_captured') WHERE id = $1`,
          [bet.id]
        );
        unresolvable++;
        continue;
      }

      const result = gradeSnapshot({
        oddsTaken: Number(bet.odds_taken),
        closeRaw: Number(bet.anchor_close_raw),
        closeOtherSideRaw: Number(bet.anchor_close_other_side_raw),
        kickoffAt: bet.kickoff_at,
        capturedAt: bet.close_captured_at,
      });

      const flags = [];
      if (result.highLag) flags.push("high_lag");
      if (result.unresolvable) flags.push("devig_disagreement");

      const status = result.unresolvable ? "unresolvable" : "graded";
      if (status === "unresolvable") unresolvable++;
      else graded++;

      await db.query(
        `UPDATE bets SET
           status = $1, close_capture_lag_s = $2,
           anchor_close_overround = $3,
           p_close_mult = $4, p_close_power = $5, p_close_shin = $6,
           clv = $7, quality_flag = $8
         WHERE id = $9`,
        [
          status,
          result.lagSeconds,
          result.overroundPct,
          result.pCloseMult,
          result.pClosePower,
          result.pCloseShin,
          result.clv,
          flags,
          bet.id,
        ]
      );

      // Best-effort real-money settlement (totals / team_totals only).
      if (!bet.paper && !bet.result && voidCheck.event) {
        const outcome = settleFromScore(bet, voidCheck.event);
        if (outcome) {
          await db.query(`UPDATE bets SET result = $1, settled_at = now() WHERE id = $2`, [outcome, bet.id]);
          settled++;
        }
      }
    }
  }

  return { graded, voided, unresolvable, settled };
}

module.exports = async (req, res) => {
  try {
    requireAuth(req);
  } catch (err) {
    res.status(err.status || 401).json({ error: err.message });
    return;
  }

  try {
    const { rows: pending } = await db.query(`SELECT * FROM bets WHERE status = 'pending'`);
    const now = Date.now();
    const preKickoff = pending.filter((b) => new Date(b.kickoff_at).getTime() > now);
    const postKickoff = pending.filter((b) => new Date(b.kickoff_at).getTime() <= now);

    const snapshotsUpdated = await pollPreKickoff(preKickoff);
    const gradeResult = await gradePostKickoff(postKickoff);

    res.status(200).json({
      pendingChecked: pending.length,
      preKickoff: preKickoff.length,
      postKickoff: postKickoff.length,
      snapshotsUpdated,
      ...gradeResult,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};
