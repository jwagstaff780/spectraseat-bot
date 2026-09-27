// YouTube Shorts upload via the YouTube Data API v3 (resumable upload).
// Setup (once): create a Google Cloud OAuth client, authorise the channel
// with the youtube.upload scope, and store the refresh token.
// Note: until the Google Cloud project passes YouTube's API audit, uploads
// are locked to private — config.VIDEO.YOUTUBE_PRIVACY defaults to private.

const fs = require("fs");
const config = require("../config");

function enabled() {
  return Boolean(process.env.YOUTUBE_CLIENT_ID && process.env.YOUTUBE_CLIENT_SECRET && process.env.YOUTUBE_REFRESH_TOKEN);
}

async function accessToken() {
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: process.env.YOUTUBE_CLIENT_ID,
      client_secret: process.env.YOUTUBE_CLIENT_SECRET,
      refresh_token: process.env.YOUTUBE_REFRESH_TOKEN,
      grant_type: "refresh_token",
    }),
  });
  const json = await res.json();
  if (!json.access_token) throw new Error(`YouTube auth: ${json.error_description || json.error || res.status}`);
  return json.access_token;
}

function metadata({ title, caption, tags }) {
  const t = /#shorts/i.test(title) ? title : `${title} #Shorts`;
  return {
    snippet: { title: t.slice(0, 100), description: caption.slice(0, 5000), tags: tags.slice(0, 15), categoryId: "26" },
    status: {
      privacyStatus: config.VIDEO.YOUTUBE_PRIVACY,
      selfDeclaredMadeForKids: false,
      // YouTube's "altered or synthetic content" disclosure.
      containsSyntheticMedia: true,
    },
  };
}

async function uploadShort(file, post) {
  const token = await accessToken();
  const size = fs.statSync(file).size;
  const init = await fetch("https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json; charset=UTF-8",
      "X-Upload-Content-Type": "video/mp4",
      "X-Upload-Content-Length": String(size),
    },
    body: JSON.stringify(metadata(post)),
  });
  const location = init.headers.get("location");
  if (!init.ok || !location) throw new Error(`YouTube init: ${init.status} ${(await init.text()).slice(0, 300)}`);
  const up = await fetch(location, { method: "PUT", headers: { "Content-Type": "video/mp4", "Content-Length": String(size) }, body: fs.readFileSync(file) });
  const json = await up.json().catch(() => ({}));
  if (!up.ok || !json.id) throw new Error(`YouTube upload: ${up.status} ${JSON.stringify(json).slice(0, 300)}`);
  return { id: json.id, url: `https://youtube.com/shorts/${json.id}` };
}

module.exports = { enabled, uploadShort, metadata };
