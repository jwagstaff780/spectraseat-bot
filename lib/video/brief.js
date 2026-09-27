// Builds the Higgsfield generation prompt for a product video. The clip is
// the character speaking to camera; the real product photo and price are
// composited afterwards (lib/video/compose.js), so the model never invents
// packaging or label text.

const config = require("../config");

function spokenLines(script) {
  return [script.hook, ...script.beats.map((b) => b.say)];
}

function higgsfieldPrompt(script) {
  const C = config.CHARACTER;
  const lines = spokenLines(script);
  return [
    `Vertical 9:16 talking-head video, ${Math.round(lines.join(" ").split(/\s+/).length / 2.6 + 3)} seconds.`,
    C.higgsfieldCharacterId ? `Character: use saved character ${C.higgsfieldCharacterId} (${C.name}).` : `Character: ${C.name}. ${C.look}`,
    `Setting and style: ${C.look}`,
    `Performance: ${C.personality} Natural British accent, friendly eye contact, subtle hand gestures. No product in hand, no packaging, no text on screen, no logos.`,
    `Dialogue (spoken exactly, in order):`,
    ...lines.map((l, i) => `${i + 1}. "${l}"`),
    `Keep the top 12% and bottom 25% of the frame clear of the face (on-screen labels are added later).`,
  ].join("\n");
}

module.exports = { higgsfieldPrompt, spokenLines };
