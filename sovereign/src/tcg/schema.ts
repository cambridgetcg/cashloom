import type { Database } from "bun:sqlite";

export const TCG_RECORD_TABLES = ["tcg_trades", "tcg_revisions", "tcg_evidence", "tcg_events", "tcg_requests"] as const;
export const TCG_SIMULATION_TABLES = ["tcg_sim_runs", "tcg_sim_events", "tcg_sim_requests"] as const;
export function assertSandboxDatabase(db: Database): void {
  const databases = db.query("PRAGMA database_list").all() as Array<{ name: string }>;
  const tables = db.query("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>;
  if (databases.some(({ name }) => name !== "main") || tables.some(({ name }) => !(TCG_SIMULATION_TABLES as readonly string[]).includes(name))) {
    throw new Error("TCG simulation requires a separate sandbox-only database without attachments");
  }
}
function retain(db: Database, tables: readonly string[]): void {
  for (const table of tables) {
    db.exec(`CREATE TRIGGER IF NOT EXISTS ${table}_no_update BEFORE UPDATE ON ${table} BEGIN SELECT RAISE(ABORT, 'TCG audit records are immutable'); END;
      CREATE TRIGGER IF NOT EXISTS ${table}_no_delete BEFORE DELETE ON ${table} BEGIN SELECT RAISE(ABORT, 'TCG audit records are immutable'); END;`);
  }
}
export function installTradeSchema(db: Database): void {
  if (db.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name GLOB 'tcg_sim_*'").get()) throw new Error("Owner records cannot share the simulation database");
  db.exec("PRAGMA foreign_keys = ON");
  db.transaction(() => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS tcg_trades (
        id TEXT PRIMARY KEY CHECK(id GLOB 'trade_*'), version INTEGER NOT NULL CHECK(version>=1),
        current_revision INTEGER NOT NULL CHECK(current_revision>=1), created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS tcg_revisions (
        trade_id TEXT NOT NULL REFERENCES tcg_trades(id), revision INTEGER NOT NULL CHECK(revision>=1),
        hash TEXT NOT NULL, json TEXT NOT NULL CHECK(json_valid(json)), PRIMARY KEY(trade_id,revision)
      );
      CREATE TABLE IF NOT EXISTS tcg_evidence (
        id TEXT PRIMARY KEY, trade_id TEXT NOT NULL, revision INTEGER NOT NULL,
        json TEXT NOT NULL CHECK(json_valid(json)), FOREIGN KEY(trade_id,revision) REFERENCES tcg_revisions(trade_id,revision)
      );
      CREATE TABLE IF NOT EXISTS tcg_events (
        id TEXT PRIMARY KEY, subject_id TEXT NOT NULL REFERENCES tcg_trades(id), sequence INTEGER NOT NULL CHECK(sequence>=1),
        json TEXT NOT NULL CHECK(json_valid(json)), UNIQUE(subject_id,sequence)
      );
      CREATE TABLE IF NOT EXISTS tcg_requests (
        key TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, response_json TEXT NOT NULL CHECK(json_valid(response_json))
      );
      CREATE TRIGGER IF NOT EXISTS tcg_trades_cas BEFORE UPDATE ON tcg_trades
      WHEN NEW.rowid IS NOT OLD.rowid OR NEW.id IS NOT OLD.id OR NEW.created_at IS NOT OLD.created_at OR NEW.version != OLD.version+1 OR NEW.current_revision NOT IN (OLD.current_revision,OLD.current_revision+1)
      BEGIN SELECT RAISE(ABORT,'TCG version transition refused'); END;
      CREATE TRIGGER IF NOT EXISTS tcg_trades_no_delete BEFORE DELETE ON tcg_trades BEGIN SELECT RAISE(ABORT,'TCG records are retained'); END;
    `);
    retain(db, ["tcg_revisions", "tcg_evidence", "tcg_events", "tcg_requests"]);
  }).immediate();
}
export function installSimulationSchema(db: Database): void {
  // Check BEFORE PRAGMAs or installation: accidentally injected wallet connections remain untouched.
  assertSandboxDatabase(db);
  db.exec("PRAGMA foreign_keys = ON");
  db.transaction(() => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS tcg_sim_runs (
        id TEXT PRIMARY KEY CHECK(id GLOB 'sim_*'), version INTEGER NOT NULL CHECK(version>=1),
        snapshot_json TEXT NOT NULL CHECK(json_valid(snapshot_json)), state_json TEXT NOT NULL CHECK(json_valid(state_json)),
        actor_json TEXT NOT NULL CHECK(json_valid(actor_json)), created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS tcg_sim_events (
        id TEXT PRIMARY KEY, subject_id TEXT NOT NULL REFERENCES tcg_sim_runs(id), sequence INTEGER NOT NULL CHECK(sequence>=1),
        json TEXT NOT NULL CHECK(json_valid(json)), UNIQUE(subject_id,sequence)
      );
      CREATE TABLE IF NOT EXISTS tcg_sim_requests (
        key TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, response_json TEXT NOT NULL CHECK(json_valid(response_json))
      );
      CREATE TRIGGER IF NOT EXISTS tcg_sim_runs_cas BEFORE UPDATE ON tcg_sim_runs
      WHEN NEW.rowid IS NOT OLD.rowid OR NEW.id IS NOT OLD.id OR NEW.created_at IS NOT OLD.created_at OR NEW.snapshot_json IS NOT OLD.snapshot_json OR NEW.actor_json IS NOT OLD.actor_json OR NEW.version != OLD.version+1
      BEGIN SELECT RAISE(ABORT,'TCG simulation snapshot or version transition refused'); END;
      CREATE TRIGGER IF NOT EXISTS tcg_sim_runs_no_delete BEFORE DELETE ON tcg_sim_runs BEGIN SELECT RAISE(ABORT,'TCG simulation runs are retained'); END;
    `);
    retain(db, ["tcg_sim_events", "tcg_sim_requests"]);
  }).immediate();
}
