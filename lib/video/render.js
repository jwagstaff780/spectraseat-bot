// Renders a Nova video: text-to-speech per line (Piper, free and open
// source), a deterministic HTML timeline rendered frame by frame in
// headless Chromium, and ffmpeg to encode a 1080x1920 H.264/AAC MP4 ready
// for YouTube Shorts, TikTok and Instagram Reels.
//
// Runs on the GitHub Actions runner (see .github/workflows/store-automation.yml
// "videos" job, which installs Chromium, Piper and a British voice). Without
// a voice model it renders a captioned video with a silent audio track.

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn, spawnSync } = require("child_process");
const config = require("../config");

const W = 1080;
const H = 1920;

// ---- WAV helpers (Piper outputs 16-bit mono PCM) -------------------------------
function readWav(file) {
  const buf = fs.readFileSync(file);
  let off = 12;
  let fmt = null;
  while (off + 8 <= buf.length) {
    const id = buf.toString("ascii", off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    if (id === "fmt ") fmt = { channels: buf.readUInt16LE(off + 10), rate: buf.readUInt32LE(off + 12), bits: buf.readUInt16LE(off + 22) };
    if (id === "data") return { ...fmt, pcm: buf.subarray(off + 8, off + 8 + size) };
    off += 8 + size + (size % 2);
  }
  throw new Error(`no data chunk in ${file}`);
}

function wavDuration(w) {
  return w.pcm.length / (w.rate * w.channels * (w.bits / 8));
}

function writeWav(file, pcm, rate) {
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVEfmt ", 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(rate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(pcm.length, 40);
  fs.writeFileSync(file, Buffer.concat([header, pcm]));
}

// ---- Text to speech ---------------------------------------------------------------
function ttsAvailable() {
  const model = process.env.PIPER_MODEL;
  if (!model || !fs.existsSync(model)) return false;
  const r = spawnSync(process.env.PIPER_BIN || "piper", ["--help"], { stdio: "ignore" });
  return r.status === 0;
}

function speak(text, outFile) {
  const r = spawnSync(process.env.PIPER_BIN || "piper", ["--model", process.env.PIPER_MODEL, "--output_file", outFile], {
    input: text,
    stdio: ["pipe", "ignore", "pipe"],
  });
  if (r.status !== 0) throw new Error(`piper failed: ${String(r.stderr).slice(0, 300)}`);
  return readWav(outFile);
}

// ---- Timeline -------------------------------------------------------------------------
// Split a line's duration across its words, weighted by length, so the
// karaoke highlight follows the voice closely enough.
function wordTimes(text, start, duration) {
  const words = text.split(/\s+/).filter(Boolean);
  const weights = words.map((w) => 1 + w.replace(/[^a-z0-9]/gi, "").length);
  const total = weights.reduce((a, b) => a + b, 0);
  let t = start;
  return words.map((w, i) => {
    const d = (duration * weights[i]) / total;
    const out = { w, start: t, end: t + d };
    t += d;
    return out;
  });
}

// ~2.6 words/second is a natural short-form delivery pace.
function estimateDuration(text) {
  return Math.max(1.2, text.split(/\s+/).filter(Boolean).length / 2.6 + 0.3);
}

function buildTimeline(script, durations) {
  const lines = [
    { say: script.hook, caption: "", visual: "product" },
    ...script.beats,
  ];
  const LEAD = 0.35;
  const GAP = 0.18;
  let t = LEAD;
  let detail = 0;
  const segments = lines.map((l, i) => {
    const d = durations[i];
    const image = l.visual === "detail" ? ++detail : 0;
    const seg = { say: l.say, caption: l.caption, visual: l.visual, start: t, end: t + d, gap: GAP, image, words: wordTimes(l.say, t, d) };
    t += d + GAP;
    return seg;
  });
  const endStart = t + 0.2;
  return { segments, endStart, total: endStart + 1.6 };
}

// ---- Render ---------------------------------------------------------------------------
function ffmpegPath() {
  if (process.env.FFMPEG_BIN) return process.env.FFMPEG_BIN;
  try {
    return require("ffmpeg-static");
  } catch {
    return "ffmpeg";
  }
}

async function launchBrowser() {
  let pw;
  try {
    pw = require("playwright");
  } catch {
    throw new Error("playwright is not installed (npm ci installs it as a dev dependency)");
  }
  const opts = process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {};
  return pw.chromium.launch(opts);
}

// script: from lib/agents/videoScript.js; product: DB row; returns
// { file, duration, voiced }.
async function renderVideo({ script, product, outFile, fps = config.VIDEO.FPS, maxSeconds = null }) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nova-"));
  const lines = [script.hook, ...script.beats.map((b) => b.say)];

  // 1. Voice (or estimated timings when no voice is installed).
  const voiced = ttsAvailable();
  const clips = voiced ? lines.map((text, i) => speak(text, path.join(tmp, `line${i}.wav`))) : null;
  const durations = voiced ? clips.map(wavDuration) : lines.map(estimateDuration);
  const timeline = buildTimeline(script, durations);
  const total = maxSeconds ? Math.min(timeline.total, maxSeconds) : timeline.total;

  // 2. One continuous voice track with each line placed at its start time.
  const audioFile = path.join(tmp, "voice.wav");
  const rate = voiced ? clips[0].rate : 22050;
  const pcm = Buffer.alloc(Math.ceil(total * rate) * 2);
  if (voiced) {
    timeline.segments.forEach((s, i) => {
      const at = Math.floor(s.start * rate) * 2;
      clips[i].pcm.copy(pcm, at, 0, Math.min(clips[i].pcm.length, pcm.length - at));
    });
  }
  writeWav(audioFile, pcm, rate);

  // 3. Frames -> ffmpeg.
  const origin = (process.env.APP_URL || "").replace(/^https?:\/\//, "").replace(/\/$/, "");
  const data = {
    brand: config.BRAND.name,
    character: config.CHARACTER.name,
    colors: config.CHARACTER.colors,
    images: (product.images || []).slice(0, 6),
    price: `${config.CURRENCY_SYMBOL}${Number(product.price).toFixed(2)}`,
    compareAt: product.compare_at_price ? `${config.CURRENCY_SYMBOL}${Number(product.compare_at_price).toFixed(2)}` : null,
    displayUrl: origin || config.BRAND.name,
    segments: timeline.segments,
    endStart: timeline.endStart,
  };
  if (!data.images.length) throw new Error("product has no images");

  const browser = await launchBrowser();
  const ff = spawn(
    ffmpegPath(),
    [
      "-y", "-loglevel", "error",
      "-f", "image2pipe", "-framerate", String(fps), "-c:v", "mjpeg", "-i", "-",
      "-i", audioFile,
      "-c:v", "libx264", "-preset", "medium", "-crf", "20", "-pix_fmt", "yuv420p", "-r", String(fps),
      "-c:a", "aac", "-b:a", "160k", "-ar", "44100",
      "-t", total.toFixed(2), "-movflags", "+faststart",
      outFile,
    ],
    { stdio: ["pipe", "ignore", "pipe"] }
  );
  let ffErr = "";
  ff.stderr.on("data", (d) => (ffErr += d));
  const ffDone = new Promise((res, rej) => ff.on("close", (code) => (code === 0 ? res() : rej(new Error(`ffmpeg: ${ffErr.slice(0, 500)}`)))));

  try {
    const page = await browser.newPage({ viewport: { width: W, height: H } });
    await page.setContent(fs.readFileSync(path.join(__dirname, "..", "..", "video", "template.html"), "utf8"), { waitUntil: "load" });
    await page.evaluate((d) => window.setupVideo(d), data);
    const frames = Math.ceil(total * fps);
    for (let f = 0; f < frames; f++) {
      await page.evaluate((t) => window.renderFrame(t), f / fps);
      const jpg = await page.screenshot({ type: "jpeg", quality: 90 });
      if (!ff.stdin.write(jpg)) await new Promise((r) => ff.stdin.once("drain", r));
    }
    ff.stdin.end();
    await ffDone;
  } finally {
    await browser.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  return { file: outFile, duration: total, voiced };
}

module.exports = { renderVideo, buildTimeline, wordTimes, estimateDuration, readWav, writeWav, wavDuration };
