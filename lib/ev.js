// EV = p_fair × decimal_odds − 1. Rank by EV, never by win probability.

function computeEV(fairProb, decimalOdds) {
  return fairProb * decimalOdds - 1;
}

function kellyFraction(fairProb, decimalOdds) {
  const b = decimalOdds - 1;
  const q = 1 - fairProb;
  return (fairProb * b - q) / b;
}

function suggestedStake({ fairProb, decimalOdds, bankroll, kellyMultiplier = 0.25, hardCapPct = 2 }) {
  const fullKellyFraction = kellyFraction(fairProb, decimalOdds);
  const rawFraction = Math.max(0, fullKellyFraction * kellyMultiplier);
  const capFraction = hardCapPct / 100;
  const suggestedFraction = Math.min(rawFraction, capFraction);

  return {
    fullKellyFraction,
    suggestedFraction,
    suggestedStake: bankroll != null ? bankroll * suggestedFraction : null,
    capped: rawFraction > capFraction,
  };
}

module.exports = { computeEV, kellyFraction, suggestedStake };
