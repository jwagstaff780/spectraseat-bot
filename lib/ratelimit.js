const db = require("./db");

function clientIp(req) {
  const fwd = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim();
  return fwd || req.headers["x-real-ip"] || (req.socket && req.socket.remoteAddress) || "unknown";
}

// Returns true if allowed. Fixed one-hour windows per key.
async function allow(key, limitPerHour) {
  const { rows } = await db.query(
    `INSERT INTO rate_limits (key, window_start, count) VALUES ($1, date_trunc('hour', now()), 1)
     ON CONFLICT (key, window_start) DO UPDATE SET count = rate_limits.count + 1
     RETURNING count`,
    [key]
  );
  if (Math.random() < 0.02) await db.query(`DELETE FROM rate_limits WHERE window_start < now() - interval '1 day'`);
  return rows[0].count <= limitPerHour;
}

module.exports = { allow, clientIp };
