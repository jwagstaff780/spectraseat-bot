const crypto = require("crypto");

function safeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

// Bearer-token guard. Returns true if the request may proceed; otherwise
// writes a 401/500 and returns false.
function requireBearer(req, res, envVar) {
  const secret = process.env[envVar];
  if (!secret) {
    res.status(500).json({ error: `${envVar} is not configured` });
    return false;
  }
  const header = req.headers.authorization || "";
  if (!header.startsWith("Bearer ") || !safeEqual(header.slice(7), secret)) {
    res.status(401).json({ error: "unauthorized" });
    return false;
  }
  return true;
}

module.exports = { requireBearer, safeEqual };
