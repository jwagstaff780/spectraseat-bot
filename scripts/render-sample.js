#!/usr/bin/env node
// Renders a sample Nova video from a built-in demo product, with no
// database or API keys needed. Use it to preview the look after editing
// video/template.html or the character settings.
//   node scripts/render-sample.js [out.mp4] [--seconds N]

const path = require("path");
const { renderVideo } = require("../lib/video/render");
const { templateScript } = require("../lib/agents/videoScript");

const svg = (bg, fg, label) =>
  "data:image/svg+xml;base64," +
  Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 800 800"><rect width="800" height="800" fill="${bg}"/>` +
      `<rect x="120" y="330" width="560" height="120" rx="60" fill="${fg}"/><rect x="170" y="300" width="460" height="30" rx="15" fill="#fff" opacity=".7"/>` +
      `<text x="400" y="620" font-family="Arial" font-size="44" text-anchor="middle" fill="${fg}">${label}</text></svg>`
  ).toString("base64");

const product = {
  title: "Monitor Light Bar",
  description: "Clips onto the top of your screen and lights your desk without glare on the display. USB powered, with touch dimming.",
  bullets: ["Asymmetric beam, no screen glare", "Touch dimmer and three colour temperatures"],
  price: 24.99,
  compare_at_price: 34.99,
  images: [svg("#e8efe9", "#2f5d50", "demo photo 1"), svg("#f3ead9", "#8a5a2b", "demo photo 2"), svg("#e1e6f2", "#3b4a7a", "demo photo 3")],
};

(async () => {
  const out = path.resolve(process.argv[2] && !process.argv[2].startsWith("--") ? process.argv[2] : "nova-sample.mp4");
  const i = process.argv.indexOf("--seconds");
  const script = {
    hook: "Your desk lamp is lying to your eyes.",
    beats: [
      { say: "This light bar clips onto the top of your monitor.", caption: "Clips on in seconds", visual: "product" },
      { say: "The beam angles down at the desk, so there's no glare on the screen.", caption: "No screen glare", visual: "detail" },
      { say: "Touch to dim, and pick warm or cool light.", caption: "Touch dimming", visual: "detail" },
      { say: "It's twenty four ninety nine, with free UK delivery.", caption: "£24.99 · free delivery", visual: "price" },
      { say: "Tap the link to take a closer look.", caption: "Link in bio", visual: "cta" },
    ],
    title: "The desk light that doesn't glare",
    description: "Nova shows you a clip-on monitor light bar.",
    hashtags: ["desksetup", "wfh"],
  };
  const r = await renderVideo({ script: process.env.USE_TEMPLATE ? templateScript(product) : script, product, outFile: out, maxSeconds: i > 0 ? Number(process.argv[i + 1]) : null });
  console.log(`rendered ${r.file} (${r.duration.toFixed(1)}s, ${r.voiced ? "with voice" : "captions only — set PIPER_MODEL for voice"})`);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
