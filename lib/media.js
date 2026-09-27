// Free public hosting for rendered videos: assets on a GitHub Release in
// this repo ("media" tag). Meta and Instagram fetch videos from a public
// URL, and the release doubles as an archive of every ad the agents made.
// Uses the GITHUB_TOKEN that GitHub Actions provides (contents: write).

const fs = require("fs");
const path = require("path");

const API = "https://api.github.com";
const TAG = "media";

function repo() {
  const r = process.env.GITHUB_REPOSITORY;
  if (!r || !process.env.GITHUB_TOKEN) throw new Error("GITHUB_REPOSITORY / GITHUB_TOKEN not set (run inside GitHub Actions)");
  return r;
}

async function gh(method, url, body, headers = {}) {
  const res = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      ...headers,
    },
    body,
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, json };
}

async function ensureRelease() {
  const r = repo();
  const found = await gh("GET", `${API}/repos/${r}/releases/tags/${TAG}`);
  if (found.status === 200) return found.json;
  const made = await gh(
    "POST",
    `${API}/repos/${r}/releases`,
    JSON.stringify({ tag_name: TAG, name: "Marketing media", body: "Videos rendered by the store's video agent.", prerelease: true }),
    { "Content-Type": "application/json" }
  );
  if (made.status >= 300) throw new Error(`create release: ${made.status} ${made.json.message || ""}`);
  return made.json;
}

// Uploads a file and returns its public download URL.
async function publishFile(file, name = path.basename(file)) {
  const release = await ensureRelease();
  const uploadUrl = release.upload_url.replace(/\{.*\}$/, "");
  const res = await gh("POST", `${uploadUrl}?name=${encodeURIComponent(name)}`, fs.readFileSync(file), {
    "Content-Type": "video/mp4",
  });
  if (res.status >= 300) throw new Error(`upload asset: ${res.status} ${res.json.message || ""}`);
  return res.json.browser_download_url;
}

module.exports = { publishFile, ensureRelease };
