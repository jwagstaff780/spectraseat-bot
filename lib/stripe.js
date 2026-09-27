// Minimal Stripe client over fetch (Checkout Sessions + webhook signature
// verification). Card data never touches our servers — Stripe Checkout is a
// hosted page.

const crypto = require("crypto");

const API = "https://api.stripe.com/v1";

// Stripe's API takes application/x-www-form-urlencoded with bracket
// notation for nested objects/arrays: line_items[0][price_data][currency]=usd
function formEncode(obj, prefix, out = []) {
  for (const [key, value] of Object.entries(obj)) {
    if (value === undefined || value === null) continue;
    const name = prefix ? `${prefix}[${key}]` : key;
    if (typeof value === "object") formEncode(value, name, out);
    else out.push(`${encodeURIComponent(name)}=${encodeURIComponent(String(value))}`);
  }
  return out.join("&");
}

async function stripeRequest(method, path, params) {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) throw new Error("STRIPE_SECRET_KEY is not set.");
  const res = await fetch(API + path, {
    method,
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: params ? formEncode(params) : undefined,
  });
  const json = await res.json();
  if (!res.ok) throw new Error(`Stripe ${method} ${path}: ${(json.error && json.error.message) || res.status}`);
  return json;
}

function createCheckoutSession(params) {
  return stripeRequest("POST", "/checkout/sessions", params);
}

function getCheckoutSession(id) {
  return stripeRequest("GET", `/checkout/sessions/${encodeURIComponent(id)}?expand[]=line_items`);
}

function updateDispute(id, params) {
  return stripeRequest("POST", `/disputes/${encodeURIComponent(id)}`, params);
}

function createRefund(paymentIntent) {
  return stripeRequest("POST", "/refunds", { payment_intent: paymentIntent });
}

// Verifies the Stripe-Signature header (t=...,v1=...) against the raw body.
// https://docs.stripe.com/webhooks#verify-manually
function verifyWebhook(rawBody, header, secret, toleranceSec = 300, nowSec = Math.floor(Date.now() / 1000)) {
  if (!header || !secret) return false;
  const parts = Object.fromEntries(
    header.split(",").map((kv) => {
      const i = kv.indexOf("=");
      return [kv.slice(0, i), kv.slice(i + 1)];
    })
  );
  const signatures = header
    .split(",")
    .filter((kv) => kv.startsWith("v1="))
    .map((kv) => kv.slice(3));
  const t = Number(parts.t);
  if (!t || signatures.length === 0) return false;
  if (Math.abs(nowSec - t) > toleranceSec) return false;

  const expected = crypto.createHmac("sha256", secret).update(`${t}.${rawBody}`, "utf8").digest("hex");
  return signatures.some((sig) => {
    const a = Buffer.from(sig, "hex");
    const b = Buffer.from(expected, "hex");
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  });
}

module.exports = { formEncode, createCheckoutSession, getCheckoutSession, createRefund, updateDispute, verifyWebhook };
