/**
 * CashLoom v2's local append-only evidence schema.
 *
 * Kept separate from the process-global database module so two sovereign
 * nodes, migration tests, and local embeddings can install the same schema in
 * distinct SQLite files. The records are authority; these columns are only
 * bounded lookup and replay-protection projections.
 */

import type { Database } from "bun:sqlite";

export const CASHLOOM_V2_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS cashloom_v2_records (
  record_id       TEXT PRIMARY KEY
                  CHECK (length(record_id) = 71 AND substr(record_id, 1, 7) = 'sha256:'),
  schema          TEXT NOT NULL,
  kind            TEXT NOT NULL,
  issuer_key_id   TEXT NOT NULL
                  CHECK (length(issuer_key_id) = 71 AND substr(issuer_key_id, 1, 7) = 'sha256:'),
  audience        TEXT NOT NULL,
  nonce           TEXT NOT NULL,
  disclosure      TEXT NOT NULL CHECK (disclosure IN ('public', 'private')),
  canonical_json  TEXT NOT NULL UNIQUE CHECK (length(canonical_json) <= 65536),
  created_at      TEXT NOT NULL,
  expires_at      TEXT NOT NULL,
  source          TEXT NOT NULL CHECK (source IN ('local', 'remote')),
  received_at     TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_cashloom_v2_issuer_nonce
  ON cashloom_v2_records(issuer_key_id, nonce);
CREATE INDEX IF NOT EXISTS idx_cashloom_v2_kind_received
  ON cashloom_v2_records(kind, received_at);
CREATE INDEX IF NOT EXISTS idx_cashloom_v2_public
  ON cashloom_v2_records(disclosure, kind, received_at);

CREATE TABLE IF NOT EXISTS cashloom_v2_record_parents (
  child_record_id  TEXT NOT NULL REFERENCES cashloom_v2_records(record_id) ON DELETE RESTRICT,
  -- v2 has exactly zero or one immediate parent; no hidden secondary edges.
  position         INTEGER NOT NULL CHECK (position = 0),
  parent_record_id TEXT NOT NULL REFERENCES cashloom_v2_records(record_id) ON DELETE RESTRICT,
  PRIMARY KEY (child_record_id, position),
  UNIQUE (child_record_id, parent_record_id)
);
CREATE INDEX IF NOT EXISTS idx_cashloom_v2_parent
  ON cashloom_v2_record_parents(parent_record_id);

-- Signatures prevent forgery, not free-key Sybil disk exhaustion. This
-- operational counter applies one global admission budget to remote records.
CREATE TABLE IF NOT EXISTS cashloom_v2_ingest_usage (
  singleton              INTEGER PRIMARY KEY CHECK (singleton = 1),
  remote_record_count    INTEGER NOT NULL CHECK (remote_record_count >= 0),
  remote_canonical_bytes INTEGER NOT NULL CHECK (remote_canonical_bytes >= 0),
  updated_at             TEXT NOT NULL
);
INSERT OR IGNORE INTO cashloom_v2_ingest_usage
  (singleton, remote_record_count, remote_canonical_bytes, updated_at)
VALUES
  (1, 0, 0, strftime('%Y-%m-%dT%H:%M:%fZ','now'));

CREATE TRIGGER IF NOT EXISTS cashloom_v2_records_no_update
BEFORE UPDATE ON cashloom_v2_records
BEGIN
  SELECT RAISE(ABORT, 'CashLoom v2 records are append-only');
END;
CREATE TRIGGER IF NOT EXISTS cashloom_v2_records_no_delete
BEFORE DELETE ON cashloom_v2_records
BEGIN
  SELECT RAISE(ABORT, 'CashLoom v2 records are append-only');
END;
CREATE TRIGGER IF NOT EXISTS cashloom_v2_parents_no_update
BEFORE UPDATE ON cashloom_v2_record_parents
BEGIN
  SELECT RAISE(ABORT, 'CashLoom v2 parent edges are append-only');
END;
CREATE TRIGGER IF NOT EXISTS cashloom_v2_parents_no_delete
BEFORE DELETE ON cashloom_v2_record_parents
BEGIN
  SELECT RAISE(ABORT, 'CashLoom v2 parent edges are append-only');
END;
`;

export function installCashLoomV2Schema(database: Database): void {
  database.exec(CASHLOOM_V2_SCHEMA_SQL);
}
