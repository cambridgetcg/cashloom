/** The outbound seam — PROTOCOL.md §4/§5.1, kept PARALLEL to the read-only
 *  RailConnector on purpose: a connector that could initiate movement does
 *  not belong behind the read interface, so movement lives here, under
 *  stricter discipline — explicit user intent, destination + amount
 *  validation, fee disclosed BEFORE submit, full audit trail, and the same
 *  never-log-secrets rule as everywhere else.
 */

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
   *  key material — they call the vault for a signature-lifetime reveal. */
  vaultKeyId: string;
  /** The payments row being acted on, when one exists — lets a UTXO sender
   *  exclude ITSELF while checking that no other signed payment already
   *  committed the same coins. */
  paymentId?: string;
  /** Optional exact quote-time payload binding. Bound execution adapters pass
   *  BOTH fields; a sender must refuse before key access if the payload it
   *  recompiles at confirm differs by even one byte or hashes differently. */
  expectedUnsignedPayload?: Uint8Array;
  expectedUnsignedPayloadHash?: `sha256:${string}`;
}

/** The fee disclosure, produced BEFORE any signature exists. */
export interface PaymentQuote {
  /** Network/provider fee disclosure, integer minor units of feeAsset. Exact
   *  for a persisted BTC selection; an explicitly labelled current estimate
   *  for Base, whose L1 data/operator components have no EIP-1559 hard cap. */
  feeMinor: string;
  /** Transaction-field ceiling when it differs from the total estimate. On
   * Base this is gasLimit × maxFeePerGas (L2 execution only). */
  executionFeeCeilingMinor?: string;
  /** Asset the fee is paid in (EVM: always the native asset; BTC: BTC). */
  feeAsset: string;
  /** Human line for the confirm screen — states amount, asset, destination, fee. */
  summary: string;
  /** See PaymentInstruction.detail — returned here, stored by pay.ts. */
  detail?: string;
  /** Internal exact unsigned rail payload. This is deliberately omitted from
   *  the public QuoteResult; a closed binding adapter may persist it beside
   *  the payment in the same transaction. */
  unsignedPayload?: Uint8Array;
  unsignedPayloadHash?: `sha256:${string}`;
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

export interface SendHooks {
  /** Called after local signing, BEFORE broadcast, with the rail's stable id
   *  (deterministic pre-broadcast for segwit). pay.ts persists it so a crash
   *  or an unanswered broadcast leaves a row reconcilable against the chain,
   *  never a mystery. */
  onSigned?: (externalId: string) => void;
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
  /** Sign locally, broadcast the signed transaction. One attempt — failed
   *  sends are recorded and surfaced, NEVER auto-retried. Throws
   *  AmbiguousBroadcastError when the outcome is genuinely unknown. */
  send(
    ctx: SenderContext,
    instruction: PaymentInstruction,
    hooks?: SendHooks
  ): Promise<PaymentReceipt>;
}
