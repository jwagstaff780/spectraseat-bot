// Cloudflare Pages Functions entry point: runs the same route handlers as
// the Vercel functions (api/), on Cloudflare's free plan (which, unlike
// Vercel Hobby, permits commercial use). Static pages are served from
// public/ by Pages itself; everything under /api/* lands here.
//
// It adapts a Fetch-API Request into the small Node/Vercel-style req/res
// surface the handlers use (req.method/headers/query/body, async-iterable
// raw body; res.status().json(), res.setHeader()).

import { withDb } from "../../lib/workers";

import checkout from "../../api/checkout";
import stripeWebhook from "../../api/webhooks/stripe";
import products from "../../routes/shop/products";
import store from "../../routes/shop/store";
import reviews from "../../routes/shop/reviews";
import content from "../../routes/shop/content";
import support from "../../routes/shop/support";
import track from "../../routes/shop/track";
import contact from "../../routes/shop/contact";
import adminSummary from "../../routes/admin/summary";
import adminProducts from "../../routes/admin/products";
import adminOrders from "../../routes/admin/orders";
import adminTickets from "../../routes/admin/tickets";
import adminAds from "../../routes/admin/ads";
import adminAgents from "../../routes/admin/agents";

// Scheduled jobs (sourcing, fulfilment, marketing, reports) do NOT run
// here: they run as Node scripts in GitHub Actions (scripts/run-job.js),
// which has no request-time or CPU limits.
const ROUTES = {
  checkout,
  "webhooks/stripe": stripeWebhook,
  "shop/products": products,
  "shop/store": store,
  "shop/reviews": reviews,
  "shop/content": content,
  "shop/support": support,
  "shop/track": track,
  "shop/contact": contact,
  "admin/summary": adminSummary,
  "admin/products": adminProducts,
  "admin/orders": adminOrders,
  "admin/tickets": adminTickets,
  "admin/ads": adminAds,
  "admin/agents": adminAgents,
};

function adaptRequest(request, url, raw) {
  const headers = {};
  request.headers.forEach((v, k) => (headers[k] = v));
  let body;
  if (raw && (headers["content-type"] || "").includes("application/json")) {
    try {
      body = JSON.parse(raw);
    } catch {
      body = undefined;
    }
  }
  return {
    method: request.method,
    url: url.pathname + url.search,
    headers,
    query: Object.fromEntries(url.searchParams),
    body,
    socket: {},
    async *[Symbol.asyncIterator]() {
      if (raw) yield Buffer.from(raw, "utf8");
    },
  };
}

function makeResponse() {
  const state = { status: 200, headers: new Headers(), body: null };
  const res = {
    setHeader(k, v) {
      state.headers.set(k, String(v));
      return res;
    },
    status(code) {
      state.status = code;
      return res;
    },
    json(payload) {
      state.headers.set("Content-Type", "application/json");
      state.body = JSON.stringify(payload);
      return res;
    },
    end(text) {
      state.body = text ?? null;
      return res;
    },
  };
  return { res, state };
}

export async function onRequest(context) {
  const { request, params } = context;
  const route = [].concat(params.path || []).join("/");
  const handler = Object.prototype.hasOwnProperty.call(ROUTES, route) ? ROUTES[route] : null;
  if (!handler) return Response.json({ error: "not found" }, { status: 404 });

  const url = new URL(request.url);
  const raw = ["GET", "HEAD"].includes(request.method) ? "" : await request.text();
  const req = adaptRequest(request, url, raw);
  const { res, state } = makeResponse();
  await withDb(context, () => handler(req, res));
  return new Response(state.body, { status: state.status, headers: state.headers });
}
