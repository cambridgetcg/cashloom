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

  const balance = await connector.fetchBalance(ctx);
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

  const newest = db
    .query("SELECT MAX(date) AS d FROM transactions WHERE account_id = ?")
    .get(account.id) as { d: string | null };
  const since = newest.d
    ? new Date(Date.parse(newest.d) - OVERLAP_MS)
    : new Date(Date.now() - FIRST_SYNC_LOOKBACK_MS);

  const fetched = await connector.fetchTransactions(ctx, since);

  let imported = 0;
  let skipped = 0;
  const insert = db.query(
    `INSERT OR IGNORE INTO transactions (id, account_id, external_id, title, amount_minor, date, source, raw)
     VALUES (?, ?, ?, ?, ?, ?, 'CONNECTOR', ?)`
  );
  for (const tx of fetched) {
    if (tx.currency.trim().toUpperCase() !== account.currency.trim().toUpperCase()) {
      skipped += 1; // foreign-currency row would corrupt every sum — skip loudly in the count
      continue;
    }
    const result = insert.run(
      newId(),
      account.id,
      tx.externalId,
      tx.title,
      tx.amountMinor,
      tx.date.toISOString(),
      tx.raw === undefined ? null : JSON.stringify(tx.raw)
    );
    if (result.changes > 0) imported += 1;
    else skipped += 1;
  }

  db.query("UPDATE accounts SET balance_minor = ?, balance_as_of = ? WHERE id = ?").run(
    balance.balanceMinor,
    balance.asOf.toISOString(),
    account.id
  );

  return { accountId: account.id, balanceMinor: balance.balanceMinor, imported, skipped };
};
