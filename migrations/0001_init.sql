CREATE TABLE calls (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  call_date TEXT NOT NULL,
  redacted_transcript TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('processing','ready','failed')),
  error TEXT,
  needs_review INTEGER NOT NULL DEFAULT 0,
  crm_note TEXT,
  urgency TEXT
);
CREATE TABLE proposals (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  call_id TEXT NOT NULL REFERENCES calls(id),
  kind TEXT NOT NULL CHECK (kind IN ('follow_up','task','figure')),
  field TEXT NOT NULL,
  label TEXT NOT NULL,
  value TEXT NOT NULL,
  quote TEXT NOT NULL,
  start_offset INTEGER,
  end_offset INTEGER,
  status TEXT NOT NULL DEFAULT 'proposed' CHECK (status IN ('proposed','approved','rejected')),
  reject_reason TEXT CHECK (reject_reason IN ('wrong_value','wrong_person','not_agreed','other')),
  decided_at TEXT
);
CREATE INDEX proposals_call ON proposals(call_id);
CREATE TABLE dropped (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  call_id TEXT NOT NULL REFERENCES calls(id),
  field TEXT NOT NULL,
  value TEXT NOT NULL,
  reason TEXT NOT NULL
);
CREATE INDEX dropped_call ON dropped(call_id);
CREATE TABLE runs (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  call_id TEXT NOT NULL REFERENCES calls(id),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  model TEXT NOT NULL,
  effort TEXT NOT NULL,
  input_tokens INTEGER NOT NULL,
  output_tokens INTEGER NOT NULL,
  cache_write_tokens INTEGER NOT NULL,
  cache_read_tokens INTEGER NOT NULL,
  cost_usd REAL,
  duration_ms INTEGER NOT NULL,
  failures TEXT NOT NULL,
  needs_review_reasons TEXT NOT NULL,
  extraction_json TEXT NOT NULL
);
