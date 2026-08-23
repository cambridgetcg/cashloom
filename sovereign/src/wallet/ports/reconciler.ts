import type { PaymentLifecycleState } from "../domain/lifecycle";
import type { ActivityObservation } from "./observer";
import type { ExecutionStatus } from "./executor";

export interface ReconciliationMatch {
  readonly execution_id: string;
  readonly observation_id: string;
  readonly basis:
    | "exact-rail-reference"
    | "exact-transaction-id"
    | "provider-idempotency-key";
}

export interface ReconciliationTransition {
  readonly execution_id: string;
  readonly from: PaymentLifecycleState;
  readonly to: PaymentLifecycleState;
  readonly evidence_observation_ids: readonly string[];
}

export interface ReconciliationResult {
  readonly outcome: "matched" | "partial" | "unmatched" | "conflict";
  readonly matches: readonly ReconciliationMatch[];
  readonly transitions: readonly ReconciliationTransition[];
  readonly unmatched_execution_ids: readonly string[];
  readonly unmatched_observation_ids: readonly string[];
  readonly reconciled_at: string;
}

/** Pure decision port: persistence applies the returned proposal atomically. */
export interface Reconciler {
  reconcile(
    executions: readonly ExecutionStatus[],
    observations: readonly ActivityObservation[],
    signal?: AbortSignal,
  ): Promise<ReconciliationResult>;
}

