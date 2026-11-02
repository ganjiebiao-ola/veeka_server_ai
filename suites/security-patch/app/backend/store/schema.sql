CREATE TABLE IF NOT EXISTS sessions (
  id            TEXT PRIMARY KEY,
  created_at    INTEGER NOT NULL,
  last_seen_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS runs (
  id            TEXT PRIMARY KEY,
  run_number    INTEGER NOT NULL CHECK (run_number > 0),
  session_id    TEXT NOT NULL REFERENCES sessions(id),
  repo_url      TEXT NOT NULL,
  branch        TEXT NOT NULL,
  commit_sha    TEXT,
  skill         TEXT NOT NULL,
  model         TEXT NOT NULL,
  effort        TEXT NOT NULL,
  review_model  TEXT,
  review_effort TEXT,
  mode          TEXT NOT NULL,
  categories    TEXT,          -- comma-joined scoped-scan tokens; "" / NULL = full scan
  include_p2 INTEGER,
  max_subagents INTEGER,       -- Scan cap on subagents, 0-3. NULL = not a scan run
  language TEXT,               -- Output language fixed at start, en or zh. NULL = before the field
  resumed_from  TEXT,          -- the stopped run this run resumes. NULL = a first attempt
  container_id  TEXT,
  status        TEXT NOT NULL,
  started_at    INTEGER,
  finished_at   INTEGER,
  error         TEXT,
  starred       INTEGER NOT NULL DEFAULT 0,
  stop_reason   TEXT,
  phase         TEXT
);
CREATE INDEX IF NOT EXISTS idx_runs_session ON runs(session_id, started_at DESC);

CREATE TABLE IF NOT EXISTS findings (
  id           TEXT NOT NULL,
  run_id       TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  category     TEXT NOT NULL,
  severity     TEXT NOT NULL,
  file         TEXT,
  line         INTEGER,
  snippet      TEXT,
  fix_summary  TEXT,
  status       TEXT,
  reason       TEXT,
  kind         TEXT,               -- misc only: the bug type
  posted       INTEGER NOT NULL DEFAULT 0,  -- 1 = posted to the repo's GitHub tracking issue from the Run tab
  emitted_at   INTEGER NOT NULL,
  PRIMARY KEY (run_id, id)
);
CREATE INDEX IF NOT EXISTS idx_findings_run ON findings(run_id);

CREATE TABLE IF NOT EXISTS usage_totals (
  run_id              TEXT PRIMARY KEY REFERENCES runs(id) ON DELETE CASCADE,
  input_tokens        INTEGER NOT NULL DEFAULT 0,
  output_tokens       INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens   INTEGER NOT NULL DEFAULT 0,
  cache_create_tokens INTEGER NOT NULL DEFAULT 0,
  credits             REAL    NOT NULL DEFAULT 0
);

-- Repos the dev started a run on. One row per GitHub repo, newest first. Start, Pick and Overview list them.
CREATE TABLE IF NOT EXISTS repos (
  repo       TEXT PRIMARY KEY,   -- lower-case owner/name
  url        TEXT NOT NULL,      -- as typed on the Scan page
  branch     TEXT NOT NULL DEFAULT '',
  last_used  INTEGER NOT NULL,
  profile    TEXT NOT NULL DEFAULT '',  -- JSON RepoProfile from the last scan
  profile_override TEXT NOT NULL DEFAULT ''  -- JSON ProfileOverride from the Scan page
);

CREATE TABLE IF NOT EXISTS run_vendor (
  run_id TEXT PRIMARY KEY REFERENCES runs(id) ON DELETE CASCADE,
  data TEXT NOT NULL
);
