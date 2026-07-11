// Anchor selection: Pinnacle if present, else Betfair Exchange, else
// nothing. Never fall back to a consensus of soft books.

function selectAnchor(bookmakers) {
  if (!bookmakers) return null;

  const pinnacle = bookmakers.find((b) => b.key === "pinnacle");
  if (pinnacle) return { bookmaker: pinnacle, source: "pinnacle" };

  const betfair = bookmakers.find((b) => (b.key || "").startsWith("betfair_ex"));
  if (betfair) return { bookmaker: betfair, source: "betfair_exchange" };

  return null;
}

function findMarket(bookmaker, marketKey) {
  return (bookmaker.markets || []).find((m) => m.key === marketKey) || null;
}

module.exports = { selectAnchor, findMarket };
