#!/usr/bin/env node
// Publishes a Higgsfield clip for a video brief (run by the publish-video
// GitHub Actions job, which the Claude + Higgsfield session triggers).
//   BRIEF_ID=12 VIDEO_URL=https://... node scripts/publish-video.js
const db = require("../lib/db");
const { publishBrief } = require("../lib/agents/videoAgent");

(async () => {
  const id = Number(process.env.BRIEF_ID);
  const url = process.env.VIDEO_URL || "";
  if (!Number.isInteger(id) || id <= 0 || !/^https:\/\//.test(url)) {
    console.error("BRIEF_ID (number) and VIDEO_URL (https) are required");
    process.exit(2);
  }
  try {
    const r = await db.recordRun("publish-video", () => publishBrief(id, url));
    console.log(`published brief ${r.briefId} -> content ${r.contentId} (${r.channels.length} channel entries)`);
  } catch (err) {
    console.error(`publish failed — see the automation log on /admin.html (${err.constructor.name})`);
    process.exitCode = 1;
  } finally {
    await db.end().catch(() => {});
  }
})();
