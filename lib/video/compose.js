// Finishes an externally generated character clip (e.g. from Higgsfield):
// scales/pads it to 1080x1920 and overlays
//  - a permanent "<name> · AI-generated character · Ad" label (disclosure)
//  - after 1.5s, a product card with the REAL product photo, name and price
// Overlays are drawn once as transparent PNGs in headless Chromium, then
// composited by ffmpeg (audio is kept as generated).

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const config = require("../config");

function ffmpegPath() {
  if (process.env.FFMPEG_BIN) return process.env.FFMPEG_BIN;
  try {
    return require("ffmpeg-static");
  } catch {
    return "ffmpeg";
  }
}

const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

function overlayHtml(kind, product) {
  const C = config.CHARACTER;
  const price = `${config.CURRENCY_SYMBOL}${Number(product.price).toFixed(2)}`;
  const base = `<style>*{margin:0;box-sizing:border-box}html,body{width:1080px;height:1920px;background:transparent;font-family:Inter,Arial,sans-serif}</style>`;
  if (kind === "label") {
    return `${base}<div style="position:absolute;top:190px;left:60px;background:rgba(0,0,0,.6);color:#fff;border:2px solid rgba(255,255,255,.4);border-radius:999px;padding:12px 26px;font-size:32px;font-weight:800">${esc(C.name)} · AI-generated character · Ad</div>`;
  }
  const img = (product.images || [])[0] || "";
  return `${base}<div style="position:absolute;left:60px;right:170px;top:1310px;background:#fff;border-radius:40px;padding:22px;display:flex;gap:24px;align-items:center;box-shadow:0 18px 50px rgba(0,0,0,.35)">
    <img src="${esc(img)}" style="width:190px;height:190px;object-fit:cover;border-radius:26px;background:#eee">
    <div style="color:#111"><div style="font-size:40px;font-weight:800;line-height:1.15">${esc(product.title)}</div>
    <div style="font-size:54px;font-weight:900;margin-top:8px">${price}</div>
    <div style="font-size:28px;color:#2f5d50;font-weight:700;margin-top:4px">Free UK delivery · link in bio</div></div></div>`;
}

async function renderOverlays(product, dir) {
  const { chromium } = require("playwright");
  const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
  try {
    const page = await browser.newPage({ viewport: { width: 1080, height: 1920 } });
    const out = {};
    for (const kind of ["label", "card"]) {
      await page.setContent(overlayHtml(kind, product), { waitUntil: "load" });
      out[kind] = path.join(dir, `${kind}.png`);
      await page.screenshot({ path: out[kind], omitBackground: true });
    }
    return out;
  } finally {
    await browser.close();
  }
}

async function composeClip({ inputFile, product, outFile }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "compose-"));
  try {
    const o = await renderOverlays(product, dir);
    const filter =
      "[0:v]scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1[v0];" +
      "[v0][1:v]overlay=0:0[v1];[v1][2:v]overlay=0:0:enable='gte(t,1.5)'[v]";
    const r = spawnSync(
      ffmpegPath(),
      ["-y", "-loglevel", "error", "-i", inputFile, "-i", o.label, "-i", o.card, "-filter_complex", filter,
        "-map", "[v]", "-map", "0:a?", "-c:v", "libx264", "-crf", "20", "-preset", "medium", "-pix_fmt", "yuv420p",
        "-c:a", "aac", "-b:a", "160k", "-movflags", "+faststart", outFile],
      { stdio: ["ignore", "ignore", "pipe"] }
    );
    if (r.status !== 0) throw new Error(`ffmpeg compose failed: ${String(r.stderr).slice(0, 400)}`);
    return outFile;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

module.exports = { composeClip, overlayHtml };
