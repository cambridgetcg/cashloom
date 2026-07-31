/** pay() — the universal primitive (PROTOCOL.md §5.3), as a two-step rite:
 *
 *    quote   → fee disclosed, intent recorded, NOTHING signed
 *    confirm → the quoted intent (and only it) is signed + broadcast, once
 *
 *  Quotes expire in 5 minutes. Failed sends are recorded and surfaced,
 *  NEVER auto-retried (inherited doctrine: a payout that failed is an
 *  operator decision, not a loop). Every outcome lands in durable payment
 *  state; only a successful broadcast creates the immediate ledger row.
 */

import { db, newId } from "./db.ts";
import { btcSender } from "./senders/btc.sender.ts";
import { evmSender } from "./senders/evm.sender.ts";
import { sha256BytesId } from "@agenttool/wallet";
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

export interface QuotePaymentOptions {
  accountId: string;
  to: string;
  amountMinor: string;
  asset: string;
}

/** Exact private quote material exposed only to an in-process binding seam. */
export interface PaymentQuoteDraft {
  readonly paymentId: string;
  readonly accountId: string;
  readonly vaultKeyId: string;
  readonly senderType: string;
  readonly to: string;
  readonly asset: string;
  readonly amountMinor: string;
  readonly feeMinor: string;
  readonly executionFeeCeilingMinor: string | null;
  readonly feeAsset: string;
  readonly summary: string;
  readonly detail: string | null;
  readonly unsignedPayload: Uint8Array | null;
  readonly unsignedPayloadHash: `sha256:${string}` | null;
  readonly createdAt: string;
  readonly expiresAt: string;
}

export interface QuotePaymentRuntime {
  /** In-process deterministic/test seam; HTTP callers never receive it. */
  readonly senders?: readonly PaymentSender[];
  readonly now?: () => string;
  /** Runs after the payment INSERT inside the same BEGIN IMMEDIATE transaction.
   * Throwing rolls the payment back. It must not return a Promise. */
  readonly bind?: (draft: Readonly<PaymentQuoteDraft>) => void;
}

const timestampNow = (now: (() => string) | undefined): string => {
  const value = now?.() ?? new Date().toISOString();
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) {
    throw new TypeError("The payment clock must return a valid timestamp.");
  }
  return value;
};

const isThenable = (value: unknown): value is PromiseLike<unknown> =>
  value !== null
  && (typeof value === "object" || typeof value === "function")
  && typeof (value as { then?: unknown }).then === "function";

export const quotePayment = async (
  opts: QuotePaymentOptions,
  runtime: QuotePaymentRuntime = {},
): Promise<QuoteResult> => {
  const account = sendingAccount(opts.accountId);
  const sender = senderForAsset(opts.asset, runtime.senders ?? SENDERS);
  const quote = await sender.quote(
    { vaultKeyId: account.vault_key_id! },
    { to: opts.to, amountMinor: opts.amountMinor, asset: opts.asset }
  );
  const id = newId();
  const createdAt = timestampNow(runtime.now);
  const expiresAt = new Date(
    Date.parse(createdAt) + QUOTE_TTL_MS,
  ).toISOString();
  const unsignedPayload = quote.unsignedPayload === undefined
    ? null
    : Uint8Array.from(quote.unsignedPayload);
  const unsignedPayloadHash = quote.unsignedPayloadHash ?? null;
  if (
    (unsignedPayload === null) !== (unsignedPayloadHash === null)
    || (
      unsignedPayload !== null
      && sha256BytesId(unsignedPayload) !== unsignedPayloadHash
    )
  ) {
    throw new Error("The sender returned inconsistent unsigned quote evidence.");
  }
  const asset = opts.asset.trim().toUpperCase();
  const detail = quote.detail ?? null;
  const executionFeeCeilingMinor = quote.executionFeeCeilingMinor ?? null;
  const draft: Readonly<PaymentQuoteDraft> = Object.freeze({
    paymentId: id,
    accountId: account.id,
    vaultKeyId: account.vault_key_id!,
    senderType: sender.type,
    to: opts.to,
    asset,
    amountMinor: opts.amountMinor,
    feeMinor: quote.feeMinor,
    executionFeeCeilingMinor,
    feeAsset: quote.feeAsset,
    summary: quote.summary,
    detail,
    unsignedPayload: unsignedPayload === null
      ? null
      : Uint8Array.from(unsignedPayload),
    unsignedPayloadHash,
    createdAt,
    expiresAt,
  });
  // quote.detail is the sender's opaque persisted state (e.g. the BTC coin
  // selection) — stored verbatim, handed back verbatim at confirm, never
  // parsed here, never selected by listPayments.
  const persist = db.transaction(() => {
    db.query(
      `INSERT INTO payments
         (id, account_id, rail, to_addr, asset, amount_minor, fee_minor,
          execution_fee_ceiling_minor, status, detail, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'quoted', ?, ?)`,
    ).run(
      id,
      account.id,
      sender.type,
      opts.to,
      asset,
      opts.amountMinor,
      quote.feeMinor,
      executionFeeCeilingMinor,
      detail,
      createdAt,
    );
    const bindResult = runtime.bind?.(draft) as unknown;
    if (isThenable(bindResult)) {
      throw new TypeError("quotePayment bind callback must be synchronous.");
    }
  });
  persist.immediate();
  return {
    paymentId: id,
    feeMinor: quote.feeMinor,
    ...(quote.executionFeeCeilingMinor
      ? { executionFeeCeilingMinor: quote.executionFeeCeilingMinor }
      : {}),
    feeAsset: quote.feeAsset,
    summary: quote.summary,
    expiresAt,
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
  /** Deterministic clock used by the atomic fresh-row claim. */
  now?: () => string;
  /** Required when the payment belongs to the append-only BTC v2 binding
   * table. Exact identifiers prevent a stale or confused review from claiming
   * a different payment. `assertClaim` runs synchronously inside the same
   * BEGIN IMMEDIATE transaction as the fresh read and status CAS. */
  boundClaim?: {
    readonly intentRecordId: string;
    readonly reviewId: string;
    readonly unsignedPayloadHash: `sha256:${string}`;
    readonly assertClaim: (claim: Readonly<BoundPaymentClaim>) => void;
  };
}

export interface BoundPaymentClaim {
  readonly paymentId: string;
  readonly accountId: string;
  readonly intentRecordId: string;
  readonly reviewId: string;
  readonly reservationId: string;
  readonly unsignedPayload: Uint8Array;
  readonly unsignedPayloadHash: `sha256:${string}`;
  readonly quoteExpiresAt: string;
  readonly bindingCreatedAt: string;
  readonly claimedAt: string;
}

interface BtcBindingRow {
  intent_record_id: string;
  payment_id: string;
  account_id: string;
  review_id: string;
  reservation_id: string;
  unsigned_payload: Uint8Array;
  unsigned_payload_hash: `sha256:${string}`;
  quote_expires_at: string;
  created_at: string;
}

const boundBitcoinPayment = (paymentId: string): BtcBindingRow | null =>
  db.query(
    `SELECT intent_record_id, payment_id, account_id, review_id,
            reservation_id, unsigned_payload, unsigned_payload_hash,
            quote_expires_at, created_at
       FROM cashloom_v2_btc_payment_bindings
      WHERE payment_id = ?`,
  ).get(paymentId) as BtcBindingRow | null;

const unavailableMessage = (paymentId: string, status: string): string =>
  `Payment ${paymentId} is "${status}" — only a fresh quote can be confirmed.`;

export const confirmPayment = async (
  paymentId: string,
  runtime: ConfirmPaymentRuntime = {},
): Promise<ConfirmResult> => {
  const initialRow = db.query("SELECT * FROM payments WHERE id = ?").get(paymentId) as
    | Record<string, string | null>
    | null;
  if (!initialRow) throw new Error(`No payment ${paymentId}`);
  if (initialRow.status !== "quoted") {
    throw new Error(unavailableMessage(paymentId, String(initialRow.status)));
  }
  // Fail the generic door closed before callbacks or sender activity. The same
  // check is repeated under the writer lock because a binding can race this
  // initial snapshot.
  if (boundBitcoinPayment(paymentId) !== null && runtime.boundClaim === undefined) {
    throw new Error(
      "This payment is bound to a reviewed CashLoom v2 Bitcoin intent; use the exact bound-confirmation door.",
    );
  }
  if (runtime.afterRead) await runtime.afterRead();

  // Preserve the old fail-before-claim behavior for a missing key or sender.
  // The exact fresh row is resolved a second time inside the writer lock.
  sendingAccount(String(initialRow.account_id));
  senderForAsset(String(initialRow.asset), runtime.senders ?? SENDERS);

  if (runtime.beforeClaim) await runtime.beforeClaim();

  const claimWrite = db.transaction(() => {
    // Take the claim timestamp only after BEGIN IMMEDIATE owns the writer
    // lock. A process must not carry a pre-expiry timestamp while waiting for
    // another process, then claim after a read-only recovery check has already
    // proved the review expired.
    const claimedAt = timestampNow(runtime.now);
    const freshRow = db.query("SELECT * FROM payments WHERE id = ?").get(paymentId) as
      | Record<string, string | null>
      | null;
    if (freshRow === null || freshRow.status !== "quoted") {
      return {
        kind: "unavailable" as const,
        status: freshRow?.status ?? "missing",
      };
    }

    const binding = boundBitcoinPayment(paymentId);
    let expectedPayload: Uint8Array | null = null;
    let expectedPayloadHash: `sha256:${string}` | null = null;
    if (binding !== null) {
      const requested = runtime.boundClaim;
      if (requested === undefined) {
        throw new Error(
          "This payment is bound to a reviewed CashLoom v2 Bitcoin intent; use the exact bound-confirmation door.",
        );
      }
      if (
        requested.intentRecordId !== binding.intent_record_id
        || requested.reviewId !== binding.review_id
        || requested.unsignedPayloadHash !== binding.unsigned_payload_hash
      ) {
        throw new Error(
          "The bound Bitcoin confirmation does not match this intent, review, and unsigned payload.",
        );
      }
      if (
        binding.account_id !== freshRow.account_id
        || !(binding.unsigned_payload instanceof Uint8Array)
        || sha256BytesId(binding.unsigned_payload)
          !== binding.unsigned_payload_hash
      ) {
        throw new Error(
          "The stored Bitcoin execution binding no longer matches its payment or payload hash.",
        );
      }
      expectedPayload = Uint8Array.from(binding.unsigned_payload);
      expectedPayloadHash = binding.unsigned_payload_hash;
    } else if (runtime.boundClaim !== undefined) {
      throw new Error(
        "This payment has no CashLoom v2 Bitcoin binding to claim.",
      );
    }

    const createdAtMs = Date.parse(String(freshRow.created_at));
    const boundExpiryMs = binding === null ? null : Date.parse(binding.quote_expires_at);
    const expired = !Number.isFinite(createdAtMs)
      || Date.parse(claimedAt) - createdAtMs > QUOTE_TTL_MS
      || (
        boundExpiryMs !== null
        && (
          !Number.isFinite(boundExpiryMs)
          || Date.parse(claimedAt) >= boundExpiryMs
        )
      );
    if (expired) {
      const updated = db.query(
        `UPDATE payments
            SET status = 'failed', error = 'quote expired', updated_at = ?
          WHERE id = ? AND status = 'quoted' AND created_at = ?`,
      ).run(claimedAt, paymentId, String(freshRow.created_at));
      if (updated.changes !== 1) {
        const current = db.query("SELECT status FROM payments WHERE id = ?")
          .get(paymentId) as { status: string } | null;
        return {
          kind: "unavailable" as const,
          status: current?.status ?? "missing",
        };
      }
      return { kind: "expired" as const };
    }

    // Only a fresh quote may advance the adapter's linked commitment. The
    // assertion can append its own evidence here; any throw, later sender
    // validation failure, or failed CAS rolls the entire writer transaction
    // back together.
    if (binding !== null) {
      const requested = runtime.boundClaim;
      if (requested === undefined || expectedPayload === null) {
        throw new Error(
          "This payment is bound to a reviewed CashLoom v2 Bitcoin intent; use the exact bound-confirmation door.",
        );
      }
      const claim: Readonly<BoundPaymentClaim> = Object.freeze({
        paymentId,
        accountId: binding.account_id,
        intentRecordId: binding.intent_record_id,
        reviewId: binding.review_id,
        reservationId: binding.reservation_id,
        unsignedPayload: Uint8Array.from(expectedPayload),
        unsignedPayloadHash: binding.unsigned_payload_hash,
        quoteExpiresAt: binding.quote_expires_at,
        bindingCreatedAt: binding.created_at,
        claimedAt,
      });
      const assertionResult = requested.assertClaim(claim) as unknown;
      if (isThenable(assertionResult)) {
        throw new TypeError(
          "Bound payment assertClaim callback must be synchronous.",
        );
      }
    }

    // Resolve from the fresh row before changing state so every local
    // validation failure rolls the transaction back to a usable quote.
    const account = sendingAccount(String(freshRow.account_id));
    const sender = senderForAsset(
      String(freshRow.asset),
      runtime.senders ?? SENDERS,
    );
    const claimed = db.query(
      `UPDATE payments
          SET status = 'confirmed', updated_at = ?
        WHERE id = ? AND status = 'quoted' AND created_at = ?`,
    ).run(claimedAt, paymentId, String(freshRow.created_at));
    if (claimed.changes !== 1) {
      const current = db.query("SELECT status FROM payments WHERE id = ?")
        .get(paymentId) as { status: string } | null;
      return {
        kind: "unavailable" as const,
        status: current?.status ?? "missing",
      };
    }
    return {
      kind: "claimed" as const,
      row: freshRow,
      account,
      sender,
      expectedPayload,
      expectedPayloadHash,
    };
  });
  const claim = claimWrite.immediate();
  if (claim.kind === "unavailable") {
    throw new Error(unavailableMessage(paymentId, String(claim.status)));
  }
  if (claim.kind === "expired") {
    throw new Error("Quote expired — request a fresh one (fees move).");
  }

  const { row, account, sender } = claim;

  let receipt;
  try {
    receipt = await sender.send(
      {
        vaultKeyId: account.vault_key_id!,
        paymentId,
        ...(claim.expectedPayload === null
          ? {}
          : { expectedUnsignedPayload: Uint8Array.from(claim.expectedPayload) }),
        ...(claim.expectedPayloadHash === null
          ? {}
          : { expectedUnsignedPayloadHash: claim.expectedPayloadHash }),
      },
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
