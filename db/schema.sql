-- Edge Finder / CLV tracker schema.
-- Applied automatically (CREATE TABLE IF NOT EXISTS) by lib/db.js on first
-- connection, so there is no manual migration step for a personal deploy.

CREATE TABLE IF NOT EXISTS bets (
  id BIGSERIAL PRIMARY KEY,

  -- identity of the game/market/selection this bet is on
  event_id TEXT NOT NULL,
  sport_key TEXT NOT NULL,
  league TEXT NOT NULL,
  home_team TEXT NOT NULL,
  away_team TEXT NOT NULL,
  market TEXT NOT NULL,
  selection TEXT NOT NULL,
  -- team name for team_totals/team_totals_h1 (disambiguates the two teams'
  -- Over/Under); '' for plain totals. NOT NULL + default '' rather than
  -- nullable, because Postgres treats every NULL as distinct for UNIQUE
  -- constraints, which would silently defeat de-duplication below.
  selection_group TEXT NOT NULL DEFAULT '',
  line_point NUMERIC NOT NULL,

  -- the price actually flagged/taken
  book TEXT NOT NULL,
  odds_taken NUMERIC NOT NULL,
  stake NUMERIC,
  paper BOOLEAN NOT NULL DEFAULT TRUE,

  placed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  kickoff_at TIMESTAMPTZ NOT NULL,

  -- sharp anchor snapshot at the moment the bet was flagged
  anchor_book TEXT NOT NULL,
  anchor_odds_at_placement NUMERIC NOT NULL,
  anchor_p_at_placement NUMERIC NOT NULL,
  book_last_update_at_placement TIMESTAMPTZ,

  -- closing-line capture (filled in by /api/cron/close)
  close_captured_at TIMESTAMPTZ,
  close_capture_lag_s INTEGER,
  anchor_close_raw NUMERIC,
  anchor_close_other_prices NUMERIC[], -- every other outcome's anchor price at the same capture (1 for two-way, up to N-1 for an N-way market like soccer h2h), needed to de-vig
  anchor_close_overround NUMERIC,
  p_close_mult NUMERIC,
  p_close_power NUMERIC,
  p_close_shin NUMERIC,

  clv NUMERIC,
  quality_flag TEXT[] NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'graded', 'void', 'unresolvable')),

  -- real-money settlement (paper bets are never settled)
  result TEXT CHECK (result IN ('win', 'loss', 'push')),
  settled_at TIMESTAMPTZ,

  UNIQUE (event_id, market, selection, selection_group, line_point, book)
);

CREATE INDEX IF NOT EXISTS bets_status_idx ON bets (status);
CREATE INDEX IF NOT EXISTS bets_kickoff_idx ON bets (kickoff_at);
CREATE INDEX IF NOT EXISTS bets_paper_idx ON bets (paper);
