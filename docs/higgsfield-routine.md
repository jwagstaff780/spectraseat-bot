# Higgsfield character videos: routine instructions

This file is the standing instruction for the **scheduled Claude session**
(a Claude Code Routine) that generates the store's AI character clips with
the Higgsfield connector. GitHub Actions does everything else: it writes the
compliant brief, adds the disclosure label and product card, then publishes
and records the result.

```
11:23  GitHub Actions "videos" job  -> picks a product, writes a GB-claims-checked
                                       script, saves a video brief (status: pending)
~12:00 Claude Routine + Higgsfield  -> THIS FILE: generate the character clip
       -> triggers "Store automation" workflow, job=publish-video
       GitHub Actions publish-video  -> adds "AI-generated character · Ad" label +
                                       real product card, hosts it, publishes to
                                       YouTube/TikTok/Instagram/Facebook, feeds Meta ads
```

## Environment the routine needs
- The **Higgsfield** connector (custom connector `https://mcp.higgsfield.ai/mcp`).
- This repository, with GitHub access to trigger workflows.
- Environment secrets: `APP_URL`, `ADMIN_TOKEN`, and optionally
  `HIGGSFIELD_CHARACTER_ID` (the saved character).

## One-time: create the character
1. In a Claude session with the Higgsfield connector, create a consistent
   character from `CHARACTER.look` in `lib/config.js`. Name it after
   `CHARACTER.name` (default "Mira").
2. Save its ID as the GitHub Actions **variable** `HIGGSFIELD_CHARACTER_ID`
   and as a routine environment secret, then set the variable
   `VIDEO_ENGINE=higgsfield`.

## Daily steps (what the routine does)
1. Fetch pending briefs:
   `curl -s -H "Authorization: Bearer $ADMIN_TOKEN" "$APP_URL/api/admin/video-briefs?status=pending"`
2. For each brief (at most 2 per run), mark it as in progress:
   `curl -s -X POST -H "Authorization: Bearer $ADMIN_TOKEN" -H "Content-Type: application/json" -d '{"status":"generating"}' "$APP_URL/api/admin/video-briefs?id=<ID>"`
3. Generate the clip with Higgsfield from the brief's `prompt`. Use the saved
   character, vertical 9:16, and a model that produces **speech with lip-sync
   for the given dialogue**.
4. **Check the result** before using it. Regenerate once if it fails, otherwise mark it failed (step 6):
   - the character matches the saved look;
   - the dialogue is spoken as written, in order;
   - no product, packaging, logos or on-screen text were invented.
5. Trigger the publish job with the clip's public HTTPS URL. Use the
   "Store automation" workflow (`store-automation.yml`) on the default
   branch, with inputs `job=publish-video`, `brief_id=<ID>` and `video_url=<URL>`.
6. If generation fails twice:
   `curl -s -X POST ... -d '{"status":"failed","error":"<short reason>"}' "$APP_URL/api/admin/video-briefs?id=<ID>"`

## Rules (non-negotiable)
- **Never change the script's wording.** It has passed the GB health-claims
  checker, and rewording can make it unlawful. If a clip must be shorter,
  drop whole lines from the end (but keep the final call-to-action line).
- The character is always an AI character. Never prompt for text that says
  or implies it's a real person, a customer, a doctor or a nutritionist.
- No invented product shots: the real product photo is added afterwards.
- Stop and report instead of improvising if anything in a brief looks wrong,
  such as health claims, disease words or weight-loss wording.
