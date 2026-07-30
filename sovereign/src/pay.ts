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
import { btcSender } from "./senders/btc.sender.ts";
import { evmSender } from "./senders/evm.sender.ts";
import { AmbiguousBroadcastError, type PaymentSender } from "./senders/types.ts";

const SENDERS: PaymentSender[] = [evmSender, btcSender];
const QUOTE_TTL_MS = 5 * 60 * 1000;

const senderForAsset = (
  asset: string,
  senders: readonly PaymentSender[] = SENDERS,
): PaymentSender => {
  const normalized = asset.trim().toUpperCase();
  const sender = senders.find((s) => s.assets.includes(normalized));
  if (!sender) {
    throw new Error(
      `No sender for asset "${asset}". Available: ${senders.flatMap((s) => s.assets).join(", ")}.`
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
  executionFeeCeilingMinor?: string;
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
  // quote.detail is the sender's opaque persisted state (e.g. the BTC coin
  // selection) — stored verbatim, handed back verbatim at confirm, never
  // parsed here, never selected by listPayments.
  db.query(
    `INSERT INTO payments
       (id, account_id, rail, to_addr, asset, amount_minor, fee_minor,
        execution_fee_ceiling_minor, status, detail)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'quoted', ?)`
  ).run(
    id,
    account.id,
    sender.type,
    opts.to,
    opts.asset.trim().toUpperCase(),
    opts.amountMinor,
    quote.feeMinor,
    quote.executionFeeCeilingMinor ?? null,
    quote.detail ?? null,
  );
  return {
    paymentId: id,
    feeMinor: quote.feeMinor,
    ...(quote.executionFeeCeilingMinor
      ? { executionFeeCeilingMinor: quote.executionFeeCeilingMinor }
      : {}),
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

export interface ConfirmPaymentRuntime {
  /** In-process deterministic test seam; HTTP callers never receive it. */
  senders?: readonly PaymentSender[];
  /** Lets a test pause after the initial row snapshot. */
  afterRead?: () => Promise<void> | void;
  /** Lets a concurrency test put two readers on the same stale snapshot. */
  beforeClaim?: () => Promise<void> | void;
}

export const confirmPayment = async (
  paymentId: string,
  runtime: ConfirmPaymentRuntime = {},
): Promise<ConfirmResult> => {
  const row = db.query("SELECT * FROM payments WHERE id = ?").get(paymentId) as
    | Record<string, string | null>
    | null;
  if (!row) throw new Error(`No payment ${paymentId}`);
  if (row.status !== "quoted") {
    throw new Error(`Payment ${paymentId} is "${row.status}" — only a fresh quote can be confirmed.`);
  }
  if (runtime.afterRead) await runtime.afterRead();
  if (Date.now() - Date.parse(String(row.created_at)) > QUOTE_TTL_MS) {
    // Expiry is also a compare-and-swap. A process with a skewed clock must
    // not overwrite a confirmation another process already claimed.
    const expired = db
      .query(
        `UPDATE payments
         SET status = 'failed', error = 'quote expired', updated_at = ?
         WHERE id = ? AND status = 'quoted' AND created_at = ?`,
      )
      .run(new Date().toISOString(), paymentId, String(row.created_at));
    if (expired.changes !== 1) {
      const current = db.query("SELECT status FROM payments WHERE id = ?").get(paymentId) as
        | { status: string }
        | null;
      throw new Error(
        `Payment ${paymentId} is "${current?.status ?? "missing"}" — only a fresh quote can be confirmed.`,
      );
    }
    throw new Error("Quote expired — request a fresh one (fees move).");
  }

  const account = sendingAccount(String(row.account_id));
  const sender = senderForAsset(String(row.asset), runtime.senders ?? SENDERS);

  if (runtime.beforeClaim) await runtime.beforeClaim();

  // Claim the quote with a compare-and-swap BEFORE any signing work. Two
  // processes can both read "quoted"; only one may move it to "confirmed".
  // The loser must stop here, before it can reveal a key or call send().
  const claimed = db
    .query(
      `UPDATE payments
       SET status = 'confirmed', updated_at = ?
       WHERE id = ? AND status = 'quoted' AND created_at = ?`
    )
    .run(new Date().toISOString(), paymentId, String(row.created_at));
  if (claimed.changes !== 1) {
    const current = db.query("SELECT status FROM payments WHERE id = ?").get(paymentId) as
      | { status: string }
      | null;
    throw new Error(
      `Payment ${paymentId} is "${current?.status ?? "missing"}" — only a fresh quote can be confirmed.`
    );
  }

  let receipt;
  try {
    receipt = await sender.send(
      { vaultKeyId: account.vault_key_id!, paymentId },
      {
        to: String(row.to_addr),
        amountMinor: String(row.amount_minor),
        asset: String(row.asset),
        detail: (row.detail as string | null) ?? null,
      },
      {
        // The signed tx's id lands in the row BEFORE the network hears the
        // tx: a crash mid-broadcast or an unanswered indexer leaves a
        // 'confirmed' payment with the exact txid to check on-chain — never
        // a mystery, never silently re-sendable.
        onSigned: (externalId) => {
          db.query("UPDATE payments SET tx_hash = ?, updated_at = ? WHERE id = ?").run(
            externalId,
            new Date().toISOString(),
            paymentId
          );
        },
      }
    );
  } catch (error) {
    if (error instanceof AmbiguousBroadcastError) {
      // NOT failed: the tx may be on the wire. The row stays 'confirmed'
      // (unresendable — only 'quoted' rows confirm), the error says what to
      // verify, and NO ledger row is written: if the tx landed, the read
      // rail imports it by txid; if it didn't, nothing moved.
      db.query("UPDATE payments SET error = ?, updated_at = ? WHERE id = ?")
        .run(error.message, new Date().toISOString(), paymentId);
      return {
        paymentId,
        status: "confirmed",
        txHash: error.externalId,
        error: error.message,
      };
    }
    const message = error instanceof Error ? error.message : "send failed";
    db.query("UPDATE payments SET status = 'failed', error = ?, updated_at = ? WHERE id = ?")
      .run(message, new Date().toISOString(), paymentId);
    // Recorded, surfaced, NOT retried.
    return { paymentId, status: "failed", txHash: null, error: message };
  }

  // The broadcast SUCCEEDED. From here on this payment must never read
  // 'failed' — a bookkeeping problem is a recording problem, not a payment
  // problem, and calling a live payment failed is the double-pay invitation
  // the whole rite exists to refuse. The bookkeeping gets its own try.
  try {
    db.query("UPDATE payments SET status = 'broadcast', tx_hash = ?, updated_at = ? WHERE id = ?")
      .run(receipt.externalId, new Date().toISOString(), paymentId);
    // The ledger records the send immediately (negative = out), using the
    // rail's exact total outflow when it knows one (BTC: amount + fee, so
    // the row equals what the read rail would derive for this txid). The
    // chain remains the source of truth; a read-rail sync of the same tx
    // dedupes on the hash.
    db.query(
      `INSERT OR IGNORE INTO transactions (id, account_id, external_id, title, amount_minor, date, source)
       VALUES (?, ?, ?, ?, ?, ?, 'PAYMENT')`
    ).run(
      newId(),
      account.id,
      receipt.externalId,
      `pay · ${row.asset} → ${String(row.to_addr).slice(0, 12)}…`,
      `-${receipt.totalOutMinor ?? row.amount_minor}`,
      new Date().toISOString()
    );
    return { paymentId, status: "broadcast", txHash: receipt.externalId, error: null };
  } catch (error) {
    const message = error instanceof Error ? error.message : "recording failed";
    const note = `Broadcast succeeded (txid ${receipt.externalId}); recording it locally failed: ${message}. Do NOT re-quote — the payment is live.`;
    try {
      db.query("UPDATE payments SET error = ?, updated_at = ? WHERE id = ?")
        .run(note, new Date().toISOString(), paymentId);
    } catch {
      // Even the error write failed — the onSigned tx_hash is already durable,
      // so the row remains reconcilable on-chain.
    }
    return { paymentId, status: "confirmed", txHash: receipt.externalId, error: note };
  }
};

export const listPayments = (limit = 50) =>
  db
    .query("SELECT id, account_id, rail, to_addr, asset, amount_minor, fee_minor, execution_fee_ceiling_minor, status, tx_hash, error, created_at FROM payments ORDER BY created_at DESC LIMIT ?")
    .all(limit);
