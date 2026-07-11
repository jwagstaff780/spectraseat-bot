const config = require("../lib/config");

// Compares the live "what's actually active right now" catalog against
// config.TRACKED_SPORTS, so drift (a new tournament starting, a tracked
// league going quiet) surfaces as a banner in the app instead of requiring
// someone to notice and re-probe manually. Uses only real Odds API data —
// no news, no inference, same rule as everything else here. The /sports
// call itself is free (0 credits).
let cache = { data: null, fetchedAt: 0 };
const CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6h — this only needs to be roughly fresh

async function fetchActiveCatalog() {
  const key = process.env.ODDS_API_KEY;
  if (!key) throw new Error("ODDS_API_KEY is not set");
  const res = await fetch(`${config.ODDS_API_BASE}/sports/?apiKey=${key}&all=false`);
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new Error(`Odds API error ${res.status}: ${body && body.message}`);
  }
  return res.json();
}

module.exports = async (req, res) => {
  try {
    if (!cache.data || Date.now() - cache.fetchedAt >= CACHE_TTL_MS) {
      const active = await fetchActiveCatalog();
      cache = { data: active, fetchedAt: Date.now() };
    }

    const activeKeys = new Set(cache.data.map((s) => s.key));
    const trackedKeys = new Set(config.TRACKED_SPORTS.map((s) => s.key));

    const trackedButInactive = config.TRACKED_SPORTS.filter((s) => !activeKeys.has(s.key));
    const activeButNotTracked = cache.data
      .filter((s) => !trackedKeys.has(s.key))
      .map((s) => ({ key: s.key, title: s.title, group: s.group }));

    res.setHeader("Cache-Control", "no-store");
    res.status(200).json({
      checkedAt: new Date(cache.fetchedAt).toISOString(),
      trackedButInactive,
      activeButNotTracked,
    });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
};
