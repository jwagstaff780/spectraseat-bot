# Edge Finder

+EV sports betting screener with a sharp-anchor de-vig engine and a CLV
(closing-line value) tracker. Static frontend + Vercel serverless functions.

## Required environment variables (set in Vercel → Project → Settings → Environment Variables)

| Variable | Used by | Notes |
|---|---|---|
| `ODDS_API_KEY` | `/api/odds`, `/api/cron/close` | The Odds API key. Server-side only — never sent to the browser. |
| `DATABASE_URL` | `/api/odds`, `/api/bets`, `/api/clv`, `/api/cron/close` | Postgres connection string (e.g. Vercel Postgres / Neon). SQLite doesn't work here — Vercel functions are ephemeral, there's no persistent disk. |
| `CRON_SECRET` | `/api/cron/close` | Shared secret the external poller must present as `Authorization: Bearer <secret>`. Generate any long random string. |

## Closing-line poller (GitHub Actions)

Vercel's Hobby-plan cron only fires once a day, which is useless for
capturing a line minutes before kickoff. `.github/workflows/close-line-poller.yml`
polls `/api/cron/close` every 5 minutes via GitHub Actions instead (the
practical minimum granularity GitHub cron reliably supports). Set these two
repo secrets under **Settings → Secrets and variables → Actions**:

| Secret | Value |
|---|---|
| `CRON_SECRET` | same value as the Vercel env var above |
| `APP_URL` | your deployed Vercel URL, e.g. `https://edge-finder.vercel.app` |

## Database

No manual migration needed — `lib/db.js` runs `db/schema.sql`
(`CREATE TABLE IF NOT EXISTS`) automatically on first connection.

## Known limitations (documented, not hidden)

- **First-half markets** (`totals_h1`, `team_totals_h1`) returned no data for
  WNBA at probe time (2026-07-11). The board will show them as empty/no-data
  rather than fabricate anything — this may change close to tip-off or not
  be offered at all; the app doesn't assume either way.
- **Close-line capture timing** is best-effort, bounded by GitHub Actions'
  ~5 minute cron granularity, not the exact T-60s/T-30s targets. Every graded
  bet carries `close_capture_lag_s` so you can judge (or filter out) low-quality
  closes yourself — see the "exclude high-lag closes" toggle on the CLV screen.
- **Auto-settlement of real-money bets** (win/loss) only works for `totals`
  and `team_totals`, using The Odds API's scores endpoint (final full-game
  score only). `totals_h1` / `team_totals_h1` have no first-half score
  available via that endpoint and must be marked manually via
  `PATCH /api/bets?id=<id>` with `{ "result": "win" | "loss" | "push" }`.
- **Void detection** is best-effort: it only checks once a game is well past
  its scheduled kickoff, and only if The Odds API's scores endpoint has an
  entry for that event.

## Local development

```
npm install
node scripts/probe.js   # requires ODDS_API_KEY in env — verifies live data before anything else
```

There's no local dev server config here (Vercel-only). Use `vercel dev` if
you want to run the API functions locally, with the same three env vars in
a `.env.local` (already gitignored).
