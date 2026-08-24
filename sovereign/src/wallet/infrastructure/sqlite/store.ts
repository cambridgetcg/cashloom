import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import {
  assertTransition,
  parseInitialPaymentLifecycleState,
  paymentLifecycleStateSchema,
  type PaymentLifecycleState,
} from "../../domain/lifecycle.ts";
import { installWalletKernelSchema } from "./schema.ts";

export type JsonPrimitive = null | boolean | number | string;
export type JsonValue =
  | JsonPrimitive
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

export type Actor = Readonly<{ type: string; ref: string }>;

export class WalletKernelStoreError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export class IdempotencyConflictError extends WalletKernelStoreError {
  constructor(scope: string, key: string) {
    super(
      "IDEMPOTENCY_FINGERPRINT_MISMATCH",
      `Idempotency key ${JSON.stringify(key)} in scope ${JSON.stringify(scope)} was already used for a different request`,
    );
  }
}

export class IntentTransitionConflictError extends WalletKernelStoreError {
  constructor(
    readonly intentId: string,
    readonly expectedState: string,
    readonly expectedVersion: number,
    readonly actualState: string | null,
    readonly actualVersion: number | null,
  ) {
    super(
      "INTENT_COMPARE_AND_SET_FAILED",
      actualState === null
        ? `Payment intent ${intentId} does not exist`
        : `Payment intent ${intentId} is ${actualState}@${actualVersion}; expected ${expectedState}@${expectedVersion}`,
    );
  }
}

export class InsufficientAvailableBalanceError extends WalletKernelStoreError {
  constructor(
    readonly accountId: string,
    readonly assetId: string,
    readonly requestedAtomic: string,
    readonly availableAtomic: string,
  ) {
    super(
      "INSUFFICIENT_AVAILABLE_BALANCE",
      `Cannot reserve ${requestedAtomic} ${assetId}; account ${accountId} has ${availableAtomic} available`,
    );
  }
}

export class ReservationConflictError extends WalletKernelStoreError {
  constructor(message: string) {
    super("RESERVATION_CONFLICT", message);
  }
}

export class AuthorizationConflictError extends WalletKernelStoreError {
  constructor(message: string) {
    super("SIGNING_AUTHORIZATION_CONFLICT", message);
  }
}

export class ExecutionConflictError extends WalletKernelStoreError {
  constructor(message: string) {
    super("EXECUTION_COMPARE_AND_SET_FAILED", message);
  }
}

export class ChainEvidenceConflictError extends WalletKernelStoreError {
  constructor(message: string) {
    super("CHAIN_EVIDENCE_CONFLICT", message);
  }
}

export class BaseReconciliationJobConflictError extends WalletKernelStoreError {
  constructor(message: string) {
    super("BASE_RECONCILIATION_JOB_CONFLICT", message);
  }
}

export class BasePositionSnapshotConflictError extends WalletKernelStoreError {
  constructor(message: string) {
    super("BASE_POSITION_SNAPSHOT_CONFLICT", message);
  }
}

export class BasePositionRefreshAttemptConflictError extends WalletKernelStoreError {
  constructor(message: string) {
    super("BASE_POSITION_REFRESH_ATTEMPT_CONFLICT", message);
  }
}

export class JournalUnbalancedError extends WalletKernelStoreError {
  constructor(readonly differences: Readonly<Record<string, string>>) {
    super(
      "UNBALANCED_JOURNAL_ENTRY",
      `Journal entry is not balanced per asset: ${Object.entries(differences)
        .map(([asset, difference]) => `${asset}=${difference}`)
        .join(", ")}`,
    );
  }
}

const assertUnicodeScalarString = (value: string, path: string): void => {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) {
        throw new TypeError(`Unpaired high surrogate at ${path}`);
      }
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      throw new TypeError(`Unpaired low surrogate at ${path}`);
    }
  }
};

/** RFC 8785/JCS-compatible JSON used for request and journal fingerprints. */
export function canonicalJson(value: unknown): string {
  const active = new Set<object>();
  const visit = (item: unknown, path: string): string => {
    if (item === null) return "null";
    if (typeof item === "boolean") return item ? "true" : "false";
    if (typeof item === "string") {
      assertUnicodeScalarString(item, path);
      return JSON.stringify(item);
    }
    if (typeof item === "number") {
      if (!Number.isFinite(item)) {
        throw new TypeError(`Non-finite number at ${path}`);
      }
      return JSON.stringify(item);
    }
    if (typeof item !== "object") {
      throw new TypeError(`Value at ${path} is not JSON-serializable`);
    }
    if (active.has(item)) throw new TypeError(`Cycle at ${path}`);
    active.add(item);
    try {
      if (Array.isArray(item)) {
        if (Object.getOwnPropertySymbols(item).length > 0) {
          throw new TypeError(`Symbol property at ${path}`);
        }
        const allowed = new Set(["length", ...Array.from({ length: item.length }, (_, index) => String(index))]);
        if (Object.getOwnPropertyNames(item).some((name) => !allowed.has(name))) {
          throw new TypeError(`Non-JSON array property at ${path}`);
        }
        for (let index = 0; index < item.length; index += 1) {
          if (!Object.prototype.hasOwnProperty.call(item, index)) {
            throw new TypeError(`Sparse array entry at ${path}[${index}]`);
          }
          const descriptor = Object.getOwnPropertyDescriptor(item, String(index));
          if (!descriptor || !("value" in descriptor)) {
            throw new TypeError(`Accessor array entry at ${path}[${index}]`);
          }
        }
        return `[${item.map((entry, index) => visit(entry, `${path}[${index}]`)).join(",")}]`;
      }
      const prototype = Object.getPrototypeOf(item);
      if (prototype !== Object.prototype && prototype !== null) {
        throw new TypeError(`Non-plain object at ${path}`);
      }
      if (Object.getOwnPropertySymbols(item).length > 0) {
        throw new TypeError(`Symbol property at ${path}`);
      }
      const names = Object.getOwnPropertyNames(item);
      const enumerableNames = Object.keys(item);
      if (names.length !== enumerableNames.length) {
        throw new TypeError(`Non-enumerable property at ${path}`);
      }
      for (const key of enumerableNames) {
        assertUnicodeScalarString(key, `${path} key`);
        const descriptor = Object.getOwnPropertyDescriptor(item, key);
        if (!descriptor || !("value" in descriptor)) {
          throw new TypeError(`Accessor property at ${path}.${key}`);
        }
      }
      return `{${enumerableNames
        .sort()
        .map((key) => `${JSON.stringify(key)}:${visit((item as Record<string, unknown>)[key], `${path}.${key}`)}`)
        .join(",")}}`;
    } finally {
      active.delete(item);
    }
  };
  return visit(value, "$");
}

export function fingerprintRequest(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}

const assertNonEmpty = (value: string, field: string): void => {
  if (value.trim() === "") throw new TypeError(`${field} must not be empty`);
};

const assertCanonicalInteger = (
  value: string,
  field: string,
  options: { positive?: boolean; unsigned?: boolean } = {},
): void => {
  const pattern = options.unsigned || options.positive ? /^(0|[1-9][0-9]*)$/ : /^(0|-?[1-9][0-9]*)$/;
  if (!pattern.test(value) || (options.positive && value === "0")) {
    const qualifier = options.positive ? "positive " : options.unsigned ? "unsigned " : "";
    throw new TypeError(`${field} must be a canonical ${qualifier}integer string`);
  }
};

const json = (value: unknown): string => canonicalJson(value ?? {});
const defaultNow = (): Date => new Date();
const defaultId = (): string => crypto.randomUUID();

export interface PaymentIntentRecord {
  id: string;
  schemaVersion: string;
  kind: string;
  sourceAccountId: string;
  assetId: string;
  amountAtomic: string;
  destination: JsonValue;
  feeCeilingAtomic: string | null;
  feeAssetId: string | null;
  state: PaymentLifecycleState;
  intentHash: string;
  createdBy: Actor;
  expiresAt: string | null;
  version: number;
  metadata: JsonValue;
  createdAt: string;
  updatedAt: string;
}

export interface IntentEventRecord {
  id: string;
  intentId: string;
  sequence: number;
  eventType: string;
  fromState: string | null;
  toState: string | null;
  actor: Actor;
  reason: string | null;
  data: JsonValue;
  occurredAt: string;
}

export interface ReservationRecord {
  id: string;
  intentId: string;
  accountId: string;
  assetId: string;
  kind: "BALANCE" | "BUDGET" | "UTXO" | "NONCE";
  resourceKey: string | null;
  amountAtomic: string;
  state: "ACTIVE" | "CONSUMED" | "RELEASED" | "EXPIRED";
  expiresAt: string | null;
  version: number;
  createdAt: string;
  updatedAt: string;
  consumedAt: string | null;
  releasedAt: string | null;
}

export type ReservationResolutionOutcome = "DROPPED" | "REPLACED";
export type ReconciliationMatchBasis =
  | "exact-rail-reference"
  | "exact-transaction-id"
  | "provider-idempotency-key";

export interface ReservationResolutionRecord {
  id: string;
  reservationId: string;
  intentId: string;
  executionId: string;
  evidenceReceiptId: string;
  evidenceReceiptHash: string;
  outcome: ReservationResolutionOutcome;
  matchBasis: ReconciliationMatchBasis;
  matchedReference: string;
  verifiedBy: Actor;
  data: JsonValue;
  createdAt: string;
}

export interface SigningAuthorizationRecord {
  id: string;
  intentId: string;
  intentHash: string;
  keyId: string;
  requestHash: string;
  actor: Actor;
  method: string;
  grantHash: string;
  constraints: JsonValue;
  status: "ACTIVE" | "CONSUMED" | "REVOKED" | "EXPIRED";
  expiresAt: string | null;
  consumedAt: string | null;
  revokedAt: string | null;
  createdAt: string;
}

export type PostingDirection = "DEBIT" | "CREDIT";

export interface JournalPostingRecord {
  id: string;
  index: number;
  ledgerAccountId: string;
  assetId: string;
  direction: PostingDirection;
  amountAtomic: string;
  memo: string | null;
}

export interface JournalEntryRecord {
  id: string;
  description: string;
  effectiveAt: string;
  referenceType: string | null;
  referenceId: string | null;
  entryFingerprint: string;
  status: "POSTED";
  metadata: JsonValue;
  createdAt: string;
  postedAt: string;
  postings: JournalPostingRecord[];
}

export interface QuoteRecord {
  id: string;
  intentId: string;
  provider: string;
  quoteHash: string;
  inputAmountAtomic: string;
  outputAssetId: string | null;
  outputAmountAtomic: string | null;
  feeAssetId: string | null;
  feeAtomic: string | null;
  expiresAt: string;
  body: JsonValue;
  createdAt: string;
}

export interface ExecutionRecord {
  id: string;
  intentId: string;
  sequence: number;
  rail: string;
  state: string;
  idempotencyKey: string | null;
  preparedRef: string | null;
  submissionRef: string | null;
  networkTxId: string | null;
  requestHash: string | null;
  signedArtifactId: string | null;
  response: JsonValue | null;
  ambiguous: boolean;
  errorCode: string | null;
  errorMessage: string | null;
  version: number;
  submittedAt: string | null;
  settledAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface SignedArtifactRecord {
  id: string;
  authorizationId: string;
  intentId: string;
  intentHash: string;
  keyId: string;
  requestHash: string;
  encoding: "hex";
  payload: `0x${string}`;
  envelopeHash: `sha256:${string}`;
  externalTxId: string;
  createdAt: string;
}

export interface ReceiptRecord {
  id: string;
  intentId: string;
  executionId: string | null;
  kind: string;
  receiptHash: string;
  body: JsonValue;
  observedAt: string;
  createdAt: string;
}

export type ChainVisibility = "NOT_FOUND" | "MEMPOOL" | "INCLUDED";
export type ChainOutcome = "UNKNOWN" | "SUCCESS" | "REVERTED";
export type ChainSecurityLevel = "UNSAFE" | "SAFE" | "FINALIZED";

export interface ChainSightingRecord {
  id: string;
  intentId: string;
  executionId: string;
  chainId: string;
  networkTxId: string;
  providerId: string;
  evidenceHash: string;
  visibility: ChainVisibility;
  outcome: ChainOutcome;
  securityLevel: ChainSecurityLevel;
  blockHash: string | null;
  blockNumber: string | null;
  body: JsonValue;
  observedAt: string;
  fetchedAt: string;
  createdAt: string;
}

export interface ChainConsensusRecord {
  id: string;
  intentId: string;
  executionId: string;
  chainId: string;
  networkTxId: string;
  evidenceHash: string;
  visibility: ChainVisibility;
  outcome: ChainOutcome;
  securityLevel: ChainSecurityLevel;
  blockHash: string | null;
  blockNumber: string | null;
  providerIds: readonly string[];
  quorum: number;
  body: JsonValue;
  decidedAt: string;
  createdAt: string;
}

export const BASE_CHAIN_ID = "eip155:8453" as const;
export const BASE_ETH_ASSET_ID = "eip155:8453/slip44:60" as const;
export const BASE_USDC_ASSET_ID =
  "eip155:8453/erc20:0x833589fcd6edb6e08f4c7c32d4f71b54bda02913" as const;
export type BasePositionAssetId = typeof BASE_ETH_ASSET_ID | typeof BASE_USDC_ASSET_ID;

export type BaseReconciliationJobState =
  | "READY"
  | "RUNNING"
  | "BACKOFF"
  | "SETTLED"
  | "PAUSED";
export type BaseReconciliationObservation =
  | "pending"
  | "partial"
  | "settled"
  | "conflicted"
  | null;

export interface BaseReconciliationCandidate {
  executionId: string;
  intentId: string;
  signedArtifactId: string;
  externalTxId: string;
  networkTxId: string;
  rail: "evm-base";
  chainId: typeof BASE_CHAIN_ID;
  assetId: BasePositionAssetId;
  executionState: string;
}

export interface BaseReconciliationJob extends BaseReconciliationCandidate {
  id: string;
  state: BaseReconciliationJobState;
  attemptCount: number;
  failureCount: number;
  nextAttemptAt: string;
  leaseOwner: string | null;
  leaseToken: string | null;
  leaseUntil: string | null;
  lastObservation: BaseReconciliationObservation;
  lastErrorCode: string | null;
  version: number;
  createdAt: string;
  updatedAt: string;
  settledAt: string | null;
}

export interface BasePositionSnapshotItem {
  assetId: BasePositionAssetId;
  observedAtomic: string;
}

export interface BasePositionSightingRecord {
  id: string;
  accountId: string;
  chainId: typeof BASE_CHAIN_ID;
  providerId: string;
  providerTrustDomain: `sha256:${string}`;
  evidenceHash: `sha256:${string}`;
  blockNumber: string;
  blockHash: `0x${string}`;
  blockTime: string;
  items: readonly [BasePositionSnapshotItem, BasePositionSnapshotItem];
  body: JsonValue;
  observedAt: string;
  fetchedAt: string;
  createdAt: string;
}

export interface BasePositionSnapshotRecord {
  id: string;
  snapshotHash: `sha256:${string}`;
  accountId: string;
  chainId: typeof BASE_CHAIN_ID;
  blockNumber: string;
  blockHash: `0x${string}`;
  blockTime: string;
  evidenceHash: `sha256:${string}`;
  providerIds: readonly string[];
  sightingIds: readonly string[];
  quorum: number;
  items: readonly [BasePositionSnapshotItem, BasePositionSnapshotItem];
  decidedAt: string;
  createdAt: string;
}

export type BasePositionSnapshotHeadState = "ACTIVE" | "FROZEN";

export interface BasePositionSnapshotHeadRecord {
  accountId: string;
  snapshotId: string;
  blockNumber: string;
  blockHash: `0x${string}`;
  state: BasePositionSnapshotHeadState;
  conflictSnapshotId: string | null;
  version: number;
  updatedAt: string;
}

export type BasePositionRefreshAttemptOutcome =
  | "applied"
  | "replayed"
  | "stale"
  | "superseded"
  | "conflict"
  | "partial"
  | "rejected"
  | "cancelled";

export interface BasePositionRefreshAttemptRetainedHead {
  snapshotId: string;
  state: BasePositionSnapshotHeadState;
  conflictSnapshotId: string | null;
  version: number;
}

export interface BasePositionRefreshAttemptRecord {
  id: string;
  accountId: string;
  attemptedAt: string;
  outcome: BasePositionRefreshAttemptOutcome;
  reasonCode: string;
  providerCount: number;
  availableProviderCount: number;
  agreeingProviderCount: number;
  retainedHead: BasePositionRefreshAttemptRetainedHead | null;
  errorCode: string | null;
  createdAt: string;
}

export type ApplyBasePositionSnapshotOutcome =
  | "applied"
  | "replayed"
  | "stale"
  | "superseded"
  | "conflict";

export interface ApplyBasePositionSnapshotResult {
  outcome: ApplyBasePositionSnapshotOutcome;
  snapshot: BasePositionSnapshotRecord;
  head: BasePositionSnapshotHeadRecord;
}

export interface BasePositionRecord {
  accountId: string;
  assetId: BasePositionAssetId;
  observedAtomic: string;
  pendingAtomic: string;
  source: string;
  sourceCursor: string | null;
  asOf: string;
  version: number;
  updatedAt: string;
  snapshotId: string;
  blockNumber: string;
  blockHash: `0x${string}`;
  headState: BasePositionSnapshotHeadState;
  conflictSnapshotId: string | null;
  headVersion: number;
}

export interface ObservationRecord {
  id: string;
  accountId: string;
  assetId: string | null;
  provider: string;
  externalId: string;
  kind: string;
  amountAtomic: string | null;
  state: string | null;
  occurredAt: string;
  body: JsonValue;
  createdAt: string;
}

export interface ReconciliationLinkRecord {
  id: string;
  observationId: string;
  intentId: string | null;
  executionId: string | null;
  journalEntryId: string | null;
  matchKind: string;
  confidenceBps: number;
  data: JsonValue;
  createdAt: string;
}

type IntentRow = {
  id: string;
  schema_version: string;
  kind: string;
  source_account_id: string;
  asset_id: string;
  amount_atomic: string;
  destination_json: string;
  fee_ceiling_atomic: string | null;
  fee_asset_id: string | null;
  state: string;
  intent_hash: string;
  created_by_type: string;
  created_by_ref: string;
  expires_at: string | null;
  version: number;
  metadata_json: string;
  created_at: string;
  updated_at: string;
};

type ReservationRow = {
  id: string;
  intent_id: string;
  account_id: string;
  asset_id: string;
  kind: ReservationRecord["kind"];
  resource_key: string | null;
  amount_atomic: string;
  state: ReservationRecord["state"];
  expires_at: string | null;
  version: number;
  created_at: string;
  updated_at: string;
  consumed_at: string | null;
  released_at: string | null;
};

type ReservationResolutionRow = {
  id: string;
  reservation_id: string;
  intent_id: string;
  execution_id: string;
  evidence_receipt_id: string;
  evidence_receipt_hash: string;
  outcome: ReservationResolutionOutcome;
  match_basis: ReconciliationMatchBasis;
  matched_reference: string;
  verifier_type: string;
  verifier_ref: string;
  data_json: string;
  created_at: string;
};

type AuthorizationRow = {
  id: string;
  intent_id: string;
  intent_hash: string;
  key_id: string;
  request_hash: string;
  actor_type: string;
  actor_ref: string;
  method: string;
  grant_hash: string;
  constraints_json: string;
  status: SigningAuthorizationRecord["status"];
  expires_at: string | null;
  consumed_at: string | null;
  revoked_at: string | null;
  created_at: string;
};

type QuoteRow = {
  id: string;
  intent_id: string;
  provider: string;
  quote_hash: string;
  input_amount_atomic: string;
  output_asset_id: string | null;
  output_amount_atomic: string | null;
  fee_asset_id: string | null;
  fee_atomic: string | null;
  expires_at: string;
  body_json: string;
  created_at: string;
};

type ExecutionRow = {
  id: string;
  intent_id: string;
  sequence: number;
  rail: string;
  state: string;
  idempotency_key: string | null;
  prepared_ref: string | null;
  submission_ref: string | null;
  network_tx_id: string | null;
  request_hash: string | null;
  signed_artifact_id: string | null;
  response_json: string | null;
  ambiguous: number;
  error_code: string | null;
  error_message: string | null;
  version: number;
  submitted_at: string | null;
  settled_at: string | null;
  created_at: string;
  updated_at: string;
};

type SignedArtifactRow = {
  id: string;
  authorization_id: string;
  intent_id: string;
  intent_hash: string;
  key_id: string;
  request_hash: string;
  encoding: string;
  payload: string;
  envelope_hash: string;
  external_tx_id: string;
  created_at: string;
};

type ReceiptRow = {
  id: string;
  intent_id: string;
  execution_id: string | null;
  kind: string;
  receipt_hash: string;
  body_json: string;
  observed_at: string;
  created_at: string;
};

type ChainSightingRow = {
  id: string;
  intent_id: string;
  execution_id: string;
  chain_id: string;
  network_tx_id: string;
  provider_id: string;
  evidence_hash: string;
  visibility: ChainVisibility;
  outcome: ChainOutcome;
  security_level: ChainSecurityLevel;
  block_hash: string | null;
  block_number: string | null;
  body_json: string;
  observed_at: string;
  fetched_at: string;
  created_at: string;
};

type ChainConsensusRow = {
  id: string;
  intent_id: string;
  execution_id: string;
  chain_id: string;
  network_tx_id: string;
  evidence_hash: string;
  visibility: ChainVisibility;
  outcome: ChainOutcome;
  security_level: ChainSecurityLevel;
  block_hash: string | null;
  block_number: string | null;
  provider_ids_json: string;
  quorum: number;
  body_json: string;
  decided_at: string;
  created_at: string;
};

type BaseReconciliationJobRow = {
  id: string;
  execution_id: string;
  intent_id: string;
  signed_artifact_id: string;
  external_tx_id: string;
  network_tx_id: string;
  rail: BaseReconciliationCandidate["rail"];
  chain_id: typeof BASE_CHAIN_ID;
  asset_id: BasePositionAssetId;
  state: BaseReconciliationJobState;
  execution_state: string;
  attempt_count: number;
  failure_count: number;
  next_attempt_at: string;
  lease_owner: string | null;
  lease_token: string | null;
  lease_until: string | null;
  last_observation_json: string | null;
  last_error_code: string | null;
  version: number;
  created_at: string;
  updated_at: string;
  settled_at: string | null;
};

type BaseReconciliationCandidateRow = {
  execution_id: string;
  intent_id: string;
  signed_artifact_id: string;
  external_tx_id: string;
  network_tx_id: string;
  rail: BaseReconciliationCandidate["rail"];
  chain_id: typeof BASE_CHAIN_ID;
  asset_id: BasePositionAssetId;
  execution_state: string;
};

type BasePositionSightingRow = {
  id: string;
  account_id: string;
  chain_id: typeof BASE_CHAIN_ID;
  provider_id: string;
  provider_trust_domain: `sha256:${string}`;
  evidence_hash: `sha256:${string}`;
  block_number: string;
  block_hash: `0x${string}`;
  block_time: string;
  eth_atomic: string;
  usdc_atomic: string;
  body_json: string;
  observed_at: string;
  fetched_at: string;
  created_at: string;
};

type BasePositionSnapshotRow = {
  id: string;
  snapshot_hash: `sha256:${string}`;
  account_id: string;
  chain_id: typeof BASE_CHAIN_ID;
  block_number: string;
  block_hash: `0x${string}`;
  block_time: string;
  evidence_hash: `sha256:${string}`;
  eth_atomic: string;
  usdc_atomic: string;
  provider_ids_json: string;
  sighting_ids_json: string;
  quorum: number;
  decided_at: string;
  created_at: string;
};

type BasePositionHeadRow = {
  account_id: string;
  snapshot_id: string;
  block_number: string;
  block_hash: `0x${string}`;
  state: BasePositionSnapshotHeadState;
  conflict_snapshot_id: string | null;
  version: number;
  updated_at: string;
};

type BasePositionRefreshAttemptRow = {
  id: string;
  account_id: string;
  attempted_at: string;
  outcome: BasePositionRefreshAttemptOutcome;
  reason_code: string;
  provider_count: number;
  available_provider_count: number;
  agreeing_provider_count: number;
  retained_snapshot_id: string | null;
  retained_head_state: BasePositionSnapshotHeadState | null;
  retained_conflict_snapshot_id: string | null;
  retained_head_version: number | null;
  error_code: string | null;
  created_at: string;
};

type BasePositionRow = {
  account_id: string;
  asset_id: BasePositionAssetId;
  observed_atomic: string;
  pending_atomic: string;
  source: string;
  source_cursor: string | null;
  as_of: string;
  version: number;
  updated_at: string;
  snapshot_id: string;
  block_number: string;
  block_hash: `0x${string}`;
  head_state: BasePositionSnapshotHeadState;
  conflict_snapshot_id: string | null;
  head_version: number;
};

type ObservationRow = {
  id: string;
  account_id: string;
  asset_id: string | null;
  provider: string;
  external_id: string;
  kind: string;
  amount_atomic: string | null;
  state: string | null;
  occurred_at: string;
  body_json: string;
  created_at: string;
};

type ReconciliationLinkRow = {
  id: string;
  observation_id: string;
  intent_id: string | null;
  execution_id: string | null;
  journal_entry_id: string | null;
  match_kind: string;
  confidence_bps: number;
  data_json: string;
  created_at: string;
};

const mapIntent = (row: IntentRow): PaymentIntentRecord => ({
  id: row.id,
  schemaVersion: row.schema_version,
  kind: row.kind,
  sourceAccountId: row.source_account_id,
  assetId: row.asset_id,
  amountAtomic: row.amount_atomic,
  destination: JSON.parse(row.destination_json) as JsonValue,
  feeCeilingAtomic: row.fee_ceiling_atomic,
  feeAssetId: row.fee_asset_id,
  state: paymentLifecycleStateSchema.parse(row.state),
  intentHash: row.intent_hash,
  createdBy: { type: row.created_by_type, ref: row.created_by_ref },
  expiresAt: row.expires_at,
  version: row.version,
  metadata: JSON.parse(row.metadata_json) as JsonValue,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

const mapReservation = (row: ReservationRow): ReservationRecord => ({
  id: row.id,
  intentId: row.intent_id,
  accountId: row.account_id,
  assetId: row.asset_id,
  kind: row.kind,
  resourceKey: row.resource_key,
  amountAtomic: row.amount_atomic,
  state: row.state,
  expiresAt: row.expires_at,
  version: row.version,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  consumedAt: row.consumed_at,
  releasedAt: row.released_at,
});

const mapReservationResolution = (
  row: ReservationResolutionRow,
): ReservationResolutionRecord => ({
  id: row.id,
  reservationId: row.reservation_id,
  intentId: row.intent_id,
  executionId: row.execution_id,
  evidenceReceiptId: row.evidence_receipt_id,
  evidenceReceiptHash: row.evidence_receipt_hash,
  outcome: row.outcome,
  matchBasis: row.match_basis,
  matchedReference: row.matched_reference,
  verifiedBy: { type: row.verifier_type, ref: row.verifier_ref },
  data: JSON.parse(row.data_json) as JsonValue,
  createdAt: row.created_at,
});

const mapAuthorization = (row: AuthorizationRow): SigningAuthorizationRecord => ({
  id: row.id,
  intentId: row.intent_id,
  intentHash: row.intent_hash,
  keyId: row.key_id,
  requestHash: row.request_hash,
  actor: { type: row.actor_type, ref: row.actor_ref },
  method: row.method,
  grantHash: row.grant_hash,
  constraints: JSON.parse(row.constraints_json) as JsonValue,
  status: row.status,
  expiresAt: row.expires_at,
  consumedAt: row.consumed_at,
  revokedAt: row.revoked_at,
  createdAt: row.created_at,
});

const mapQuote = (row: QuoteRow): QuoteRecord => ({
  id: row.id,
  intentId: row.intent_id,
  provider: row.provider,
  quoteHash: row.quote_hash,
  inputAmountAtomic: row.input_amount_atomic,
  outputAssetId: row.output_asset_id,
  outputAmountAtomic: row.output_amount_atomic,
  feeAssetId: row.fee_asset_id,
  feeAtomic: row.fee_atomic,
  expiresAt: row.expires_at,
  body: JSON.parse(row.body_json) as JsonValue,
  createdAt: row.created_at,
});

const signedEnvelopeEvidence = (encoding: string, payload: string): {
  encoding: "hex";
  payload: `0x${string}`;
  envelopeHash: `sha256:${string}`;
  byteLength: number;
} => {
  if (
    encoding !== "hex" ||
    !/^0x[0-9a-f]+$/.test(payload) ||
    payload.length % 2 !== 0
  ) {
    throw new AuthorizationConflictError("Signed artifact is not canonical lower-case hex bytes");
  }
  const byteLength = (payload.length - 2) / 2;
  if (byteLength === 0 || byteLength > 256 * 1024) {
    throw new AuthorizationConflictError("Signed artifact exceeds the 256 KiB execution-evidence bound");
  }
  return {
    encoding: "hex",
    payload: payload as `0x${string}`,
    envelopeHash: `sha256:${fingerprintRequest({ encoding: "hex", payload })}`,
    byteLength,
  };
};

const mapSignedArtifact = (row: SignedArtifactRow): SignedArtifactRecord => {
  const envelope = signedEnvelopeEvidence(row.encoding, row.payload);
  if (row.envelope_hash !== envelope.envelopeHash) {
    throw new AuthorizationConflictError(
      `Signed artifact ${row.id} has an invalid immutable envelope hash`,
    );
  }
  if (row.external_tx_id.trim() === "" || row.external_tx_id.length > 256) {
    throw new AuthorizationConflictError(`Signed artifact ${row.id} has an invalid external transaction id`);
  }
  return {
    id: row.id,
    authorizationId: row.authorization_id,
    intentId: row.intent_id,
    intentHash: row.intent_hash,
    keyId: row.key_id,
    requestHash: row.request_hash,
    encoding: envelope.encoding,
    payload: envelope.payload,
    envelopeHash: envelope.envelopeHash,
    externalTxId: row.external_tx_id,
    createdAt: row.created_at,
  };
};

const mapExecution = (row: ExecutionRow): ExecutionRecord => ({
  id: row.id,
  intentId: row.intent_id,
  sequence: row.sequence,
  rail: row.rail,
  state: row.state,
  idempotencyKey: row.idempotency_key,
  preparedRef: row.prepared_ref,
  submissionRef: row.submission_ref,
  networkTxId: row.network_tx_id,
  requestHash: row.request_hash,
  signedArtifactId: row.signed_artifact_id,
  response: row.response_json === null ? null : (JSON.parse(row.response_json) as JsonValue),
  ambiguous: row.ambiguous === 1,
  errorCode: row.error_code,
  errorMessage: row.error_message,
  version: row.version,
  submittedAt: row.submitted_at,
  settledAt: row.settled_at,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

const mapReceipt = (row: ReceiptRow): ReceiptRecord => ({
  id: row.id,
  intentId: row.intent_id,
  executionId: row.execution_id,
  kind: row.kind,
  receiptHash: row.receipt_hash,
  body: JSON.parse(row.body_json) as JsonValue,
  observedAt: row.observed_at,
  createdAt: row.created_at,
});

const mapChainSighting = (row: ChainSightingRow): ChainSightingRecord => ({
  id: row.id,
  intentId: row.intent_id,
  executionId: row.execution_id,
  chainId: row.chain_id,
  networkTxId: row.network_tx_id,
  providerId: row.provider_id,
  evidenceHash: row.evidence_hash,
  visibility: row.visibility,
  outcome: row.outcome,
  securityLevel: row.security_level,
  blockHash: row.block_hash,
  blockNumber: row.block_number,
  body: JSON.parse(row.body_json) as JsonValue,
  observedAt: row.observed_at,
  fetchedAt: row.fetched_at,
  createdAt: row.created_at,
});

const mapChainConsensus = (row: ChainConsensusRow): ChainConsensusRecord => ({
  id: row.id,
  intentId: row.intent_id,
  executionId: row.execution_id,
  chainId: row.chain_id,
  networkTxId: row.network_tx_id,
  evidenceHash: row.evidence_hash,
  visibility: row.visibility,
  outcome: row.outcome,
  securityLevel: row.security_level,
  blockHash: row.block_hash,
  blockNumber: row.block_number,
  providerIds: JSON.parse(row.provider_ids_json) as string[],
  quorum: row.quorum,
  body: JSON.parse(row.body_json) as JsonValue,
  decidedAt: row.decided_at,
  createdAt: row.created_at,
});

const baseItems = (
  ethAtomic: string,
  usdcAtomic: string,
): readonly [BasePositionSnapshotItem, BasePositionSnapshotItem] => [
  { assetId: BASE_ETH_ASSET_ID, observedAtomic: ethAtomic },
  { assetId: BASE_USDC_ASSET_ID, observedAtomic: usdcAtomic },
];

const mapBaseReconciliationJob = (row: BaseReconciliationJobRow): BaseReconciliationJob => ({
  id: row.id,
  executionId: row.execution_id,
  intentId: row.intent_id,
  signedArtifactId: row.signed_artifact_id,
  externalTxId: row.external_tx_id,
  networkTxId: row.network_tx_id,
  rail: row.rail,
  chainId: row.chain_id,
  assetId: row.asset_id,
  executionState: row.execution_state,
  state: row.state,
  attemptCount: row.attempt_count,
  failureCount: row.failure_count,
  nextAttemptAt: row.next_attempt_at,
  leaseOwner: row.lease_owner,
  leaseToken: row.lease_token,
  leaseUntil: row.lease_until,
  lastObservation: row.last_observation_json === null
    ? null
    : (JSON.parse(row.last_observation_json) as Exclude<BaseReconciliationObservation, null>),
  lastErrorCode: row.last_error_code,
  version: row.version,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  settledAt: row.settled_at,
});

const mapBaseReconciliationCandidate = (
  row: BaseReconciliationCandidateRow,
): BaseReconciliationCandidate => ({
  executionId: row.execution_id,
  intentId: row.intent_id,
  signedArtifactId: row.signed_artifact_id,
  externalTxId: row.external_tx_id,
  networkTxId: row.network_tx_id,
  rail: row.rail,
  chainId: row.chain_id,
  assetId: row.asset_id,
  executionState: row.execution_state,
});

const mapBasePositionSighting = (row: BasePositionSightingRow): BasePositionSightingRecord => ({
  id: row.id,
  accountId: row.account_id,
  chainId: row.chain_id,
  providerId: row.provider_id,
  providerTrustDomain: row.provider_trust_domain,
  evidenceHash: row.evidence_hash,
  blockNumber: row.block_number,
  blockHash: row.block_hash,
  blockTime: row.block_time,
  items: baseItems(row.eth_atomic, row.usdc_atomic),
  body: JSON.parse(row.body_json) as JsonValue,
  observedAt: row.observed_at,
  fetchedAt: row.fetched_at,
  createdAt: row.created_at,
});

const mapBasePositionSnapshot = (row: BasePositionSnapshotRow): BasePositionSnapshotRecord => ({
  id: row.id,
  snapshotHash: row.snapshot_hash,
  accountId: row.account_id,
  chainId: row.chain_id,
  blockNumber: row.block_number,
  blockHash: row.block_hash,
  blockTime: row.block_time,
  evidenceHash: row.evidence_hash,
  providerIds: JSON.parse(row.provider_ids_json) as string[],
  sightingIds: JSON.parse(row.sighting_ids_json) as string[],
  quorum: row.quorum,
  items: baseItems(row.eth_atomic, row.usdc_atomic),
  decidedAt: row.decided_at,
  createdAt: row.created_at,
});

const mapBasePositionHead = (row: BasePositionHeadRow): BasePositionSnapshotHeadRecord => ({
  accountId: row.account_id,
  snapshotId: row.snapshot_id,
  blockNumber: row.block_number,
  blockHash: row.block_hash,
  state: row.state,
  conflictSnapshotId: row.conflict_snapshot_id,
  version: row.version,
  updatedAt: row.updated_at,
});

const mapBasePositionRefreshAttempt = (
  row: BasePositionRefreshAttemptRow,
): BasePositionRefreshAttemptRecord => ({
  id: row.id,
  accountId: row.account_id,
  attemptedAt: row.attempted_at,
  outcome: row.outcome,
  reasonCode: row.reason_code,
  providerCount: row.provider_count,
  availableProviderCount: row.available_provider_count,
  agreeingProviderCount: row.agreeing_provider_count,
  retainedHead: row.retained_snapshot_id === null
    ? null
    : {
        snapshotId: row.retained_snapshot_id,
        state: row.retained_head_state!,
        conflictSnapshotId: row.retained_conflict_snapshot_id,
        version: row.retained_head_version!,
      },
  errorCode: row.error_code,
  createdAt: row.created_at,
});

const mapBasePosition = (row: BasePositionRow): BasePositionRecord => ({
  accountId: row.account_id,
  assetId: row.asset_id,
  observedAtomic: row.observed_atomic,
  pendingAtomic: row.pending_atomic,
  source: row.source,
  sourceCursor: row.source_cursor,
  asOf: row.as_of,
  version: row.version,
  updatedAt: row.updated_at,
  snapshotId: row.snapshot_id,
  blockNumber: row.block_number,
  blockHash: row.block_hash,
  headState: row.head_state,
  conflictSnapshotId: row.conflict_snapshot_id,
  headVersion: row.head_version,
});

const mapObservation = (row: ObservationRow): ObservationRecord => ({
  id: row.id,
  accountId: row.account_id,
  assetId: row.asset_id,
  provider: row.provider,
  externalId: row.external_id,
  kind: row.kind,
  amountAtomic: row.amount_atomic,
  state: row.state,
  occurredAt: row.occurred_at,
  body: JSON.parse(row.body_json) as JsonValue,
  createdAt: row.created_at,
});

const mapReconciliationLink = (row: ReconciliationLinkRow): ReconciliationLinkRecord => ({
  id: row.id,
  observationId: row.observation_id,
  intentId: row.intent_id,
  executionId: row.execution_id,
  journalEntryId: row.journal_entry_id,
  matchKind: row.match_kind,
  confidenceBps: row.confidence_bps,
  data: JSON.parse(row.data_json) as JsonValue,
  createdAt: row.created_at,
});

const CHAIN_VISIBILITIES = new Set<ChainVisibility>(["NOT_FOUND", "MEMPOOL", "INCLUDED"]);
const CHAIN_OUTCOMES = new Set<ChainOutcome>(["UNKNOWN", "SUCCESS", "REVERTED"]);
const CHAIN_SECURITY_LEVELS = new Set<ChainSecurityLevel>(["UNSAFE", "SAFE", "FINALIZED"]);

const CANONICAL_SHA256 = /^sha256:[0-9a-f]{64}$/;
const CANONICAL_BLOCK_HASH = /^0x[0-9a-f]{64}$/;
const MAX_UINT256 = (1n << 256n) - 1n;
const BASE_ASSETS = new Set<BasePositionAssetId>([BASE_ETH_ASSET_ID, BASE_USDC_ASSET_ID]);
const BASE_RECONCILIATION_OBSERVATIONS = new Set<BaseReconciliationObservation>([
  "pending",
  "partial",
  "settled",
  "conflicted",
  null,
]);
const BASE_POSITION_REFRESH_ATTEMPT_OUTCOMES = new Set<BasePositionRefreshAttemptOutcome>([
  "applied",
  "replayed",
  "stale",
  "superseded",
  "conflict",
  "partial",
  "rejected",
  "cancelled",
]);

const assertCanonicalTimestamp = (value: string, field: string): void => {
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) {
    throw new TypeError(`${field} must be an ISO 8601 UTC timestamp with millisecond precision`);
  }
};

const assertCanonicalSha256: (
  value: string,
  field: string,
) => asserts value is `sha256:${string}` = (value, field) => {
  if (!CANONICAL_SHA256.test(value)) {
    throw new TypeError(`${field} must be a canonical lower-case sha256 digest`);
  }
};

const assertCanonicalBlockHash: (
  value: string,
  field: string,
) => asserts value is `0x${string}` = (value, field) => {
  if (!CANONICAL_BLOCK_HASH.test(value)) {
    throw new TypeError(`${field} must be a 32-byte lower-case hexadecimal hash`);
  }
};

const assertStableErrorCode = (value: string | null, field: string): void => {
  if (value !== null && !/^[A-Z0-9_]{1,128}$/.test(value)) {
    throw new TypeError(`${field} must be a stable upper-case error code`);
  }
};

const assertStableLowerCode = (value: string, field: string): void => {
  if (!/^[a-z][a-z0-9_]{0,127}$/.test(value)) {
    throw new TypeError(`${field} must be a stable lower-case code`);
  }
};

const assertBaseReconciliationObservation = (
  value: BaseReconciliationObservation | undefined,
): void => {
  if (value !== undefined && !BASE_RECONCILIATION_OBSERVATIONS.has(value)) {
    throw new TypeError("baseReconciliation.observation is invalid");
  }
};

const assertCanonicalUint256 = (value: string, field: string): void => {
  assertCanonicalInteger(value, field, { unsigned: true });
  if (value.length > 78 || BigInt(value) > MAX_UINT256) {
    throw new TypeError(`${field} exceeds uint256`);
  }
};

const normalizeBasePositionItems = (
  items: readonly BasePositionSnapshotItem[],
): readonly [BasePositionSnapshotItem, BasePositionSnapshotItem] => {
  if (items.length !== 2) {
    throw new TypeError("A Base position snapshot must contain exactly ETH and Circle USDC");
  }
  const byAsset = new Map<BasePositionAssetId, string>();
  for (const item of items) {
    if (!BASE_ASSETS.has(item.assetId)) {
      throw new TypeError(`Unsupported Base position asset ${JSON.stringify(item.assetId)}`);
    }
    if (byAsset.has(item.assetId)) {
      throw new TypeError(`Duplicate Base position asset ${item.assetId}`);
    }
    assertCanonicalUint256(item.observedAtomic, "basePosition.items[].observedAtomic");
    byAsset.set(item.assetId, item.observedAtomic);
  }
  const ethAtomic = byAsset.get(BASE_ETH_ASSET_ID);
  const usdcAtomic = byAsset.get(BASE_USDC_ASSET_ID);
  if (ethAtomic === undefined || usdcAtomic === undefined) {
    throw new TypeError("A Base position snapshot must contain both ETH and native Circle USDC");
  }
  return baseItems(ethAtomic, usdcAtomic);
};

const normalizeAsciiIds = (values: readonly string[], field: string): string[] => {
  if (values.length === 0) throw new TypeError(`${field} must not be empty`);
  for (const value of values) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(value)) {
      throw new TypeError(`${field} contains an invalid stable identifier`);
    }
  }
  const distinct = new Set(values);
  if (distinct.size !== values.length) throw new TypeError(`${field} must be distinct`);
  return [...distinct].sort();
};

const assertChainTruthShape = (input: {
  chainId: string;
  networkTxId: string;
  evidenceHash: string;
  visibility: ChainVisibility;
  outcome: ChainOutcome;
  securityLevel: ChainSecurityLevel;
  blockHash?: string | null;
  blockNumber?: string | null;
}): void => {
  assertNonEmpty(input.chainId, "chainEvidence.chainId");
  assertNonEmpty(input.networkTxId, "chainEvidence.networkTxId");
  assertNonEmpty(input.evidenceHash, "chainEvidence.evidenceHash");
  if (!CHAIN_VISIBILITIES.has(input.visibility)) {
    throw new TypeError("chainEvidence.visibility is invalid");
  }
  if (!CHAIN_OUTCOMES.has(input.outcome)) {
    throw new TypeError("chainEvidence.outcome is invalid");
  }
  if (!CHAIN_SECURITY_LEVELS.has(input.securityLevel)) {
    throw new TypeError("chainEvidence.securityLevel is invalid");
  }
  const blockHash = input.blockHash ?? null;
  const blockNumber = input.blockNumber ?? null;
  if (blockNumber !== null) {
    assertCanonicalInteger(blockNumber, "chainEvidence.blockNumber", { unsigned: true });
  }
  if (input.visibility === "INCLUDED") {
    if (input.outcome === "UNKNOWN" || blockHash === null || blockNumber === null) {
      throw new TypeError("An INCLUDED chain fact requires outcome, blockHash and blockNumber");
    }
    assertNonEmpty(blockHash, "chainEvidence.blockHash");
  } else if (
    input.outcome !== "UNKNOWN" ||
    input.securityLevel !== "UNSAFE" ||
    blockHash !== null ||
    blockNumber !== null
  ) {
    throw new TypeError("NOT_FOUND and MEMPOOL chain facts must be UNKNOWN/UNSAFE and blockless");
  }
};

const normalizeProviderIds = (providerIds: readonly string[]): string[] => {
  if (providerIds.length === 0) {
    throw new TypeError("chainConsensus.providerIds must not be empty");
  }
  for (const providerId of providerIds) {
    assertNonEmpty(providerId, "chainConsensus.providerIds[]");
    // An ASCII identifier keeps JavaScript sorting identical to SQLite's
    // binary collation, making the persisted quorum representation portable.
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(providerId)) {
      throw new TypeError(`Invalid chain consensus provider id ${JSON.stringify(providerId)}`);
    }
  }
  const distinct = new Set(providerIds);
  if (distinct.size !== providerIds.length) {
    throw new TypeError("chainConsensus.providerIds must be distinct");
  }
  return [...distinct].sort();
};

export class WalletKernelStore {
  readonly #now: () => Date;
  readonly #newId: () => string;

  constructor(
    readonly db: Database,
    options: { now?: () => Date; newId?: () => string; install?: boolean } = {},
  ) {
    this.#now = options.now ?? defaultNow;
    this.#newId = options.newId ?? defaultId;
    if (options.install !== false) installWalletKernelSchema(db);
  }

  #timestamp(): string {
    return this.#now().toISOString();
  }

  #outbox(topic: string, aggregateType: string, aggregateId: string, payload: unknown, at: string): void {
    this.db
      .query(
        `INSERT INTO wk_outbox
          (id, topic, aggregate_type, aggregate_id, payload_json, status, available_at, created_at)
         VALUES (?, ?, ?, ?, ?, 'PENDING', ?, ?)`,
      )
      .run(this.#newId(), topic, aggregateType, aggregateId, json(payload), at, at);
  }

  putWallet(input: {
    id: string;
    label: string;
    ownerRef?: string | null;
    policyRef?: string | null;
    status?: "ACTIVE" | "LOCKED" | "ARCHIVED";
    metadata?: JsonValue;
  }): void {
    assertNonEmpty(input.id, "wallet.id");
    assertNonEmpty(input.label, "wallet.label");
    const at = this.#timestamp();
    this.db
      .query(
        `INSERT INTO wk_wallets
          (id, label, owner_ref, policy_ref, status, metadata_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           label=excluded.label, owner_ref=excluded.owner_ref, policy_ref=excluded.policy_ref,
           status=excluded.status, metadata_json=excluded.metadata_json, updated_at=excluded.updated_at`,
      )
      .run(
        input.id,
        input.label,
        input.ownerRef ?? null,
        input.policyRef ?? null,
        input.status ?? "ACTIVE",
        json(input.metadata),
        at,
        at,
      );
  }

  putAsset(input: {
    id: string;
    instrumentId?: string | null;
    kind: string;
    symbol: string;
    name: string;
    decimals: number;
    chainId?: string | null;
    contractAddress?: string | null;
    metadata?: JsonValue;
  }): void {
    if (!Number.isInteger(input.decimals) || input.decimals < 0 || input.decimals > 255) {
      throw new TypeError("asset.decimals must be an integer between 0 and 255");
    }
    for (const [field, value] of [
      ["asset.id", input.id],
      ["asset.kind", input.kind],
      ["asset.symbol", input.symbol],
      ["asset.name", input.name],
    ] as const) assertNonEmpty(value, field);
    const at = this.#timestamp();
    this.db
      .query(
        `INSERT INTO wk_assets
          (id, instrument_id, kind, symbol, name, decimals, chain_id, contract_address,
           metadata_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           instrument_id=excluded.instrument_id, kind=excluded.kind, symbol=excluded.symbol,
           name=excluded.name, decimals=excluded.decimals, chain_id=excluded.chain_id,
           contract_address=excluded.contract_address, metadata_json=excluded.metadata_json,
           updated_at=excluded.updated_at`,
      )
      .run(
        input.id,
        input.instrumentId ?? null,
        input.kind,
        input.symbol,
        input.name,
        input.decimals,
        input.chainId ?? null,
        input.contractAddress ?? null,
        json(input.metadata),
        at,
        at,
      );
  }

  putAccount(input: {
    id: string;
    walletId: string;
    label: string;
    kind: string;
    rail: string;
    chainId?: string | null;
    accountRef?: string | null;
    address?: string | null;
    custodyMode:
      | "watch_only"
      | "external_signer"
      | "local_self_custody"
      | "smart_account"
      | "managed_mpc"
      | "regulated_fiat_provider";
    status?: "ACTIVE" | "LOCKED" | "DISCONNECTED" | "ARCHIVED";
    metadata?: JsonValue;
  }): void {
    const at = this.#timestamp();
    this.db
      .query(
        `INSERT INTO wk_accounts
          (id, wallet_id, label, kind, rail, chain_id, account_ref, address, custody_mode,
           status, metadata_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           label=excluded.label, kind=excluded.kind, rail=excluded.rail,
           chain_id=excluded.chain_id, account_ref=excluded.account_ref, address=excluded.address,
           custody_mode=excluded.custody_mode, status=excluded.status,
           metadata_json=excluded.metadata_json, updated_at=excluded.updated_at`,
      )
      .run(
        input.id,
        input.walletId,
        input.label,
        input.kind,
        input.rail,
        input.chainId ?? null,
        input.accountRef ?? null,
        input.address ?? null,
        input.custodyMode,
        input.status ?? "ACTIVE",
        json(input.metadata),
        at,
        at,
      );
  }

  putLedgerAccount(input: {
    id: string;
    code: string;
    name: string;
    kind: "ASSET" | "LIABILITY" | "EQUITY" | "INCOME" | "EXPENSE" | "CLEARING";
    walletId?: string | null;
    externalAccountId?: string | null;
    status?: "ACTIVE" | "ARCHIVED";
  }): void {
    this.db
      .query(
        `INSERT INTO wk_ledger_accounts
          (id, wallet_id, external_account_id, code, name, kind, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           wallet_id=excluded.wallet_id, external_account_id=excluded.external_account_id,
           code=excluded.code, name=excluded.name, kind=excluded.kind, status=excluded.status`,
      )
      .run(
        input.id,
        input.walletId ?? null,
        input.externalAccountId ?? null,
        input.code,
        input.name,
        input.kind,
        input.status ?? "ACTIVE",
        this.#timestamp(),
      );
  }

  setPosition(input: {
    accountId: string;
    assetId: string;
    observedAtomic: string;
    pendingAtomic?: string;
    source: string;
    sourceCursor?: string | null;
    asOf?: string;
  }): void {
    assertCanonicalInteger(input.observedAtomic, "position.observedAtomic");
    assertCanonicalInteger(input.pendingAtomic ?? "0", "position.pendingAtomic");
    const at = this.#timestamp();
    this.db
      .query(
        `INSERT INTO wk_positions
          (account_id, asset_id, observed_atomic, pending_atomic, source, source_cursor,
           as_of, version, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?)
         ON CONFLICT(account_id, asset_id) DO UPDATE SET
           observed_atomic=excluded.observed_atomic, pending_atomic=excluded.pending_atomic,
           source=excluded.source, source_cursor=excluded.source_cursor, as_of=excluded.as_of,
           version=wk_positions.version + 1, updated_at=excluded.updated_at`,
      )
      .run(
        input.accountId,
        input.assetId,
        input.observedAtomic,
        input.pendingAtomic ?? "0",
        input.source,
        input.sourceCursor ?? null,
        input.asOf ?? at,
        at,
      );
  }

  createPaymentIntent(
    input: {
      id?: string;
      schemaVersion?: string;
      kind: string;
      sourceAccountId: string;
      assetId: string;
      amountAtomic: string;
      destination: JsonValue;
      feeCeilingAtomic?: string | null;
      feeAssetId?: string | null;
      initialState?: string;
      intentHash: string;
      createdBy: Actor;
      expiresAt?: string | null;
      metadata?: JsonValue;
    },
    idempotency?: {
      scope: string;
      key: string;
      requestFingerprint?: string;
      expiresAt?: string | null;
    },
  ): { intent: PaymentIntentRecord; replayed: boolean } {
    for (const [field, value] of [
      ["intent.kind", input.kind],
      ["intent.sourceAccountId", input.sourceAccountId],
      ["intent.assetId", input.assetId],
      ["intent.intentHash", input.intentHash],
      ["intent.createdBy.type", input.createdBy.type],
      ["intent.createdBy.ref", input.createdBy.ref],
    ] as const) assertNonEmpty(value, field);
    assertCanonicalInteger(input.amountAtomic, "intent.amountAtomic", { positive: true });
    if (input.feeCeilingAtomic !== undefined && input.feeCeilingAtomic !== null) {
      assertCanonicalInteger(input.feeCeilingAtomic, "intent.feeCeilingAtomic", { unsigned: true });
    }
    const initialState = parseInitialPaymentLifecycleState(input.initialState ?? "draft");
    const semanticRequest = {
      schemaVersion: input.schemaVersion ?? "cashloom.payment-intent/1",
      kind: input.kind,
      sourceAccountId: input.sourceAccountId,
      assetId: input.assetId,
      amountAtomic: input.amountAtomic,
      destination: input.destination,
      feeCeilingAtomic: input.feeCeilingAtomic ?? null,
      feeAssetId: input.feeAssetId ?? null,
      initialState,
      intentHash: input.intentHash,
      createdBy: input.createdBy,
      expiresAt: input.expiresAt ?? null,
      metadata: input.metadata ?? {},
    };
    const requestFingerprint = idempotency?.requestFingerprint ?? fingerprintRequest(semanticRequest);
    assertNonEmpty(requestFingerprint, "idempotency.requestFingerprint");

    const run = this.db.transaction((): { intent: PaymentIntentRecord; replayed: boolean } => {
      if (idempotency) {
        const existing = this.db
          .query(
            `SELECT request_fingerprint, response_kind, response_id
             FROM wk_idempotency_requests WHERE scope = ? AND idempotency_key = ?`,
          )
          .get(idempotency.scope, idempotency.key) as
          | { request_fingerprint: string; response_kind: string; response_id: string }
          | null;
        if (existing) {
          if (existing.request_fingerprint !== requestFingerprint) {
            throw new IdempotencyConflictError(idempotency.scope, idempotency.key);
          }
          if (existing.response_kind !== "PAYMENT_INTENT") {
            throw new WalletKernelStoreError(
              "IDEMPOTENCY_RESPONSE_KIND_MISMATCH",
              `Idempotency record points to ${existing.response_kind}, not PAYMENT_INTENT`,
            );
          }
          const replay = this.getPaymentIntent(existing.response_id);
          if (!replay) {
            throw new WalletKernelStoreError(
              "IDEMPOTENCY_DANGLING_RESPONSE",
              `Idempotency record points to missing intent ${existing.response_id}`,
            );
          }
          return { intent: replay, replayed: true };
        }
      }

      const id = input.id ?? this.#newId();
      const at = this.#timestamp();
      const state = initialState;
      this.db
        .query(
          `INSERT INTO wk_payment_intents
            (id, schema_version, kind, source_account_id, asset_id, amount_atomic,
             destination_json, fee_ceiling_atomic, fee_asset_id, state, intent_hash,
             created_by_type, created_by_ref, expires_at, version, metadata_json,
             created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)`,
        )
        .run(
          id,
          input.schemaVersion ?? "cashloom.payment-intent/1",
          input.kind,
          input.sourceAccountId,
          input.assetId,
          input.amountAtomic,
          json(input.destination),
          input.feeCeilingAtomic ?? null,
          input.feeAssetId ?? null,
          state,
          input.intentHash,
          input.createdBy.type,
          input.createdBy.ref,
          input.expiresAt ?? null,
          json(input.metadata),
          at,
          at,
        );
      const eventId = this.#newId();
      this.db
        .query(
          `INSERT INTO wk_intent_events
            (id, intent_id, sequence, event_type, from_state, to_state,
             actor_type, actor_ref, data_json, occurred_at)
           VALUES (?, ?, 0, 'intent.created', NULL, ?, ?, ?, '{}', ?)`,
        )
        .run(eventId, id, state, input.createdBy.type, input.createdBy.ref, at);
      this.#outbox("wallet.intent.created", "PAYMENT_INTENT", id, { eventId, intentId: id, state }, at);

      if (idempotency) {
        this.db
          .query(
            `INSERT INTO wk_idempotency_requests
              (scope, idempotency_key, request_fingerprint, response_kind, response_id,
               created_at, expires_at)
             VALUES (?, ?, ?, 'PAYMENT_INTENT', ?, ?, ?)`,
          )
          .run(
            idempotency.scope,
            idempotency.key,
            requestFingerprint,
            id,
            at,
            idempotency.expiresAt ?? null,
          );
      }
      const created = this.getPaymentIntent(id);
      if (!created) throw new Error(`Failed to read newly-created payment intent ${id}`);
      return { intent: created, replayed: false };
    });
    return run.immediate();
  }

  getPaymentIntent(id: string): PaymentIntentRecord | null {
    const row = this.db.query("SELECT * FROM wk_payment_intents WHERE id = ?").get(id) as IntentRow | null;
    return row ? mapIntent(row) : null;
  }

  transitionIntent(input: {
    intentId: string;
    expectedState: string;
    expectedVersion: number;
    toState: string;
    actor: Actor;
    eventType?: string;
    reason?: string | null;
    data?: JsonValue;
    at?: string;
  }): PaymentIntentRecord {
    const from = paymentLifecycleStateSchema.parse(input.expectedState);
    const to = paymentLifecycleStateSchema.parse(input.toState);
    assertTransition(from, to);
    return this.#mutateIntent({ ...input, eventType: input.eventType ?? "intent.state_changed" });
  }

  appendIntentEvent(input: {
    intentId: string;
    expectedState: string;
    expectedVersion: number;
    actor: Actor;
    eventType: string;
    reason?: string | null;
    data?: JsonValue;
    at?: string;
  }): PaymentIntentRecord {
    paymentLifecycleStateSchema.parse(input.expectedState);
    return this.#mutateIntent({ ...input, toState: input.expectedState });
  }

  #mutateIntent(input: {
    intentId: string;
    expectedState: string;
    expectedVersion: number;
    toState: string;
    actor: Actor;
    eventType: string;
    reason?: string | null;
    data?: JsonValue;
    at?: string;
  }): PaymentIntentRecord {
    if (!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 0) {
      throw new TypeError("expectedVersion must be a non-negative safe integer");
    }
    const run = this.db.transaction((): PaymentIntentRecord | IntentTransitionConflictError => {
      const current = this.getPaymentIntent(input.intentId);
      if (
        !current ||
        current.state !== input.expectedState ||
        current.version !== input.expectedVersion
      ) {
        return new IntentTransitionConflictError(
          input.intentId,
          input.expectedState,
          input.expectedVersion,
          current?.state ?? null,
          current?.version ?? null,
        );
      }
      const at = input.at ?? this.#timestamp();
      const result = this.db
        .query(
          `UPDATE wk_payment_intents
           SET state = ?, version = version + 1, updated_at = ?
           WHERE id = ? AND state = ? AND version = ?`,
        )
        .run(input.toState, at, input.intentId, input.expectedState, input.expectedVersion);
      if (result.changes !== 1) {
        const raced = this.getPaymentIntent(input.intentId);
        return new IntentTransitionConflictError(
          input.intentId,
          input.expectedState,
          input.expectedVersion,
          raced?.state ?? null,
          raced?.version ?? null,
        );
      }
      const eventId = this.#newId();
      const nextVersion = input.expectedVersion + 1;
      this.db
        .query(
          `INSERT INTO wk_intent_events
            (id, intent_id, sequence, event_type, from_state, to_state, actor_type,
             actor_ref, reason, data_json, occurred_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          eventId,
          input.intentId,
          nextVersion,
          input.eventType,
          input.expectedState,
          input.toState,
          input.actor.type,
          input.actor.ref,
          input.reason ?? null,
          json(input.data),
          at,
        );
      this.#outbox(
        "wallet.intent.event",
        "PAYMENT_INTENT",
        input.intentId,
        { eventId, intentId: input.intentId, sequence: nextVersion, eventType: input.eventType },
        at,
      );
      const updated = this.getPaymentIntent(input.intentId);
      if (!updated) throw new Error(`Payment intent ${input.intentId} disappeared during transition`);
      return updated;
    });
    const result = run.immediate();
    if (result instanceof IntentTransitionConflictError) throw result;
    return result;
  }

  listIntentEvents(intentId: string): IntentEventRecord[] {
    const rows = this.db
      .query("SELECT * FROM wk_intent_events WHERE intent_id = ? ORDER BY sequence")
      .all(intentId) as Array<{
      id: string;
      intent_id: string;
      sequence: number;
      event_type: string;
      from_state: string | null;
      to_state: string | null;
      actor_type: string;
      actor_ref: string;
      reason: string | null;
      data_json: string;
      occurred_at: string;
    }>;
    return rows.map((row) => ({
      id: row.id,
      intentId: row.intent_id,
      sequence: row.sequence,
      eventType: row.event_type,
      fromState: row.from_state,
      toState: row.to_state,
      actor: { type: row.actor_type, ref: row.actor_ref },
      reason: row.reason,
      data: JSON.parse(row.data_json) as JsonValue,
      occurredAt: row.occurred_at,
    }));
  }

  recordQuote(input: {
    id?: string;
    intentId: string;
    provider: string;
    quoteHash: string;
    inputAmountAtomic: string;
    outputAssetId?: string | null;
    outputAmountAtomic?: string | null;
    feeAssetId?: string | null;
    feeAtomic?: string | null;
    expiresAt: string;
    body: JsonValue;
  }): { quote: QuoteRecord; replayed: boolean } {
    assertCanonicalInteger(input.inputAmountAtomic, "quote.inputAmountAtomic", { positive: true });
    if (input.outputAmountAtomic !== undefined && input.outputAmountAtomic !== null) {
      assertCanonicalInteger(input.outputAmountAtomic, "quote.outputAmountAtomic", { unsigned: true });
    }
    if (input.feeAtomic !== undefined && input.feeAtomic !== null) {
      assertCanonicalInteger(input.feeAtomic, "quote.feeAtomic", { unsigned: true });
      if (!input.feeAssetId) throw new TypeError("quote.feeAssetId is required when feeAtomic is present");
    }
    if (input.outputAmountAtomic !== undefined && input.outputAmountAtomic !== null && !input.outputAssetId) {
      throw new TypeError("quote.outputAssetId is required when outputAmountAtomic is present");
    }
    assertNonEmpty(input.provider, "quote.provider");
    assertNonEmpty(input.quoteHash, "quote.quoteHash");
    const id = input.id ?? this.#newId();
    const run = this.db.transaction((): { quote: QuoteRecord; replayed: boolean } => {
      if (!this.getPaymentIntent(input.intentId)) {
        throw new WalletKernelStoreError("QUOTE_INTENT_NOT_FOUND", `Payment intent ${input.intentId} does not exist`);
      }
      const prior = this.getQuote(id);
      if (prior) {
        const same =
          prior.intentId === input.intentId &&
          prior.provider === input.provider &&
          prior.quoteHash === input.quoteHash &&
          prior.inputAmountAtomic === input.inputAmountAtomic &&
          prior.outputAssetId === (input.outputAssetId ?? null) &&
          prior.outputAmountAtomic === (input.outputAmountAtomic ?? null) &&
          prior.feeAssetId === (input.feeAssetId ?? null) &&
          prior.feeAtomic === (input.feeAtomic ?? null) &&
          prior.expiresAt === input.expiresAt &&
          canonicalJson(prior.body) === canonicalJson(input.body);
        if (!same) {
          throw new WalletKernelStoreError(
            "QUOTE_FINGERPRINT_MISMATCH",
            `Quote id ${id} was already recorded with different content`,
          );
        }
        return { quote: prior, replayed: true };
      }
      const at = this.#timestamp();
      this.db
        .query(
          `INSERT INTO wk_quotes
            (id, intent_id, provider, quote_hash, input_amount_atomic, output_asset_id,
             output_amount_atomic, fee_asset_id, fee_atomic, expires_at, body_json, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          input.intentId,
          input.provider,
          input.quoteHash,
          input.inputAmountAtomic,
          input.outputAssetId ?? null,
          input.outputAmountAtomic ?? null,
          input.feeAssetId ?? null,
          input.feeAtomic ?? null,
          input.expiresAt,
          json(input.body),
          at,
        );
      const quote = this.getQuote(id);
      if (!quote) throw new Error(`Failed to read newly-recorded quote ${id}`);
      this.#outbox(
        "wallet.quote.recorded",
        "QUOTE",
        id,
        { quoteId: id, intentId: input.intentId, quoteHash: input.quoteHash },
        at,
      );
      return { quote, replayed: false };
    });
    return run.immediate();
  }

  getQuote(id: string): QuoteRecord | null {
    const row = this.db.query("SELECT * FROM wk_quotes WHERE id=?").get(id) as QuoteRow | null;
    return row ? mapQuote(row) : null;
  }

  createExecution(input: {
    id?: string;
    intentId: string;
    sequence?: number;
    rail: string;
    state?: string;
    idempotencyKey?: string | null;
    preparedRef?: string | null;
    submissionRef?: string | null;
    networkTxId?: string | null;
    requestHash?: string | null;
    signedArtifactId?: string | null;
    response?: JsonValue | null;
    ambiguous?: boolean;
    submittedAt?: string | null;
  }): { execution: ExecutionRecord; replayed: boolean } {
    assertNonEmpty(input.rail, "execution.rail");
    if (input.sequence !== undefined && (!Number.isSafeInteger(input.sequence) || input.sequence < 0)) {
      throw new TypeError("execution.sequence must be a non-negative safe integer");
    }
    const id = input.id ?? this.#newId();
    const run = this.db.transaction((): { execution: ExecutionRecord; replayed: boolean } => {
      if (!this.getPaymentIntent(input.intentId)) {
        throw new ExecutionConflictError(`Payment intent ${input.intentId} does not exist`);
      }
      const priorById = this.getExecution(id);
      const priorByKey = input.idempotencyKey
        ? (this.db
            .query("SELECT * FROM wk_executions WHERE rail=? AND idempotency_key=?")
            .get(input.rail, input.idempotencyKey) as ExecutionRow | null)
        : null;
      const prior = priorById ?? (priorByKey ? mapExecution(priorByKey) : null);
      if (prior) {
        const sameCreation =
          prior.intentId === input.intentId &&
          prior.rail === input.rail &&
          prior.idempotencyKey === (input.idempotencyKey ?? null) &&
          prior.preparedRef === (input.preparedRef ?? null) &&
          prior.requestHash === (input.requestHash ?? null) &&
          (input.signedArtifactId === undefined || prior.signedArtifactId === input.signedArtifactId) &&
          (input.sequence === undefined || prior.sequence === input.sequence);
        if (!sameCreation || (priorById !== null && priorByKey !== null && priorById.id !== priorByKey.id)) {
          throw new ExecutionConflictError("Execution id or rail idempotency key was reused for another request");
        }
        return { execution: prior, replayed: true };
      }
      const sequence = input.sequence ?? ((this.db
        .query("SELECT COALESCE(MAX(sequence), -1) + 1 AS next FROM wk_executions WHERE intent_id=?")
        .get(input.intentId) as { next: number }).next);
      const at = this.#timestamp();
      this.db
        .query(
          `INSERT INTO wk_executions
            (id, intent_id, sequence, rail, state, idempotency_key, prepared_ref,
             submission_ref, network_tx_id, request_hash, signed_artifact_id,
             response_json, ambiguous,
             version, submitted_at, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)`,
        )
        .run(
          id,
          input.intentId,
          sequence,
          input.rail,
          input.state ?? "prepared",
          input.idempotencyKey ?? null,
          input.preparedRef ?? null,
          input.submissionRef ?? null,
          input.networkTxId ?? null,
          input.requestHash ?? null,
          input.signedArtifactId ?? null,
          input.response === undefined || input.response === null ? null : json(input.response),
          input.ambiguous ? 1 : 0,
          input.submittedAt ?? null,
          at,
          at,
        );
      const execution = this.getExecution(id);
      if (!execution) throw new Error(`Failed to read newly-created execution ${id}`);
      this.#outbox(
        "wallet.execution.created",
        "EXECUTION",
        id,
        { executionId: id, intentId: input.intentId, state: execution.state },
        at,
      );
      return { execution, replayed: false };
    });
    return run.immediate();
  }

  getExecution(id: string): ExecutionRecord | null {
    const row = this.db.query("SELECT * FROM wk_executions WHERE id=?").get(id) as ExecutionRow | null;
    return row ? mapExecution(row) : null;
  }

  transitionExecution(input: {
    id: string;
    expectedState: string;
    expectedVersion: number;
    toState: string;
    submissionRef?: string | null;
    networkTxId?: string | null;
    signedArtifactId?: string | null;
    response?: JsonValue | null;
    ambiguous?: boolean;
    errorCode?: string | null;
    errorMessage?: string | null;
    submittedAt?: string | null;
    settledAt?: string | null;
    at?: string;
  }): ExecutionRecord {
    if (!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 0) {
      throw new TypeError("expectedVersion must be a non-negative safe integer");
    }
    const run = this.db.transaction((): ExecutionRecord | ExecutionConflictError => {
      const current = this.getExecution(input.id);
      if (!current) return new ExecutionConflictError(`Execution ${input.id} does not exist`);
      if (current.state !== input.expectedState || current.version !== input.expectedVersion) {
        return new ExecutionConflictError(
          `Execution ${input.id} is ${current.state}@${current.version}; expected ${input.expectedState}@${input.expectedVersion}`,
        );
      }
      if (current.networkTxId && input.networkTxId !== undefined && input.networkTxId !== current.networkTxId) {
        return new ExecutionConflictError(
          `Execution ${input.id} already has immutable transaction id ${current.networkTxId}`,
        );
      }
      if (
        current.signedArtifactId &&
        input.signedArtifactId !== undefined &&
        input.signedArtifactId !== current.signedArtifactId
      ) {
        return new ExecutionConflictError(
          `Execution ${input.id} already has immutable signed artifact ${current.signedArtifactId}`,
        );
      }
      const nextArtifactId = input.signedArtifactId === undefined
        ? current.signedArtifactId
        : input.signedArtifactId;
      const nextNetworkTxId = input.networkTxId === undefined
        ? current.networkTxId
        : input.networkTxId;
      if (nextArtifactId) {
        const artifact = this.getSignedArtifact(nextArtifactId);
        if (
          !artifact ||
          artifact.authorizationId !== current.preparedRef ||
          artifact.intentId !== current.intentId ||
          artifact.requestHash !== current.requestHash ||
          artifact.externalTxId !== nextNetworkTxId
        ) {
          return new ExecutionConflictError(
            `Execution ${input.id} signed evidence does not match its prepared authorization and request`,
          );
        }
      }
      const at = input.at ?? this.#timestamp();
      const nextResponse = input.response === undefined
        ? current.response
        : input.response;
      const result = this.db
        .query(
          `UPDATE wk_executions SET
             state=?, submission_ref=?, network_tx_id=?, signed_artifact_id=?,
             response_json=?, ambiguous=?,
             error_code=?, error_message=?, submitted_at=?, settled_at=?,
             version=version+1, updated_at=?
           WHERE id=? AND state=? AND version=?`,
        )
        .run(
          input.toState,
          input.submissionRef === undefined ? current.submissionRef : input.submissionRef,
          nextNetworkTxId,
          nextArtifactId,
          nextResponse === null ? null : json(nextResponse),
          input.ambiguous === undefined ? (current.ambiguous ? 1 : 0) : input.ambiguous ? 1 : 0,
          input.errorCode === undefined ? current.errorCode : input.errorCode,
          input.errorMessage === undefined ? current.errorMessage : input.errorMessage,
          input.submittedAt === undefined ? current.submittedAt : input.submittedAt,
          input.settledAt === undefined ? current.settledAt : input.settledAt,
          at,
          input.id,
          input.expectedState,
          input.expectedVersion,
        );
      if (result.changes !== 1) return new ExecutionConflictError(`Execution ${input.id} changed concurrently`);
      const updated = this.getExecution(input.id);
      if (!updated) throw new Error(`Execution ${input.id} disappeared during transition`);
      this.#outbox(
        "wallet.execution.state_changed",
        "EXECUTION",
        input.id,
        { executionId: input.id, fromState: input.expectedState, toState: input.toState },
        at,
      );
      return updated;
    });
    const result = run.immediate();
    if (result instanceof ExecutionConflictError) throw result;
    return result;
  }

  recordReceipt(input: {
    id?: string;
    intentId: string;
    executionId?: string | null;
    kind: string;
    receiptHash: string;
    body: JsonValue;
    observedAt?: string;
  }): { receipt: ReceiptRecord; replayed: boolean } {
    assertNonEmpty(input.kind, "receipt.kind");
    assertNonEmpty(input.receiptHash, "receipt.receiptHash");
    const id = input.id ?? this.#newId();
    const run = this.db.transaction((): { receipt: ReceiptRecord; replayed: boolean } => {
      if (!this.getPaymentIntent(input.intentId)) {
        throw new WalletKernelStoreError("RECEIPT_INTENT_NOT_FOUND", `Payment intent ${input.intentId} does not exist`);
      }
      if (input.executionId) {
        const execution = this.getExecution(input.executionId);
        if (!execution || execution.intentId !== input.intentId) {
          throw new WalletKernelStoreError(
            "RECEIPT_EXECUTION_MISMATCH",
            `Execution ${input.executionId} does not belong to intent ${input.intentId}`,
          );
        }
      }
      const priorById = this.getReceipt(id);
      const priorByHash = this.db.query("SELECT * FROM wk_receipts WHERE receipt_hash=?").get(input.receiptHash) as
        | ReceiptRow
        | null;
      const prior = priorById ?? (priorByHash ? mapReceipt(priorByHash) : null);
      if (prior) {
        const same =
          prior.intentId === input.intentId &&
          prior.executionId === (input.executionId ?? null) &&
          prior.kind === input.kind &&
          prior.receiptHash === input.receiptHash &&
          canonicalJson(prior.body) === canonicalJson(input.body) &&
          (input.observedAt === undefined || prior.observedAt === input.observedAt);
        if (!same || (priorById !== null && priorByHash !== null && priorById.id !== priorByHash.id)) {
          throw new WalletKernelStoreError(
            "RECEIPT_FINGERPRINT_MISMATCH",
            "Receipt id or receipt hash was reused with different evidence",
          );
        }
        return { receipt: prior, replayed: true };
      }
      const at = this.#timestamp();
      this.db
        .query(
          `INSERT INTO wk_receipts
            (id, intent_id, execution_id, kind, receipt_hash, body_json, observed_at, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          input.intentId,
          input.executionId ?? null,
          input.kind,
          input.receiptHash,
          json(input.body),
          input.observedAt ?? at,
          at,
        );
      const receipt = this.getReceipt(id);
      if (!receipt) throw new Error(`Failed to read newly-recorded receipt ${id}`);
      this.#outbox(
        "wallet.receipt.recorded",
        "RECEIPT",
        id,
        { receiptId: id, intentId: input.intentId, receiptHash: input.receiptHash },
        at,
      );
      return { receipt, replayed: false };
    });
    return run.immediate();
  }

  getReceipt(id: string): ReceiptRecord | null {
    const row = this.db.query("SELECT * FROM wk_receipts WHERE id=?").get(id) as ReceiptRow | null;
    return row ? mapReceipt(row) : null;
  }

  listReceiptsForIntent(intentId: string): ReceiptRecord[] {
    assertNonEmpty(intentId, "intentId");
    return (this.db
      .query(
        `SELECT * FROM wk_receipts
         WHERE intent_id=?
         ORDER BY observed_at, created_at, id`,
      )
      .all(intentId) as ReceiptRow[]).map(mapReceipt);
  }

  appendChainSighting(input: {
    id?: string;
    intentId: string;
    executionId: string;
    chainId: string;
    networkTxId: string;
    providerId: string;
    evidenceHash: string;
    visibility: ChainVisibility;
    outcome: ChainOutcome;
    securityLevel: ChainSecurityLevel;
    blockHash?: string | null;
    blockNumber?: string | null;
    body: JsonValue;
    observedAt: string;
    fetchedAt?: string;
  }): { sighting: ChainSightingRecord; replayed: boolean } {
    assertNonEmpty(input.intentId, "chainSighting.intentId");
    assertNonEmpty(input.executionId, "chainSighting.executionId");
    assertNonEmpty(input.providerId, "chainSighting.providerId");
    assertNonEmpty(input.observedAt, "chainSighting.observedAt");
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(input.providerId)) {
      throw new TypeError(`Invalid chain sighting provider id ${JSON.stringify(input.providerId)}`);
    }
    if (input.fetchedAt !== undefined) assertNonEmpty(input.fetchedAt, "chainSighting.fetchedAt");
    assertChainTruthShape(input);
    const id = input.id ?? this.#newId();
    const fetchedAt = input.fetchedAt ?? input.observedAt;
    const run = this.db.transaction((): { sighting: ChainSightingRecord; replayed: boolean } => {
      const execution = this.getExecution(input.executionId);
      if (
        !execution ||
        execution.intentId !== input.intentId ||
        execution.networkTxId !== input.networkTxId
      ) {
        throw new ChainEvidenceConflictError(
          `Chain sighting does not match execution ${input.executionId} and its immutable transaction id`,
        );
      }
      const priorById = this.getChainSighting(id);
      const priorSemanticRow = this.db
        .query(
          `SELECT * FROM wk_chain_sightings
           WHERE intent_id=? AND execution_id=?
             AND chain_id=? AND network_tx_id=? AND provider_id=? AND evidence_hash=?
             AND visibility=? AND outcome=? AND security_level=?
             AND block_hash IS ? AND block_number IS ?
           ORDER BY fetched_at, created_at, id LIMIT 1`,
        )
        .get(
          input.intentId,
          input.executionId,
          input.chainId,
          input.networkTxId,
          input.providerId,
          input.evidenceHash,
          input.visibility,
          input.outcome,
          input.securityLevel,
          input.blockHash ?? null,
          input.blockNumber ?? null,
        ) as ChainSightingRow | null;
      if (
        priorSemanticRow &&
        canonicalJson(mapChainSighting(priorSemanticRow).body) !== canonicalJson(input.body)
      ) {
        throw new ChainEvidenceConflictError(
          "Chain sighting evidence tuple was reused with a different canonical body",
        );
      }
      const priorByFactRow = this.db
        .query(
          `SELECT * FROM wk_chain_sightings
           WHERE intent_id=? AND execution_id=?
             AND chain_id=? AND network_tx_id=? AND provider_id=? AND evidence_hash=?
             AND visibility=? AND outcome=? AND security_level=?
             AND block_hash IS ? AND block_number IS ?
             AND observed_at=? AND fetched_at=?`,
        )
        .get(
          input.intentId,
          input.executionId,
          input.chainId,
          input.networkTxId,
          input.providerId,
          input.evidenceHash,
          input.visibility,
          input.outcome,
          input.securityLevel,
          input.blockHash ?? null,
          input.blockNumber ?? null,
          input.observedAt,
          fetchedAt,
        ) as ChainSightingRow | null;
      const priorByFact = priorByFactRow ? mapChainSighting(priorByFactRow) : null;
      const prior = priorById ?? priorByFact;
      if (prior) {
        const same =
          prior.intentId === input.intentId &&
          prior.executionId === input.executionId &&
          prior.chainId === input.chainId &&
          prior.networkTxId === input.networkTxId &&
          prior.providerId === input.providerId &&
          prior.evidenceHash === input.evidenceHash &&
          prior.visibility === input.visibility &&
          prior.outcome === input.outcome &&
          prior.securityLevel === input.securityLevel &&
          prior.blockHash === (input.blockHash ?? null) &&
          prior.blockNumber === (input.blockNumber ?? null) &&
          prior.observedAt === input.observedAt &&
          prior.fetchedAt === fetchedAt &&
          canonicalJson(prior.body) === canonicalJson(input.body);
        if (!same || (priorById !== null && priorByFact !== null && priorById.id !== priorByFact.id)) {
          throw new ChainEvidenceConflictError(
            "Chain sighting id or evidence hash was reused with different evidence",
          );
        }
        return { sighting: prior, replayed: true };
      }
      const at = this.#timestamp();
      this.db
        .query(
          `INSERT INTO wk_chain_sightings
            (id, intent_id, execution_id, chain_id, network_tx_id, provider_id,
             evidence_hash, visibility, outcome, security_level, block_hash,
             block_number, body_json, observed_at, fetched_at, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          input.intentId,
          input.executionId,
          input.chainId,
          input.networkTxId,
          input.providerId,
          input.evidenceHash,
          input.visibility,
          input.outcome,
          input.securityLevel,
          input.blockHash ?? null,
          input.blockNumber ?? null,
          json(input.body),
          input.observedAt,
          fetchedAt,
          at,
        );
      const sighting = this.getChainSighting(id);
      if (!sighting) throw new Error(`Failed to read newly-recorded chain sighting ${id}`);
      this.#outbox(
        "wallet.chain_sighting.recorded",
        "CHAIN_SIGHTING",
        id,
        {
          sightingId: id,
          intentId: input.intentId,
          executionId: input.executionId,
          evidenceHash: input.evidenceHash,
        },
        at,
      );
      return { sighting, replayed: false };
    });
    return run.immediate();
  }

  getChainSighting(id: string): ChainSightingRecord | null {
    const row = this.db.query("SELECT * FROM wk_chain_sightings WHERE id=?").get(id) as
      | ChainSightingRow
      | null;
    return row ? mapChainSighting(row) : null;
  }

  listChainSightings(
    filter: {
      intentId?: string;
      executionId?: string;
      chainId?: string;
      networkTxId?: string;
      providerId?: string;
      securityLevel?: ChainSecurityLevel;
    } = {},
  ): ChainSightingRecord[] {
    const clauses: string[] = [];
    const values: string[] = [];
    for (const [column, value] of [
      ["intent_id", filter.intentId],
      ["execution_id", filter.executionId],
      ["chain_id", filter.chainId],
      ["network_tx_id", filter.networkTxId],
      ["provider_id", filter.providerId],
      ["security_level", filter.securityLevel],
    ] as const) {
      if (value !== undefined) {
        assertNonEmpty(value, `chainSightings.${column}`);
        clauses.push(`${column}=?`);
        values.push(value);
      }
    }
    const where = clauses.length === 0 ? "" : `WHERE ${clauses.join(" AND ")}`;
    return (this.db
      .query(
        `SELECT * FROM wk_chain_sightings ${where}
         ORDER BY fetched_at, created_at, id`,
      )
      .all(...values) as ChainSightingRow[]).map(mapChainSighting);
  }

  appendChainConsensus(input: {
    id?: string;
    intentId: string;
    executionId: string;
    chainId: string;
    networkTxId: string;
    evidenceHash: string;
    visibility: ChainVisibility;
    outcome: ChainOutcome;
    securityLevel: ChainSecurityLevel;
    blockHash?: string | null;
    blockNumber?: string | null;
    providerIds: readonly string[];
    quorum: number;
    body: JsonValue;
    decidedAt: string;
  }): { consensus: ChainConsensusRecord; replayed: boolean } {
    assertNonEmpty(input.intentId, "chainConsensus.intentId");
    assertNonEmpty(input.executionId, "chainConsensus.executionId");
    assertNonEmpty(input.decidedAt, "chainConsensus.decidedAt");
    assertChainTruthShape(input);
    const providerIds = normalizeProviderIds(input.providerIds);
    if (!Number.isSafeInteger(input.quorum) || input.quorum < 1 || input.quorum > providerIds.length) {
      throw new TypeError("chainConsensus.quorum must be positive and no greater than provider count");
    }
    const id = input.id ?? this.#newId();
    const run = this.db.transaction((): { consensus: ChainConsensusRecord; replayed: boolean } => {
      const execution = this.getExecution(input.executionId);
      if (
        !execution ||
        execution.intentId !== input.intentId ||
        execution.networkTxId !== input.networkTxId
      ) {
        throw new ChainEvidenceConflictError(
          `Chain consensus does not match execution ${input.executionId} and its immutable transaction id`,
        );
      }
      const priorById = this.getChainConsensus(id);
      const priorByFactRow = this.db
        .query(
          `SELECT * FROM wk_chain_consensus
           WHERE intent_id=? AND execution_id=?
             AND chain_id=? AND network_tx_id=? AND evidence_hash=?
             AND visibility=? AND outcome=? AND security_level=?
             AND block_hash IS ? AND block_number IS ?`,
        )
        .get(
          input.intentId,
          input.executionId,
          input.chainId,
          input.networkTxId,
          input.evidenceHash,
          input.visibility,
          input.outcome,
          input.securityLevel,
          input.blockHash ?? null,
          input.blockNumber ?? null,
        ) as ChainConsensusRow | null;
      const priorByFact = priorByFactRow ? mapChainConsensus(priorByFactRow) : null;
      const prior = priorById ?? priorByFact;
      if (prior) {
        const same =
          prior.intentId === input.intentId &&
          prior.executionId === input.executionId &&
          prior.chainId === input.chainId &&
          prior.networkTxId === input.networkTxId &&
          prior.evidenceHash === input.evidenceHash &&
          prior.visibility === input.visibility &&
          prior.outcome === input.outcome &&
          prior.securityLevel === input.securityLevel &&
          prior.blockHash === (input.blockHash ?? null) &&
          prior.blockNumber === (input.blockNumber ?? null) &&
          canonicalJson(prior.providerIds) === canonicalJson(providerIds) &&
          prior.quorum === input.quorum &&
          canonicalJson(prior.body) === canonicalJson(input.body);
        if (!same || (priorById !== null && priorByFact !== null && priorById.id !== priorByFact.id)) {
          throw new ChainEvidenceConflictError(
            "Chain consensus id or evidence hash was reused with different evidence",
          );
        }
        return { consensus: prior, replayed: true };
      }
      for (const providerId of providerIds) {
        const matching = this.db.query(
          `SELECT id FROM wk_chain_sightings
           WHERE intent_id=? AND execution_id=? AND chain_id=? AND network_tx_id=?
             AND provider_id=? AND evidence_hash=?
             AND visibility=? AND outcome=? AND security_level=?
             AND block_hash IS ? AND block_number IS ?
           LIMIT 1`,
        ).get(
          input.intentId,
          input.executionId,
          input.chainId,
          input.networkTxId,
          providerId,
          input.evidenceHash,
          input.visibility,
          input.outcome,
          input.securityLevel,
          input.blockHash ?? null,
          input.blockNumber ?? null,
        );
        if (!matching) {
          throw new ChainEvidenceConflictError(
            `Consensus provider ${providerId} has no matching durable chain sighting`,
          );
        }
      }
      const at = this.#timestamp();
      this.db
        .query(
          `INSERT INTO wk_chain_consensus
            (id, intent_id, execution_id, chain_id, network_tx_id, evidence_hash,
             visibility, outcome, security_level, block_hash, block_number,
             provider_ids_json, quorum, body_json, decided_at, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          input.intentId,
          input.executionId,
          input.chainId,
          input.networkTxId,
          input.evidenceHash,
          input.visibility,
          input.outcome,
          input.securityLevel,
          input.blockHash ?? null,
          input.blockNumber ?? null,
          json(providerIds),
          input.quorum,
          json(input.body),
          input.decidedAt,
          at,
        );
      const consensus = this.getChainConsensus(id);
      if (!consensus) throw new Error(`Failed to read newly-recorded chain consensus ${id}`);
      this.#outbox(
        "wallet.chain_consensus.recorded",
        "CHAIN_CONSENSUS",
        id,
        {
          consensusId: id,
          intentId: input.intentId,
          executionId: input.executionId,
          evidenceHash: input.evidenceHash,
        },
        at,
      );
      return { consensus, replayed: false };
    });
    return run.immediate();
  }

  getChainConsensus(id: string): ChainConsensusRecord | null {
    const row = this.db.query("SELECT * FROM wk_chain_consensus WHERE id=?").get(id) as
      | ChainConsensusRow
      | null;
    return row ? mapChainConsensus(row) : null;
  }

  listChainConsensus(
    filter: {
      intentId?: string;
      executionId?: string;
      chainId?: string;
      networkTxId?: string;
      securityLevel?: ChainSecurityLevel;
    } = {},
  ): ChainConsensusRecord[] {
    const clauses: string[] = [];
    const values: string[] = [];
    for (const [column, value] of [
      ["intent_id", filter.intentId],
      ["execution_id", filter.executionId],
      ["chain_id", filter.chainId],
      ["network_tx_id", filter.networkTxId],
      ["security_level", filter.securityLevel],
    ] as const) {
      if (value !== undefined) {
        assertNonEmpty(value, `chainConsensus.${column}`);
        clauses.push(`${column}=?`);
        values.push(value);
      }
    }
    const where = clauses.length === 0 ? "" : `WHERE ${clauses.join(" AND ")}`;
    return (this.db
      .query(
        `SELECT * FROM wk_chain_consensus ${where}
         ORDER BY decided_at, created_at, id`,
      )
      .all(...values) as ChainConsensusRow[]).map(mapChainConsensus);
  }

  #eligibleBaseReconciliation(executionId: string): BaseReconciliationCandidate | null {
    const row = this.db.query(
      `SELECT
         execution.id AS execution_id,
         execution.intent_id,
         execution.signed_artifact_id,
         artifact.external_tx_id,
         execution.network_tx_id,
         execution.rail,
         account.chain_id,
         intent.asset_id,
         execution.state AS execution_state
       FROM wk_executions execution
       JOIN wk_signed_artifacts artifact
         ON artifact.id=execution.signed_artifact_id
       JOIN wk_payment_intents intent ON intent.id=execution.intent_id
       JOIN wk_accounts account ON account.id=intent.source_account_id
       WHERE execution.id=?
         AND execution.state IN ('signed','submitted','ambiguous','failed')
         AND execution.rail='evm-base'
         AND account.chain_id='eip155:8453'
         AND intent.asset_id IN (
           'eip155:8453/slip44:60',
           'eip155:8453/erc20:0x833589fcd6edb6e08f4c7c32d4f71b54bda02913'
         )
         AND execution.network_tx_id IS NOT NULL
         AND artifact.intent_id=execution.intent_id
         AND artifact.external_tx_id=execution.network_tx_id
         AND length(execution.network_tx_id)=66
         AND substr(execution.network_tx_id,1,2)='0x'
         AND execution.network_tx_id=lower(execution.network_tx_id)
         AND substr(execution.network_tx_id,3) NOT GLOB '*[^0-9a-f]*'
         AND NOT EXISTS (
           SELECT 1 FROM wk_chain_consensus consensus
           WHERE consensus.execution_id=execution.id
             AND consensus.intent_id=execution.intent_id
             AND consensus.chain_id='eip155:8453'
             AND consensus.network_tx_id=execution.network_tx_id
             AND consensus.security_level='FINALIZED'
         )`,
    ).get(executionId) as BaseReconciliationCandidateRow | null;
    return row ? mapBaseReconciliationCandidate(row) : null;
  }

  discoverEligibleBaseReconciliations(
    input: { limit?: number } = {},
  ): BaseReconciliationCandidate[] {
    const limit = input.limit ?? 32;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 256) {
      throw new TypeError("baseReconciliation.limit must be an integer between 1 and 256");
    }
    return (this.db.query(
      `SELECT
         execution.id AS execution_id,
         execution.intent_id,
         execution.signed_artifact_id,
         artifact.external_tx_id,
         execution.network_tx_id,
         execution.rail,
         account.chain_id,
         intent.asset_id,
         execution.state AS execution_state
       FROM wk_executions execution
       JOIN wk_signed_artifacts artifact
         ON artifact.id=execution.signed_artifact_id
       JOIN wk_payment_intents intent ON intent.id=execution.intent_id
       JOIN wk_accounts account ON account.id=intent.source_account_id
       WHERE execution.state IN ('signed','submitted','ambiguous','failed')
         AND execution.rail='evm-base'
         AND account.chain_id='eip155:8453'
         AND intent.asset_id IN (
           'eip155:8453/slip44:60',
           'eip155:8453/erc20:0x833589fcd6edb6e08f4c7c32d4f71b54bda02913'
         )
         AND execution.network_tx_id IS NOT NULL
         AND artifact.intent_id=execution.intent_id
         AND artifact.external_tx_id=execution.network_tx_id
         AND length(execution.network_tx_id)=66
         AND substr(execution.network_tx_id,1,2)='0x'
         AND execution.network_tx_id=lower(execution.network_tx_id)
         AND substr(execution.network_tx_id,3) NOT GLOB '*[^0-9a-f]*'
         AND NOT EXISTS (
           SELECT 1 FROM wk_chain_consensus consensus
           WHERE consensus.execution_id=execution.id
             AND consensus.intent_id=execution.intent_id
             AND consensus.chain_id='eip155:8453'
             AND consensus.network_tx_id=execution.network_tx_id
             AND consensus.security_level='FINALIZED'
         )
       ORDER BY execution.updated_at, execution.id
       LIMIT ?`,
    ).all(limit) as BaseReconciliationCandidateRow[]).map(mapBaseReconciliationCandidate);
  }

  enqueueBaseReconciliationJobs(
    candidates: readonly BaseReconciliationCandidate[],
    options: { now?: string } = {},
  ): BaseReconciliationJob[] {
    if (candidates.length > 256) {
      throw new TypeError("At most 256 Base reconciliation candidates may be enqueued at once");
    }
    const at = options.now ?? this.#timestamp();
    assertCanonicalTimestamp(at, "baseReconciliation.now");
    const run = this.db.transaction((): BaseReconciliationJob[] => {
      const jobs: BaseReconciliationJob[] = [];
      const seen = new Set<string>();
      for (const supplied of candidates) {
        assertNonEmpty(supplied.executionId, "baseReconciliation.executionId");
        if (seen.has(supplied.executionId)) continue;
        seen.add(supplied.executionId);
        const eligible = this.#eligibleBaseReconciliation(supplied.executionId);
        if (!eligible) {
          throw new BaseReconciliationJobConflictError(
            `Execution ${supplied.executionId} is not eligible for Base reconciliation`,
          );
        }
        for (const field of [
          "intentId",
          "signedArtifactId",
          "externalTxId",
          "networkTxId",
          "rail",
          "chainId",
          "assetId",
        ] as const) {
          if (supplied[field] !== eligible[field]) {
            throw new BaseReconciliationJobConflictError(
              `Execution ${supplied.executionId} changed its ${field} binding before enqueue`,
            );
          }
        }
        const prior = this.getBaseReconciliationJobByExecution(eligible.executionId);
        if (prior) {
          jobs.push(prior);
          continue;
        }
        const id = `base-reconciliation:${fingerprintRequest({
          schema: "cashloom.base-reconciliation-job/1",
          executionId: eligible.executionId,
        })}`;
        this.db.query(
          `INSERT INTO wk_base_reconciliation_jobs
            (id, execution_id, intent_id, signed_artifact_id, external_tx_id,
             network_tx_id, rail, chain_id, asset_id, state, attempt_count,
             failure_count, next_attempt_at, version, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'READY', 0, 0, ?, 0, ?, ?)`,
        ).run(
          id,
          eligible.executionId,
          eligible.intentId,
          eligible.signedArtifactId,
          eligible.externalTxId,
          eligible.networkTxId,
          eligible.rail,
          eligible.chainId,
          eligible.assetId,
          at,
          at,
          at,
        );
        const job = this.getBaseReconciliationJob(id);
        if (!job) throw new Error(`Failed to read newly-enqueued Base reconciliation job ${id}`);
        jobs.push(job);
      }
      return jobs;
    });
    return run.immediate();
  }

  getBaseReconciliationJob(id: string): BaseReconciliationJob | null {
    assertNonEmpty(id, "baseReconciliation.jobId");
    const row = this.db.query(
      `SELECT job.*, execution.state AS execution_state
       FROM wk_base_reconciliation_jobs job
       JOIN wk_executions execution ON execution.id=job.execution_id
       WHERE job.id=?`,
    ).get(id) as BaseReconciliationJobRow | null;
    return row ? mapBaseReconciliationJob(row) : null;
  }

  getBaseReconciliationJobByExecution(executionId: string): BaseReconciliationJob | null {
    assertNonEmpty(executionId, "baseReconciliation.executionId");
    const row = this.db.query(
      `SELECT job.*, execution.state AS execution_state
       FROM wk_base_reconciliation_jobs job
       JOIN wk_executions execution ON execution.id=job.execution_id
       WHERE job.execution_id=?`,
    ).get(executionId) as BaseReconciliationJobRow | null;
    return row ? mapBaseReconciliationJob(row) : null;
  }

  listBaseReconciliationJobs(
    filter: {
      state?: BaseReconciliationJobState;
      intentId?: string;
      executionId?: string;
      limit?: number;
    } = {},
  ): BaseReconciliationJob[] {
    const limit = filter.limit ?? 100;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 512) {
      throw new TypeError("baseReconciliation.limit must be an integer between 1 and 512");
    }
    const clauses: string[] = [];
    const values: Array<string | number> = [];
    for (const [column, value] of [
      ["job.state", filter.state],
      ["job.intent_id", filter.intentId],
      ["job.execution_id", filter.executionId],
    ] as const) {
      if (value !== undefined) {
        assertNonEmpty(value, `baseReconciliation.${column}`);
        clauses.push(`${column}=?`);
        values.push(value);
      }
    }
    const where = clauses.length === 0 ? "" : `WHERE ${clauses.join(" AND ")}`;
    values.push(limit);
    return (this.db.query(
      `SELECT job.*, execution.state AS execution_state
       FROM wk_base_reconciliation_jobs job
       JOIN wk_executions execution ON execution.id=job.execution_id
       ${where}
       ORDER BY job.created_at, job.id
       LIMIT ?`,
    ).all(...values) as BaseReconciliationJobRow[]).map(mapBaseReconciliationJob);
  }

  claimDueBaseReconciliationJobs(input: {
    limit: number;
    leaseOwner: string;
    leaseUntil: string;
    now?: string;
  }): BaseReconciliationJob[] {
    if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 64) {
      throw new TypeError("baseReconciliation.limit must be an integer between 1 and 64");
    }
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(input.leaseOwner)) {
      throw new TypeError("baseReconciliation.leaseOwner is invalid");
    }
    const at = input.now ?? this.#timestamp();
    assertCanonicalTimestamp(at, "baseReconciliation.now");
    assertCanonicalTimestamp(input.leaseUntil, "baseReconciliation.leaseUntil");
    if (input.leaseUntil <= at) {
      throw new TypeError("baseReconciliation.leaseUntil must be after now");
    }
    const run = this.db.transaction((): BaseReconciliationJob[] => {
      const rows = this.db.query(
        `SELECT job.id, job.version
         FROM wk_base_reconciliation_jobs job
         JOIN wk_executions execution ON execution.id=job.execution_id
         JOIN wk_signed_artifacts artifact ON artifact.id=job.signed_artifact_id
         JOIN wk_payment_intents intent ON intent.id=job.intent_id
         JOIN wk_accounts account ON account.id=intent.source_account_id
         WHERE job.state IN ('READY','BACKOFF')
           AND job.next_attempt_at <= ?
           AND execution.intent_id=job.intent_id
           AND execution.signed_artifact_id=job.signed_artifact_id
           AND execution.network_tx_id=job.network_tx_id
           AND execution.rail=job.rail
           AND execution.rail='evm-base'
           AND artifact.intent_id=job.intent_id
           AND artifact.external_tx_id=job.external_tx_id
           AND artifact.external_tx_id=execution.network_tx_id
           AND intent.asset_id=job.asset_id
           AND intent.asset_id IN (
             'eip155:8453/slip44:60',
             'eip155:8453/erc20:0x833589fcd6edb6e08f4c7c32d4f71b54bda02913'
           )
           AND account.chain_id=job.chain_id
           AND account.chain_id='eip155:8453'
         ORDER BY job.next_attempt_at, job.created_at, job.id
         LIMIT ?`,
      ).all(at, input.limit) as Array<{ id: string; version: number }>;
      const claimed: BaseReconciliationJob[] = [];
      for (const row of rows) {
        const leaseToken = this.#newId();
        assertNonEmpty(leaseToken, "baseReconciliation.leaseToken");
        const result = this.db.query(
          `UPDATE wk_base_reconciliation_jobs
           SET state='RUNNING', attempt_count=attempt_count+1,
               lease_owner=?, lease_token=?, lease_until=?,
               version=version+1, updated_at=?
           WHERE id=? AND version=? AND state IN ('READY','BACKOFF')
             AND next_attempt_at <= ?`,
        ).run(
          input.leaseOwner,
          leaseToken,
          input.leaseUntil,
          at,
          row.id,
          row.version,
          at,
        );
        if (result.changes !== 1) continue;
        const job = this.getBaseReconciliationJob(row.id);
        if (!job) throw new Error(`Claimed Base reconciliation job ${row.id} disappeared`);
        claimed.push(job);
      }
      return claimed;
    });
    return run.immediate();
  }

  #requireBaseReconciliationLease(
    jobId: string,
    leaseToken: string,
    at: string,
  ): BaseReconciliationJob {
    assertNonEmpty(jobId, "baseReconciliation.jobId");
    assertNonEmpty(leaseToken, "baseReconciliation.leaseToken");
    const job = this.getBaseReconciliationJob(jobId);
    if (
      !job ||
      job.state !== "RUNNING" ||
      job.leaseToken !== leaseToken ||
      job.leaseUntil === null ||
      job.leaseUntil <= at
    ) {
      throw new BaseReconciliationJobConflictError(
        `Base reconciliation job ${jobId} is not held by the supplied live lease`,
      );
    }
    return job;
  }

  settleBaseReconciliationJob(input: {
    jobId: string;
    leaseToken: string;
    observation?: BaseReconciliationObservation;
    now?: string;
  }): BaseReconciliationJob {
    const at = input.now ?? this.#timestamp();
    assertCanonicalTimestamp(at, "baseReconciliation.now");
    assertBaseReconciliationObservation(input.observation);
    const run = this.db.transaction((): BaseReconciliationJob => {
      const current = this.#requireBaseReconciliationLease(input.jobId, input.leaseToken, at);
      const observation = input.observation === undefined
        ? current.lastObservation
        : input.observation;
      const result = this.db.query(
        `UPDATE wk_base_reconciliation_jobs
         SET state='SETTLED', lease_owner=NULL, lease_token=NULL, lease_until=NULL,
             last_observation_json=?, last_error_code=NULL, settled_at=?,
             version=version+1, updated_at=?
         WHERE id=? AND version=? AND state='RUNNING' AND lease_token=?`,
      ).run(
        observation === null ? null : json(observation),
        at,
        at,
        input.jobId,
        current.version,
        input.leaseToken,
      );
      if (result.changes !== 1) {
        throw new BaseReconciliationJobConflictError(
          `Base reconciliation job ${input.jobId} changed before settlement`,
        );
      }
      const job = this.getBaseReconciliationJob(input.jobId);
      if (!job) throw new Error(`Settled Base reconciliation job ${input.jobId} disappeared`);
      return job;
    });
    return run.immediate();
  }

  rescheduleBaseReconciliationJob(input: {
    jobId: string;
    leaseToken: string;
    nextAttemptAt: string;
    errorCode?: string | null;
    observation?: BaseReconciliationObservation;
    incrementFailure?: boolean;
    now?: string;
  }): BaseReconciliationJob {
    const at = input.now ?? this.#timestamp();
    const errorCode = input.errorCode ?? null;
    assertCanonicalTimestamp(at, "baseReconciliation.now");
    assertCanonicalTimestamp(input.nextAttemptAt, "baseReconciliation.nextAttemptAt");
    assertStableErrorCode(errorCode, "baseReconciliation.errorCode");
    assertBaseReconciliationObservation(input.observation);
    const run = this.db.transaction((): BaseReconciliationJob => {
      const current = this.#requireBaseReconciliationLease(input.jobId, input.leaseToken, at);
      const observation = input.observation === undefined
        ? current.lastObservation
        : input.observation;
      const result = this.db.query(
        `UPDATE wk_base_reconciliation_jobs
         SET state='BACKOFF', lease_owner=NULL, lease_token=NULL, lease_until=NULL,
             next_attempt_at=?, failure_count=failure_count+?,
             last_observation_json=?, last_error_code=?,
             version=version+1, updated_at=?
         WHERE id=? AND version=? AND state='RUNNING' AND lease_token=?`,
      ).run(
        input.nextAttemptAt,
        input.incrementFailure === false ? 0 : 1,
        observation === null ? null : json(observation),
        errorCode,
        at,
        input.jobId,
        current.version,
        input.leaseToken,
      );
      if (result.changes !== 1) {
        throw new BaseReconciliationJobConflictError(
          `Base reconciliation job ${input.jobId} changed before reschedule`,
        );
      }
      const job = this.getBaseReconciliationJob(input.jobId);
      if (!job) throw new Error(`Rescheduled Base reconciliation job ${input.jobId} disappeared`);
      return job;
    });
    return run.immediate();
  }

  pauseBaseReconciliationJob(input: {
    jobId: string;
    leaseToken: string;
    errorCode?: string | null;
    observation?: BaseReconciliationObservation;
    incrementFailure?: boolean;
    now?: string;
  }): BaseReconciliationJob {
    const at = input.now ?? this.#timestamp();
    const errorCode = input.errorCode ?? null;
    assertCanonicalTimestamp(at, "baseReconciliation.now");
    assertStableErrorCode(errorCode, "baseReconciliation.errorCode");
    assertBaseReconciliationObservation(input.observation);
    const run = this.db.transaction((): BaseReconciliationJob => {
      const current = this.#requireBaseReconciliationLease(input.jobId, input.leaseToken, at);
      const observation = input.observation === undefined
        ? current.lastObservation
        : input.observation;
      const result = this.db.query(
        `UPDATE wk_base_reconciliation_jobs
         SET state='PAUSED', lease_owner=NULL, lease_token=NULL, lease_until=NULL,
             failure_count=failure_count+?, last_observation_json=?, last_error_code=?,
             version=version+1, updated_at=?
         WHERE id=? AND version=? AND state='RUNNING' AND lease_token=?`,
      ).run(
        input.incrementFailure === false ? 0 : 1,
        observation === null ? null : json(observation),
        errorCode,
        at,
        input.jobId,
        current.version,
        input.leaseToken,
      );
      if (result.changes !== 1) {
        throw new BaseReconciliationJobConflictError(
          `Base reconciliation job ${input.jobId} changed before pause`,
        );
      }
      const job = this.getBaseReconciliationJob(input.jobId);
      if (!job) throw new Error(`Paused Base reconciliation job ${input.jobId} disappeared`);
      return job;
    });
    return run.immediate();
  }

  reapExpiredBaseReconciliationLeases(input: { now?: string } = {}): number {
    const at = input.now ?? this.#timestamp();
    assertCanonicalTimestamp(at, "baseReconciliation.now");
    const run = this.db.transaction((): number => this.db.query(
      `UPDATE wk_base_reconciliation_jobs
       SET state='BACKOFF', lease_owner=NULL, lease_token=NULL, lease_until=NULL,
           next_attempt_at=?, failure_count=failure_count+1,
           last_error_code='RECONCILIATION_LEASE_EXPIRED',
           version=version+1, updated_at=?
       WHERE state='RUNNING' AND lease_until <= ?`,
    ).run(at, at, at).changes);
    return run.immediate();
  }

  appendBasePositionRefreshAttempt(input: {
    id?: string;
    accountId: string;
    attemptedAt: string;
    outcome: BasePositionRefreshAttemptOutcome;
    reasonCode: string;
    providerCount: number;
    availableProviderCount: number;
    agreeingProviderCount: number;
    retainedHead?: BasePositionRefreshAttemptRetainedHead | null;
    errorCode?: string | null;
  }): BasePositionRefreshAttemptRecord {
    assertNonEmpty(input.accountId, "basePositionRefreshAttempt.accountId");
    assertCanonicalTimestamp(
      input.attemptedAt,
      "basePositionRefreshAttempt.attemptedAt",
    );
    if (!BASE_POSITION_REFRESH_ATTEMPT_OUTCOMES.has(input.outcome)) {
      throw new TypeError("basePositionRefreshAttempt.outcome is invalid");
    }
    assertStableLowerCode(input.reasonCode, "basePositionRefreshAttempt.reasonCode");
    for (const [field, value] of [
      ["providerCount", input.providerCount],
      ["availableProviderCount", input.availableProviderCount],
      ["agreeingProviderCount", input.agreeingProviderCount],
    ] as const) {
      if (!Number.isSafeInteger(value) || value < 0 || value > 64) {
        throw new TypeError(
          `basePositionRefreshAttempt.${field} must be an integer between 0 and 64`,
        );
      }
    }
    if (
      input.agreeingProviderCount > input.availableProviderCount ||
      input.availableProviderCount > input.providerCount
    ) {
      throw new TypeError(
        "Base position refresh provider counts must satisfy agreeing <= available <= total",
      );
    }
    const errorCode = input.errorCode ?? null;
    if (errorCode !== null) {
      assertStableLowerCode(errorCode, "basePositionRefreshAttempt.errorCode");
    }
    if (input.retainedHead) {
      assertNonEmpty(
        input.retainedHead.snapshotId,
        "basePositionRefreshAttempt.retainedHead.snapshotId",
      );
      if (
        (input.retainedHead.state !== "ACTIVE" && input.retainedHead.state !== "FROZEN") ||
        !Number.isSafeInteger(input.retainedHead.version) ||
        input.retainedHead.version < 0 ||
        (input.retainedHead.state === "ACTIVE" &&
          input.retainedHead.conflictSnapshotId !== null) ||
        (input.retainedHead.state === "FROZEN" &&
          input.retainedHead.conflictSnapshotId === null)
      ) {
        throw new TypeError("basePositionRefreshAttempt.retainedHead is invalid");
      }
      if (input.retainedHead.conflictSnapshotId !== null) {
        assertNonEmpty(
          input.retainedHead.conflictSnapshotId,
          "basePositionRefreshAttempt.retainedHead.conflictSnapshotId",
        );
      }
    }
    const id = input.id ?? `base-position-refresh-attempt:${this.#newId()}`;
    assertNonEmpty(id, "basePositionRefreshAttempt.id");
    if (/(?:https?|wss?):\/\//i.test(id)) {
      throw new TypeError("basePositionRefreshAttempt.id must not contain a URL");
    }

    const run = this.db.transaction((): BasePositionRefreshAttemptRecord => {
      const account = this.db.query(
        "SELECT chain_id FROM wk_accounts WHERE id=?",
      ).get(input.accountId) as { chain_id: string | null } | null;
      if (!account || account.chain_id !== BASE_CHAIN_ID) {
        throw new BasePositionRefreshAttemptConflictError(
          `Account ${input.accountId} is not a projected Base mainnet account`,
        );
      }
      const currentHead = this.getBasePositionHead(input.accountId);
      const retainedHead = input.retainedHead === undefined
        ? currentHead === null
          ? null
          : {
              snapshotId: currentHead.snapshotId,
              state: currentHead.state,
              conflictSnapshotId: currentHead.conflictSnapshotId,
              version: currentHead.version,
            }
        : input.retainedHead;
      const exactHead =
        (retainedHead === null && currentHead === null) ||
        (retainedHead !== null && currentHead !== null &&
          retainedHead.snapshotId === currentHead.snapshotId &&
          retainedHead.state === currentHead.state &&
          retainedHead.conflictSnapshotId === currentHead.conflictSnapshotId &&
          retainedHead.version === currentHead.version);
      if (!exactHead) {
        throw new BasePositionRefreshAttemptConflictError(
          "Base position head changed before its refresh attempt could be recorded",
        );
      }
      const createdAt = this.#timestamp();
      this.db.query(
        `INSERT INTO wk_base_position_refresh_attempts
          (id, account_id, attempted_at, outcome, reason_code,
           provider_count, available_provider_count, agreeing_provider_count,
           retained_snapshot_id, retained_head_state,
           retained_conflict_snapshot_id, retained_head_version,
           error_code, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        id,
        input.accountId,
        input.attemptedAt,
        input.outcome,
        input.reasonCode,
        input.providerCount,
        input.availableProviderCount,
        input.agreeingProviderCount,
        retainedHead?.snapshotId ?? null,
        retainedHead?.state ?? null,
        retainedHead?.conflictSnapshotId ?? null,
        retainedHead?.version ?? null,
        errorCode,
        createdAt,
      );
      const attempt = this.getBasePositionRefreshAttempt(id);
      if (!attempt) {
        throw new Error(`Base position refresh attempt ${id} disappeared after insertion`);
      }
      return attempt;
    });
    return run.immediate();
  }

  getBasePositionRefreshAttempt(id: string): BasePositionRefreshAttemptRecord | null {
    assertNonEmpty(id, "basePositionRefreshAttempt.id");
    const row = this.db.query(
      "SELECT * FROM wk_base_position_refresh_attempts WHERE id=?",
    ).get(id) as BasePositionRefreshAttemptRow | null;
    return row ? mapBasePositionRefreshAttempt(row) : null;
  }

  listBasePositionRefreshAttempts(
    filter: {
      accountId?: string;
      outcome?: BasePositionRefreshAttemptOutcome;
      limit?: number;
    } = {},
  ): BasePositionRefreshAttemptRecord[] {
    const limit = filter.limit ?? 100;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 512) {
      throw new TypeError(
        "basePositionRefreshAttempts.limit must be an integer between 1 and 512",
      );
    }
    const clauses: string[] = [];
    const values: Array<string | number> = [];
    if (filter.accountId !== undefined) {
      assertNonEmpty(filter.accountId, "basePositionRefreshAttempts.accountId");
      clauses.push("account_id=?");
      values.push(filter.accountId);
    }
    if (filter.outcome !== undefined) {
      if (!BASE_POSITION_REFRESH_ATTEMPT_OUTCOMES.has(filter.outcome)) {
        throw new TypeError("basePositionRefreshAttempts.outcome is invalid");
      }
      clauses.push("outcome=?");
      values.push(filter.outcome);
    }
    const where = clauses.length === 0 ? "" : `WHERE ${clauses.join(" AND ")}`;
    values.push(limit);
    return (this.db.query(
      `SELECT * FROM wk_base_position_refresh_attempts ${where}
       ORDER BY attempted_at DESC, created_at DESC, rowid DESC
       LIMIT ?`,
    ).all(...values) as BasePositionRefreshAttemptRow[]).map(
      mapBasePositionRefreshAttempt,
    );
  }

  appendBasePositionSighting(input: {
    id?: string;
    accountId: string;
    chainId?: typeof BASE_CHAIN_ID;
    providerId: string;
    providerTrustDomain: `sha256:${string}`;
    evidenceHash: `sha256:${string}`;
    blockNumber: string;
    blockHash: `0x${string}`;
    blockTime: string;
    items: readonly BasePositionSnapshotItem[];
    body: JsonValue;
    observedAt: string;
    fetchedAt: string;
  }): { sighting: BasePositionSightingRecord; replayed: boolean } {
    assertNonEmpty(input.accountId, "basePositionSighting.accountId");
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(input.providerId)) {
      throw new TypeError("basePositionSighting.providerId is invalid");
    }
    assertCanonicalSha256(
      input.providerTrustDomain,
      "basePositionSighting.providerTrustDomain",
    );
    assertCanonicalSha256(input.evidenceHash, "basePositionSighting.evidenceHash");
    assertCanonicalUint256(input.blockNumber, "basePositionSighting.blockNumber");
    assertCanonicalBlockHash(input.blockHash, "basePositionSighting.blockHash");
    assertCanonicalTimestamp(input.blockTime, "basePositionSighting.blockTime");
    assertCanonicalTimestamp(input.observedAt, "basePositionSighting.observedAt");
    assertCanonicalTimestamp(input.fetchedAt, "basePositionSighting.fetchedAt");
    const chainId = input.chainId ?? BASE_CHAIN_ID;
    if (chainId !== BASE_CHAIN_ID) throw new TypeError("Only Base mainnet positions are supported");
    const items = normalizeBasePositionItems(input.items);
    const ethAtomic = items[0].observedAtomic;
    const usdcAtomic = items[1].observedAtomic;
    const bodyJson = json(input.body);
    if (/(?:https?|wss?):\/\//i.test(bodyJson)) {
      throw new TypeError("Base position evidence must not contain a provider URL or origin");
    }
    const semantic = {
      schema: "cashloom.base-position-sighting/1",
      accountId: input.accountId,
      chainId,
      providerId: input.providerId,
      providerTrustDomain: input.providerTrustDomain,
      evidenceHash: input.evidenceHash,
      blockNumber: input.blockNumber,
      blockHash: input.blockHash,
      blockTime: input.blockTime,
      ethAtomic,
      usdcAtomic,
      observedAt: input.observedAt,
      fetchedAt: input.fetchedAt,
    } as const;
    const id = input.id ?? `base-position-sighting:${fingerprintRequest(semantic)}`;
    assertNonEmpty(id, "basePositionSighting.id");
    const run = this.db.transaction((): {
      sighting: BasePositionSightingRecord;
      replayed: boolean;
    } => {
      const account = this.db.query(
        "SELECT chain_id FROM wk_accounts WHERE id=?",
      ).get(input.accountId) as { chain_id: string | null } | null;
      if (!account || account.chain_id !== BASE_CHAIN_ID) {
        throw new BasePositionSnapshotConflictError(
          `Account ${input.accountId} is not a projected Base mainnet account`,
        );
      }
      const priorById = this.getBasePositionSighting(id);
      const priorByFactRow = this.db.query(
        `SELECT * FROM wk_base_position_snapshot_sightings
         WHERE account_id=? AND chain_id=? AND provider_id=?
           AND provider_trust_domain=? AND evidence_hash=?
           AND block_number=? AND block_hash=? AND block_time=?
           AND eth_atomic=? AND usdc_atomic=?
           AND observed_at=? AND fetched_at=?`,
      ).get(
        input.accountId,
        chainId,
        input.providerId,
        input.providerTrustDomain,
        input.evidenceHash,
        input.blockNumber,
        input.blockHash,
        input.blockTime,
        ethAtomic,
        usdcAtomic,
        input.observedAt,
        input.fetchedAt,
      ) as BasePositionSightingRow | null;
      const priorByFact = priorByFactRow ? mapBasePositionSighting(priorByFactRow) : null;
      const prior = priorById ?? priorByFact;
      if (prior) {
        const same =
          prior.accountId === input.accountId &&
          prior.chainId === chainId &&
          prior.providerId === input.providerId &&
          prior.providerTrustDomain === input.providerTrustDomain &&
          prior.evidenceHash === input.evidenceHash &&
          prior.blockNumber === input.blockNumber &&
          prior.blockHash === input.blockHash &&
          prior.blockTime === input.blockTime &&
          prior.items[0].observedAtomic === ethAtomic &&
          prior.items[1].observedAtomic === usdcAtomic &&
          prior.observedAt === input.observedAt &&
          prior.fetchedAt === input.fetchedAt &&
          canonicalJson(prior.body) === canonicalJson(input.body);
        if (!same || (priorById && priorByFact && priorById.id !== priorByFact.id)) {
          throw new BasePositionSnapshotConflictError(
            "Base position sighting id or immutable fact was reused with different evidence",
          );
        }
        return { sighting: prior, replayed: true };
      }
      const at = this.#timestamp();
      this.db.query(
        `INSERT INTO wk_base_position_snapshot_sightings
          (id, account_id, chain_id, provider_id, provider_trust_domain,
           evidence_hash, block_number, block_hash, block_time, eth_atomic,
           usdc_atomic, body_json, observed_at, fetched_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        id,
        input.accountId,
        chainId,
        input.providerId,
        input.providerTrustDomain,
        input.evidenceHash,
        input.blockNumber,
        input.blockHash,
        input.blockTime,
        ethAtomic,
        usdcAtomic,
        bodyJson,
        input.observedAt,
        input.fetchedAt,
        at,
      );
      const sighting = this.getBasePositionSighting(id);
      if (!sighting) throw new Error(`Base position sighting ${id} disappeared after insertion`);
      return { sighting, replayed: false };
    });
    return run.immediate();
  }

  getBasePositionSighting(id: string): BasePositionSightingRecord | null {
    assertNonEmpty(id, "basePositionSighting.id");
    const row = this.db.query(
      "SELECT * FROM wk_base_position_snapshot_sightings WHERE id=?",
    ).get(id) as BasePositionSightingRow | null;
    return row ? mapBasePositionSighting(row) : null;
  }

  listBasePositionSightings(
    filter: { accountId?: string; providerId?: string; limit?: number } = {},
  ): BasePositionSightingRecord[] {
    const limit = filter.limit ?? 100;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 512) {
      throw new TypeError("basePositionSightings.limit must be an integer between 1 and 512");
    }
    const clauses: string[] = [];
    const values: Array<string | number> = [];
    for (const [column, value] of [
      ["account_id", filter.accountId],
      ["provider_id", filter.providerId],
    ] as const) {
      if (value !== undefined) {
        assertNonEmpty(value, `basePositionSightings.${column}`);
        clauses.push(`${column}=?`);
        values.push(value);
      }
    }
    const where = clauses.length === 0 ? "" : `WHERE ${clauses.join(" AND ")}`;
    values.push(limit);
    return (this.db.query(
      `SELECT * FROM wk_base_position_snapshot_sightings ${where}
       ORDER BY length(block_number), block_number, fetched_at, id
       LIMIT ?`,
    ).all(...values) as BasePositionSightingRow[]).map(mapBasePositionSighting);
  }

  getBasePositionSnapshot(id: string): BasePositionSnapshotRecord | null {
    assertNonEmpty(id, "basePositionSnapshot.id");
    const row = this.db.query(
      "SELECT * FROM wk_base_position_snapshots WHERE id=?",
    ).get(id) as BasePositionSnapshotRow | null;
    return row ? mapBasePositionSnapshot(row) : null;
  }

  listBasePositionSnapshots(
    filter: { accountId?: string; limit?: number } = {},
  ): BasePositionSnapshotRecord[] {
    const limit = filter.limit ?? 100;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 512) {
      throw new TypeError("basePositionSnapshots.limit must be an integer between 1 and 512");
    }
    const where = filter.accountId === undefined ? "" : "WHERE account_id=?";
    const values: Array<string | number> = [];
    if (filter.accountId !== undefined) {
      assertNonEmpty(filter.accountId, "basePositionSnapshots.accountId");
      values.push(filter.accountId);
    }
    values.push(limit);
    return (this.db.query(
      `SELECT * FROM wk_base_position_snapshots ${where}
       ORDER BY length(block_number), block_number, decided_at, id
       LIMIT ?`,
    ).all(...values) as BasePositionSnapshotRow[]).map(mapBasePositionSnapshot);
  }

  getBasePositionHead(accountId: string): BasePositionSnapshotHeadRecord | null {
    assertNonEmpty(accountId, "basePositionHead.accountId");
    const row = this.db.query(
      "SELECT * FROM wk_base_position_snapshot_heads WHERE account_id=?",
    ).get(accountId) as BasePositionHeadRow | null;
    return row ? mapBasePositionHead(row) : null;
  }

  listBasePositions(input: { accountId?: string } = {}): BasePositionRecord[] {
    const accountPredicate = input.accountId === undefined ? "" : "AND position.account_id=?";
    const values: string[] = [];
    if (input.accountId !== undefined) {
      assertNonEmpty(input.accountId, "basePositions.accountId");
      values.push(input.accountId);
    }
    return (this.db.query(
      `SELECT position.*,
              head.snapshot_id, head.block_number, head.block_hash,
              head.state AS head_state, head.conflict_snapshot_id,
              head.version AS head_version
       FROM wk_positions position
       JOIN wk_base_position_snapshot_heads head ON head.account_id=position.account_id
       WHERE position.asset_id IN (
           'eip155:8453/slip44:60',
           'eip155:8453/erc20:0x833589fcd6edb6e08f4c7c32d4f71b54bda02913'
         )
       ${accountPredicate}
       ORDER BY position.account_id, position.asset_id`,
    ).all(...values) as BasePositionRow[]).map(mapBasePosition);
  }

  #writeBasePositionProjection(snapshot: BasePositionSnapshotRecord, at: string): void {
    for (const item of snapshot.items) {
      this.db.query(
        `INSERT INTO wk_positions
          (account_id, asset_id, observed_atomic, pending_atomic, source,
           source_cursor, as_of, version, updated_at)
         VALUES (?, ?, ?, '0', 'BASE_FINALIZED_QUORUM', ?, ?, 0, ?)
         ON CONFLICT(account_id, asset_id) DO UPDATE SET
           observed_atomic=excluded.observed_atomic,
           source=excluded.source,
           source_cursor=excluded.source_cursor,
           as_of=excluded.as_of,
           version=wk_positions.version+1,
           updated_at=excluded.updated_at`,
      ).run(
        snapshot.accountId,
        item.assetId,
        item.observedAtomic,
        snapshot.id,
        snapshot.blockTime,
        at,
      );
    }
  }

  applyBasePositionSnapshot(input: {
    id?: string;
    accountId: string;
    chainId?: typeof BASE_CHAIN_ID;
    blockNumber: string;
    blockHash: `0x${string}`;
    blockTime: string;
    evidenceHash: `sha256:${string}`;
    providerIds: readonly string[];
    sightingIds: readonly string[];
    quorum: number;
    items: readonly BasePositionSnapshotItem[];
    decidedAt: string;
  }): ApplyBasePositionSnapshotResult {
    assertNonEmpty(input.accountId, "basePositionSnapshot.accountId");
    const chainId = input.chainId ?? BASE_CHAIN_ID;
    if (chainId !== BASE_CHAIN_ID) throw new TypeError("Only Base mainnet positions are supported");
    assertCanonicalUint256(input.blockNumber, "basePositionSnapshot.blockNumber");
    assertCanonicalBlockHash(input.blockHash, "basePositionSnapshot.blockHash");
    assertCanonicalTimestamp(input.blockTime, "basePositionSnapshot.blockTime");
    assertCanonicalSha256(input.evidenceHash, "basePositionSnapshot.evidenceHash");
    assertCanonicalTimestamp(input.decidedAt, "basePositionSnapshot.decidedAt");
    const items = normalizeBasePositionItems(input.items);
    for (const providerId of input.providerIds) {
      if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(providerId)) {
        throw new TypeError("basePositionSnapshot.providerIds contains an invalid provider id");
      }
    }
    const providerIds = normalizeAsciiIds(input.providerIds, "basePositionSnapshot.providerIds");
    const sightingIds = normalizeAsciiIds(input.sightingIds, "basePositionSnapshot.sightingIds");
    if (providerIds.length !== sightingIds.length) {
      throw new TypeError("Base position consensus requires one sighting per provider");
    }
    if (
      !Number.isSafeInteger(input.quorum) ||
      input.quorum < 2 ||
      input.quorum > providerIds.length
    ) {
      throw new TypeError("Base position consensus requires a quorum of at least two providers");
    }
    const ethAtomic = items[0].observedAtomic;
    const usdcAtomic = items[1].observedAtomic;
    const snapshotHash = `sha256:${fingerprintRequest({
      schema: "cashloom.base-position-snapshot/1",
      accountId: input.accountId,
      chainId,
      blockNumber: input.blockNumber,
      blockHash: input.blockHash,
      blockTime: input.blockTime,
      evidenceHash: input.evidenceHash,
      ethAtomic,
      usdcAtomic,
      providerIds,
      sightingIds,
      quorum: input.quorum,
    })}` as const;
    const id = input.id ?? `base-position-snapshot:${snapshotHash.slice(7)}`;
    assertNonEmpty(id, "basePositionSnapshot.id");
    const run = this.db.transaction((): ApplyBasePositionSnapshotResult => {
      const account = this.db.query(
        "SELECT chain_id FROM wk_accounts WHERE id=?",
      ).get(input.accountId) as { chain_id: string | null } | null;
      if (!account || account.chain_id !== BASE_CHAIN_ID) {
        throw new BasePositionSnapshotConflictError(
          `Account ${input.accountId} is not a projected Base mainnet account`,
        );
      }
      for (const assetId of [BASE_ETH_ASSET_ID, BASE_USDC_ASSET_ID] as const) {
        const asset = this.db.query(
          "SELECT chain_id FROM wk_assets WHERE id=?",
        ).get(assetId) as { chain_id: string | null } | null;
        if (!asset || asset.chain_id !== BASE_CHAIN_ID) {
          throw new BasePositionSnapshotConflictError(
            `Required Base asset projection ${assetId} does not exist`,
          );
        }
      }
      const selectedSightings = sightingIds.map((sightingId) => {
        const sighting = this.getBasePositionSighting(sightingId);
        if (!sighting) {
          throw new BasePositionSnapshotConflictError(
            `Base position consensus sighting ${sightingId} does not exist`,
          );
        }
        return sighting;
      });
      const trustDomains = new Set<string>();
      for (const sighting of selectedSightings) {
        trustDomains.add(sighting.providerTrustDomain);
        const matches =
          sighting.accountId === input.accountId &&
          sighting.chainId === chainId &&
          sighting.evidenceHash === input.evidenceHash &&
          sighting.blockNumber === input.blockNumber &&
          sighting.blockHash === input.blockHash &&
          sighting.blockTime === input.blockTime &&
          sighting.items[0].observedAtomic === ethAtomic &&
          sighting.items[1].observedAtomic === usdcAtomic &&
          providerIds.includes(sighting.providerId);
        if (!matches) {
          throw new BasePositionSnapshotConflictError(
            `Base position consensus sighting ${sighting.id} does not match the atomic snapshot`,
          );
        }
      }
      if (trustDomains.size !== selectedSightings.length) {
        throw new BasePositionSnapshotConflictError(
          "Base position consensus providers do not have distinct trust domains",
        );
      }
      for (const providerId of providerIds) {
        if (selectedSightings.filter((sighting) => sighting.providerId === providerId).length !== 1) {
          throw new BasePositionSnapshotConflictError(
            `Base position consensus does not contain exactly one sighting for ${providerId}`,
          );
        }
      }

      const priorById = this.getBasePositionSnapshot(id);
      const priorByHashRow = this.db.query(
        "SELECT * FROM wk_base_position_snapshots WHERE snapshot_hash=?",
      ).get(snapshotHash) as BasePositionSnapshotRow | null;
      const priorByHash = priorByHashRow ? mapBasePositionSnapshot(priorByHashRow) : null;
      const prior = priorById ?? priorByHash;
      if (prior) {
        const same =
          prior.snapshotHash === snapshotHash &&
          prior.accountId === input.accountId &&
          prior.chainId === chainId &&
          prior.blockNumber === input.blockNumber &&
          prior.blockHash === input.blockHash &&
          prior.blockTime === input.blockTime &&
          prior.evidenceHash === input.evidenceHash &&
          canonicalJson(prior.providerIds) === canonicalJson(providerIds) &&
          canonicalJson(prior.sightingIds) === canonicalJson(sightingIds) &&
          prior.quorum === input.quorum &&
          prior.items[0].observedAtomic === ethAtomic &&
          prior.items[1].observedAtomic === usdcAtomic;
        if (!same || (priorById && priorByHash && priorById.id !== priorByHash.id)) {
          throw new BasePositionSnapshotConflictError(
            "Base position snapshot id or hash was reused for another consensus fact",
          );
        }
        const head = this.getBasePositionHead(input.accountId);
        if (!head) {
          throw new BasePositionSnapshotConflictError(
            `Replayed Base position snapshot ${prior.id} has no durable applied head`,
          );
        }
        return { outcome: "replayed", snapshot: prior, head };
      }

      const at = this.#timestamp();
      this.db.query(
        `INSERT INTO wk_base_position_snapshots
          (id, snapshot_hash, account_id, chain_id, block_number, block_hash,
           block_time, evidence_hash, eth_atomic, usdc_atomic,
           provider_ids_json, sighting_ids_json, quorum, decided_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        id,
        snapshotHash,
        input.accountId,
        chainId,
        input.blockNumber,
        input.blockHash,
        input.blockTime,
        input.evidenceHash,
        ethAtomic,
        usdcAtomic,
        json(providerIds),
        json(sightingIds),
        input.quorum,
        input.decidedAt,
        at,
      );
      for (const item of items) {
        this.db.query(
          `INSERT INTO wk_base_position_snapshot_items
            (snapshot_id, asset_id, observed_atomic, created_at)
           VALUES (?, ?, ?, ?)`,
        ).run(id, item.assetId, item.observedAtomic, at);
      }
      const snapshot = this.getBasePositionSnapshot(id);
      if (!snapshot) throw new Error(`Base position snapshot ${id} disappeared after insertion`);
      let head = this.getBasePositionHead(input.accountId);
      if (!head) {
        this.db.query(
          `INSERT INTO wk_base_position_snapshot_heads
            (account_id, snapshot_id, block_number, block_hash, state,
             conflict_snapshot_id, version, updated_at)
           VALUES (?, ?, ?, ?, 'ACTIVE', NULL, 0, ?)`,
        ).run(input.accountId, id, input.blockNumber, input.blockHash, at);
        this.#writeBasePositionProjection(snapshot, at);
        head = this.getBasePositionHead(input.accountId);
        if (!head) throw new Error(`Base position head for ${input.accountId} disappeared`);
        return { outcome: "applied", snapshot, head };
      }

      const current = this.getBasePositionSnapshot(head.snapshotId);
      if (!current) {
        throw new BasePositionSnapshotConflictError(
          `Base position head ${head.snapshotId} has no immutable snapshot`,
        );
      }
      const candidateHeight = BigInt(input.blockNumber);
      const currentHeight = BigInt(head.blockNumber);
      const sameCurrentFact =
        snapshot.blockHash === current.blockHash &&
        snapshot.blockTime === current.blockTime &&
        snapshot.items[0].observedAtomic === current.items[0].observedAtomic &&
        snapshot.items[1].observedAtomic === current.items[1].observedAtomic;
      const conflictSnapshot = head.conflictSnapshotId
        ? this.getBasePositionSnapshot(head.conflictSnapshotId)
        : null;
      const sameKnownConflict = conflictSnapshot !== null &&
        snapshot.blockHash === conflictSnapshot.blockHash &&
        snapshot.blockTime === conflictSnapshot.blockTime &&
        snapshot.items[0].observedAtomic === conflictSnapshot.items[0].observedAtomic &&
        snapshot.items[1].observedAtomic === conflictSnapshot.items[1].observedAtomic;
      if (head.state === "FROZEN") {
        return {
          outcome: sameCurrentFact || sameKnownConflict ? "replayed" : "conflict",
          snapshot,
          head,
        };
      }
      if (candidateHeight < currentHeight) {
        return { outcome: "stale", snapshot, head };
      }
      if (candidateHeight === currentHeight) {
        if (sameCurrentFact || sameKnownConflict) {
          return { outcome: "replayed", snapshot, head };
        }
        if (head.state === "ACTIVE") {
          const updated = this.db.query(
            `UPDATE wk_base_position_snapshot_heads
             SET state='FROZEN', conflict_snapshot_id=?,
                 version=version+1, updated_at=?
             WHERE account_id=? AND version=? AND state='ACTIVE'`,
          ).run(snapshot.id, at, input.accountId, head.version);
          if (updated.changes !== 1) {
            throw new BasePositionSnapshotConflictError(
              `Base position head for ${input.accountId} changed concurrently`,
            );
          }
          head = this.getBasePositionHead(input.accountId);
          if (!head) throw new Error(`Base position head for ${input.accountId} disappeared`);
        }
        return { outcome: "conflict", snapshot, head };
      }

      const updated = this.db.query(
        `UPDATE wk_base_position_snapshot_heads
         SET snapshot_id=?, block_number=?, block_hash=?, state='ACTIVE',
             conflict_snapshot_id=NULL, version=version+1, updated_at=?
         WHERE account_id=? AND version=?`,
      ).run(
        snapshot.id,
        snapshot.blockNumber,
        snapshot.blockHash,
        at,
        input.accountId,
        head.version,
      );
      if (updated.changes !== 1) {
        throw new BasePositionSnapshotConflictError(
          `Base position head for ${input.accountId} changed concurrently`,
        );
      }
      this.#writeBasePositionProjection(snapshot, at);
      head = this.getBasePositionHead(input.accountId);
      if (!head) throw new Error(`Base position head for ${input.accountId} disappeared`);
      return { outcome: "superseded", snapshot, head };
    });
    return run.immediate();
  }

  appendObservation(input: {
    id?: string;
    accountId: string;
    assetId?: string | null;
    provider: string;
    externalId: string;
    kind: string;
    amountAtomic?: string | null;
    state?: string | null;
    occurredAt: string;
    body: JsonValue;
  }): { observation: ObservationRecord; replayed: boolean } {
    for (const [field, value] of [
      ["observation.accountId", input.accountId],
      ["observation.provider", input.provider],
      ["observation.externalId", input.externalId],
      ["observation.kind", input.kind],
      ["observation.occurredAt", input.occurredAt],
    ] as const) assertNonEmpty(value, field);
    if (input.amountAtomic !== undefined && input.amountAtomic !== null) {
      assertCanonicalInteger(input.amountAtomic, "observation.amountAtomic");
    }
    const id = input.id ?? this.#newId();
    const run = this.db.transaction((): { observation: ObservationRecord; replayed: boolean } => {
      const priorById = this.getObservation(id);
      const priorByExternalRow = this.db.query(
        `SELECT * FROM wk_observations
         WHERE provider=? AND account_id=? AND external_id=?`,
      ).get(input.provider, input.accountId, input.externalId) as ObservationRow | null;
      const priorByExternal = priorByExternalRow ? mapObservation(priorByExternalRow) : null;
      const prior = priorById ?? priorByExternal;
      if (prior) {
        const same =
          prior.accountId === input.accountId &&
          prior.assetId === (input.assetId ?? null) &&
          prior.provider === input.provider &&
          prior.externalId === input.externalId &&
          prior.kind === input.kind &&
          prior.amountAtomic === (input.amountAtomic ?? null) &&
          prior.state === (input.state ?? null) &&
          prior.occurredAt === input.occurredAt &&
          canonicalJson(prior.body) === canonicalJson(input.body);
        if (!same || (priorById !== null && priorByExternal !== null && priorById.id !== priorByExternal.id)) {
          throw new WalletKernelStoreError(
            "OBSERVATION_FINGERPRINT_MISMATCH",
            "Observation id or provider external id was reused with different evidence",
          );
        }
        return { observation: prior, replayed: true };
      }
      const at = this.#timestamp();
      this.db.query(
        `INSERT INTO wk_observations
          (id, account_id, asset_id, provider, external_id, kind, amount_atomic,
           state, occurred_at, body_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        id,
        input.accountId,
        input.assetId ?? null,
        input.provider,
        input.externalId,
        input.kind,
        input.amountAtomic ?? null,
        input.state ?? null,
        input.occurredAt,
        json(input.body),
        at,
      );
      const observation = this.getObservation(id);
      if (!observation) throw new Error(`Failed to read newly-recorded observation ${id}`);
      return { observation, replayed: false };
    });
    return run.immediate();
  }

  getObservation(id: string): ObservationRecord | null {
    const row = this.db.query("SELECT * FROM wk_observations WHERE id=?").get(id) as
      | ObservationRow
      | null;
    return row ? mapObservation(row) : null;
  }

  listObservations(filter: { accountId?: string; provider?: string } = {}): ObservationRecord[] {
    const clauses: string[] = [];
    const values: string[] = [];
    if (filter.accountId !== undefined) {
      assertNonEmpty(filter.accountId, "observations.accountId");
      clauses.push("account_id=?");
      values.push(filter.accountId);
    }
    if (filter.provider !== undefined) {
      assertNonEmpty(filter.provider, "observations.provider");
      clauses.push("provider=?");
      values.push(filter.provider);
    }
    const where = clauses.length === 0 ? "" : `WHERE ${clauses.join(" AND ")}`;
    return (this.db.query(
      `SELECT * FROM wk_observations ${where} ORDER BY occurred_at, created_at, id`,
    ).all(...values) as ObservationRow[]).map(mapObservation);
  }

  listObservationsForIntent(intentId: string): ObservationRecord[] {
    assertNonEmpty(intentId, "intentId");
    return (this.db.query(
      `SELECT DISTINCT observation.*
       FROM wk_observations observation
       JOIN wk_reconciliation_links link ON link.observation_id=observation.id
       WHERE link.intent_id=?
       ORDER BY observation.occurred_at, observation.created_at, observation.id`,
    ).all(intentId) as ObservationRow[]).map(mapObservation);
  }

  appendReconciliationLink(input: {
    id?: string;
    observationId: string;
    intentId?: string | null;
    executionId?: string | null;
    journalEntryId?: string | null;
    matchKind: string;
    confidenceBps: number;
    data?: JsonValue;
  }): { link: ReconciliationLinkRecord; replayed: boolean } {
    assertNonEmpty(input.observationId, "reconciliationLink.observationId");
    assertNonEmpty(input.matchKind, "reconciliationLink.matchKind");
    if (!Number.isSafeInteger(input.confidenceBps) || input.confidenceBps < 0 || input.confidenceBps > 10_000) {
      throw new TypeError("reconciliationLink.confidenceBps must be an integer from 0 through 10000");
    }
    if (!input.intentId && !input.executionId && !input.journalEntryId) {
      throw new TypeError("A reconciliation link must bind at least one wallet record");
    }
    const id = input.id ?? this.#newId();
    const run = this.db.transaction((): { link: ReconciliationLinkRecord; replayed: boolean } => {
      if (!this.getObservation(input.observationId)) {
        throw new WalletKernelStoreError(
          "RECONCILIATION_OBSERVATION_NOT_FOUND",
          `Observation ${input.observationId} does not exist`,
        );
      }
      if (input.intentId && !this.getPaymentIntent(input.intentId)) {
        throw new WalletKernelStoreError(
          "RECONCILIATION_INTENT_NOT_FOUND",
          `Payment intent ${input.intentId} does not exist`,
        );
      }
      if (input.executionId) {
        const execution = this.getExecution(input.executionId);
        if (!execution || (input.intentId && execution.intentId !== input.intentId)) {
          throw new WalletKernelStoreError(
            "RECONCILIATION_EXECUTION_MISMATCH",
            `Execution ${input.executionId} does not match the reconciliation intent`,
          );
        }
      }
      if (input.journalEntryId && !this.#getJournalEntry(input.journalEntryId)) {
        throw new WalletKernelStoreError(
          "RECONCILIATION_JOURNAL_NOT_FOUND",
          `Posted journal entry ${input.journalEntryId} does not exist`,
        );
      }
      const priorById = this.getReconciliationLink(id);
      const priorNaturalRow = this.db.query(
        `SELECT * FROM wk_reconciliation_links
         WHERE observation_id=? AND match_kind=?
           AND intent_id IS ? AND execution_id IS ? AND journal_entry_id IS ?
         ORDER BY created_at, id LIMIT 1`,
      ).get(
        input.observationId,
        input.matchKind,
        input.intentId ?? null,
        input.executionId ?? null,
        input.journalEntryId ?? null,
      ) as ReconciliationLinkRow | null;
      const priorNatural = priorNaturalRow ? mapReconciliationLink(priorNaturalRow) : null;
      const prior = priorById ?? priorNatural;
      if (prior) {
        const same =
          prior.observationId === input.observationId &&
          prior.intentId === (input.intentId ?? null) &&
          prior.executionId === (input.executionId ?? null) &&
          prior.journalEntryId === (input.journalEntryId ?? null) &&
          prior.matchKind === input.matchKind &&
          prior.confidenceBps === input.confidenceBps &&
          canonicalJson(prior.data) === canonicalJson(input.data ?? {});
        if (!same || (priorById !== null && priorNatural !== null && priorById.id !== priorNatural.id)) {
          throw new WalletKernelStoreError(
            "RECONCILIATION_LINK_FINGERPRINT_MISMATCH",
            "Reconciliation link identity was reused with different evidence",
          );
        }
        return { link: prior, replayed: true };
      }
      const at = this.#timestamp();
      this.db.query(
        `INSERT INTO wk_reconciliation_links
          (id, observation_id, intent_id, execution_id, journal_entry_id,
           match_kind, confidence_bps, data_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        id,
        input.observationId,
        input.intentId ?? null,
        input.executionId ?? null,
        input.journalEntryId ?? null,
        input.matchKind,
        input.confidenceBps,
        json(input.data),
        at,
      );
      const link = this.getReconciliationLink(id);
      if (!link) throw new Error(`Failed to read newly-recorded reconciliation link ${id}`);
      return { link, replayed: false };
    });
    return run.immediate();
  }

  getReconciliationLink(id: string): ReconciliationLinkRecord | null {
    const row = this.db.query("SELECT * FROM wk_reconciliation_links WHERE id=?").get(id) as
      | ReconciliationLinkRow
      | null;
    return row ? mapReconciliationLink(row) : null;
  }

  listReconciliationLinks(filter: { intentId?: string; observationId?: string } = {}): ReconciliationLinkRecord[] {
    const clauses: string[] = [];
    const values: string[] = [];
    if (filter.intentId !== undefined) {
      assertNonEmpty(filter.intentId, "reconciliationLinks.intentId");
      clauses.push("intent_id=?");
      values.push(filter.intentId);
    }
    if (filter.observationId !== undefined) {
      assertNonEmpty(filter.observationId, "reconciliationLinks.observationId");
      clauses.push("observation_id=?");
      values.push(filter.observationId);
    }
    const where = clauses.length === 0 ? "" : `WHERE ${clauses.join(" AND ")}`;
    return (this.db.query(
      `SELECT * FROM wk_reconciliation_links ${where} ORDER BY created_at, id`,
    ).all(...values) as ReconciliationLinkRow[]).map(mapReconciliationLink);
  }

  listReconciliationLinksForIntent(intentId: string): ReconciliationLinkRecord[] {
    return this.listReconciliationLinks({ intentId });
  }

  createSigningAuthorization(input: {
    id?: string;
    intentId: string;
    intentHash: string;
    keyId: string;
    requestHash: string;
    actor: Actor;
    method: string;
    grantHash: string;
    constraints?: JsonValue;
    expiresAt?: string | null;
  }): { authorization: SigningAuthorizationRecord; replayed: boolean } {
    for (const [field, value] of [
      ["authorization.intentHash", input.intentHash],
      ["authorization.keyId", input.keyId],
      ["authorization.requestHash", input.requestHash],
      ["authorization.grantHash", input.grantHash],
    ] as const) assertNonEmpty(value, field);
    const id = input.id ?? this.#newId();
    const run = this.db.transaction(() => {
      const intent = this.getPaymentIntent(input.intentId);
      if (!intent) throw new AuthorizationConflictError(`Payment intent ${input.intentId} does not exist`);
      if (intent.intentHash !== input.intentHash) {
        throw new AuthorizationConflictError(
          `Authorization intent hash does not match payment intent ${input.intentId}`,
        );
      }
      const at = this.#timestamp();
      if (input.expiresAt && input.expiresAt <= at) {
        throw new AuthorizationConflictError("A new signing authorization must expire in the future");
      }
      const priorById = this.getSigningAuthorization(id);
      const priorByGrant = this.db
        .query("SELECT * FROM wk_authorizations WHERE grant_hash=?")
        .get(input.grantHash) as AuthorizationRow | null;
      const prior = priorById ?? (priorByGrant ? mapAuthorization(priorByGrant) : null);
      if (prior) {
        const same =
          prior.id === id &&
          prior.intentId === input.intentId &&
          prior.intentHash === input.intentHash &&
          prior.keyId === input.keyId &&
          prior.requestHash === input.requestHash &&
          prior.actor.type === input.actor.type &&
          prior.actor.ref === input.actor.ref &&
          prior.method === input.method &&
          prior.grantHash === input.grantHash &&
          canonicalJson(prior.constraints) === canonicalJson(input.constraints ?? {}) &&
          prior.expiresAt === (input.expiresAt ?? null);
        if (!same) {
          throw new AuthorizationConflictError(
            `Authorization id or grant hash was reused with different signing bindings`,
          );
        }
        return { authorization: prior, replayed: true };
      }
      this.db
        .query(
          `INSERT INTO wk_authorizations
            (id, intent_id, intent_hash, key_id, request_hash, actor_type, actor_ref,
             method, grant_hash, constraints_json, status, expires_at, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ACTIVE', ?, ?)`,
        )
        .run(
          id,
          input.intentId,
          input.intentHash,
          input.keyId,
          input.requestHash,
          input.actor.type,
          input.actor.ref,
          input.method,
          input.grantHash,
          json(input.constraints),
          input.expiresAt ?? null,
          at,
        );
      const created = this.getSigningAuthorization(id);
      if (!created) throw new Error(`Failed to read newly-created signing authorization ${id}`);
      this.#outbox(
        "wallet.authorization.created",
        "SIGNING_AUTHORIZATION",
        id,
        { authorizationId: id, intentId: input.intentId, requestHash: input.requestHash },
        at,
      );
      return { authorization: created, replayed: false };
    });
    return run.immediate();
  }

  getSigningAuthorization(id: string): SigningAuthorizationRecord | null {
    const row = this.db.query("SELECT * FROM wk_authorizations WHERE id=?").get(id) as AuthorizationRow | null;
    return row ? mapAuthorization(row) : null;
  }

  getSignedArtifact(id: string): SignedArtifactRecord | null {
    const row = this.db.query("SELECT * FROM wk_signed_artifacts WHERE id=?").get(id) as
      | SignedArtifactRow
      | null;
    return row ? mapSignedArtifact(row) : null;
  }

  getSignedArtifactByAuthorization(authorizationId: string): SignedArtifactRecord | null {
    const row = this.db
      .query("SELECT * FROM wk_signed_artifacts WHERE authorization_id=?")
      .get(authorizationId) as SignedArtifactRow | null;
    return row ? mapSignedArtifact(row) : null;
  }

  /** Append exact wire bytes and consume their one-shot signer grant as one
   * IMMEDIATE transaction. Signing happens while the authorization is still
   * retryable; only a successfully committed artifact makes it CONSUMED. */
  persistSignedArtifact(input: {
    id?: string;
    authorizationId: string;
    intentId: string;
    intentHash: string;
    keyId: string;
    requestHash: string;
    encoding: "hex";
    payload: `0x${string}`;
    externalTxId: string;
  }): { artifact: SignedArtifactRecord; authorization: SigningAuthorizationRecord; replayed: boolean } {
    const envelope = signedEnvelopeEvidence(input.encoding, input.payload);
    if (
      input.externalTxId.trim() === "" ||
      input.externalTxId !== input.externalTxId.trim() ||
      input.externalTxId.length > 256
    ) {
      throw new AuthorizationConflictError("Signed artifact has an invalid external transaction id");
    }
    const id = input.id ?? `signed-artifact.${input.authorizationId}`;
    // Commit time is a security boundary: callers cannot backdate a signed
    // artifact to consume an authorization or reservation that has expired.
    const at = this.#timestamp();
    const run = this.db.transaction(():
      | { artifact: SignedArtifactRecord; authorization: SigningAuthorizationRecord; replayed: boolean }
      | AuthorizationConflictError => {
      const current = this.getSigningAuthorization(input.authorizationId);
      if (!current) {
        return new AuthorizationConflictError(
          `Signing authorization ${input.authorizationId} does not exist`,
        );
      }
      const bindingMatches =
        current.intentId === input.intentId &&
        current.intentHash === input.intentHash &&
        current.keyId === input.keyId &&
        current.requestHash === input.requestHash;
      if (!bindingMatches) {
        return new AuthorizationConflictError(
          `Signing authorization ${input.authorizationId} does not match the intent, key, and prepared request`,
        );
      }
      const priorById = this.getSignedArtifact(id);
      const priorByAuthorization = this.getSignedArtifactByAuthorization(input.authorizationId);
      const priorByEnvelope = this.db
        .query(
          `SELECT * FROM wk_signed_artifacts
           WHERE envelope_hash=? AND external_tx_id=?`,
        )
        .get(envelope.envelopeHash, input.externalTxId) as SignedArtifactRow | null;
      const prior = priorById ?? priorByAuthorization ?? (priorByEnvelope ? mapSignedArtifact(priorByEnvelope) : null);
      if (prior) {
        const committedClaims = this.db
          .query("SELECT state FROM wk_reservations WHERE intent_id=? ORDER BY id")
          .all(input.intentId) as Array<{ state: ReservationRecord["state"] }>;
        const same =
          prior.id === id &&
          prior.authorizationId === input.authorizationId &&
          prior.intentId === input.intentId &&
          prior.intentHash === input.intentHash &&
          prior.keyId === input.keyId &&
          prior.requestHash === input.requestHash &&
          prior.encoding === envelope.encoding &&
          prior.payload === envelope.payload &&
          prior.envelopeHash === envelope.envelopeHash &&
          prior.externalTxId === input.externalTxId;
        if (
          !same ||
          current.status !== "CONSUMED" ||
          committedClaims.length === 0 ||
          committedClaims.some((claim) => claim.state !== "CONSUMED")
        ) {
          return new AuthorizationConflictError(
            "Signed artifact id, authorization, or envelope was reused with different execution evidence",
          );
        }
        return { artifact: prior, authorization: current, replayed: true };
      }
      if (current.status !== "ACTIVE") {
        return new AuthorizationConflictError(
          `Signing authorization ${input.authorizationId} is ${current.status}; it is one-time use`,
        );
      }
      if (current.expiresAt && current.expiresAt <= at) {
        this.db
          .query(
            `UPDATE wk_authorizations SET status='EXPIRED'
             WHERE id=? AND status='ACTIVE' AND intent_id=? AND intent_hash=?
               AND key_id=? AND request_hash=?`,
          )
          .run(input.authorizationId, input.intentId, input.intentHash, input.keyId, input.requestHash);
        return new AuthorizationConflictError(
          `Signing authorization ${input.authorizationId} has expired`,
        );
      }
      const reservations = this.db
        .query("SELECT * FROM wk_reservations WHERE intent_id=? ORDER BY id")
        .all(input.intentId) as ReservationRow[];
      if (reservations.length === 0) {
        return new AuthorizationConflictError(
          `Signing authorization ${input.authorizationId} has no live resource reservations`,
        );
      }
      const expired = reservations.filter(
        (reservation) =>
          reservation.state === "ACTIVE" &&
          reservation.expires_at !== null &&
          reservation.expires_at <= at,
      );
      if (expired.length > 0) {
        this.db
          .query(
            `UPDATE wk_reservations
             SET state='EXPIRED', version=version+1, updated_at=?
             WHERE intent_id=? AND state='ACTIVE'
               AND expires_at IS NOT NULL AND expires_at <= ?`,
          )
          .run(at, input.intentId, at);
        return new AuthorizationConflictError(
          `Signing authorization ${input.authorizationId} has expired resource reservations`,
        );
      }
      if (reservations.some((reservation) => reservation.state !== "ACTIVE")) {
        return new AuthorizationConflictError(
          `Signing authorization ${input.authorizationId} does not own every required resource`,
        );
      }
      this.db
        .query(
          `INSERT INTO wk_signed_artifacts
            (id, authorization_id, intent_id, intent_hash, key_id, request_hash,
             encoding, payload, envelope_hash, external_tx_id, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          input.authorizationId,
          input.intentId,
          input.intentHash,
          input.keyId,
          input.requestHash,
          envelope.encoding,
          envelope.payload,
          envelope.envelopeHash,
          input.externalTxId,
          at,
        );
      const consumed = this.getSigningAuthorization(input.authorizationId);
      const artifact = this.getSignedArtifact(id);
      const committedReservations = this.db
        .query("SELECT * FROM wk_reservations WHERE intent_id=? ORDER BY id")
        .all(input.intentId) as ReservationRow[];
      if (
        !consumed ||
        consumed.status !== "CONSUMED" ||
        !artifact ||
        committedReservations.length !== reservations.length ||
        committedReservations.some((reservation) => reservation.state !== "CONSUMED")
      ) {
        throw new Error(
          `Signed artifact ${id}, its authorization, or its resource claims disappeared during commit`,
        );
      }
      for (const reservation of committedReservations) {
        this.#outbox(
          "wallet.reservation.consumed",
          "RESERVATION",
          reservation.id,
          {
            reservationId: reservation.id,
            intentId: input.intentId,
            signedArtifactId: artifact.id,
            state: reservation.state,
            version: reservation.version,
          },
          at,
        );
      }
      this.#outbox(
        "wallet.authorization.consumed",
        "SIGNING_AUTHORIZATION",
        input.authorizationId,
        {
          authorizationId: input.authorizationId,
          artifactId: artifact.id,
          intentId: input.intentId,
          requestHash: input.requestHash,
          envelopeHash: artifact.envelopeHash,
          externalTxId: artifact.externalTxId,
        },
        at,
      );
      this.#outbox(
        "wallet.signed_artifact.recorded",
        "SIGNED_ARTIFACT",
        artifact.id,
        {
          artifactId: artifact.id,
          authorizationId: input.authorizationId,
          intentId: input.intentId,
          envelopeHash: artifact.envelopeHash,
          externalTxId: artifact.externalTxId,
        },
        at,
      );
      return { artifact, authorization: consumed, replayed: false };
    });
    const result = run.immediate();
    if (result instanceof AuthorizationConflictError) throw result;
    return result;
  }

  /** Deliberately fail closed: a signing grant may no longer be consumed
   * without the exact append-only artifact it authorized. */
  consumeSigningAuthorization(): never {
    throw new AuthorizationConflictError(
      "Signing authorization consumption requires persistSignedArtifact() and exact signed bytes",
    );
  }

  acquireReservation(input: {
    id?: string;
    intentId: string;
    accountId: string;
    assetId: string;
    kind: ReservationRecord["kind"];
    resourceKey?: string | null;
    amountAtomic: string;
    expiresAt?: string | null;
    enforceAvailable?: boolean;
  }): { reservation: ReservationRecord; replayed: boolean; availableAfterAtomic: string | null } {
    assertCanonicalInteger(input.amountAtomic, "reservation.amountAtomic", { positive: true });
    if ((input.kind === "UTXO" || input.kind === "NONCE") && !input.resourceKey) {
      throw new TypeError(`${input.kind} reservations require resourceKey`);
    }
    const id = input.id ?? this.#newId();
    const run = this.db.transaction(() => {
      const now = this.#timestamp();
      if (input.expiresAt && input.expiresAt <= now) {
        throw new ReservationConflictError("A new reservation must expire in the future");
      }
      this.db
        .query(
          `UPDATE wk_reservations
           SET state='EXPIRED', version=version+1, updated_at=?
           WHERE state='ACTIVE' AND expires_at IS NOT NULL AND expires_at <= ?`,
        )
        .run(now, now);

      const prior = this.getReservation(id);
      if (prior) {
        const same =
          prior.intentId === input.intentId &&
          prior.accountId === input.accountId &&
          prior.assetId === input.assetId &&
          prior.kind === input.kind &&
          prior.resourceKey === (input.resourceKey ?? null) &&
          prior.amountAtomic === input.amountAtomic &&
          prior.expiresAt === (input.expiresAt ?? null);
        if (!same) throw new ReservationConflictError(`Reservation id ${id} was reused with different terms`);
        return { reservation: prior, replayed: true, availableAfterAtomic: null };
      }

      if (input.resourceKey) {
        const claimed = this.db
          .query(
            `SELECT id FROM wk_reservations
             WHERE account_id=? AND kind=? AND resource_key=?
               AND state IN ('ACTIVE','CONSUMED')`,
          )
          .get(input.accountId, input.kind, input.resourceKey) as { id: string } | null;
        if (claimed) {
          throw new ReservationConflictError(
            `${input.kind} resource ${input.resourceKey} is already committed to another payment by reservation ${claimed.id}`,
          );
        }
      }

      let availableAfterAtomic: string | null = null;
      const enforceAvailable = input.enforceAvailable ?? input.kind === "BALANCE";
      if (enforceAvailable) {
        const position = this.db
          .query(
            "SELECT observed_atomic FROM wk_positions WHERE account_id=? AND asset_id=?",
          )
          .get(input.accountId, input.assetId) as { observed_atomic: string } | null;
        const active = this.db
          .query(
            `SELECT amount_atomic FROM wk_reservations
             WHERE account_id=? AND asset_id=? AND state='ACTIVE'
               AND kind='BALANCE'
               AND (expires_at IS NULL OR expires_at > ?)`,
          )
          .all(input.accountId, input.assetId, now) as Array<{ amount_atomic: string }>;
        const reserved = active.reduce((sum, row) => sum + BigInt(row.amount_atomic), 0n);
        const available = BigInt(position?.observed_atomic ?? "0") - reserved;
        const requested = BigInt(input.amountAtomic);
        if (available < requested) {
          throw new InsufficientAvailableBalanceError(
            input.accountId,
            input.assetId,
            input.amountAtomic,
            available.toString(),
          );
        }
        availableAfterAtomic = (available - requested).toString();
      }

      this.db
        .query(
          `INSERT INTO wk_reservations
            (id, intent_id, account_id, asset_id, kind, resource_key, amount_atomic,
             state, expires_at, version, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'ACTIVE', ?, 0, ?, ?)`,
        )
        .run(
          id,
          input.intentId,
          input.accountId,
          input.assetId,
          input.kind,
          input.resourceKey ?? null,
          input.amountAtomic,
          input.expiresAt ?? null,
          now,
          now,
        );
      const reservation = this.getReservation(id);
      if (!reservation) throw new Error(`Failed to read newly-created reservation ${id}`);
      this.#outbox(
        "wallet.reservation.acquired",
        "RESERVATION",
        id,
        { reservationId: id, intentId: input.intentId },
        now,
      );
      return { reservation, replayed: false, availableAfterAtomic };
    });
    return run.immediate();
  }

  getReservation(id: string): ReservationRecord | null {
    const row = this.db.query("SELECT * FROM wk_reservations WHERE id=?").get(id) as ReservationRow | null;
    return row ? mapReservation(row) : null;
  }

  getReservationResolution(id: string): ReservationResolutionRecord | null {
    const row = this.db
      .query("SELECT * FROM wk_reservation_resolutions WHERE id=?")
      .get(id) as ReservationResolutionRow | null;
    return row ? mapReservationResolution(row) : null;
  }

  /**
   * Reopen a signed nonce/UTXO only after a reconciler has persisted exact,
   * immutable evidence that the execution was dropped/replaced and that this
   * particular resource is reusable. Ordinary releaseReservation deliberately
   * remains unable to release a CONSUMED claim.
   */
  releaseConsumedReservationAfterReconciliation(input: {
    id?: string;
    reservationId: string;
    expectedVersion: number;
    executionId: string;
    evidenceReceiptId: string;
    outcome: ReservationResolutionOutcome;
    matchBasis: ReconciliationMatchBasis;
    verifiedBy: Actor;
    data?: JsonValue;
  }): {
    reservation: ReservationRecord;
    resolution: ReservationResolutionRecord;
    replayed: boolean;
  } {
    if (!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 0) {
      throw new TypeError("expectedVersion must be a non-negative safe integer");
    }
    if (input.outcome !== "DROPPED" && input.outcome !== "REPLACED") {
      throw new TypeError("reservation resolution outcome must be DROPPED or REPLACED");
    }
    if (
      input.matchBasis !== "exact-rail-reference" &&
      input.matchBasis !== "exact-transaction-id" &&
      input.matchBasis !== "provider-idempotency-key"
    ) {
      throw new TypeError("reservation resolution requires a supported exact match basis");
    }
    for (const [field, value] of [
      ["resolution.reservationId", input.reservationId],
      ["resolution.executionId", input.executionId],
      ["resolution.evidenceReceiptId", input.evidenceReceiptId],
      ["resolution.verifiedBy.type", input.verifiedBy.type],
      ["resolution.verifiedBy.ref", input.verifiedBy.ref],
    ] as const) assertNonEmpty(value, field);

    const requestedId = input.id;
    const id = requestedId ?? this.#newId();
    const resolutionData = input.data ?? {};
    const run = this.db.transaction(() => {
      const priorByReservation = this.db
        .query("SELECT * FROM wk_reservation_resolutions WHERE reservation_id=?")
        .get(input.reservationId) as ReservationResolutionRow | null;
      const priorById = this.db
        .query("SELECT * FROM wk_reservation_resolutions WHERE id=?")
        .get(id) as ReservationResolutionRow | null;
      if (priorByReservation || priorById) {
        if (
          priorByReservation &&
          priorById &&
          priorByReservation.id !== priorById.id
        ) {
          throw new ReservationConflictError(
            "Resolution id and reservation were already bound to different evidence",
          );
        }
        const prior = mapReservationResolution(priorByReservation ?? priorById!);
        const reservation = this.getReservation(input.reservationId);
        const same =
          (requestedId === undefined || prior.id === id) &&
          prior.reservationId === input.reservationId &&
          prior.executionId === input.executionId &&
          prior.evidenceReceiptId === input.evidenceReceiptId &&
          prior.outcome === input.outcome &&
          prior.matchBasis === input.matchBasis &&
          prior.verifiedBy.type === input.verifiedBy.type &&
          prior.verifiedBy.ref === input.verifiedBy.ref &&
          canonicalJson(prior.data) === canonicalJson(resolutionData) &&
          reservation?.state === "RELEASED" &&
          reservation.version === input.expectedVersion + 1;
        if (!same || !reservation) {
          throw new ReservationConflictError(
            `Reservation ${input.reservationId} was already resolved with different evidence`,
          );
        }
        return { reservation, resolution: prior, replayed: true };
      }

      const reservation = this.getReservation(input.reservationId);
      if (!reservation) {
        throw new ReservationConflictError(`Reservation ${input.reservationId} does not exist`);
      }
      if (
        reservation.state !== "CONSUMED" ||
        reservation.version !== input.expectedVersion
      ) {
        throw new ReservationConflictError(
          `Reservation ${input.reservationId} is ${reservation.state}@${reservation.version}; expected CONSUMED@${input.expectedVersion}`,
        );
      }
      if (
        (reservation.kind !== "NONCE" && reservation.kind !== "UTXO") ||
        reservation.resourceKey === null
      ) {
        throw new ReservationConflictError(
          "Only an exact consumed NONCE or UTXO resource claim can be reconciler-released",
        );
      }

      const execution = this.getExecution(input.executionId);
      if (!execution || execution.intentId !== reservation.intentId) {
        throw new ReservationConflictError(
          `Execution ${input.executionId} is absent or belongs to another intent`,
        );
      }
      if (execution.state.toUpperCase() !== input.outcome) {
        throw new ReservationConflictError(
          `Execution ${input.executionId} is ${execution.state}; expected verified ${input.outcome.toLowerCase()} state`,
        );
      }
      const matchedReference = input.matchBasis === "exact-transaction-id"
        ? execution.networkTxId
        : input.matchBasis === "exact-rail-reference"
          ? execution.submissionRef
          : execution.idempotencyKey;
      if (!matchedReference) {
        throw new ReservationConflictError(
          `Execution ${input.executionId} has no ${input.matchBasis} reference`,
        );
      }

      const receipt = this.getReceipt(input.evidenceReceiptId);
      const expectedReceiptKind = `RECONCILIATION_${input.outcome}`;
      if (
        !receipt ||
        receipt.intentId !== reservation.intentId ||
        receipt.executionId !== execution.id ||
        receipt.kind !== expectedReceiptKind
      ) {
        throw new ReservationConflictError(
          `Receipt ${input.evidenceReceiptId} is not ${expectedReceiptKind} evidence for this execution`,
        );
      }
      if (
        receipt.body === null ||
        Array.isArray(receipt.body) ||
        typeof receipt.body !== "object"
      ) {
        throw new ReservationConflictError("Reconciliation receipt body is malformed");
      }
      const evidence = receipt.body as { readonly [key: string]: JsonValue };
      const exactEvidence =
        evidence.schema_version === "cashloom.reservation-release-evidence/1" &&
        evidence.verified === true &&
        evidence.resource_reusable === true &&
        evidence.reservation_id === reservation.id &&
        evidence.intent_id === reservation.intentId &&
        evidence.execution_id === execution.id &&
        evidence.outcome === input.outcome &&
        evidence.match_basis === input.matchBasis &&
        evidence.matched_reference === matchedReference;
      if (!exactEvidence) {
        throw new ReservationConflictError(
          "Reconciliation receipt does not exactly bind this reusable resource and execution outcome",
        );
      }

      const at = this.#timestamp();
      this.db
        .query(
          `INSERT INTO wk_reservation_resolutions
            (id, reservation_id, intent_id, execution_id, evidence_receipt_id,
             evidence_receipt_hash, outcome, match_basis, matched_reference,
             verifier_type, verifier_ref, data_json, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          reservation.id,
          reservation.intentId,
          execution.id,
          receipt.id,
          receipt.receiptHash,
          input.outcome,
          input.matchBasis,
          matchedReference,
          input.verifiedBy.type,
          input.verifiedBy.ref,
          json(resolutionData),
          at,
        );
      const released = this.db
        .query(
          `UPDATE wk_reservations
           SET state='RELEASED', version=version+1, updated_at=?, released_at=?
           WHERE id=? AND state='CONSUMED' AND version=?`,
        )
        .run(at, at, reservation.id, input.expectedVersion);
      if (released.changes !== 1) {
        throw new ReservationConflictError(
          `Reservation ${reservation.id} changed concurrently during reconciliation`,
        );
      }
      const updated = this.getReservation(reservation.id);
      const resolution = this.getReservationResolution(id);
      if (!updated || !resolution) {
        throw new Error(`Failed to read reconciled reservation ${reservation.id}`);
      }
      this.#outbox(
        "wallet.reservation.reconciled_release",
        "RESERVATION",
        reservation.id,
        {
          reservationId: reservation.id,
          intentId: reservation.intentId,
          resolutionId: id,
          evidenceReceiptId: receipt.id,
          outcome: input.outcome,
        },
        at,
      );
      return { reservation: updated, resolution, replayed: false };
    });
    return run.immediate();
  }

  consumeReservation(id: string, expectedVersion: number): ReservationRecord {
    return this.#finishReservation(id, expectedVersion, "CONSUMED");
  }

  releaseReservation(id: string, expectedVersion: number): ReservationRecord {
    return this.#finishReservation(id, expectedVersion, "RELEASED");
  }

  #finishReservation(
    id: string,
    expectedVersion: number,
    state: "CONSUMED" | "RELEASED",
  ): ReservationRecord {
    if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 0) {
      throw new TypeError("expectedVersion must be a non-negative safe integer");
    }
    const run = this.db.transaction((): ReservationRecord | ReservationConflictError => {
      const current = this.getReservation(id);
      if (!current) return new ReservationConflictError(`Reservation ${id} does not exist`);
      const now = this.#timestamp();
      if (state === "CONSUMED" && current.state === "ACTIVE" && current.expiresAt && current.expiresAt <= now) {
        this.db
          .query(
            `UPDATE wk_reservations SET state='EXPIRED', version=version+1, updated_at=?
             WHERE id=? AND state='ACTIVE' AND version=?`,
          )
          .run(now, id, expectedVersion);
        return new ReservationConflictError(`Reservation ${id} has expired`);
      }
      if (current.state !== "ACTIVE" || current.version !== expectedVersion) {
        return new ReservationConflictError(
          `Reservation ${id} is ${current.state}@${current.version}; expected ACTIVE@${expectedVersion}`,
        );
      }
      const result = this.db
        .query(
          `UPDATE wk_reservations
           SET state=?, version=version+1, updated_at=?,
               consumed_at=CASE WHEN ?='CONSUMED' THEN ? ELSE consumed_at END,
               released_at=CASE WHEN ?='RELEASED' THEN ? ELSE released_at END
           WHERE id=? AND state='ACTIVE' AND version=?`,
        )
        .run(state, now, state, now, state, now, id, expectedVersion);
      if (result.changes !== 1) {
        return new ReservationConflictError(`Reservation ${id} changed concurrently`);
      }
      const updated = this.getReservation(id);
      if (!updated) throw new Error(`Reservation ${id} disappeared during transition`);
      this.#outbox(
        `wallet.reservation.${state.toLowerCase()}`,
        "RESERVATION",
        id,
        { reservationId: id, intentId: updated.intentId },
        now,
      );
      return updated;
    });
    const result = run.immediate();
    if (result instanceof ReservationConflictError) throw result;
    return result;
  }

  postJournalEntry(input: {
    id?: string;
    description: string;
    effectiveAt: string;
    referenceType?: string | null;
    referenceId?: string | null;
    metadata?: JsonValue;
    postings: ReadonlyArray<{
      id?: string;
      ledgerAccountId: string;
      assetId: string;
      direction: PostingDirection;
      amountAtomic: string;
      memo?: string | null;
    }>;
  }): { entry: JournalEntryRecord; replayed: boolean } {
    if (input.postings.length < 2) {
      throw new JournalUnbalancedError({ _entry: "fewer-than-two-postings" });
    }
    const balances = new Map<string, bigint>();
    input.postings.forEach((posting, index) => {
      if (posting.direction !== "DEBIT" && posting.direction !== "CREDIT") {
        throw new TypeError(`postings[${index}].direction must be DEBIT or CREDIT`);
      }
      assertCanonicalInteger(posting.amountAtomic, `postings[${index}].amountAtomic`, { positive: true });
      const signed = posting.direction === "DEBIT"
        ? BigInt(posting.amountAtomic)
        : -BigInt(posting.amountAtomic);
      balances.set(posting.assetId, (balances.get(posting.assetId) ?? 0n) + signed);
    });
    const differences = Object.fromEntries(
      [...balances.entries()].filter(([, amount]) => amount !== 0n).map(([asset, amount]) => [asset, amount.toString()]),
    );
    if (Object.keys(differences).length > 0) throw new JournalUnbalancedError(differences);

    const fingerprint = fingerprintRequest({
      description: input.description,
      effectiveAt: input.effectiveAt,
      referenceType: input.referenceType ?? null,
      referenceId: input.referenceId ?? null,
      metadata: input.metadata ?? {},
      postings: input.postings.map((posting) => ({
        ledgerAccountId: posting.ledgerAccountId,
        assetId: posting.assetId,
        direction: posting.direction,
        amountAtomic: posting.amountAtomic,
        memo: posting.memo ?? null,
      })),
    });
    const id = input.id ?? this.#newId();
    const run = this.db.transaction((): { entry: JournalEntryRecord; replayed: boolean } => {
      const existing = this.#getJournalEntry(id);
      if (existing) {
        if (existing.entryFingerprint !== fingerprint) {
          throw new WalletKernelStoreError(
            "JOURNAL_ENTRY_FINGERPRINT_MISMATCH",
            `Journal entry id ${id} was already posted with different content`,
          );
        }
        return { entry: existing, replayed: true };
      }
      const at = this.#timestamp();
      this.db
        .query(
          `INSERT INTO wk_journal_entries
            (id, description, effective_at, reference_type, reference_id, entry_fingerprint,
             status, metadata_json, created_at)
           VALUES (?, ?, ?, ?, ?, ?, 'DRAFT', ?, ?)`,
        )
        .run(
          id,
          input.description,
          input.effectiveAt,
          input.referenceType ?? null,
          input.referenceId ?? null,
          fingerprint,
          json(input.metadata),
          at,
        );
      input.postings.forEach((posting, index) => {
        this.db
          .query(
            `INSERT INTO wk_postings
              (id, journal_entry_id, posting_index, ledger_account_id, asset_id,
               direction, amount_atomic, memo, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            posting.id ?? this.#newId(),
            id,
            index,
            posting.ledgerAccountId,
            posting.assetId,
            posting.direction,
            posting.amountAtomic,
            posting.memo ?? null,
            at,
          );
      });
      const posted = this.db
        .query("UPDATE wk_journal_entries SET status='POSTED', posted_at=? WHERE id=? AND status='DRAFT'")
        .run(at, id);
      if (posted.changes !== 1) throw new Error(`Failed to post journal entry ${id}`);
      this.#outbox("wallet.journal.posted", "JOURNAL_ENTRY", id, { journalEntryId: id }, at);
      const entry = this.#getJournalEntry(id);
      if (!entry) throw new Error(`Failed to read newly-posted journal entry ${id}`);
      return { entry, replayed: false };
    });
    return run.immediate();
  }

  getJournalEntry(id: string): JournalEntryRecord | null {
    return this.#getJournalEntry(id);
  }

  listJournalEntriesForReferencePrefix(input: {
    referenceIdPrefix: string;
    referenceType?: string;
  }): JournalEntryRecord[] {
    assertNonEmpty(input.referenceIdPrefix, "journal.referenceIdPrefix");
    if (input.referenceType !== undefined) {
      assertNonEmpty(input.referenceType, "journal.referenceType");
    }
    const escapedPrefix = input.referenceIdPrefix.replace(/[\\%_]/g, "\\$&");
    const rows = input.referenceType === undefined
      ? this.db.query(
          `SELECT id FROM wk_journal_entries
           WHERE status='POSTED' AND reference_id LIKE ? ESCAPE '\\'
           ORDER BY effective_at, created_at, id`,
        ).all(`${escapedPrefix}%`)
      : this.db.query(
          `SELECT id FROM wk_journal_entries
           WHERE status='POSTED' AND reference_type=?
             AND reference_id LIKE ? ESCAPE '\\'
           ORDER BY effective_at, created_at, id`,
        ).all(input.referenceType, `${escapedPrefix}%`);
    return (rows as Array<{ id: string }>).map(({ id }) => {
      const entry = this.#getJournalEntry(id);
      if (!entry) throw new Error(`Posted journal entry ${id} disappeared during audit read`);
      return entry;
    });
  }

  #getJournalEntry(id: string): JournalEntryRecord | null {
    const entry = this.db
      .query("SELECT * FROM wk_journal_entries WHERE id=? AND status='POSTED'")
      .get(id) as
      | {
          id: string;
          description: string;
          effective_at: string;
          reference_type: string | null;
          reference_id: string | null;
          entry_fingerprint: string;
          metadata_json: string;
          created_at: string;
          posted_at: string;
        }
      | null;
    if (!entry) return null;
    const postings = this.db
      .query("SELECT * FROM wk_postings WHERE journal_entry_id=? ORDER BY posting_index")
      .all(id) as Array<{
      id: string;
      posting_index: number;
      ledger_account_id: string;
      asset_id: string;
      direction: PostingDirection;
      amount_atomic: string;
      memo: string | null;
    }>;
    return {
      id: entry.id,
      description: entry.description,
      effectiveAt: entry.effective_at,
      referenceType: entry.reference_type,
      referenceId: entry.reference_id,
      entryFingerprint: entry.entry_fingerprint,
      status: "POSTED",
      metadata: JSON.parse(entry.metadata_json) as JsonValue,
      createdAt: entry.created_at,
      postedAt: entry.posted_at,
      postings: postings.map((posting) => ({
        id: posting.id,
        index: posting.posting_index,
        ledgerAccountId: posting.ledger_account_id,
        assetId: posting.asset_id,
        direction: posting.direction,
        amountAtomic: posting.amount_atomic,
        memo: posting.memo,
      })),
    };
  }
}
