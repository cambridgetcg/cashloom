import type { Database } from "bun:sqlite";

/** Additive extensions to the existing accounts/transactions, never a second ledger. */
export function installConnectSchema(db: Database): void {
  db.transaction(() => {
    db.exec(`CREATE TABLE IF NOT EXISTS read_connections (
      id TEXT PRIMARY KEY,
      provider TEXT NOT NULL,
      environment TEXT NOT NULL,
      display_name TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      cursor TEXT,
      revision INTEGER NOT NULL DEFAULT 0,
      last_attempt_at TEXT,
      last_success_at TEXT,
      last_error_code TEXT,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    )`);
    const addColumns = (table: string, additions: Record<string, string>) => {
      const existing = new Set((db.query(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((column) => column.name));
      for (const [name, type] of Object.entries(additions)) {
        if (!existing.has(name)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${type}`);
      }
    };
    addColumns("accounts", {
      read_connection_id: "TEXT REFERENCES read_connections(id)",
      available_minor: "TEXT", pending_minor: "TEXT", held_minor: "TEXT",
      balance_kind: "TEXT NOT NULL DEFAULT 'observed'",
      read_environment: "TEXT NOT NULL DEFAULT 'local'",
      read_observed_at: "TEXT", account_mask: "TEXT", account_type: "TEXT",
    });
    addColumns("transactions", {
      status: "TEXT NOT NULL DEFAULT 'posted'", provider_updated_at: "TEXT",
      provider_category: "TEXT", pending_external_id: "TEXT",
      gross_minor: "TEXT", fee_minor: "TEXT", net_minor: "TEXT", transfer_link_id: "TEXT",
    });
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_accounts_read_connection ON accounts(read_connection_id);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_read_account_provider
        ON accounts(read_connection_id, external_account_id) WHERE read_connection_id IS NOT NULL;
      CREATE INDEX IF NOT EXISTS idx_transactions_record_status ON transactions(status, date);
      CREATE TABLE IF NOT EXISTS internal_transfers (
        id TEXT PRIMARY KEY,
        outgoing_id TEXT NOT NULL REFERENCES transactions(id),
        incoming_id TEXT NOT NULL REFERENCES transactions(id),
        created_at TEXT NOT NULL,
        unlinked_at TEXT,
        unlink_reason TEXT
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_internal_transfer_outgoing
        ON internal_transfers(outgoing_id) WHERE unlinked_at IS NULL;
      CREATE UNIQUE INDEX IF NOT EXISTS idx_internal_transfer_incoming
        ON internal_transfers(incoming_id) WHERE unlinked_at IS NULL;
    `);
  })();
}
