// Video agent: each day, picks the products most worth promoting, has the
// script agent write a Nova video, renders it, hosts it, and publishes it
// to every connected channel (YouTube Shorts, TikTok, Instagram Reels,
// Facebook). The ads manager then uses the same video as a Meta ad creative.

const fs = require("fs");
const os = require("os");
const path = require("path");
const config = require("../config");
const db = require("../db");
const { writeVideoScript, postText } = require("./videoScript");
const { renderVideo } = require("../video/render");
const media = require("../media");
const youtube = require("../social/youtube");
const tiktok = require("../social/tiktok");
const meta = require("../ads/meta");

async function pickProducts(n) {
  // Best sellers and the scout's strongest picks first, skipping products
  // that got a video recently.
  const { rows } = await db.query(
    `SELECT p.* FROM products p
     LEFT JOIN (
       SELECT oi.product_id, sum(oi.quantity) AS units FROM order_items oi JOIN orders o ON o.id = oi.order_id
       WHERE o.created_at > now() - interval '30 days' GROUP BY oi.product_id
     ) s ON s.product_id = p.id
     WHERE p.status = 'active' AND p.in_stock AND array_length(p.images, 1) > 0
       AND NOT EXISTS (SELECT 1 FROM content c WHERE c.kind = 'video' AND c.product_id = p.id
                       AND c.created_at > now() - make_interval(days => $2))
     ORDER BY coalesce(s.units, 0) DESC, p.scout_score DESC NULLS LAST, p.created_at DESC
     LIMIT $1`,
    [n, config.VIDEO.PRODUCT_COOLDOWN_DAYS]
  );
  return rows;
}

async function publishEverywhere(file, mediaUrl, post, tags) {
  const channels = {};
  const attempt = async (name, fn) => {
    try {
      channels[name] = await fn();
    } catch (err) {
      channels[`${name}_error`] = String(err.message || err).slice(0, 300);
    }
  };
  if (youtube.enabled()) await attempt("youtube", () => youtube.uploadShort(file, { ...post, tags }));
  if (tiktok.enabled()) await attempt("tiktok", () => tiktok.postVideo(file, post));
  if (mediaUrl && process.env.META_PAGE_ACCESS_TOKEN && process.env.META_IG_USER_ID) {
    await attempt("instagram", () => meta.publishInstagramReel(mediaUrl, post.caption));
  }
  if (mediaUrl && process.env.META_PAGE_ACCESS_TOKEN && process.env.META_PAGE_ID) {
    await attempt("facebook", () => meta.publishFacebookVideo(mediaUrl, post.caption));
  }
  return channels;
}

async function makeVideo(product, workDir) {
  const { script, source, rejected } = await writeVideoScript(product);
  const file = path.join(workDir, `nova-${product.slug}-${new Date().toISOString().slice(0, 10)}.mp4`);
  const render = await renderVideo({ script, product, outFile: file });
  const url = `${process.env.APP_URL || ""}/p/${encodeURIComponent(product.slug)}?utm_source=social&utm_medium=video&utm_campaign=p${product.id}`;
  const post = postText(script, url);

  let mediaUrl = null;
  const channels = {};
  if (process.env.GITHUB_TOKEN && process.env.GITHUB_REPOSITORY) {
    try {
      mediaUrl = await media.publishFile(file);
      channels.mediaUrl = mediaUrl;
    } catch (err) {
      channels.media_error = String(err.message || err).slice(0, 300);
    }
  }
  Object.assign(channels, await publishEverywhere(file, mediaUrl, post, script.hashtags));
  const published = ["youtube", "tiktok", "instagram", "facebook"].some((k) => channels[k]);

  const { rows } = await db.query(
    `INSERT INTO content (kind, product_id, title, body, image, status, channels, published_at)
     VALUES ('video', $1, $2, $3, $4, $5, $6, CASE WHEN $7 THEN now() END) RETURNING id`,
    [
      product.id,
      script.title,
      JSON.stringify({ script, caption: post.caption, source, rejected: rejected || null, voiced: render.voiced, seconds: Math.round(render.duration) }),
      (product.images || [])[0] || null,
      published ? "published" : mediaUrl ? "queued" : "failed",
      channels,
      published,
    ]
  );
  return { id: rows[0].id, product: product.title, source, voiced: render.voiced, channels: Object.keys(channels) };
}

async function runVideos() {
  const { rows } = await db.query(`SELECT count(*)::int AS n FROM content WHERE kind = 'video' AND created_at > now() - interval '24 hours'`);
  const due = config.VIDEO.PER_DAY - rows[0].n;
  if (due <= 0) return { made: [], note: "daily quota reached" };
  const products = await pickProducts(due);
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "videos-"));
  const summary = { made: [], errors: [] };
  try {
    for (const p of products) {
      try {
        summary.made.push(await makeVideo(p, workDir));
      } catch (err) {
        summary.errors.push(`${p.id}: ${String(err.message || err).slice(0, 200)}`);
      }
    }
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
  return summary;
}

module.exports = { runVideos, pickProducts, makeVideo, publishEverywhere };
