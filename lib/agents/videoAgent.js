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
const { higgsfieldPrompt } = require("../video/brief");
const { composeClip } = require("../video/compose");
const { notifyOwner } = require("../alerts");

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
       AND NOT EXISTS (SELECT 1 FROM video_briefs b WHERE b.product_id = p.id AND b.status IN ('pending','generating'))
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

// ---- Higgsfield engine: briefs -> (Claude session + Higgsfield) -> publish ----
async function createBriefs(n) {
  const products = await pickProducts(n);
  const made = [];
  for (const p of products) {
    const { script, source } = await writeVideoScript(p);
    const { rows } = await db.query(
      `INSERT INTO video_briefs (product_id, script, prompt) VALUES ($1, $2, $3) RETURNING id`,
      [p.id, JSON.stringify(script), higgsfieldPrompt(script)]
    );
    made.push({ briefId: rows[0].id, product: p.title, source });
  }
  // The generating session should pick briefs up within a day.
  const { rows: stale } = await db.query(`SELECT count(*)::int AS n FROM video_briefs WHERE status IN ('pending','generating') AND created_at < now() - interval '30 hours'`);
  if (stale[0].n) {
    await notifyOwner("briefs-stale", `${stale[0].n} Higgsfield video brief(s) waiting over 30h`, "The scheduled Claude + Higgsfield session hasn't picked them up. Check the Routine and your Higgsfield credits.").catch(() => {});
  }
  return { briefs: made, stale: stale[0].n };
}

function assertSafeUrl(u) {
  const url = new URL(u);
  if (url.protocol !== "https:") throw new Error("video_url must be https");
  if (/^(localhost|127\.|10\.|192\.168\.|169\.254\.)/.test(url.hostname)) throw new Error("video_url host not allowed");
  return url.toString();
}

async function download(u, file, maxBytes = 300 * 1024 * 1024) {
  const res = await fetch(assertSafeUrl(u));
  if (!res.ok) throw new Error(`download ${res.status}`);
  const type = res.headers.get("content-type") || "";
  if (!/^video\/|application\/octet-stream/.test(type)) throw new Error(`not a video (${type})`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > maxBytes) throw new Error("video too large");
  fs.writeFileSync(file, buf);
  return file;
}

// Called by GitHub Actions (publish-video job) once the Claude + Higgsfield
// session has generated the clip for a brief.
async function publishBrief(briefId, videoUrl) {
  const { rows } = await db.query(
    `UPDATE video_briefs SET status='generating', video_url=$2, updated_at=now() WHERE id=$1 AND status IN ('pending','generating') RETURNING *`,
    [briefId, videoUrl]
  );
  const brief = rows[0];
  if (!brief) throw new Error(`brief ${briefId} not found or already done`);
  const { rows: prod } = await db.query(`SELECT * FROM products WHERE id = $1`, [brief.product_id]);
  const product = prod[0];
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "brief-"));
  try {
    const raw = await download(videoUrl, path.join(workDir, "raw.mp4"));
    const file = path.join(workDir, `mira-${product.slug}-${new Date().toISOString().slice(0, 10)}.mp4`);
    await composeClip({ inputFile: raw, product, outFile: file });
    const script = brief.script;
    const url = `${process.env.APP_URL || ""}/p/${encodeURIComponent(product.slug)}?utm_source=social&utm_medium=video&utm_campaign=p${product.id}`;
    const post = postText(script, url);
    const channels = {};
    if (process.env.GITHUB_TOKEN && process.env.GITHUB_REPOSITORY) {
      try {
        channels.mediaUrl = await media.publishFile(file);
      } catch (err) {
        channels.media_error = String(err.message || err).slice(0, 300);
      }
    }
    Object.assign(channels, await publishEverywhere(file, channels.mediaUrl || null, post, script.hashtags));
    const published = ["youtube", "tiktok", "instagram", "facebook"].some((k) => channels[k]);
    const { rows: c } = await db.query(
      `INSERT INTO content (kind, product_id, title, body, image, status, channels, published_at)
       VALUES ('video', $1, $2, $3, $4, $5, $6, CASE WHEN $7 THEN now() END) RETURNING id`,
      [product.id, script.title, JSON.stringify({ script, caption: post.caption, source: "higgsfield", briefId }), (product.images || [])[0] || null,
       published ? "published" : channels.mediaUrl ? "queued" : "failed", channels, published]
    );
    await db.query(`UPDATE video_briefs SET status='done', content_id=$2, updated_at=now() WHERE id=$1`, [briefId, c[0].id]);
    return { briefId, contentId: c[0].id, channels: Object.keys(channels) };
  } catch (err) {
    await db.query(`UPDATE video_briefs SET status='failed', error=$2, updated_at=now() WHERE id=$1`, [briefId, String(err.message || err).slice(0, 500)]);
    throw err;
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
}

async function runVideos() {
  const { rows } = await db.query(
    `SELECT (SELECT count(*) FROM content WHERE kind = 'video' AND created_at > now() - interval '24 hours')
          + (SELECT count(*) FROM video_briefs WHERE status IN ('pending','generating') AND created_at > now() - interval '24 hours') AS n`
  );
  const due = config.VIDEO.PER_DAY - Number(rows[0].n);
  if (due <= 0) return { made: [], note: "daily quota reached" };
  if (config.VIDEO.ENGINE === "higgsfield") return createBriefs(due);
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

module.exports = { runVideos, pickProducts, makeVideo, publishEverywhere, createBriefs, publishBrief, assertSafeUrl };
