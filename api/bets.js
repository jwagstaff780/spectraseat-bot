const db = require("../lib/db");

// GET /api/bets?status=graded&paper=false  — list bets (raw log, for audit
// and for the CLV dashboard to pull segmentation data from).
// PATCH /api/bets?id=123 { paper, stake, result } — the "opt OUT of paper
// mode" action: mark a specific flagged bet as one you actually placed for
// real money, with a real stake. Also usable to manually mark a result for
// markets the cron can't auto-settle (totals_h1 / team_totals_h1).
module.exports = async (req, res) => {
  try {
    if (req.method === "GET") {
      const clauses = [];
      const params = [];
      if (req.query.status) {
        params.push(req.query.status);
        clauses.push(`status = $${params.length}`);
      }
      if (req.query.paper !== undefined) {
        params.push(req.query.paper === "true");
        clauses.push(`paper = $${params.length}`);
      }
      const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
      const { rows } = await db.query(
        `SELECT * FROM bets ${where} ORDER BY placed_at DESC LIMIT 1000`,
        params
      );
      res.status(200).json({ bets: rows });
      return;
    }

    if (req.method === "PATCH") {
      const id = Number(req.query.id);
      if (!id) {
        res.status(400).json({ error: "id query param required" });
        return;
      }
      const { paper, stake, result } = req.body || {};
      const sets = [];
      const params = [];

      if (paper !== undefined) {
        params.push(paper);
        sets.push(`paper = $${params.length}`);
      }
      if (stake !== undefined) {
        params.push(stake);
        sets.push(`stake = $${params.length}`);
      }
      if (result !== undefined) {
        params.push(result);
        sets.push(`result = $${params.length}`, `settled_at = now()`);
      }
      if (sets.length === 0) {
        res.status(400).json({ error: "nothing to update" });
        return;
      }
      params.push(id);
      const { rows } = await db.query(
        `UPDATE bets SET ${sets.join(", ")} WHERE id = $${params.length} RETURNING *`,
        params
      );
      res.status(200).json({ bet: rows[0] });
      return;
    }

    res.status(405).json({ error: "GET or PATCH only" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};
