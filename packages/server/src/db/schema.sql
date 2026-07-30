-- ─────────────────────────────────────────────────────────────────────────────
-- AI Enhancement App — metadata store (Technical Specification §4.7, §7)
--
-- Every user-owned table carries user_id and every read path filters on it:
-- per-user isolation (BR-S2) is enforced in SQL, not just in the handlers.
-- ─────────────────────────────────────────────────────────────────────────────

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS users (
  user_id       TEXT PRIMARY KEY,
  email         TEXT NOT NULL UNIQUE,
  display_name  TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  preferences   TEXT NOT NULL DEFAULT '{}',
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS refresh_tokens (
  token_hash TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_refresh_user ON refresh_tokens(user_id);

CREATE TABLE IF NOT EXISTS jobs (
  job_id         TEXT PRIMARY KEY,
  user_id        TEXT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  url            TEXT NOT NULL,
  normalized_url TEXT NOT NULL,
  -- hash(user_id + normalized_url): folds a duplicate share into the first job.
  idempotency_key TEXT NOT NULL,
  shared_text    TEXT,
  note           TEXT,
  platform       TEXT NOT NULL,
  state          TEXT NOT NULL,
  status_message TEXT,
  title          TEXT,
  capture_source TEXT NOT NULL DEFAULT 'api',
  folder_name    TEXT,
  cost_asr_seconds  REAL NOT NULL DEFAULT 0,
  cost_model_tokens INTEGER NOT NULL DEFAULT 0,
  cost_usd          REAL NOT NULL DEFAULT 0,
  attempts       INTEGER NOT NULL DEFAULT 0,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL,
  UNIQUE (user_id, idempotency_key)
);
CREATE INDEX IF NOT EXISTS idx_jobs_user_created ON jobs(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_jobs_state ON jobs(state);

-- Durable work queue. A row per unit of pipeline work; the worker leases rows
-- with a visibility timeout so a crashed worker's job becomes runnable again.
CREATE TABLE IF NOT EXISTS job_queue (
  queue_id     INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id       TEXT NOT NULL REFERENCES jobs(job_id) ON DELETE CASCADE,
  kind         TEXT NOT NULL,           -- 'process' | 'implement'
  payload      TEXT NOT NULL DEFAULT '{}',
  status       TEXT NOT NULL DEFAULT 'pending', -- pending | leased | done | failed
  attempts     INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 3,
  run_after    TEXT NOT NULL,
  leased_until TEXT,
  lease_owner  TEXT,
  last_error   TEXT,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_queue_ready ON job_queue(status, run_after);
CREATE INDEX IF NOT EXISTS idx_queue_job ON job_queue(job_id);

CREATE TABLE IF NOT EXISTS insight_sources (
  insight_source_id TEXT PRIMARY KEY,
  job_id            TEXT NOT NULL REFERENCES jobs(job_id) ON DELETE CASCADE,
  user_id           TEXT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  segments          TEXT NOT NULL,
  post_description  TEXT,
  language          TEXT NOT NULL DEFAULT 'en',
  duration_sec      REAL,
  overall_confidence REAL NOT NULL DEFAULT 0,
  low_confidence    INTEGER NOT NULL DEFAULT 0,
  methods_used      TEXT NOT NULL DEFAULT '[]',
  created_at        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_src_job ON insight_sources(job_id);

-- Content-addressed cache: re-sharing a link anyone has already processed is
-- instant and free (spec §6.5 "Caching & idempotency").
CREATE TABLE IF NOT EXISTS extraction_cache (
  content_hash TEXT PRIMARY KEY,
  payload      TEXT NOT NULL,
  created_at   TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS specs (
  spec_id       TEXT PRIMARY KEY,
  job_id        TEXT NOT NULL REFERENCES jobs(job_id) ON DELETE CASCADE,
  user_id       TEXT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  title         TEXT NOT NULL,
  summary       TEXT NOT NULL,
  technical_spec TEXT NOT NULL,
  no_actionable_items INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_specs_job ON specs(job_id);

CREATE TABLE IF NOT EXISTS spec_items (
  item_id       TEXT PRIMARY KEY,
  spec_id       TEXT NOT NULL REFERENCES specs(spec_id) ON DELETE CASCADE,
  user_id       TEXT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  ordinal       INTEGER NOT NULL,
  title         TEXT NOT NULL,
  type          TEXT NOT NULL,
  why           TEXT NOT NULL,
  proposed_method TEXT NOT NULL,
  prerequisites TEXT NOT NULL DEFAULT '[]',
  missing_prerequisites TEXT NOT NULL DEFAULT '[]',
  effort        TEXT NOT NULL,
  impact        TEXT NOT NULL,
  risk_tier     TEXT NOT NULL,
  scopes        TEXT NOT NULL DEFAULT '[]',
  requires_browser INTEGER NOT NULL DEFAULT 0,
  parameters    TEXT NOT NULL DEFAULT '{}',
  source_segments TEXT NOT NULL DEFAULT '[]',
  duplicate_of_item_id TEXT
);
CREATE INDEX IF NOT EXISTS idx_items_spec ON spec_items(spec_id, ordinal);

CREATE TABLE IF NOT EXISTS decisions (
  decision_id TEXT PRIMARY KEY,
  spec_id     TEXT NOT NULL REFERENCES specs(spec_id) ON DELETE CASCADE,
  item_id     TEXT NOT NULL REFERENCES spec_items(item_id) ON DELETE CASCADE,
  user_id     TEXT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  decision    TEXT NOT NULL,
  edits       TEXT,
  decided_at  TEXT NOT NULL
);
-- One current decision per item; re-deciding replaces it (history lives in audit_log).
CREATE UNIQUE INDEX IF NOT EXISTS idx_decision_item ON decisions(item_id);
CREATE INDEX IF NOT EXISTS idx_decision_user ON decisions(user_id, decided_at DESC);

CREATE TABLE IF NOT EXISTS runs (
  run_id      TEXT PRIMARY KEY,
  spec_id     TEXT NOT NULL REFERENCES specs(spec_id) ON DELETE CASCADE,
  job_id      TEXT NOT NULL REFERENCES jobs(job_id) ON DELETE CASCADE,
  user_id     TEXT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  status      TEXT NOT NULL,
  dry_run     INTEGER NOT NULL DEFAULT 0,
  items       TEXT NOT NULL DEFAULT '[]',
  actions     TEXT NOT NULL DEFAULT '[]',
  overall     TEXT,
  started_at  TEXT NOT NULL,
  finished_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_runs_spec ON runs(spec_id);
CREATE INDEX IF NOT EXISTS idx_runs_user ON runs(user_id, started_at DESC);

-- Recurring / deferred work registered by schedule_task items (BR-I5).
CREATE TABLE IF NOT EXISTS scheduled_tasks (
  task_id     TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  item_id     TEXT,
  name        TEXT NOT NULL,
  cron        TEXT NOT NULL,
  timezone    TEXT NOT NULL DEFAULT 'UTC',
  action      TEXT NOT NULL,
  enabled     INTEGER NOT NULL DEFAULT 1,
  next_run_at TEXT,
  last_run_at TEXT,
  created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sched_user ON scheduled_tasks(user_id);

CREATE TABLE IF NOT EXISTS connectors (
  connector_id TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  kind         TEXT NOT NULL,
  label        TEXT NOT NULL,
  -- Encrypted at rest with a key derived from JWT_SECRET; never returned by the API.
  secret_enc   TEXT,
  scopes       TEXT NOT NULL DEFAULT '[]',
  created_at   TEXT NOT NULL,
  UNIQUE (user_id, kind)
);

-- Immutable record of every autonomous action and security-relevant event
-- (BR-I4, spec §4.7 Audit Log). Append-only by convention; never updated.
CREATE TABLE IF NOT EXISTS audit_log (
  audit_id   INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    TEXT,
  job_id     TEXT,
  run_id     TEXT,
  item_id    TEXT,
  event      TEXT NOT NULL,
  scope      TEXT,
  detail     TEXT,
  at         TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_user ON audit_log(user_id, at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_run ON audit_log(run_id);

-- Per-user, per-day spend roll-up backing the budget ceilings (spec §15).
CREATE TABLE IF NOT EXISTS usage_daily (
  user_id     TEXT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  day         TEXT NOT NULL,
  usd         REAL NOT NULL DEFAULT 0,
  asr_seconds REAL NOT NULL DEFAULT 0,
  model_tokens INTEGER NOT NULL DEFAULT 0,
  jobs        INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, day)
);

CREATE TABLE IF NOT EXISTS push_subscriptions (
  subscription_id TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  endpoint   TEXT NOT NULL,
  keys       TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (user_id, endpoint)
);

CREATE TABLE IF NOT EXISTS notifications (
  notification_id TEXT PRIMARY KEY,
  user_id   TEXT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  job_id    TEXT,
  kind      TEXT NOT NULL,
  title     TEXT NOT NULL,
  body      TEXT NOT NULL,
  read      INTEGER NOT NULL DEFAULT 0,
  -- Set when the notification was held back by quiet hours (BR value-add "quiet defaults").
  deferred_until TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_notif_user ON notifications(user_id, created_at DESC);
