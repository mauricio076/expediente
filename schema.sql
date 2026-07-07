-- Expediente — D1 schema
-- Each deployment holds a single expediente (key = 'main').
-- Multiple cases can be added later by using different keys.

CREATE TABLE IF NOT EXISTS case_data (
  key        TEXT NOT NULL PRIMARY KEY,
  data       TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- OAuth tokens for account-wide cloud provider connections (Dropbox, OneDrive).
-- One row per provider; access_token is refreshed in place using refresh_token.
-- Google Drive does not use this table (it authenticates via a service account secret).
CREATE TABLE IF NOT EXISTS provider_tokens (
  provider      TEXT NOT NULL PRIMARY KEY,
  access_token  TEXT NOT NULL,
  refresh_token TEXT NOT NULL,
  expires_at    INTEGER NOT NULL, -- epoch ms
  account_label TEXT,
  updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
