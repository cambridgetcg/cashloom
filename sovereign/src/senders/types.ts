/** The outbound seam — PROTOCOL.md §4/§5.1, kept PARALLEL to the read-only
 *  RailConnector on purpose: a connector that could initiate movement does
 *  not belong behind the read interface, so movement lives here, under
 *  stricter discipline — explicit user intent, destination + amount
 *  validation, fee disclosed BEFORE submit, full audit trail, and the same
 *  never-log-secrets rule as everywhere else.
 */

import type { SigningBinding } from "../vault.ts";

export interface PaymentInstruction {
  /** Rail-specific destination (EVM 0x-address, BTC address, Stripe id). */
  to: string;
  /** Integer minor units of the ASSET as a decimal string (USDC: 6dp; ETH: wei; BTC: sats). */
  amountMinor: string;
  /** Asset symbol the sender understands ("ETH", "USDC", "BTC"). */
  asset: string;
  /** Opaque sender state persisted at quote time (payments.detail) and handed
   *  back VERBATIM at send — how a UTXO rail signs exactly the selection it
   *  disclosed. Rail-specific; pay.ts stores it, never parses it. It MUST
   *  never contain key material, and a sender MUST treat it as UNTRUSTED
   *  input at send — re-validate every invariant before signing. */
  detail?: string | null;
}

export interface SenderContext {
  /** Vault key backing the sending account. Senders receive the ID, never
   *  key material — they submit a typed, authorization-bound request to the
   *  vault and receive only signed wire bytes. */
  vaultKeyId: string;
  /** The payments row being acted on, when one exists — lets a UTXO sender
   *  exclude ITSELF while checking that no other signed payment already
   *  committed the same coins. */
  paymentId?: string;
  /** An immutable, time-bounded authorization binding created by the payment
   * kernel. Senders must pass it into the vault; a vault key cannot be used by
   * this seam without an authorized intent. */
  signingBinding?: SigningBinding;
}

export type PaymentFeeComponentKind =
  | "l2_execution"
  | "l1_data_security"
  | "operator";

/** One exact atomic-unit term in a structured pre-signature fee disclosure. */
export interface PaymentFeeComponent {
  kind: PaymentFeeComponentKind;
  amount_atomic: string;
  classification: "hard_cap" | "estimated_upper_bound";
  method: string;
  /** Decimal block number when a protocol contract supplied the estimate. */
  source_block?: string;
}

/** Additive fee truth for rails whose protocol charge has multiple terms.
 *
 * Base's EIP-1559 execution term is a real transaction-level hard cap, but
 * the L1 data/security and operator values are estimates at a particular
 * chain state. Consequently the sum is useful as a conservative estimate,
 * not a promise that the eventual protocol fee cannot be higher. */
export interface PaymentFeeTerms {
  schema_version: "cashloom.payment-fee-terms/1";
  hard_execution_cap_atomic: string;
  estimated_l1_upper_bound_atomic: string;
  estimated_operator_upper_bound_atomic: string;
  estimated_total_atomic: string;
  total_is_hard_cap: false;
  components: readonly PaymentFeeComponent[];
}

/** The fee disclosure, produced BEFORE any signature exists. */
export interface PaymentQuote {
  /** Compatibility fee amount, integer minor units of feeAsset, as a string.
   * It is the conservative estimated total for Base and exact for BTC. Never
   * infer a hard maximum from this field; inspect feeTerms when present. */
  feeMinor: string;
  /** Asset the fee is paid in (EVM: always the native asset; BTC: BTC). */
  feeAsset: string;
  /** Human line for the confirm screen — states amount, asset, destination, fee. */
  summary: string;
  /** Structured component semantics for multi-term protocol fees. */
  feeTerms?: PaymentFeeTerms;
  /** See PaymentInstruction.detail — returned here, stored by pay.ts. */
  detail?: string;
}

export interface PaymentReservationClaim {
  kind: "UTXO" | "NONCE";
  /** Chain-scoped outpoint or nonce identity. Never a secret. */
  resourceKey: string;
  /** Exact positive amount protected by this resource claim. */
  amountAtomic: string;
}

export type SendStatus = "broadcast" | "failed";

export interface PaymentReceipt {
  /** The rail's own stable id (tx hash) — becomes the ledger external_id. */
  externalId: string;
  status: SendStatus;
  /** The full signed outflow in the SENT asset — amount + fee when the fee
   *  is paid in the same asset (BTC, where the fee is known exactly at
   *  signing). Absent when the fee lives in another asset (EVM gas): the
   *  ledger then records the amount alone and the read rail's later import
   *  of the same hash stays the source of truth. Without this, the txid
   *  dedupe would freeze a fee-less ledger row forever. */
  totalOutMinor?: string;
}

/** Public, already-signed wire bytes. This is deliberately safe to persist:
 * it cannot reveal or recreate a signing key, and exact rebroadcast of the
 * same bytes cannot create a second transaction. */
export interface SignedTransactionEnvelope {
  encoding: "hex";
  /** Canonical 0x-prefixed lower-case bytes, bounded by the kernel before it
   * is accepted into durable recovery state. */
  payload: `0x${string}`;
}

export interface SendHooks {
  /** Called after local signing, BEFORE broadcast, with the rail's stable id
   *  (deterministic pre-broadcast for segwit). pay.ts persists it so a crash
   *  or an unanswered broadcast leaves a row reconcilable against the chain,
   *  never a mystery. */
  onSigned?: (externalId: string, envelope: SignedTransactionEnvelope) => void;
}

/** Thrown when a broadcast's OUTCOME is unknown — transport failure, 5xx,
 *  unreadable answer. The transaction may be relaying: recording a clean
 *  "failed" would invite an immediate second send, which is exactly the
 *  double-pay lever a hostile indexer would pull. pay.ts keeps such payments
 *  in their unresendable 'confirmed' state and tells the human what to check. */
export class AmbiguousBroadcastError extends Error {
  /** The signed transaction's id — already persisted via onSigned. */
  readonly externalId: string | null;
  constructor(message: string, externalId: string | null = null) {
    super(message);
    this.name = "AmbiguousBroadcastError";
    this.externalId = externalId;
  }
}

export interface PaymentSender {
  type: string;
  /** Which assets this sender can move. */
  assets: string[];
  /** Fee + sanity BEFORE signing. Throws on invalid destination/amount. */
  quote(ctx: SenderContext, instruction: PaymentInstruction): Promise<PaymentQuote>;
  /** Deterministic digest of the complete, already-quoted wire request. The
   * payment kernel binds its one-shot authorization to this digest, and the
   * vault independently recomputes it before decrypting a key. */
  signingRequestHash(
    ctx: SenderContext,
    instruction: PaymentInstruction,
  ): Promise<`sha256:${string}`>;
  /** Resources that must be unique while an intent is live. Returned from
   * the persisted quote, so the kernel can claim them transactionally. */
  reservationClaims(
    ctx: SenderContext,
    instruction: PaymentInstruction,
  ): Promise<readonly PaymentReservationClaim[]>;
  /** Sign locally, broadcast the signed transaction. One attempt — failed
   *  sends are recorded and surfaced, NEVER auto-retried. Throws
   *  AmbiguousBroadcastError when the outcome is genuinely unknown. */
  send(
    ctx: SenderContext,
    instruction: PaymentInstruction,
    hooks?: SendHooks
  ): Promise<PaymentReceipt>;
  /** Explicit crash recovery broadcasts the exact previously-signed bytes;
   * it never creates a new signature, nonce, input selection, or tx id. The
   * original prepared instruction is required so the rail can decode the
   * bytes and re-check every authorized wire field before network I/O. */
  resumeBroadcast?(
    ctx: SenderContext,
    instruction: PaymentInstruction,
    envelope: SignedTransactionEnvelope,
    expectedExternalId: string,
  ): Promise<PaymentReceipt>;
}
