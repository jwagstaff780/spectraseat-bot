function settingsParams() {
  const bankroll = document.getElementById("bankroll").value;
  const kellyMult = document.getElementById("kellyMult").value || "0.25";
  const hardCap = document.getElementById("hardCap").value || "2";
  const params = new URLSearchParams({ kellyMultiplier: kellyMult, hardCapPct: hardCap });
  if (bankroll) params.set("bankroll", bankroll);
  return params.toString();
}

const STATUS_LABELS = {
  no_sharp_reference: "no reference price",
  unresolvable: "estimates don't agree",
  no_comparison: "no other price to check",
  no_data: "no price data",
  fetch_error: "couldn't load",
};

function devigRow(opp) {
  // Three ways of estimating the "true" chance, all shown so nothing is
  // hidden — "Best estimate" is the one actually used to judge the bet.
  // devigTable has one entry per outcome in the market (2 for a two-way
  // total, up to 3 for soccer's Home/Draw/Away).
  const names = opp.devigTable.map((d) => d.name).join(" / ");
  const mult = opp.devigTable.map((d) => fmtPct(d.multiplicative)).join(" / ");
  const power = opp.devigTable.map((d) => fmtPct(d.power)).join(" / ");
  const shin = opp.devigTable.map((d) => fmtPct(d.shin)).join(" / ");
  return `
    <div class="devig-row" style="flex-direction:column; gap:2px;">
      <span class="dim">${names}</span>
      <span><span class="label">Simple estimate</span> ${mult}</span>
      <span><span class="label">Best estimate (used)</span> ${power}</span>
      <span><span class="label">Cross-check</span> ${shin}</span>
    </div>
  `;
}

// h2h markets (soccer Home/Draw/Away, tennis match winner) have no line
// point — the selection name (team/player/"Draw") says it all. Totals-type
// markets always have a real point.
function betTitle(opp) {
  if (opp.market === "h2h") return opp.selection;
  return opp.selectionGroup ? `${opp.selection} ${opp.linePoint} — ${opp.selectionGroup}` : `${opp.selection} ${opp.linePoint}`;
}

function evaluatedCard(opp) {
  const evCls = opp.ev > 0 ? "positive-num" : "negative-num";
  const overroundCls = opp.overroundBanner ? "negative-num" : "dim";
  const title = betTitle(opp);

  const stakeText =
    opp.kelly.suggestedStake !== null
      ? `£${opp.kelly.suggestedStake.toFixed(2)}`
      : `${(opp.kelly.suggestedFraction * 100).toFixed(2)}% of your bankroll`;

  return `
    <div class="opp-card">
      ${opp.overroundBanner ? `<div class="banner-red">This bookmaker's margin is ${opp.anchorOverroundPct.toFixed(1)}% — unusually high (above 6%)</div>` : ""}
      <div class="row1">
        <div class="teams">${opp.awayTeam} @ ${opp.homeTeam}<br/><span class="dim">${opp.market} · ${title}</span></div>
        <div class="ev ${evCls}">${fmtPct(opp.ev)}</div>
      </div>
      <div class="mono" style="font-size:0.8rem;">
        Sharp price (<b>${opp.anchorBook}</b>): ${fmtOdds(opp.anchorOdds)} → real chance ≈ ${fmtPct(opp.fairProb)}<br/>
        Best price you can get: <b>${opp.bestBook}</b> at ${fmtOdds(opp.bestOdds)}
      </div>
      ${devigRow(opp)}
      <div class="meta">
        <span class="overround-val ${overroundCls}">bookmaker's margin: ${opp.anchorOverroundPct.toFixed(2)}%</span>
        <span>estimates agree within ${opp.maxSpreadPct.toFixed(2)} points</span>
        <span>suggested bet size: ${stakeText}${opp.kelly.capped ? " (capped)" : ""}</span>
        <span>price last changed: ${opp.bestBookLastUpdate ? new Date(opp.bestBookLastUpdate).toLocaleTimeString() : "unknown"}</span>
      </div>
    </div>
  `;
}

function excludedCard(opp) {
  const pillClass = opp.status === "no_sharp_reference" ? "pill no-ref" : "pill";
  const title = opp.selection ? betTitle(opp) : "";
  const label = STATUS_LABELS[opp.status] || opp.status.replace(/_/g, " ");
  return `
    <div class="opp-card greyed">
      <div class="row1">
        <div class="teams">${opp.awayTeam || ""} ${opp.homeTeam ? "@ " + opp.homeTeam : ""}<br/><span class="dim">${opp.market || ""} ${title}</span></div>
        <span class="${pillClass}">${label}</span>
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

async function loadCatalogStatus() {
  const panel = document.getElementById("catalogDrift");
  const body = document.getElementById("catalogDriftBody");
  let data;
  try {
    data = await apiGet("/api/catalog-status");
  } catch {
    return; // best-effort only — never block the board over this
  }

  const parts = [];

  if (data.trackedButInactive.length > 0) {
    const names = data.trackedButInactive.map((s) => s.league).join(", ");
    parts.push(`<div>Gone quiet — no longer active: <b>${names}</b></div>`);
  }

  if (data.activeButNotTracked.length > 0) {
    const shown = data.activeButNotTracked.slice(0, 15).map((s) => s.title);
    const extra = data.activeButNotTracked.length - shown.length;
    parts.push(
      `<div style="margin-top:6px;">Active right now but not tracked (${data.activeButNotTracked.length}): ${shown.join(", ")}${extra > 0 ? ` … +${extra} more` : ""}</div>`
    );
  }

  if (parts.length === 0) {
    panel.style.display = "none";
    return;
  }

  body.innerHTML = parts.join("");
  panel.style.display = "";
}

["bankroll", "kellyMult", "hardCap"].forEach((id) =>
  document.getElementById(id).addEventListener("change", loadBoard)
);

loadBoard();
loadCatalogStatus();
setInterval(loadBoard, 60000);
