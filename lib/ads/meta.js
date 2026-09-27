// Meta Marketing API (Facebook + Instagram ads), Conversions API and Page /
// Instagram publishing, over fetch. Needs a System User access token with
// ads_management, pages_manage_posts and instagram_content_publish.
// Verify against your account with `npm run probe:meta` before ADS_MODE=live.

const crypto = require("crypto");

const VERSION = process.env.META_API_VERSION || "v23.0";
const BASE = `https://graph.facebook.com/${VERSION}`;

function env(name) {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not set.`);
  return v;
}

function enabled() {
  return Boolean(process.env.META_ACCESS_TOKEN && process.env.META_AD_ACCOUNT_ID);
}

async function graph(method, path, params = {}, token = process.env.META_ACCESS_TOKEN) {
  if (!token) throw new Error("META_ACCESS_TOKEN is not set.");
  const url = new URL(`${BASE}/${path.replace(/^\//, "")}`);
  const body = new URLSearchParams();
  const target = method === "GET" ? url.searchParams : body;
  for (const [k, v] of Object.entries({ ...params, access_token: token })) {
    if (v === undefined || v === null) continue;
    target.set(k, typeof v === "object" ? JSON.stringify(v) : String(v));
  }
  const res = await fetch(url, { method, body: method === "GET" ? undefined : body });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json.error) {
    const e = json.error || {};
    throw new Error(`Meta ${method} ${path}: ${e.error_user_msg || e.message || res.status}`);
  }
  return json;
}

const act = () => `act_${env("META_AD_ACCOUNT_ID").replace(/^act_/, "")}`;

async function uploadImage(imageUrl) {
  const img = await fetch(imageUrl);
  if (!img.ok) throw new Error(`image fetch ${img.status}`);
  const bytes = Buffer.from(await img.arrayBuffer()).toString("base64");
  const res = await graph("POST", `${act()}/adimages`, { bytes });
  const first = Object.values(res.images || {})[0];
  if (!first || !first.hash) throw new Error("Meta adimages returned no hash");
  return first.hash;
}

// One campaign + ad set per product test, with one ad per creative variant.
// Budgets live on the ad set so the optimiser can scale each test alone.
async function launchProductTest({ name, dailyBudgetCents, countries, link, imageUrl, variants }) {
  const pixelId = env("META_PIXEL_ID");
  const pageId = env("META_PAGE_ID");

  const campaign = await graph("POST", `${act()}/campaigns`, {
    name,
    objective: "OUTCOME_SALES",
    status: "ACTIVE",
    special_ad_categories: [],
    is_adset_budget_sharing_enabled: false,
  });
  const adset = await graph("POST", `${act()}/adsets`, {
    name,
    campaign_id: campaign.id,
    daily_budget: dailyBudgetCents,
    billing_event: "IMPRESSIONS",
    optimization_goal: "OFFSITE_CONVERSIONS",
    bid_strategy: "LOWEST_COST_WITHOUT_CAP",
    promoted_object: { pixel_id: pixelId, custom_event_type: "PURCHASE" },
    targeting: { geo_locations: { countries }, age_min: 18, targeting_automation: { advantage_audience: 1 } },
    status: "ACTIVE",
  });
  const imageHash = await uploadImage(imageUrl);
  const adIds = [];
  for (const [i, v] of variants.entries()) {
    const creative = await graph("POST", `${act()}/adcreatives`, {
      name: `${name} v${i + 1}`,
      object_story_spec: {
        page_id: pageId,
        ...(process.env.META_IG_USER_ID ? { instagram_user_id: process.env.META_IG_USER_ID } : {}),
        link_data: {
          link,
          message: v.primary_text,
          name: v.headline,
          description: v.description,
          image_hash: imageHash,
          call_to_action: { type: "SHOP_NOW", value: { link } },
        },
      },
    });
    const ad = await graph("POST", `${act()}/ads`, {
      name: `${name} v${i + 1}`,
      adset_id: adset.id,
      creative: { creative_id: creative.id },
      status: "ACTIVE",
    });
    adIds.push(ad.id);
  }
  return { campaignId: campaign.id, adsetId: adset.id, adIds };
}

function setStatus(objectId, status) {
  return graph("POST", objectId, { status });
}

function setDailyBudget(adsetId, cents) {
  return graph("POST", adsetId, { daily_budget: cents });
}

const PURCHASE_TYPES = ["omni_purchase", "purchase", "offsite_conversion.fb_pixel_purchase"];
function pickAction(list) {
  const byType = Object.fromEntries((list || []).map((a) => [a.action_type, Number(a.value)]));
  for (const t of PURCHASE_TYPES) if (byType[t] !== undefined) return byType[t];
  return 0;
}

// Daily rows for an ad set: [{ day, spend, impressions, clicks, purchases, purchaseValue }]
async function dailyInsights(adsetId, since, until) {
  const res = await graph("GET", `${adsetId}/insights`, {
    fields: "spend,impressions,clicks,actions,action_values",
    time_increment: 1,
    time_range: { since, until },
  });
  return (res.data || []).map((d) => ({
    day: d.date_start,
    spend: Number(d.spend || 0),
    impressions: Number(d.impressions || 0),
    clicks: Number(d.clicks || 0),
    purchases: pickAction(d.actions),
    purchaseValue: pickAction(d.action_values),
  }));
}

// ---- Conversions API: tell Meta about each real purchase, server-side ----
const sha = (s) => crypto.createHash("sha256").update(String(s).trim().toLowerCase()).digest("hex");

function purchaseEvent(order, appUrl) {
  const a = order.shipping_address || {};
  const user = { em: [sha(order.email)] };
  if (a.phone) user.ph = [sha(String(a.phone).replace(/\D/g, ""))];
  if (a.country) user.country = [sha(a.country)];
  if (a.postal_code) user.zp = [sha(a.postal_code)];
  return {
    event_name: "Purchase",
    event_time: Math.floor(new Date(order.created_at || Date.now()).getTime() / 1000),
    event_id: `order-${order.id}`,
    action_source: "website",
    event_source_url: appUrl,
    user_data: user,
    custom_data: { currency: String(order.currency).toUpperCase(), value: Number(order.total) },
  };
}

async function sendPurchase(order) {
  if (!process.env.META_PIXEL_ID || !process.env.META_ACCESS_TOKEN) return false;
  const country = order.shipping_address && order.shipping_address.country;
  if (!require("../config").ADS.CAPI_COUNTRIES.includes(country)) return false;
  await graph("POST", `${process.env.META_PIXEL_ID}/events`, { data: [purchaseEvent(order, process.env.APP_URL)] });
  return true;
}

// ---- Organic publishing (content agent) ----------------------------------
async function publishFacebookPhoto(imageUrl, caption) {
  const token = env("META_PAGE_ACCESS_TOKEN");
  const res = await graph("POST", `${env("META_PAGE_ID")}/photos`, { url: imageUrl, caption }, token);
  return res.post_id || res.id;
}

async function publishInstagramPhoto(imageUrl, caption) {
  const token = env("META_PAGE_ACCESS_TOKEN");
  const ig = env("META_IG_USER_ID");
  const container = await graph("POST", `${ig}/media`, { image_url: imageUrl, caption }, token);
  const res = await graph("POST", `${ig}/media_publish`, { creation_id: container.id }, token);
  return res.id;
}

module.exports = {
  enabled,
  graph,
  launchProductTest,
  setStatus,
  setDailyBudget,
  dailyInsights,
  sendPurchase,
  purchaseEvent,
  publishFacebookPhoto,
  publishInstagramPhoto,
  _pickAction: pickAction,
};
