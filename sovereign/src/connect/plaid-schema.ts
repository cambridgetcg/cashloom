import type { Database } from "bun:sqlite";

/** Secrets are isolated from signing keys and every public connection DTO. */
export function installPlaidSchema(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS connect_plaid_items (
      id TEXT PRIMARY KEY,
      provider_item_id TEXT NOT NULL UNIQUE,
      state TEXT NOT NULL CHECK(state IN ('setup_pending','connected','reconnect_required','disconnect_pending','disconnected')),
      account_count INTEGER NOT NULL DEFAULT 0 CHECK(account_count >= 0),
      last_synced_at TEXT,
      error_code TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS connect_provider_tokens (
      item_id TEXT PRIMARY KEY REFERENCES connect_plaid_items(id),
      provider TEXT NOT NULL CHECK(provider = 'plaid-sandbox'),
      enc_blob BLOB NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS connect_plaid_link_attempts (
      id TEXT PRIMARY KEY,
      session_hash TEXT NOT NULL,
      state TEXT NOT NULL CHECK(state IN ('pending','exchanging','import_pending','completed','uncertain','failed')),
      public_token_hash TEXT UNIQUE,
      item_id TEXT REFERENCES connect_plaid_items(id),
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
  `);
}
