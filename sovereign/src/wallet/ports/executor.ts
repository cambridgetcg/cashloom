import type { PaymentIntentV1, Sha256Digest } from "../domain/intent";
import type { PaymentLifecycleState } from "../domain/lifecycle";
import type { BoundSignRequest } from "../domain/signing";
import type { UnsignedAtomicAmount } from "../domain/money";
import type { ApprovalProof, SignedEnvelope } from "./signer";

export type PreparedExecution =
  | Readonly<{
      kind: "signable";
      execution_id: string;
      intent_hash: Sha256Digest;
      sign_request: BoundSignRequest;
      request_hash: Sha256Digest;
      expires_at: string;
    }>
  | Readonly<{
      kind: "provider-authorized";
      execution_id: string;
      intent_hash: Sha256Digest;
      provider_confirmation_ref: string;
      expires_at: string;
    }>;

export interface SubmitExecutionRequest {
  readonly prepared: PreparedExecution;
  readonly approval: ApprovalProof;
  readonly signed_envelope?: SignedEnvelope;
  readonly idempotency_key: string;
  readonly request_fingerprint: Sha256Digest;
}

export interface Submission {
  readonly execution_id: string;
  readonly intent_hash: Sha256Digest;
  readonly outcome: "accepted" | "pending" | "settled" | "ambiguous";
  readonly rail_reference?: string;
  readonly submitted_at: string;
  /** Ambiguous means reconcile first; it never means safe to retry. */
  readonly safe_to_retry: false;
}

export interface ExecutionStatus {
  readonly execution_id: string;
  readonly intent_hash: Sha256Digest;
  readonly state: PaymentLifecycleState;
  readonly rail_reference?: string;
  readonly observed_at: string;
  readonly confirmations_atomic?: UnsignedAtomicAmount;
}

export interface Executor {
  prepare(
    intent: PaymentIntentV1,
    approval: ApprovalProof,
    signal?: AbortSignal,
  ): Promise<PreparedExecution>;

  submit(
    request: SubmitExecutionRequest,
    signal?: AbortSignal,
  ): Promise<Submission>;

  status(executionId: string, signal?: AbortSignal): Promise<ExecutionStatus>;
}
