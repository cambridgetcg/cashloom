/** pay() — the universal primitive (PROTOCOL.md §5.3), as a two-step rite:
 *
 *    quote   → fee disclosed, intent recorded, NOTHING signed
 *    confirm → the quoted intent (and only it) is signed + broadcast, once
 *
 *  Quotes expire in 5 minutes. Failed sends are recorded and surfaced,
 *  NEVER auto-retried (inherited doctrine: a payout that failed is an
 *  operator decision, not a loop). Every outcome lands in the ledger.
 */

import { db, newId } from "./db.ts";
import { evmSender } from "./senders/evm.sender.ts";
import type { PaymentSender } from "./senders/types.ts";

const SENDERS: PaymentSender[] = [evmSender];
const QUOTE_TTL_MS = 5 * 60 * 1000;

const senderForAsset = (asset: string): PaymentSender => {
  const normalized = asset.trim().toUpperCase();
  const sender = SENDERS.find((s) => s.assets.includes(normalized));
  if (!sender) {
    throw new Error(
      `No sender for asset "${asset}". Available: ${SENDERS.flatMap((s) => s.assets).join(", ")}.`
    );
  }
  return sender;
};

interface AccountRow {
  id: string;
  rail: string;
  display_name: string;
  currency: string;
  vault_key_id: string | null;
}

const sendingAccount = (accountId: string): AccountRow => {
  const row = db
    .query(
      "SELECT id, rail, display_name, currency, vault_key_id FROM accounts WHERE id = ? AND status = 'ACTIVE'"
    )
    .get(accountId) as AccountRow | null;
  if (!row) throw new Error(`No active account ${accountId}`);
  if (!row.vault_key_id) {
    throw new Error(
      `Account "${row.display_name}" has no local signing key — only key-backed accounts can send.`
    );
  }
  return row;
};

export interface QuoteResult {
  paymentId: string;
  feeMinor: string;
  feeAsset: string;
  summary: string;
  expiresAt: string;
}

export const quotePayment = async (opts: {
  accountId: string;
  to: string;
  amountMinor: string;
  asset: string;
}): Promise<QuoteResult> => {
  const account = sendingAccount(opts.accountId);
  const sender = senderForAsset(opts.asset);
  const quote = await sender.quote(
    { vaultKeyId: account.vault_key_id! },
    { to: opts.to, amountMinor: opts.amountMinor, asset: opts.asset }
  );
  const id = newId();
  db.query(
    `INSERT INTO payments (id, account_id, rail, to_addr, asset, amount_minor, fee_minor, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'quoted')`
  ).run(id, account.id, sender.type, opts.to, opts.asset.trim().toUpperCase(), opts.amountMinor, quote.feeMinor);
  return {
    paymentId: id,
    feeMinor: quote.feeMinor,
    feeAsset: quote.feeAsset,
    summary: quote.summary,
    expiresAt: new Date(Date.now() + QUOTE_TTL_MS).toISOString(),
  };
};

export interface ConfirmResult {
  paymentId: string;
  status: string;
  txHash: string | null;
  error: string | null;
}

export const confirmPayment = async (paymentId: string): Promise<ConfirmResult> => {
  const row = db.query("SELECT * FROM payments WHERE id = ?").get(paymentId) as
    | Record<string, string | null>
    | null;
  if (!row) throw new Error(`No payment ${paymentId}`);
  if (row.status !== "quoted") {
    throw new Error(`Payment ${paymentId} is "${row.status}" — only a fresh quote can be confirmed.`);
  }
  if (Date.now() - Date.parse(String(row.created_at)) > QUOTE_TTL_MS) {
    db.query("UPDATE payments SET status = 'failed', error = 'quote expired', updated_at = ? WHERE id = ?")
      .run(new Date().toISOString(), paymentId);
    throw new Error("Quote expired — request a fresh one (fees move).");
  }

  const account = sendingAccount(String(row.account_id));
  const sender = senderForAsset(String(row.asset));

  // Point of no return is INSIDE send(): mark first so a crash between
  // broadcast and record is visible as 'confirmed' (needs investigation),
  // never silently re-sendable.
  db.query("UPDATE payments SET status = 'confirmed', updated_at = ? WHERE id = ?")
    .run(new Date().toISOString(), paymentId);

  try {
    const receipt = await sender.send(
      { vaultKeyId: account.vault_key_id! },
      { to: String(row.to_addr), amountMinor: String(row.amount_minor), asset: String(row.asset) }
    );
    db.query("UPDATE payments SET status = 'broadcast', tx_hash = ?, updated_at = ? WHERE id = ?")
      .run(receipt.externalId, new Date().toISOString(), paymentId);
    // The ledger records the send immediately (negative = out). The chain
    // remains the source of truth; a read-rail sync of the same tx dedupes
    // on the hash.
    db.query(
      `INSERT OR IGNORE INTO transactions (id, account_id, external_id, title, amount_minor, date, source)
       VALUES (?, ?, ?, ?, ?, ?, 'PAYMENT')`
    ).run(
      newId(),
      account.id,
      receipt.externalId,
      `pay · ${row.asset} → ${String(row.to_addr).slice(0, 12)}…`,
      `-${row.amount_minor}`,
      new Date().toISOString()
    );
    return { paymentId, status: "broadcast", txHash: receipt.externalId, error: null };
  } catch (error) {
    const message = error instanceof Error ? error.message : "send failed";
    db.query("UPDATE payments SET status = 'failed', error = ?, updated_at = ? WHERE id = ?")
      .run(message, new Date().toISOString(), paymentId);
    // Recorded, surfaced, NOT retried.
    return { paymentId, status: "failed", txHash: null, error: message };
  }
};

export const listPayments = (limit = 50) =>
  db
    .query("SELECT id, account_id, rail, to_addr, asset, amount_minor, fee_minor, status, tx_hash, error, created_at FROM payments ORDER BY created_at DESC LIMIT ?")
    .all(limit);
