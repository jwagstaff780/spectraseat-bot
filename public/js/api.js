async function apiGet(path) {
  const res = await fetch(path);
  const body = await res.json();
  if (!res.ok) throw new Error(body.error || `Request failed: ${res.status}`);
  return body;
}

async function apiPatch(path, data) {
  const res = await fetch(path, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(body.error || `Request failed: ${res.status}`);
  return body;
}

function fmtPct(fraction, decimals = 1) {
  if (fraction === null || fraction === undefined || Number.isNaN(fraction)) return "—";
  const pct = fraction * 100;
  const sign = pct >= 0 ? "+" : "";
  return `${sign}${pct.toFixed(decimals)}%`;
}

function fmtOdds(o) {
  if (o === null || o === undefined) return "—";
  return Number(o).toFixed(2);
}
