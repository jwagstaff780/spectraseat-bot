// Content agent: faceless organic marketing on autopilot.
//  - Blog: one SEO article a day, hosted on the store (/blog.html), linking
//    to a real product. Drives free search traffic.
//  - Social: product posts (image + caption) published to the Facebook Page
//    and Instagram account when their tokens are configured; otherwise they
//    queue for the admin to copy out.

const config = require("../config");
const db = require("../db");
const ai = require("../ai");
const meta = require("../ads/meta");
const { slugify } = require("../sourcing");
const { allowedClaims, checkCopy } = require("../compliance/claims");

function healthRules(product) {
  if (!product.product_type || product.product_type === "gear") return "";
  const claims = allowedClaims(product);
  return (
    "\nHealth-product rules (GB law): no health or benefit claims except these, word for word:\n" +
    (claims.length ? claims.map((c) => `- ${c}`).join("\n") : "- none") +
    "\nNever mention stress, sleep, anxiety, mood, hormones, weight, detox or any disease. Not medical advice: suggest checking with a GP or pharmacist for health conditions."
  );
}

const BLOG_SCHEMA = {
  type: "object",
  properties: {
    title: { type: "string", description: "Article title, max 70 characters." },
    body: {
      type: "string",
      description: "600-900 word article. Plain text paragraphs separated by blank lines; section headings start with '## '. No markdown links.",
    },
  },
  required: ["title", "body"],
  additionalProperties: false,
};

const SOCIAL_SCHEMA = {
  type: "object",
  properties: {
    caption: { type: "string", description: "Instagram/Facebook caption, max 400 characters, ending with 3-5 relevant hashtags." },
  },
  required: ["caption"],
  additionalProperties: false,
};

const SYSTEM = [
  `You write organic content for ${config.BRAND.name}, a faceless online store. ${config.BRAND.tagline}`,
  `Brand voice: ${config.BRAND.voice}`,
  "Be genuinely useful. Never invent statistics, studies, experts, testimonials or reviews. No medical claims.",
  "Never mention suppliers or dropshipping. No first-person founder voice.",
].join("\n");

async function pickProduct(excludeKind) {
  // Rotate: the active product that has gone longest without this content kind.
  const { rows } = await db.query(
    `SELECT p.* FROM products p
     LEFT JOIN LATERAL (SELECT max(created_at) AS last FROM content c WHERE c.product_id = p.id AND c.kind = $1) c ON TRUE
     WHERE p.status = 'active' AND p.in_stock
     ORDER BY c.last NULLS FIRST, random() LIMIT 1`,
    [excludeKind]
  );
  return rows[0] || null;
}

async function countToday(kind) {
  const { rows } = await db.query(`SELECT count(*)::int AS n FROM content WHERE kind = $1 AND created_at > now() - interval '24 hours'`, [kind]);
  return rows[0].n;
}

async function writeBlogPost() {
  const product = await pickProduct("blog");
  if (!product || !ai.enabled()) return null;
  const { rows: recent } = await db.query(`SELECT title FROM content WHERE kind='blog' ORDER BY created_at DESC LIMIT 30`);
  const out = await ai.generateJson({
    system: SYSTEM + healthRules(product),
    effort: "medium",
    prompt:
      `Write a helpful how-to or buying-guide article for people who might need this product. Mention the product naturally once or twice by name.\n` +
      `Product: ${JSON.stringify({ title: product.title, description: product.description, bullets: product.bullets })}\n` +
      `Avoid repeating these existing titles: ${JSON.stringify(recent.map((r) => r.title))}`,
    schema: BLOG_SCHEMA,
  });
  if (!out) return null;
  // Articles that break GB health-claim rules are never published.
  if (checkCopy(`${out.title}\n${out.body.replace(/^## /gm, "")}`, product).length) return { skipped: "failed health-claims check", product: product.id };
  const { rows } = await db.query(
    `INSERT INTO content (kind, product_id, slug, title, body, image, status, published_at)
     VALUES ('blog', $1, $2, $3, $4, $5, 'published', now()) RETURNING id, slug, title`,
    [product.id, `${slugify(out.title)}-${Date.now().toString(36)}`, out.title.slice(0, 120), out.body, (product.images || [])[0] || null]
  );
  return rows[0];
}

async function writeSocialPost() {
  const product = await pickProduct("social");
  if (!product) return null;
  const image = (product.images || [])[0];
  if (!image) return null;
  const out = await ai.generateJson({
    system: SYSTEM + healthRules(product),
    prompt: `Write a social post for this product (the photo is the product image).\n${JSON.stringify({
      title: product.title,
      description: product.description,
      price: Number(product.price),
    })}`,
    schema: SOCIAL_SCHEMA,
  });
  const safeCaption = out && out.caption && !checkCopy(out.caption.replace(/#\S+/g, ""), product).length ? out.caption : null;
  const caption =
    (safeCaption || `${product.title} — free tracked UK delivery.`).slice(0, 400) +
    `\n\nShop: ${process.env.APP_URL || ""}/p/${product.slug}`;

  const channels = {};
  if (process.env.META_PAGE_ACCESS_TOKEN && process.env.META_PAGE_ID) {
    try {
      channels.facebook = await meta.publishFacebookPhoto(image, caption);
    } catch (err) {
      channels.facebook_error = err.message;
    }
  }
  if (process.env.META_PAGE_ACCESS_TOKEN && process.env.META_IG_USER_ID) {
    try {
      channels.instagram = await meta.publishInstagramPhoto(image, caption);
    } catch (err) {
      channels.instagram_error = err.message;
    }
  }
  const published = Boolean(channels.facebook || channels.instagram);
  const status = published ? "published" : Object.keys(channels).length ? "failed" : "queued";
  const { rows } = await db.query(
    `INSERT INTO content (kind, product_id, body, image, status, channels, published_at)
     VALUES ('social', $1, $2, $3, $4, $5, CASE WHEN $6 THEN now() END) RETURNING id, status`,
    [product.id, caption, image, status, channels, published]
  );
  return { ...rows[0], channels };
}

async function runContent() {
  const summary = { blog: [], social: [] };
  const blogsDue = config.CONTENT.BLOG_POSTS_PER_DAY - (await countToday("blog"));
  for (let i = 0; i < blogsDue; i++) {
    const post = await writeBlogPost();
    if (post) summary.blog.push(post);
  }
  const socialDue = config.CONTENT.SOCIAL_POSTS_PER_DAY - (await countToday("social"));
  for (let i = 0; i < socialDue; i++) {
    const post = await writeSocialPost();
    if (post) summary.social.push(post);
  }
  return summary;
}

module.exports = { runContent, writeBlogPost, writeSocialPost };
