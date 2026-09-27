// TikTok Content Posting API — Direct Post, file upload.
// Setup (once): a TikTok developer app with the video.publish scope,
// authorised by your TikTok account; store client key/secret + refresh
// token. Until the app passes TikTok's audit, posts are restricted to
// SELF_ONLY (private) — config.VIDEO.TIKTOK_PRIVACY defaults to that.
// Every post is flagged as AI-generated content and as promoting your own
// business (TikTok's commercial-content disclosure).
// Field names follow TikTok's docs; verify with a first private post.

const fs = require("fs");
const config = require("../config");

const API = "https://open.tiktokapis.com/v2";

function enabled() {
  return Boolean(process.env.TIKTOK_CLIENT_KEY && process.env.TIKTOK_CLIENT_SECRET && process.env.TIKTOK_REFRESH_TOKEN);
}

async function accessToken() {
  const res = await fetch(`${API}/oauth/token/`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_key: process.env.TIKTOK_CLIENT_KEY,
      client_secret: process.env.TIKTOK_CLIENT_SECRET,
      grant_type: "refresh_token",
      refresh_token: process.env.TIKTOK_REFRESH_TOKEN,
    }),
  });
  const json = await res.json();
  if (!json.access_token) throw new Error(`TikTok auth: ${json.error_description || json.error || res.status}`);
  return json.access_token;
}

function postInfo(caption) {
  return {
    title: caption.slice(0, 2200),
    privacy_level: config.VIDEO.TIKTOK_PRIVACY,
    disable_duet: false,
    disable_stitch: false,
    disable_comment: false,
    // Commercial content disclosure: promoting your own business.
    brand_organic_toggle: true,
    brand_content_toggle: false,
    // AI-generated content label.
    is_aigc: true,
  };
}

async function postVideo(file, post) {
  const token = await accessToken();
  const size = fs.statSync(file).size;
  const init = await fetch(`${API}/post/publish/video/init/`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json; charset=UTF-8" },
    body: JSON.stringify({
      post_info: postInfo(post.caption),
      source_info: { source: "FILE_UPLOAD", video_size: size, chunk_size: size, total_chunk_count: 1 },
    }),
  });
  const json = await init.json().catch(() => ({}));
  const data = json.data || {};
  if (!init.ok || !data.upload_url) throw new Error(`TikTok init: ${init.status} ${JSON.stringify(json.error || json).slice(0, 300)}`);
  const up = await fetch(data.upload_url, {
    method: "PUT",
    headers: { "Content-Type": "video/mp4", "Content-Length": String(size), "Content-Range": `bytes 0-${size - 1}/${size}` },
    body: fs.readFileSync(file),
  });
  if (!up.ok) throw new Error(`TikTok upload: ${up.status}`);
  return { publishId: data.publish_id };
}

module.exports = { enabled, postVideo, postInfo };
