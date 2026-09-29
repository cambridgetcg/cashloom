import type { Database } from "bun:sqlite";

/** Suggestions are an audit queue in the private database, never another ledger. */
export function installAssistSchema(db: Database): void {
  db.transaction(() => db.exec(`
    CREATE TABLE IF NOT EXISTS assist_proposals (
      id TEXT PRIMARY KEY, grant_id TEXT NOT NULL, access_label TEXT NOT NULL,
      account_id TEXT NOT NULL, transaction_id TEXT NOT NULL,
      request_id TEXT NOT NULL, request_hash TEXT NOT NULL,
      before_json TEXT NOT NULL, category TEXT NOT NULL, reason TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('pending','accepted','rejected','stale')) DEFAULT 'pending',
      created_at TEXT NOT NULL, decided_at TEXT,
      UNIQUE(grant_id,request_id),
      CHECK((status='pending' AND decided_at IS NULL) OR (status<>'pending' AND decided_at IS NOT NULL))
    );
    CREATE INDEX IF NOT EXISTS idx_assist_proposals_grant ON assist_proposals(grant_id,created_at);
    CREATE INDEX IF NOT EXISTS idx_assist_proposals_status ON assist_proposals(status);
    CREATE TRIGGER IF NOT EXISTS assist_proposals_immutable BEFORE UPDATE ON assist_proposals
    WHEN NEW.id<>OLD.id OR NEW.grant_id<>OLD.grant_id OR NEW.access_label<>OLD.access_label
      OR NEW.account_id<>OLD.account_id OR NEW.transaction_id<>OLD.transaction_id
      OR NEW.request_id<>OLD.request_id OR NEW.request_hash<>OLD.request_hash
      OR NEW.before_json<>OLD.before_json OR NEW.category<>OLD.category OR NEW.reason<>OLD.reason
      OR NEW.created_at<>OLD.created_at OR OLD.status<>'pending'
    BEGIN SELECT RAISE(ABORT,'Assist proposal evidence is immutable'); END;
    CREATE TRIGGER IF NOT EXISTS assist_proposals_no_delete BEFORE DELETE ON assist_proposals
    BEGIN SELECT RAISE(ABORT,'Assist proposal decisions are retained'); END;
  `))();
}
