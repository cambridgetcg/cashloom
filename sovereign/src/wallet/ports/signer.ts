import type { CustodyMode } from "../domain/custody";
import type { Caip10AccountId } from "../domain/identities";
import type { ActorRef, Sha256Digest } from "../domain/intent";
import type { BoundSignRequest, HexData } from "../domain/signing";

export type SignRequestKind = BoundSignRequest["kind"];

export interface SignerCapabilities {
  readonly signer_id: string;
  readonly custody_mode: CustodyMode;
  readonly account_ids: readonly Caip10AccountId[];
  readonly request_kinds: readonly SignRequestKind[];
  readonly interaction: "none" | "device" | "redirect" | "local-approval";
  /** Wallet Kernel signers never expose an arbitrary byte-signing primitive. */
  readonly arbitrary_data_signing: false;
}

export interface ApprovalProof {
  readonly authorization_id: string;
  readonly intent_hash: Sha256Digest;
  /** Canonical digest returned by hashBoundSignRequest. */
  readonly request_hash: Sha256Digest;
  readonly granted_to: string;
  readonly granted_by: ActorRef;
  readonly granted_at: string;
  readonly expires_at: string;
}

export type SignedEnvelope =
  | Readonly<{
      kind: "evm-transaction";
      request_id: string;
      intent_hash: Sha256Digest;
      serialized_transaction: HexData;
      transaction_hash: HexData;
    }>
  | Readonly<{
      kind: "eip712";
      request_id: string;
      intent_hash: Sha256Digest;
      signature: HexData;
    }>
  | Readonly<{
      kind: "bitcoin-psbt";
      request_id: string;
      intent_hash: Sha256Digest;
      finalized_psbt_base64: string;
      raw_transaction_hex?: string;
      transaction_id?: string;
    }>
  | Readonly<{
      kind: "solana-transaction";
      request_id: string;
      intent_hash: Sha256Digest;
      signed_transaction_base64: string;
      signature: string;
    }>;

export interface Signer {
  capabilities(signal?: AbortSignal): Promise<SignerCapabilities>;
  /**
   * Implementations MUST recompute hashBoundSignRequest(request), compare it
   * with approval.request_hash, compare both intent/authorization ids and
   * expiry, and then decode any PSBT/Solana bytes to verify their explanatory
   * summaries before asking a device or key to sign.
   */
  sign(
    request: BoundSignRequest,
    approval: ApprovalProof,
    signal?: AbortSignal,
  ): Promise<SignedEnvelope>;
}
