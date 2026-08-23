/** Read-rail sync — pull one account's balance + transactions through its
 *  strictly read-only connector into the local ledger. Connectors observe;
 *  this records. Dedupe is the UNIQUE(account_id, external_id) index — a
 *  re-synced row is a skip, never a double.
 */

import { db, newId } from "./db.ts";
import { getConnector } from "./connectors/index.ts";

const DAY_MS = 24 * 60 * 60 * 1000;
// Re-fetch behind the newest known row so late-booking rows still land.
const OVERLAP_MS = 3 * DAY_MS;
const FIRST_SYNC_LOOKBACK_MS = 90 * DAY_MS;
const ATOMIC_INTEGER = /^-?[0-9]+$/;

const requireAtomicInteger = (value: unknown, field: string): string => {
  if (typeof value !== "string" || !ATOMIC_INTEGER.test(value)) {
    throw new Error(`Connector ${field} must be a signed decimal integer string.`);
  }
  return value;
};

const requireIsoDate = (value: unknown, field: string): string => {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new Error(`Connector ${field} must be a valid Date.`);
  }
  return value.toISOString();
};

export interface SyncResult {
  accountId: string;
  balanceMinor: string;
  imported: number;
  skipped: number;
}

interface AccountRow {
  id: string;
  connector_type: string | null;
  currency: string;
  decimals: number;
  external_account_id: string | null;
  credential_ref: string | null;
}

export const syncAccount = async (accountId: string): Promise<SyncResult> => {
  const account = db
    .query(
      "SELECT id, connector_type, currency, decimals, external_account_id, credential_ref FROM accounts WHERE id = ? AND status = 'ACTIVE'"
    )
    .get(accountId) as AccountRow | null;
  if (!account) throw new Error(`No active account ${accountId}`);
  if (!account.connector_type || !account.external_account_id) {
    throw new Error(`Account ${accountId} has no connector — nothing to sync.`);
  }

  const connector = getConnector(account.connector_type, account.currency);
  const ctx = {
    credentialRef: account.credential_ref,
    externalAccountId: account.external_account_id,
  };

  const newest = db
    .query(
      `SELECT MAX(date) AS d
       FROM transactions
       WHERE account_id = ? AND source = 'CONNECTOR' AND external_id IS NOT NULL`,
    )
    .get(account.id) as { d: string | null };
  const since = newest.d
    ? new Date(Date.parse(newest.d) - OVERLAP_MS)
    : new Date(Date.now() - FIRST_SYNC_LOOKBACK_MS);

  // Both calls are observation-only and independent. Complete every network
  // read before opening the short local write transaction.
  const [balance, fetched] = await Promise.all([
    connector.fetchBalance(ctx),
    connector.fetchTransactions(ctx, since),
  ]);
  if (balance.currency.trim().toUpperCase() !== account.currency.trim().toUpperCase()) {
    throw new Error(
      `Connector reports ${balance.currency} but the account is ${account.currency} — refusing to mix currencies.`
    );
  }
  if (balance.decimals !== account.decimals) {
    throw new Error(
      `Connector reports ${balance.decimals} decimals but the account is set to ${account.decimals} — refusing to mis-scale.`
    );
  }
  const balanceMinor = requireAtomicInteger(balance.balanceMinor, "balanceMinor");
  const balanceAsOf = requireIsoDate(balance.asOf, "balance asOf");

  // Validate and serialize connector material before beginning to write. A
  // malformed payload therefore leaves both rows and balance untouched.
  let rejected = 0;
  const prepared = fetched.flatMap((tx) => {
    if (tx.currency.trim().toUpperCase() !== account.currency.trim().toUpperCase()) {
      rejected += 1;
      return [];
    }
    return [{
      externalId: tx.externalId,
      title: tx.title,
      amountMinor: requireAtomicInteger(tx.amountMinor, "transaction amountMinor"),
      date: requireIsoDate(tx.date, "transaction date"),
      raw: tx.raw === undefined ? null : JSON.stringify(tx.raw),
    }];
  });

  const commit = db.transaction(() => {
    let imported = 0;
    let skipped = rejected;
    const insert = db.query(
      `INSERT OR IGNORE INTO transactions (id, account_id, external_id, title, amount_minor, date, source, raw)
       VALUES (?, ?, ?, ?, ?, ?, 'CONNECTOR', ?)`,
    );
    for (const tx of prepared) {
      const result = insert.run(
        newId(),
        account.id,
        tx.externalId,
        tx.title,
        tx.amountMinor,
        tx.date,
        tx.raw,
      );
      if (result.changes > 0) imported += 1;
      else skipped += 1;
    }

    db
      .query(
         `UPDATE accounts SET balance_minor = ?, balance_as_of = ?
         WHERE id = ? AND status = 'ACTIVE'
           AND (balance_as_of IS NULL OR balance_as_of <= ?)`,
      )
      .run(balanceMinor, balanceAsOf, account.id, balanceAsOf);
    const retained = db
      .query("SELECT status, balance_minor FROM accounts WHERE id = ?")
      .get(account.id) as { status: string; balance_minor: string } | null;
    if (!retained || retained.status !== "ACTIVE") {
      throw new Error(`Account ${account.id} stopped being active during sync.`);
    }

    // A slower, older observation may finish after a newer one. Its ledger
    // rows still reconcile, but it must not move the account balance backward.
    return { imported, skipped, balanceMinor: retained.balance_minor };
  });

  const result = commit();
  return {
    accountId: account.id,
    balanceMinor: result.balanceMinor,
    imported: result.imported,
    skipped: result.skipped,
  };
};
