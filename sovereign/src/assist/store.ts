import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import type { AssistAccess, AssistAccount, AssistContext, AssistProposal, AssistProposalInput, AssistProposalList, AssistProposalResult, AssistTransaction } from "./contracts";
import { AssistError } from "./errors";
import { proposalInputSchema } from "./validation";

const digest = (value: unknown): string => `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;
const accountFields = `a.id,a.display_name,a.currency,a.decimals,a.rail,a.read_environment,a.status,
 a.balance_minor,a.balance_as_of,a.available_minor,a.pending_minor,a.held_minor,a.balance_kind,a.account_type,
 a.connector_type,a.read_connection_id,a.external_account_id,a.chain_id,a.asset_id,a.account_ref,
 r.status AS connection_status`;
interface AccountRow {
  id: string; display_name: string; currency: string; decimals: number; rail: string; read_environment: AssistAccount["environment"]; status: string;
  balance_minor: string; balance_as_of: string | null; available_minor: string | null; pending_minor: string | null; held_minor: string | null;
  balance_kind: string | null; account_type: string | null; connection_status: string | null;
  connector_type: string | null; read_connection_id: string | null; external_account_id: string | null;
  chain_id: string | null; asset_id: string | null; account_ref: string | null;
}
interface TransactionRow {
  id: string; account_id: string; title: string; amount_minor: string; date: string; category: string | null;
  status: AssistTransaction["status"]; source: string; external_id: string | null; transfer_link_id: string | null;
  gross_minor: string | null; fee_minor: string | null; net_minor: string | null; provider_category: string | null; pending_external_id: string | null;
}
const transactionFields = `t.id,t.account_id,t.title,t.amount_minor,t.date,t.category,t.status,t.source,
 t.external_id,t.transfer_link_id,t.gross_minor,t.fee_minor,t.net_minor,t.provider_category,t.pending_external_id`;
interface ProposalRow {
  id: string; grant_id: string; access_label: string; account_id: string; transaction_id: string;
  request_id: string; request_hash: string; before_json: string; category: string; reason: string;
  status: AssistProposal["status"]; created_at: string; decided_at: string | null;
}

/** The hash binds review facts and the account's identity/state. Provider IDs
 * participate only in the digest, never in the exposed snapshot. Balance-only
 * observations do not invalidate an otherwise unchanged categorization. */
function projectRecord(row: TransactionRow, account: AccountRow): AssistTransaction {
  const view = { id: row.id, account_id: row.account_id, title: row.title, amount_minor: row.amount_minor,
    currency: account.currency, decimals: account.decimals, date: row.date, category: row.category,
    status: row.status, source: row.source, is_internal_transfer: row.transfer_link_id !== null };
  return { ...view, record_version: digest([
    view, row.external_id, row.transfer_link_id, row.gross_minor, row.fee_minor, row.net_minor, row.provider_category, row.pending_external_id,
    account.id, account.display_name, account.currency, account.decimals, account.rail, account.status, account.read_environment,
    account.connector_type, account.read_connection_id, account.external_account_id, account.chain_id, account.asset_id, account.account_ref, account.connection_status,
  ]) };
}

export class AssistStore {
  constructor(private readonly db: Database) {}
  private account(id: string): AccountRow | null {
    return this.db.query(`SELECT ${accountFields} FROM accounts a LEFT JOIN read_connections r ON r.id=a.read_connection_id WHERE a.id=?`).get(id) as AccountRow | null;
  }
  private record(id: string): { view: AssistTransaction; row: TransactionRow; account: AccountRow } | null {
    const row = this.db.query(`SELECT ${transactionFields} FROM transactions t WHERE t.id=?`).get(id) as TransactionRow | null;
    const account = row && this.account(row.account_id);
    return row && account ? { view: projectRecord(row, account), row, account } : null;
  }
  context(access: AssistAccess, limit = 30, accountId?: string): AssistContext {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new AssistError("assist_invalid_request", "Choose an activity limit from 1 to 100.", 400);
    if (accountId && !access.account_ids.includes(accountId)) throw new AssistError("assist_account_forbidden", "This account is outside the granted access.", 403);
    return this.db.transaction((): AssistContext => {
      const selected = accountId ? [accountId] : access.account_ids;
      const accounts = selected.map((id) => this.account(id)).filter((account): account is AccountRow => account !== null && account.status === "ACTIVE");
      const byId = new Map(accounts.map((account) => [account.id, account]));
      const raw = accounts.length ? this.db.query(`SELECT ${transactionFields} FROM transactions t
        WHERE t.account_id IN (${accounts.map(() => "?").join(",")}) ORDER BY t.date DESC,t.id DESC LIMIT ?`).all(...byId.keys(), limit + 1) as TransactionRow[] : [];
      return {
        schema_version: "cashloom.assist-context/1", generated_at: new Date().toISOString(), access,
        accounts: accounts.map((account): AssistAccount => {
          // Crypto needs the kernel's stronger evidence projection. This first
          // record-only layer deliberately leaves legacy crypto balances unknown.
          const observed = account.rail !== "CRYPTO" && account.balance_as_of !== null;
          return { id: account.id, display_name: account.display_name, currency: account.currency, decimals: account.decimals,
            rail: account.rail, environment: account.read_environment, balance_minor: observed ? account.balance_minor : null,
            balance_as_of: observed ? account.balance_as_of : null, available_minor: observed ? account.available_minor : null,
            pending_minor: observed ? account.pending_minor : null, held_minor: observed ? account.held_minor : null,
            balance_kind: account.balance_kind, account_type: account.account_type, connection_status: account.connection_status };
        }),
        transactions: raw.slice(0, limit).map((row) => projectRecord(row, byId.get(row.account_id)!)),
        activity_window: { limit, returned: Math.min(raw.length, limit), has_more: raw.length > limit, order: "date_desc_id_desc" },
      };
    })();
  }
  private present(row: ProposalRow): AssistProposal {
    const before = JSON.parse(row.before_json) as AssistTransaction;
    const current = this.record(row.transaction_id);
    let reviewState: AssistProposal["review_state"] = "unavailable";
    if (current && current.account.status === "ACTIVE" && current.row.status === "posted") {
      // Acceptance itself changes the category; compare all remaining facts
      // against the immutable review while checking the accepted value too.
      const version = row.status === "accepted" && current.row.category === row.category
        ? projectRecord({ ...current.row, category: before.category }, current.account).record_version : current.view.record_version;
      reviewState = version === before.record_version ? "current" : "changed";
    }
    return { id: row.id, grant_id: row.grant_id, access_label: row.access_label, account_id: row.account_id,
      transaction_id: row.transaction_id, before, category: row.category, reason: row.reason,
      status: row.status, review_state: reviewState, created_at: row.created_at, decided_at: row.decided_at };
  }
  list(grantId?: string): AssistProposalList {
    return this.db.transaction(() => {
      const rows = this.db.query(`SELECT * FROM assist_proposals WHERE (? IS NULL OR grant_id=?)
        ORDER BY CASE WHEN status='pending' THEN 0 ELSE 1 END,created_at DESC,id DESC LIMIT 101`).all(grantId ?? null, grantId ?? null) as ProposalRow[];
      return { proposals: rows.slice(0, 100).map((row) => this.present(row)), has_more: rows.length > 100 };
    })();
  }
  propose(input: AssistProposalInput, assertAccess: () => AssistAccess): AssistProposalResult {
    const body = proposalInputSchema.parse(input);
    return this.db.transaction(() => {
      const access = assertAccess();
      const requestHash = digest(body);
      const prior = this.db.query("SELECT * FROM assist_proposals WHERE grant_id=? AND request_id=?").get(access.id, body.request_id) as ProposalRow | null;
      if (prior) {
        if (prior.request_hash !== requestHash) throw new AssistError("assist_request_conflict", "This request ID was already used for a different suggestion.", 409);
        return { proposal: this.present(prior), replayed: true };
      }
      const current = this.record(body.transaction_id);
      if (!current || !access.account_ids.includes(current.view.account_id)) throw new AssistError("assist_record_unavailable", "This entry is not available through the granted access.", 404);
      if (current.account.status !== "ACTIVE" || current.row.status !== "posted" || current.view.record_version !== body.expected_record_version) {
        throw new AssistError("assist_record_stale", "The entry changed or is no longer a posted entry in an active account. Read it again before proposing.", 409);
      }
      if (body.category === current.view.category) throw new AssistError("assist_category_unchanged", "Choose a category different from the entry's current category.", 409);
      const counts = this.db.query("SELECT (SELECT COUNT(*) FROM assist_proposals WHERE grant_id=?) AS granted,(SELECT COUNT(*) FROM assist_proposals WHERE status='pending') AS pending").get(access.id) as { granted: number; pending: number };
      if (counts.granted >= 100 || counts.pending >= 1000) throw new AssistError("assist_proposal_limit", "The suggestion limit has been reached. The owner can review existing suggestions before granting more access.", 409);
      const id = crypto.randomUUID();
      this.db.query(`INSERT INTO assist_proposals(id,grant_id,access_label,account_id,transaction_id,request_id,request_hash,before_json,category,reason,created_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run(id, access.id, access.label, current.view.account_id, current.view.id,
        body.request_id, requestHash, JSON.stringify(current.view), body.category, body.reason, new Date().toISOString());
      const row = this.db.query("SELECT * FROM assist_proposals WHERE id=?").get(id) as ProposalRow;
      return { proposal: this.present(row), replayed: false };
    }).immediate();
  }
  decide(id: string, decision: "accept" | "reject", expectedVersion: string | undefined, assertOwner: () => void): AssistProposalResult {
    const result = this.db.transaction(() => {
      assertOwner();
      const row = this.db.query("SELECT * FROM assist_proposals WHERE id=?").get(id) as ProposalRow | null;
      if (!row) throw new AssistError("assist_proposal_not_found", "This suggestion is not available.", 404);
      const before = JSON.parse(row.before_json) as AssistTransaction;
      if (decision === "accept" && expectedVersion !== before.record_version) throw new AssistError("assist_proposal_conflict", "The reviewed suggestion does not match. Reload it before deciding.", 409);
      const target = decision === "accept" ? "accepted" : "rejected";
      if (row.status === target) return { proposal: this.present(row), replayed: true, stale: false };
      if (row.status === "stale") return { proposal: this.present(row), replayed: false, stale: true };
      if (row.status !== "pending") throw new AssistError("assist_proposal_conflict", "This suggestion already has a different decision.", 409);
      const current = this.record(row.transaction_id);
      const stale = decision === "accept" && (!current || current.account.status !== "ACTIVE" || current.row.status !== "posted" || current.view.record_version !== before.record_version);
      if (decision === "accept" && !stale) this.db.query("UPDATE transactions SET category=? WHERE id=?").run(row.category, row.transaction_id);
      this.db.query("UPDATE assist_proposals SET status=?,decided_at=? WHERE id=? AND status='pending'").run(stale ? "stale" : target, new Date().toISOString(), id);
      return { proposal: this.present(this.db.query("SELECT * FROM assist_proposals WHERE id=?").get(id) as ProposalRow), replayed: false, stale: !!stale };
    }).immediate();
    // Throw after committing the stale decision, never roll its audit back.
    if (result.stale) throw new AssistError("assist_record_stale", "The entry changed or became unavailable. This suggestion is stale and was not applied.", 409);
    return { proposal: result.proposal, replayed: result.replayed };
  }
}
