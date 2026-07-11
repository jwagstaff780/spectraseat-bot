function settingsParams() {
  const bankroll = document.getElementById("bankroll").value;
  const kellyMult = document.getElementById("kellyMult").value || "0.25";
  const hardCap = document.getElementById("hardCap").value || "2";
  const params = new URLSearchParams({ kellyMultiplier: kellyMult, hardCapPct: hardCap });
  if (bankroll) params.set("bankroll", bankroll);
  return params.toString();
}

function devigRow(opp) {
  return `
    <div class="devig-row">
      <span><span class="label">mult</span> ${fmtPct(opp.devigMultiplicative.over)}/${fmtPct(opp.devigMultiplicative.under)}</span>
      <span><span class="label">power</span> ${fmtPct(opp.devigPower.over)}/${fmtPct(opp.devigPower.under)}</span>
      <span><span class="label">shin</span> ${fmtPct(opp.devigShin.over)}/${fmtPct(opp.devigShin.under)}</span>
    </div>
  `;
}

function evaluatedCard(opp) {
  const evCls = opp.ev > 0 ? "positive-num" : "negative-num";
  const overroundCls = opp.overroundBanner ? "negative-num" : "dim";
  const title = opp.selectionGroup
    ? `${opp.selection} ${opp.linePoint} — ${opp.selectionGroup}`
    : `${opp.selection} ${opp.linePoint}`;

  return `
    <div class="opp-card">
      ${opp.overroundBanner ? `<div class="banner-red">Overround ${opp.anchorOverroundPct.toFixed(1)}% — above 6% threshold</div>` : ""}
      <div class="row1">
        <div class="teams">${opp.awayTeam} @ ${opp.homeTeam}<br/><span class="dim">${opp.market} · ${title}</span></div>
        <div class="ev ${evCls}">${fmtPct(opp.ev)}</div>
      </div>
      <div class="mono" style="font-size:0.8rem;">
        Anchor <b>${opp.anchorBook}</b> ${fmtOdds(opp.anchorOdds)} →
        fair ${fmtPct(opp.fairProb)} (power) →
        best <b>${opp.bestBook}</b> ${fmtOdds(opp.bestOdds)}
      </div>
      ${devigRow(opp)}
      <div class="meta">
        <span class="overround-val ${overroundCls}">overround ${opp.anchorOverroundPct.toFixed(2)}%</span>
        <span>spread ${opp.maxSpreadPct.toFixed(2)}pp</span>
        <span>kelly stake ${opp.kelly.suggestedStake !== null ? opp.kelly.suggestedStake.toFixed(2) : (opp.kelly.suggestedFraction * 100).toFixed(2) + "% of bankroll"}${opp.kelly.capped ? " (capped)" : ""}</span>
        <span>book updated ${opp.bestBookLastUpdate ? new Date(opp.bestBookLastUpdate).toLocaleTimeString() : "—"}</span>
      </div>
    </div>
  `;
}

function excludedCard(opp) {
  const pillClass = opp.status === "no_sharp_reference" ? "pill no-ref" : "pill";
  const title = opp.selection ? `${opp.selection}${opp.linePoint ? " " + opp.linePoint : ""}` : "";
  return `
    <div class="opp-card greyed">
      <div class="row1">
        <div class="teams">${opp.awayTeam || ""} ${opp.homeTeam ? "@ " + opp.homeTeam : ""}<br/><span class="dim">${opp.market || ""} ${title}</span></div>
        <span class="${pillClass}">${opp.status.replace(/_/g, " ")}</span>
      </div>
      <div class="dim" style="font-size:0.78rem;">${opp.reason}</div>
    </div>
  `;
}

async function loadBoard() {
  const boardEl = document.getElementById("board");
  const excludedEl = document.getElementById("excluded");
  let data;
  try {
    data = await apiGet(`/api/odds?${settingsParams()}`);
  } catch (err) {
    boardEl.innerHTML = `<div class="empty-state">Failed to load board: ${err.message}</div>`;
    return;
  }

  document.getElementById("creditsInfo").textContent =
    data.credits.remaining !== null ? `credits left: ${data.credits.remaining}` : "";

  if (data.board.length === 0) {
    boardEl.innerHTML = `<div class="empty-state">There is no edge here today. No +EV bets passed the screen.</div>`;
  } else {
    boardEl.innerHTML = data.board.map(evaluatedCard).join("");
  }

  excludedEl.innerHTML = data.excluded.length
    ? data.excluded.map(excludedCard).join("")
    : `<div class="empty-state">Nothing excluded.</div>`;
}

["bankroll", "kellyMult", "hardCap"].forEach((id) =>
  document.getElementById(id).addEventListener("change", loadBoard)
);

loadBoard();
setInterval(loadBoard, 60000);
