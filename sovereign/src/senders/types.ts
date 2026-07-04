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
  /** Integer minor units of the ASSET as a decimal string (USDC: 6dp; ETH: wei). */
  amountMinor: string;
  /** Asset symbol the sender understands ("ETH", "USDC"). */
  asset: string;
}

export interface SenderContext {
  /** Vault key backing the sending account. Senders receive the ID, never
   *  key material — they call the vault for a signature-lifetime reveal. */
  vaultKeyId: string;
}

/** The fee disclosure, produced BEFORE any signature exists. */
export interface PaymentQuote {
  /** Upper-bound network fee, integer minor units of feeAsset, as a string. */
  feeMinor: string;
  /** Asset the fee is paid in (EVM: always the native asset). */
  feeAsset: string;
  /** Human line for the confirm screen — states amount, asset, destination, fee. */
  summary: string;
}

export type SendStatus = "broadcast" | "failed";

export interface PaymentReceipt {
  /** The rail's own stable id (tx hash) — becomes the ledger external_id. */
  externalId: string;
  status: SendStatus;
}

export interface PaymentSender {
  type: string;
  /** Which assets this sender can move. */
  assets: string[];
  /** Fee + sanity BEFORE signing. Throws on invalid destination/amount. */
  quote(ctx: SenderContext, instruction: PaymentInstruction): Promise<PaymentQuote>;
  /** Sign locally, broadcast the signed transaction. One attempt — failed
   *  sends are recorded and surfaced, NEVER auto-retried. */
  send(ctx: SenderContext, instruction: PaymentInstruction): Promise<PaymentReceipt>;
}
