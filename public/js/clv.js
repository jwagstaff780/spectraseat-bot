function renderSegmentTable(tableEl, rows, keyLabel) {
  tableEl.innerHTML = "";
  if (!rows || rows.length === 0) {
    tableEl.innerHTML = `<tr><td class="dim">No graded bets yet.</td></tr>`;
    return;
  }
  const sorted = [...rows].sort((a, b) => b.n - a.n);
  const thead = document.createElement("thead");
  thead.innerHTML = `<tr><th>${keyLabel}</th><th>n</th><th>Mean CLV</th><th>SD</th><th>SE</th></tr>`;
  const tbody = document.createElement("tbody");
  for (const r of sorted) {
    const tr = document.createElement("tr");
    const cls = r.mean > 0 ? "positive-num" : r.mean < 0 ? "negative-num" : "";
    tr.innerHTML = `
      <td>${r.key}</td>
      <td class="num">${r.n}</td>
      <td class="num ${cls}">${fmtPct(r.mean)}</td>
      <td class="num dim">${r.sd === null ? "—" : fmtPct(r.sd)}</td>
      <td class="num dim">${r.se === null ? "—" : fmtPct(r.se)}</td>
    `;
    tbody.appendChild(tr);
  }
  tableEl.appendChild(thead);
  tableEl.appendChild(tbody);
}

async function loadClv() {
  const excludeHighLag = document.getElementById("excludeHighLag").checked;
  let data;
  try {
    data = await apiGet(`/api/clv?excludeHighLag=${excludeHighLag}`);
  } catch (err) {
    document.getElementById("verdictPanel").textContent = `Failed to load: ${err.message}`;
    return;
  }

  const panel = document.getElementById("verdictPanel");
  panel.className = `panel verdict ${data.verdict.type}`;
  panel.textContent = data.verdict.text;

  document.getElementById("statusCounts").textContent = Object.entries(data.statusCounts || {})
    .map(([k, v]) => `${k}:${v}`)
    .join("  ");

  if (data.projectedRoi) {
    document.getElementById("projRoi").textContent = fmtPct(data.projectedRoi.mean);
    document.getElementById("projCi").textContent = `${fmtPct(data.projectedRoi.ci.lo)} to ${fmtPct(data.projectedRoi.ci.hi)}`;
  } else {
    document.getElementById("projRoi").textContent = "—";
    document.getElementById("projCi").textContent = "n too small";
  }

  document.getElementById("realPnl").textContent =
    data.realized.settledCount > 0 ? data.realized.totalPnl.toFixed(2) : "—";
  document.getElementById("realRoi").textContent =
    data.realized.roiPct !== null ? `${data.realized.roiPct.toFixed(1)}%` : "no settled real bets";

  const staleTable = document.getElementById("staleLineTable");
  const stalePanel = document.getElementById("staleLinePanel");
  if (data.staleLineEdge.table.length > 0) {
    stalePanel.style.display = "";
    renderSegmentTable(staleTable, data.staleLineEdge.table, "Book staleness at placement");
    document.getElementById("staleLineWarning").style.display = data.staleLineEdge.warning ? "" : "none";
  }

  renderSegmentTable(document.getElementById("oddsBandTable"), data.segments.oddsBand, "Odds band");
  renderSegmentTable(document.getElementById("marketTable"), data.segments.market, "Market");
  renderSegmentTable(document.getElementById("bookTable"), data.segments.book, "Book");
  renderSegmentTable(document.getElementById("leagueTable"), data.segments.league, "League");
  renderSegmentTable(document.getElementById("timeTable"), data.segments.timeBeforeKickoff, "Time before kickoff");
}

document.getElementById("excludeHighLag").addEventListener("change", loadClv);
loadClv();
