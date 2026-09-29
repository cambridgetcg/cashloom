import type { Database } from "bun:sqlite";
import type {
  ImportedRow, ReadAccountInput, ReadAccountView, ReadConnectionInput, ReadConnectionView,
  ReadStatus, ReadSyncBatch, ReadSyncResult, ReadSyncState, ReadTransactionInput,
  TransferCandidate, TransferLink, TransferRecord,
} from "./contracts.ts";

const MAX_BATCH = 100_000;
const MAX_RAW = 65_536;
const DAY = 86_400_000;
const id = () => crypto.randomUUID();

export class ReadModelError extends Error {
  constructor(message: string, public readonly code = "READ_MODEL_INVALID", public readonly status = 400) { super(message); }
}
export class ReadSyncConflict extends ReadModelError {
  constructor() { super("This connection changed during the read. Its newer state was kept; refresh before trying again.", "READ_SYNC_CONFLICT", 409); }
}
export function requireMinor(value: unknown, field = "amountMinor"): string {
  if (typeof value !== "string" || value.length > 120 || !/^-?[0-9]+$/.test(value)) throw new ReadModelError(`Connector ${field} must be a signed decimal integer string.`);
  return BigInt(value).toString();
}
function nullableMinor(value: unknown, field: string): string | null {
  return value === null || value === undefined ? null : requireMinor(value, field);
}
function text(value: unknown, field: string, max = 300): string {
  if (typeof value !== "string" || !value.trim() || value.length > max || /[\u0000-\u001f\u007f]/.test(value)) throw new ReadModelError(`Invalid ${field}.`);
  return value;
}
function nullableText(value: unknown, field: string, max = 300): string | null {
  return value === undefined || value === null ? null : text(value, field, max);
}
function iso(value: unknown): string {
  if (typeof value !== "string" || value.length > 64 || !/^\d{4}-\d{2}-\d{2}(?:T|$)/.test(value)) throw new ReadModelError("Observation and transaction dates must be valid ISO dates.");
  const parsed = new Date(value);
  const day = new Date(`${value.slice(0, 10)}T00:00:00.000Z`);
  if (!Number.isFinite(parsed.getTime()) || !Number.isFinite(day.getTime()) || day.toISOString().slice(0, 10) !== value.slice(0, 10)) throw new ReadModelError("Observation and transaction dates must be valid ISO dates.");
  return parsed.toISOString();
}
function currency(value: unknown): string {
  const result = text(value, "currency", 20).trim().toUpperCase();
  if (!/^[A-Z0-9_-]{2,20}$/.test(result)) throw new ReadModelError("Invalid currency.");
  return result;
}
function safeRaw(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  // Provider reconciliation data may contain private transaction information,
  // but secrets and request headers never belong in the ledger.
  let encoded: string | undefined;
  try { encoded = JSON.stringify(value, (key, item) => /(?:token|secret|password|authorization|headers|credential)/i.test(key) ? undefined : item); }
  catch { throw new ReadModelError("Provider reconciliation record is not valid JSON."); }
  if (encoded === undefined) throw new ReadModelError("Provider reconciliation record is not valid JSON.");
  if (encoded.length > MAX_RAW) throw new ReadModelError("Provider reconciliation record is too large.");
  return encoded;
}

export function createReadConnection(db: Database, input: ReadConnectionInput): ReadSyncState {
  const connectionId = input.id ? text(input.id, "connection id", 180) : id();
  const provider = text(input.provider, "provider", 60);
  if (!["local", "sandbox", "live"].includes(input.environment)) throw new ReadModelError("Invalid connection environment.");
  const name = text(input.displayName, "connection name", 180);
  const existing = db.query("SELECT * FROM read_connections WHERE id=?").get(connectionId) as ReadSyncState | null;
  if (existing) {
    if (existing.provider !== provider || existing.environment !== input.environment) throw new ReadModelError("Connection identity already belongs to another provider or environment.");
    return getReadSyncState(db, connectionId);
  }
  db.query("INSERT INTO read_connections(id,provider,environment,display_name) VALUES(?,?,?,?)").run(connectionId, provider, input.environment, name);
  return getReadSyncState(db, connectionId);
}
export function getReadSyncState(db: Database, connectionId: string): ReadSyncState {
  const result = db.query("SELECT id,provider,environment,cursor,revision,status FROM read_connections WHERE id=?").get(connectionId) as ReadSyncState | null;
  if (!result) throw new ReadModelError("Read connection was not found.");
  return result;
}
export function markReadSyncAttempt(db: Database, connectionId: string, observedAt = new Date().toISOString()): void {
  db.query("UPDATE read_connections SET last_attempt_at=? WHERE id=?").run(iso(observedAt), connectionId);
}
/** A failed older request cannot replace a newer success or disconnect. Failure
 * does not advance the data revision, so a concurrent successful read can commit. */
export function markReadSyncFailure(db: Database, state: Pick<ReadSyncState, "id" | "revision" | "cursor">): void {
  db.query(`UPDATE read_connections SET status='error',last_error_code='READ_FAILED'
    WHERE id=? AND revision=? AND cursor IS ? AND status IN ('active','error')`).run(state.id, state.revision, state.cursor);
}
export function setReadConnectionStatus(db: Database, connectionId: string, status: ReadStatus, errorCode?: string | null): void {
  if (!["active", "reconnect_required", "disconnected", "error"].includes(status)) throw new ReadModelError("Invalid connection status.");
  // Only bounded machine codes may be retained. Never persist a raw provider error.
  if (errorCode && !/^[A-Z0-9_-]{1,80}$/.test(errorCode)) throw new ReadModelError("Use a safe provider error code.");
  const result = db.query("UPDATE read_connections SET status=?,last_error_code=?,revision=revision+1 WHERE id=?").run(status, errorCode ?? null, connectionId);
  if (!result.changes) throw new ReadModelError("Read connection was not found.");
}

interface AccountRow {
  id: string; currency: string; decimals: number; status: string;
  read_connection_id: string | null; external_account_id: string | null;
  balance_minor: string; read_observed_at: string | null;
}
function prepareAccount(account: ReadAccountInput, observedAt: string) {
  if (!Number.isInteger(account.decimals) || account.decimals < 0 || account.decimals > 30) throw new ReadModelError("Invalid account decimal scale.");
  if (account.balanceKind && !["current", "total", "observed"].includes(account.balanceKind)) throw new ReadModelError("Invalid balance kind.");
  return {
    ...account, externalAccountId: text(account.externalAccountId, "external account id", 240),
    displayName: text(account.displayName, "account name", 180), rail: text(account.rail, "rail", 40),
    currency: currency(account.currency), balanceMinor: nullableMinor(account.balanceMinor, "balanceMinor"),
    availableMinor: nullableMinor(account.availableMinor, "availableMinor"), pendingMinor: nullableMinor(account.pendingMinor, "pendingMinor"),
    heldMinor: nullableMinor(account.heldMinor, "heldMinor"), observedAt: iso(account.observedAt ?? observedAt),
    mask: nullableText(account.mask, "account mask", 20), accountType: nullableText(account.accountType, "account type", 60),
  };
}
function prepareTransaction(tx: ReadTransactionInput) {
  if (tx.status && tx.status !== "posted" && tx.status !== "pending") throw new ReadModelError("Invalid transaction status.");
  const grossMinor = nullableMinor(tx.grossMinor, "grossMinor");
  const feeMinor = nullableMinor(tx.feeMinor, "feeMinor");
  const netMinor = nullableMinor(tx.netMinor, "netMinor");
  const amountMinor = requireMinor(tx.amountMinor);
  if ([grossMinor, feeMinor, netMinor].some((amount) => amount !== null)
    && (grossMinor === null || feeMinor === null || netMinor === null || BigInt(grossMinor) - BigInt(feeMinor) !== BigInt(netMinor) || netMinor !== amountMinor)) {
    throw new ReadModelError("Gross, fee and net must be supplied together; net must equal gross minus fee and the recorded amount.");
  }
  return {
    ...tx, externalAccountId: text(tx.externalAccountId, "external account id", 240),
    externalId: text(tx.externalId, "external transaction id", 240), title: text(tx.title, "transaction title", 500),
    currency: currency(tx.currency), amountMinor, date: iso(tx.date), status: tx.status ?? "posted",
    pendingExternalId: nullableText(tx.pendingExternalId, "pending transaction id", 240),
    providerCategory: nullableText(tx.providerCategory, "provider category", 120),
    grossMinor, feeMinor, netMinor, raw: safeRaw(tx.raw),
  };
}

/** All pages must be fetched before calling this. Accounts, records and cursor
 * are committed together. A changed revision OR cursor rejects the entire batch. */
export function applyReadSync(db: Database, batch: ReadSyncBatch): ReadSyncResult {
  if (!Number.isSafeInteger(batch.expectedRevision) || batch.expectedRevision < 0) throw new ReadModelError("Invalid expected read revision.");
  if (batch.transactions.length > MAX_BATCH || (batch.removed?.length ?? 0) > MAX_BATCH || batch.accounts.length > 1_000) throw new ReadModelError("Read batch is too large.");
  const observedAt = iso(batch.observedAt);
  if (batch.environment && !["local", "sandbox", "live"].includes(batch.environment)) throw new ReadModelError("Invalid connection environment.");
  const nextCursor = batch.nextCursor === null ? null : text(batch.nextCursor, "sync cursor", 10_000);
  const accounts = batch.accounts.map((account) => prepareAccount(account, observedAt));
  if (new Set(accounts.map((account) => account.externalAccountId)).size !== accounts.length) throw new ReadModelError("Read batch contains duplicate account identifiers.");
  const transactions = batch.transactions.map(prepareTransaction);
  const removals = (batch.removed ?? []).map((row) => ({ externalId: text(row.externalId, "removed transaction id", 240), externalAccountId: row.externalAccountId === undefined ? undefined : text(row.externalAccountId, "external account id", 240) }));
  return db.transaction(() => {
    const state = getReadSyncState(db, batch.connectionId);
    if (state.revision !== batch.expectedRevision || state.cursor !== batch.expectedCursor || state.status === "disconnected" || state.status === "reconnect_required") throw new ReadSyncConflict();
    if (batch.environment && batch.environment !== state.environment) {
      if (state.revision !== 0 || state.environment !== "local") throw new ReadModelError("A connection cannot change between test and live data. Create a separate connection.");
      db.query("UPDATE read_connections SET environment=? WHERE id=?").run(batch.environment, state.id);
      state.environment = batch.environment;
    }
    const result: ReadSyncResult = { imported: 0, updated: 0, removed: 0, skipped: 0, revision: state.revision + 1, accounts: [] };
    for (const account of accounts) {
      let existing = account.accountId
        ? db.query("SELECT * FROM accounts WHERE id=?").get(account.accountId) as AccountRow | null
        : db.query("SELECT * FROM accounts WHERE read_connection_id=? AND external_account_id=?").get(state.id, account.externalAccountId) as AccountRow | null;
      if (account.accountId && !existing) throw new ReadModelError("The local account to update was not found.");
      if (existing) {
        if (existing.status !== "ACTIVE") throw new ReadModelError("Account stopped being active during sync.");
        if (existing.read_connection_id && existing.read_connection_id !== state.id) throw new ReadModelError("Account belongs to a different connection.");
        if (existing.external_account_id && existing.external_account_id !== account.externalAccountId) throw new ReadModelError("Provider account identity does not match the local account.");
        if (currency(existing.currency) !== account.currency) throw new ReadModelError("Connector reports a different currency — refusing to mix currencies.");
        if (existing.decimals !== account.decimals) throw new ReadModelError("Connector reports different decimals — refusing to mis-scale.");
        if (existing.read_observed_at && existing.read_observed_at > account.observedAt) throw new ReadSyncConflict();
      } else {
        const localId = id();
        db.query(`INSERT INTO accounts(id,rail,connector_type,display_name,currency,decimals,external_account_id,read_connection_id)
          VALUES(?,?,?,?,?,?,?,?)`).run(localId, account.rail, state.provider, account.displayName, account.currency, account.decimals, account.externalAccountId, state.id);
        existing = db.query("SELECT * FROM accounts WHERE id=?").get(localId) as AccountRow;
      }
      db.query(`UPDATE accounts SET read_connection_id=?, balance_minor=?, balance_as_of=?, available_minor=?,pending_minor=?,held_minor=?,
        balance_kind=?,read_observed_at=?,account_mask=?,account_type=?,read_environment=? WHERE id=?`).run(
        state.id, account.balanceMinor ?? existing.balance_minor, account.balanceMinor === null ? null : account.observedAt,
        account.availableMinor, account.pendingMinor, account.heldMinor, account.balanceKind ?? "observed", account.observedAt,
        account.mask, account.accountType, state.environment, existing.id,
      );
      result.accounts.push({ accountId: existing.id, externalAccountId: account.externalAccountId });
    }
    const accountMap = new Map((db.query("SELECT * FROM accounts WHERE read_connection_id=?").all(state.id) as AccountRow[]).map((account) => [account.external_account_id!, account]));
    for (const tx of transactions) {
      const account = accountMap.get(tx.externalAccountId);
      if (!account || account.status !== "ACTIVE") throw new ReadModelError("Transaction refers to an unknown or inactive connected account.");
      if (currency(account.currency) !== tx.currency) throw new ReadModelError("Transaction currency does not match its account.");
      const previous = db.query("SELECT * FROM transactions WHERE account_id=? AND external_id=?").get(account.id, tx.externalId) as { id: string; source: string; category: string | null; title: string; amount_minor: string; date: string; status: string; provider_category: string | null; pending_external_id: string | null; gross_minor: string | null; fee_minor: string | null; net_minor: string | null; raw: string | null } | null;
      if (previous && previous.source !== "CONNECTOR") throw new ReadModelError("Provider transaction identifier conflicts with a user record.");
      let inheritedCategory: string | null = null;
      if (tx.pendingExternalId && tx.pendingExternalId !== tx.externalId && tx.status === "posted") {
        const pending = db.query("SELECT id,category,status FROM transactions WHERE account_id=? AND external_id=? AND source='CONNECTOR' AND status IN ('pending','removed')").get(account.id, tx.pendingExternalId) as { id: string; category: string | null; status: string } | null;
        if (pending) {
          inheritedCategory = pending.category;
          db.query("UPDATE transactions SET status='removed',provider_updated_at=? WHERE id=?").run(observedAt, pending.id);
          if (pending.status !== "removed") result.removed++;
        }
      }
      if (!previous) {
        db.query(`INSERT INTO transactions(id,account_id,external_id,title,amount_minor,date,source,raw,status,provider_updated_at,provider_category,pending_external_id,gross_minor,fee_minor,net_minor,category)
          VALUES(?,?,?,?,?,?,'CONNECTOR',?,?,?,?,?,?,?,?,?)`).run(id(), account.id, tx.externalId, tx.title, tx.amountMinor, tx.date, tx.raw, tx.status, observedAt, tx.providerCategory, tx.pendingExternalId, tx.grossMinor, tx.feeMinor, tx.netMinor, inheritedCategory);
        result.imported++;
      } else {
        const changed = previous.title !== tx.title || previous.amount_minor !== tx.amountMinor || previous.date !== tx.date || previous.status !== tx.status || previous.provider_category !== tx.providerCategory || previous.pending_external_id !== tx.pendingExternalId || previous.gross_minor !== tx.grossMinor || previous.fee_minor !== tx.feeMinor || previous.net_minor !== tx.netMinor || previous.raw !== tx.raw || (previous.category === null && inheritedCategory !== null);
        db.query(`UPDATE transactions SET title=?,amount_minor=?,date=?,raw=?,status=?,provider_updated_at=?,provider_category=?,pending_external_id=?,gross_minor=?,fee_minor=?,net_minor=?,category=COALESCE(category,?) WHERE id=?`).run(tx.title, tx.amountMinor, tx.date, tx.raw, tx.status, observedAt, tx.providerCategory, tx.pendingExternalId, tx.grossMinor, tx.feeMinor, tx.netMinor, inheritedCategory, previous.id);
        if (changed) result.updated++; else result.skipped++;
      }
    }
    for (const removal of removals) {
      const matches = db.query(`SELECT t.id,t.status FROM transactions t JOIN accounts a ON a.id=t.account_id
        WHERE a.read_connection_id=? AND t.external_id=? AND t.source='CONNECTOR'
          AND (? IS NULL OR a.external_account_id=?)`).all(state.id, removal.externalId, removal.externalAccountId ?? null, removal.externalAccountId ?? null) as { id: string; status: string }[];
      if (matches.length > 1 && !removal.externalAccountId) throw new ReadModelError("Removed transaction identifier is ambiguous within this connection.");
      for (const match of matches) {
        if (match.status !== "removed") {
          db.query("UPDATE transactions SET status='removed',provider_updated_at=? WHERE id=?").run(observedAt, match.id);
          result.removed++;
        }
      }
    }
    invalidateChangedTransfers(db, observedAt, state.id);
    const commit = db.query(`UPDATE read_connections SET cursor=?,revision=revision+1,last_attempt_at=MAX(COALESCE(last_attempt_at,''),?),last_success_at=?,last_error_code=NULL,status='active'
      WHERE id=? AND revision=? AND cursor IS ? AND status NOT IN ('disconnected','reconnect_required')`).run(nextCursor, observedAt, observedAt, state.id, batch.expectedRevision, batch.expectedCursor);
    if (!commit.changes) throw new ReadSyncConflict();
    return result;
  })();
}

export function getReadConnections(db: Database): ReadConnectionView[] {
  const connections = db.query("SELECT id,provider,environment,display_name,status,last_attempt_at,last_success_at,last_error_code FROM read_connections ORDER BY created_at,id").all() as Omit<ReadConnectionView, "accounts" | "capabilities">[];
  return connections.map((connection) => ({ ...connection,
    capabilities: { accounts: true, balances: true, transactions: true, payments: false },
    accounts: db.query(`SELECT id,display_name,currency,decimals,balance_minor,available_minor,pending_minor,held_minor,balance_as_of,balance_kind,read_observed_at,read_environment,account_mask,account_type,status
      FROM accounts WHERE read_connection_id=? ORDER BY created_at,id`).all(connection.id) as ReadAccountView[],
  }));
}

export function applyImportedRows(db: Database, input: { accountId: string; rows: ImportedRow[]; observedAt?: Date }): { imported: number; skipped: number } {
  if (input.rows.length > MAX_BATCH) throw new ReadModelError("Import is too large.");
  const observedAt = iso((input.observedAt ?? new Date()).toISOString());
  const rows = input.rows.map((row) => ({ ...prepareTransaction({ ...row, externalAccountId: input.accountId, date: row.date.toISOString() }), category: nullableText(row.category, "category", 60) }));
  return db.transaction(() => {
    const account = db.query("SELECT currency,status,connector_type,read_connection_id FROM accounts WHERE id=?").get(input.accountId) as { currency: string; status: string; connector_type: string | null; read_connection_id: string | null } | null;
    if (!account || account.status !== "ACTIVE") throw new ReadModelError("Choose an active account for the import.");
    if (account.connector_type || account.read_connection_id) throw new ReadModelError("Import statements into a manual account to avoid duplicating connected transactions.");
    let imported = 0;
    let skipped = 0;
    for (const row of rows) {
      if (row.currency !== currency(account.currency)) throw new ReadModelError("Import currency does not match the account.");
      const existing = db.query("SELECT source FROM transactions WHERE account_id=? AND external_id=?").get(input.accountId, row.externalId) as { source: string } | null;
      if (existing) {
        if (existing.source !== "CSV") throw new ReadModelError("Import identifier conflicts with a non-imported record.");
        skipped++;
        continue;
      }
      db.query(`INSERT INTO transactions(id,account_id,external_id,title,amount_minor,date,category,source,status,provider_updated_at)
        VALUES(?,?,?,?,?,?,?,'CSV','posted',?)`).run(id(), input.accountId, row.externalId, row.title, row.amountMinor, row.date, row.category, observedAt);
      imported++;
    }
    return { imported, skipped };
  })();
}

const transferSelect = `SELECT t.id,t.account_id,a.display_name AS account_name,t.title,t.amount_minor,a.currency,a.decimals,t.date,a.read_environment,a.rail,a.chain_id,a.asset_id,t.fee_minor,
  t.status,a.status AS account_status,t.transfer_link_id FROM transactions t JOIN accounts a ON a.id=t.account_id`;
interface TransferRow extends TransferRecord { status: string; account_status: string; transfer_link_id: string | null; rail: string; chain_id: string | null; asset_id: string | null; fee_minor: string | null }
function transferRow(db: Database, transactionId: string): TransferRow | null {
  return db.query(`${transferSelect} WHERE t.id=?`).get(transactionId) as TransferRow | null;
}
function publicTransfer(row: TransferRow): TransferRecord {
  return { id: row.id, account_id: row.account_id, account_name: row.account_name, title: row.title, amount_minor: row.amount_minor, currency: row.currency, decimals: row.decimals, date: row.date, read_environment: row.read_environment };
}
function validPair(outgoing: TransferRow | null, incoming: TransferRow | null, requireActive = true): outgoing is TransferRow {
  return !!outgoing && !!incoming && outgoing.id !== incoming.id && outgoing.account_id !== incoming.account_id
    && outgoing.status === "posted" && incoming.status === "posted"
    && (!requireActive || outgoing.account_status === "ACTIVE" && incoming.account_status === "ACTIVE")
    && currency(outgoing.currency) === currency(incoming.currency) && outgoing.decimals === incoming.decimals
    && (outgoing.read_environment === "sandbox") === (incoming.read_environment === "sandbox")
    && BigInt(outgoing.fee_minor ?? "0") === 0n && BigInt(incoming.fee_minor ?? "0") === 0n
    && (outgoing.rail !== "CRYPTO" && incoming.rail !== "CRYPTO" || outgoing.rail === "CRYPTO" && incoming.rail === "CRYPTO"
      && !!outgoing.chain_id && !!outgoing.asset_id && outgoing.chain_id === incoming.chain_id && outgoing.asset_id === incoming.asset_id)
    && BigInt(outgoing.amount_minor) < 0n && BigInt(incoming.amount_minor) === -BigInt(outgoing.amount_minor);
}

/** Suggestions are limited to nearby dates. They never assert account ownership
 * or create links; the local owner confirms both accounts and entries in the UI. */
export function getTransferCandidates(db: Database, limit = 100): TransferCandidate[] {
  const safeLimit = Math.min(Math.max(Math.floor(limit), 1), 500);
  const rows = db.query(`${transferSelect} WHERE t.status='posted' AND a.status='ACTIVE' AND t.transfer_link_id IS NULL ORDER BY t.date DESC LIMIT 3000`).all() as TransferRow[];
  const positives = new Map<string, TransferRow[]>();
  for (const row of rows) {
    if (BigInt(row.amount_minor) <= 0n) continue;
    const key = `${currency(row.currency)}:${row.decimals}:${BigInt(row.amount_minor)}`;
    positives.set(key, [...(positives.get(key) ?? []), row]);
  }
  const result: TransferCandidate[] = [];
  for (const outgoing of rows) {
    if (BigInt(outgoing.amount_minor) >= 0n) continue;
    for (const incoming of positives.get(`${currency(outgoing.currency)}:${outgoing.decimals}:${-BigInt(outgoing.amount_minor)}`) ?? []) {
      const gap = Math.abs(Date.parse(outgoing.date) - Date.parse(incoming.date)) / DAY;
      if (gap <= 7 && validPair(outgoing, incoming)) {
        result.push({ outgoing: publicTransfer(outgoing), incoming: publicTransfer(incoming), day_gap: Math.round(gap * 100) / 100 });
        if (result.length >= safeLimit) return result;
      }
    }
  }
  return result;
}
export function getTransferLinks(db: Database): TransferLink[] {
  const links = db.query("SELECT id,outgoing_id,incoming_id,created_at FROM internal_transfers WHERE unlinked_at IS NULL ORDER BY created_at DESC").all() as Omit<TransferLink, "outgoing" | "incoming">[];
  return links.flatMap((link) => {
    const outgoing = transferRow(db, link.outgoing_id);
    const incoming = transferRow(db, link.incoming_id);
    return outgoing && incoming ? [{ ...link, outgoing: publicTransfer(outgoing), incoming: publicTransfer(incoming) }] : [];
  });
}
/** This action is an explicit owner declaration, never an automatic matcher. */
export function linkInternalTransfer(db: Database, input: { outgoingId: string; incomingId: string }): TransferLink {
  return db.transaction(() => {
    const outgoing = transferRow(db, input.outgoingId);
    const incoming = transferRow(db, input.incomingId);
    if (!validPair(outgoing, incoming)) throw new ReadModelError("Choose two posted records in different owned accounts with the same currency and asset, compatible sandbox environment, equal opposite amounts and no recorded fees.");
    if (outgoing.transfer_link_id || incoming!.transfer_link_id) throw new ReadModelError("One of these records is already linked to a transfer.");
    const linkId = id();
    const createdAt = new Date().toISOString();
    db.query("INSERT INTO internal_transfers(id,outgoing_id,incoming_id,created_at) VALUES(?,?,?,?)").run(linkId, outgoing.id, incoming!.id, createdAt);
    db.query("UPDATE transactions SET transfer_link_id=? WHERE id IN (?,?)").run(linkId, outgoing.id, incoming!.id);
    return { id: linkId, outgoing_id: outgoing.id, incoming_id: incoming!.id, created_at: createdAt, outgoing: publicTransfer(outgoing), incoming: publicTransfer(incoming!) };
  })();
}
export function unlinkInternalTransfer(db: Database, linkId: string): void {
  db.transaction(() => {
    const changed = db.query("UPDATE internal_transfers SET unlinked_at=?,unlink_reason='owner' WHERE id=? AND unlinked_at IS NULL").run(new Date().toISOString(), linkId);
    if (!changed.changes) throw new ReadModelError("The active transfer link was not found.");
    db.query("UPDATE transactions SET transfer_link_id=NULL WHERE transfer_link_id=?").run(linkId);
  })();
}
function invalidateChangedTransfers(db: Database, observedAt: string, connectionId: string): void {
  const links = db.query(`SELECT l.id,l.outgoing_id,l.incoming_id FROM internal_transfers l WHERE l.unlinked_at IS NULL AND EXISTS (
    SELECT 1 FROM transactions t JOIN accounts a ON a.id=t.account_id
    WHERE t.id IN (l.outgoing_id,l.incoming_id) AND a.read_connection_id=?)`).all(connectionId) as { id: string; outgoing_id: string; incoming_id: string }[];
  for (const link of links) {
    if (validPair(transferRow(db, link.outgoing_id), transferRow(db, link.incoming_id), false)) continue;
    db.query("UPDATE internal_transfers SET unlinked_at=?,unlink_reason='provider_change' WHERE id=?").run(observedAt, link.id);
    db.query("UPDATE transactions SET transfer_link_id=NULL WHERE transfer_link_id=?").run(link.id);
  }
}
