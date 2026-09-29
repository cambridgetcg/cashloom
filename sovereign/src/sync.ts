/** Existing read connectors share the same account/transaction reconciliation
 * store as bank connections. Network reads finish before the atomic commit. */
import { db } from "./db.ts";
import { getConnector } from "./connectors/index.ts";
import { applyReadSync, createReadConnection, getReadSyncState, markReadSyncAttempt, markReadSyncFailure, ReadModelError } from "./connect/read-model.ts";
import type { ReadEnvironment, ReadTransactionInput } from "./connect/contracts.ts";

const DAY_MS = 86_400_000;
const LOOKBACK_MS = 90 * DAY_MS;
const OVERLAP_MS = 3 * DAY_MS;

function date(value: unknown): string {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) throw new ReadModelError("Connector date must be a valid Date.");
  return value.toISOString();
}

export interface SyncResult {
  accountId: string;
  balanceMinor: string;
  imported: number;
  updated: number;
  removed: number;
  skipped: number;
}
interface AccountRow {
  id: string; rail: string; display_name: string;
  connector_type: string | null; currency: string; decimals: number;
  external_account_id: string | null; credential_ref: string | null;
  read_connection_id: string | null; read_environment: ReadEnvironment;
  account_mask: string | null; account_type: string | null;
}

export const syncAccount = async (accountId: string): Promise<SyncResult> => {
  const account = db.query("SELECT * FROM accounts WHERE id=? AND status='ACTIVE'").get(accountId) as AccountRow | null;
  if (!account) throw new ReadModelError("No active account was found.");
  if (!account.connector_type || !account.external_account_id) throw new ReadModelError("Account has no connector — nothing to sync.");
  const connector = getConnector(account.connector_type, account.currency);
  const state = account.read_connection_id
    ? getReadSyncState(db, account.read_connection_id)
    : createReadConnection(db, { id: `legacy:${account.id}`, provider: account.connector_type, environment: account.read_environment, displayName: account.display_name });
  markReadSyncAttempt(db, state.id);
  try {
  const ctx = { credentialRef: account.credential_ref, externalAccountId: account.external_account_id };
  // Revisit the complete locally known connector history, plus 90 days for a
  // first read. This catches revisions and long-lived pending entries. Absent
  // rows are never inferred as removals; a provider must explicitly remove one.
  const oldest = db.query("SELECT MIN(date) AS d FROM transactions WHERE account_id=? AND source='CONNECTOR' AND external_id IS NOT NULL").get(account.id) as { d: string | null };
  const since = new Date(Math.min(Date.now() - LOOKBACK_MS, oldest.d ? Date.parse(oldest.d) - OVERLAP_MS : Infinity));
  const [balance, fetched] = await Promise.all([connector.fetchBalance(ctx), connector.fetchTransactions(ctx, since)]);
  const observedAt = date(balance.asOf);
  let rejected = 0;
  const transactions: ReadTransactionInput[] = [];
  const removed: Array<{ externalAccountId: string; externalId: string }> = [];
  for (const tx of fetched) {
    if (tx.currency.trim().toUpperCase() !== account.currency.trim().toUpperCase()) { rejected++; continue; }
    if (tx.status === "removed") { removed.push({ externalAccountId: account.external_account_id, externalId: tx.externalId }); continue; }
    transactions.push({ ...tx, externalAccountId: account.external_account_id, date: date(tx.date), status: tx.status });
  }
  const result = applyReadSync(db, {
    connectionId: state.id, expectedRevision: state.revision, expectedCursor: state.cursor, nextCursor: state.cursor,
    observedAt, environment: balance.environment,
    accounts: [{ accountId: account.id, externalAccountId: account.external_account_id, displayName: account.display_name,
      rail: account.rail, currency: balance.currency, decimals: balance.decimals, balanceMinor: balance.balanceMinor,
      availableMinor: balance.availableMinor, pendingMinor: balance.pendingMinor, heldMinor: balance.heldMinor,
      balanceKind: balance.balanceKind, observedAt, mask: account.account_mask, accountType: account.account_type }],
    transactions, removed,
  });
  return { accountId: account.id, balanceMinor: balance.balanceMinor, imported: result.imported, updated: result.updated, removed: result.removed, skipped: result.skipped + rejected };
  } catch (error) {
    markReadSyncFailure(db, state);
    throw error;
  }
};
