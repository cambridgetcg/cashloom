import type { Database } from "bun:sqlite";

/** Upgrade the old account/date index once, retaining no redundant prefix index. */
export function installActivityHistoryIndexes(db: Database): void {
  db.transaction(() => {
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_tx_account_date_id ON transactions(account_id, date DESC, id DESC);
      CREATE INDEX IF NOT EXISTS idx_tx_date_id ON transactions(date DESC, id DESC);
      DROP INDEX IF EXISTS idx_tx_account_date;
    `);
  }).immediate();
}
