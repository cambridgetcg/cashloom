/**
 * Closed local creation workflows for CashLoom v2.
 *
 * This is intentionally not a generic signing oracle. Each method supplies
 * schema, authority, nonce, timestamps, disclosure defaults, and ancestry.
 * Callers choose bounded payment terms and explicit local trust inputs only.
 */

import {
  assertSha256Id,
  assertTimestamp,
  type Sha256Id,
} from "@agenttool/wallet";
import {
  FAIL_CLOSED_ASSET_TRUST_POLICY,
  evaluateAssetTrust,
  parseAssetTrustPolicy,
  type AssetTrustDecision,
  type AssetTrustPolicy,
} from "./asset-trust.ts";
import type { V2NodeAuthorityProvider } from "./node-authority.ts";
import {
  V2RecordStoreError,
  type CashLoomV2RecordStore,
} from "./record-store.ts";
import {
  V2_SCHEMAS,
  createAssetTrustManifestRecord,
  createExecutionCommitment,
  createNodeDescriptor,
  createPaymentIntent,
  createPaymentRequest,
  signV2Record,
  v2Nonce,
  v2RecordBytes,
  verifyV2Record,
  type AssetTrustManifestRecordCore,
  type AssetTrustBinding,
  type ExecutionCommitmentCore,
  type NodeDescriptorCore,
  type NodeRole,
  type PaymentIntentCore,
  type PaymentRequestCore,
  type V2Audience,
  type V2Disclosure,
  type VerifiedV2Record,
} from "./records.ts";
import type { AssetTrustManifest } from "./asset-trust.ts";

export type V2LocalServiceErrorCode =
  | "NODE_NOT_ACTIVATED"
  | "WRONG_RECORD_KIND"
  | "ASSET_TRUST_AUTHORITY_MISMATCH"
  | "ASSET_TRUST_ASSET_MISMATCH"
  | "ASSET_TRUST_RAIL_MISMATCH"
  | "ASSET_TRUST_DISCLOSURE_MISMATCH"
  | "ASSET_POLICY_REJECTED"
  | "LOCAL_PAYMENT_INTENT_REQUIRED"
  | "PAYMENT_INTENT_INACTIVE"
  | "INVALID_EXECUTION_WINDOW"
  | "EXECUTION_COMMITMENT_CONFLICT";

export class V2LocalServiceError extends Error {
  readonly code: V2LocalServiceErrorCode;
  readonly decision?: AssetTrustDecision;

  constructor(
    code: V2LocalServiceErrorCode,
    message: string,
    decision?: AssetTrustDecision,
  ) {
    super(message);
    this.name = "V2LocalServiceError";
    this.code = code;
    this.decision = decision;
  }
}

export interface AssetTrustSelection {
  readonly record_id: string;
  /**
   * Explicit local pin. A valid self-signature proves authorship, not that the
   * author is trusted; the unlocked node owner chooses this key fingerprint.
   */
  readonly trusted_authority_key_id: string;
  readonly policy?: AssetTrustPolicy;
}

export interface ActivateNodeInput {
  readonly roles?: readonly NodeRole[];
  readonly ttl_seconds?: number;
}

export interface CreateAssetTrustManifestInput {
  readonly manifest: AssetTrustManifest;
  readonly audience?: V2Audience;
  readonly disclosure?: V2Disclosure;
  readonly ttl_seconds?: number;
}

export interface CreatePaymentRequestInput {
  readonly rail: string;
  readonly destination: string;
  readonly asset_id: string;
  readonly amount_atomic: string;
  readonly purpose_hash: string;
  readonly asset_trust: AssetTrustSelection;
  readonly audience?: V2Audience;
  readonly disclosure?: V2Disclosure;
  readonly ttl_seconds?: number;
}

export interface CreatePaymentIntentInput {
  readonly request_record_id: string;
  readonly source_account: string;
  readonly fee_asset_id: string;
  /**
   * Total exposure in fee_asset_id atomic units. It is not an RPC estimate or
   * a partial L2 subtotal.
   */
  readonly max_fee_atomic: string;
  readonly payment_asset_trust: AssetTrustSelection;
  readonly fee_asset_trust: AssetTrustSelection;
  readonly ttl_seconds?: number;
}

export interface CreateExecutionCommitmentInput {
  readonly intent_record_id: string;
  readonly reservation_id: string;
  readonly unsigned_payload_hash: string;
  readonly expires_at: string;
}

export interface CreatedWithAssetTrust<T> {
  readonly record: T;
  readonly asset_trust: AssetTrustDecision;
}

export interface CreatedIntentWithAssetTrust {
  readonly record: VerifiedV2Record<PaymentIntentCore>;
  readonly payment_asset_trust: AssetTrustDecision;
  readonly fee_asset_trust: AssetTrustDecision;
}

export interface CreatedExecutionCommitment {
  readonly record: VerifiedV2Record<ExecutionCommitmentCore>;
  readonly reused: boolean;
}

interface ResolvedAssetTrust {
  readonly decision: AssetTrustDecision;
  readonly binding: AssetTrustBinding;
  readonly manifestDisclosure: V2Disclosure;
}

export interface V2LocalServiceDependencies {
  readonly store: CashLoomV2RecordStore;
  readonly authorityProvider: V2NodeAuthorityProvider;
  readonly now?: () => string;
  readonly randomBytes?: (length: number) => Uint8Array;
}

const TTL = Object.freeze({
  node: { default: 7 * 24 * 60 * 60, max: 30 * 24 * 60 * 60 },
  asset: { default: 7 * 24 * 60 * 60, max: 30 * 24 * 60 * 60 },
  request: { default: 60 * 60, max: 24 * 60 * 60 },
  intent: { default: 5 * 60, max: 10 * 60 },
});

const defaultRandomBytes = (length: number): Uint8Array =>
  crypto.getRandomValues(new Uint8Array(length));

function selectedTtl(
  value: number | undefined,
  bounds: { default: number; max: number },
): number {
  const ttl = value ?? bounds.default;
  if (!Number.isSafeInteger(ttl) || ttl < 1 || ttl > bounds.max) {
    throw new TypeError(`ttl_seconds must be an integer from 1 through ${bounds.max}.`);
  }
  return ttl;
}

function expiry(issuedAt: string, seconds: number): string {
  const milliseconds = Date.parse(issuedAt);
  if (!Number.isFinite(milliseconds)) {
    throw new TypeError("The local clock did not return a valid timestamp.");
  }
  return new Date(milliseconds + seconds * 1_000).toISOString();
}

function normalizedRoles(value: readonly NodeRole[] | undefined): NodeRole[] {
  const roles = [...(value ?? ["merchant", "payer"])];
  roles.sort();
  return roles;
}

function localNow(now: () => string): string {
  const value = now();
  assertTimestamp(value, "now");
  return value;
}

function activeRecord<T extends NodeDescriptorCore | PaymentRequestCore>(
  record: VerifiedV2Record<T>,
  now: string,
): VerifiedV2Record<T> {
  return verifyV2Record(record, { now }) as unknown as VerifiedV2Record<T>;
}

function sameExecutionCommitmentInput(
  record: VerifiedV2Record<ExecutionCommitmentCore>,
  input: CreateExecutionCommitmentInput,
): boolean {
  return record.reservation_id === input.reservation_id
    && record.unsigned_payload_hash === input.unsigned_payload_hash
    && record.expires_at === input.expires_at;
}

function executionCommitmentConflict(
  existing: VerifiedV2Record<ExecutionCommitmentCore> | null,
  cause?: unknown,
): V2LocalServiceError {
  const error = new V2LocalServiceError(
    "EXECUTION_COMMITMENT_CONFLICT",
    existing === null
      ? "The payment intent already has an execution commitment that is not an exact local retry."
      : `Payment intent already has different execution commitment ${existing.record_id}.`,
  );
  if (cause !== undefined) error.cause = cause;
  return error;
}

export function createV2LocalService(dependencies: V2LocalServiceDependencies) {
  const { store, authorityProvider } = dependencies;
  const now = dependencies.now ?? (() => new Date().toISOString());
  const randomBytes = dependencies.randomBytes ?? defaultRandomBytes;

  const nonce = (): string => {
    const entropy = randomBytes(16);
    if (!(entropy instanceof Uint8Array)) {
      throw new TypeError("randomBytes must return a Uint8Array.");
    }
    return v2Nonce(Uint8Array.from(entropy));
  };

  const signingDescriptor = async (
    issuedAt: string,
    requiredRole: NodeRole,
  ): Promise<VerifiedV2Record<NodeDescriptorCore>> => {
    const node = await authorityProvider.ensure();
    const descriptor = store.latestPublicNodeDescriptor();
    if (
      descriptor === null
      || descriptor.authority.key_id !== node.authority.key_id
    ) {
      throw new V2LocalServiceError(
        "NODE_NOT_ACTIVATED",
        "Activate this sovereign node's signed v2 descriptor first.",
      );
    }
    const active = activeRecord(descriptor, issuedAt);
    if (!active.roles.includes(requiredRole)) {
      throw new V2LocalServiceError(
        "NODE_NOT_ACTIVATED",
        `The active v2 descriptor does not declare the ${requiredRole} role.`,
      );
    }
    return active;
  };

  const assetTrust = (
    selection: AssetTrustSelection,
    expectedAssetId: string,
    expectedRail: string,
    issuedAt: string,
  ): ResolvedAssetTrust => {
    assertSha256Id(selection.record_id, "asset_trust.record_id");
    assertSha256Id(
      selection.trusted_authority_key_id,
      "asset_trust.trusted_authority_key_id",
    );
    const stored = store.getLocal(selection.record_id);
    if (stored === null || stored.schema !== V2_SCHEMAS.asset_trust_manifest) {
      throw new V2LocalServiceError(
        "WRONG_RECORD_KIND",
        "The selected asset-trust record is missing or has the wrong schema.",
      );
    }
    const manifestRecord = verifyV2Record(stored, {
      now: issuedAt,
    }) as VerifiedV2Record<AssetTrustManifestRecordCore>;
    if (
      manifestRecord.authority.key_id !==
      selection.trusted_authority_key_id
    ) {
      throw new V2LocalServiceError(
        "ASSET_TRUST_AUTHORITY_MISMATCH",
        "The asset-trust record is not signed by the explicitly pinned authority.",
      );
    }
    if (manifestRecord.manifest.asset_id !== expectedAssetId) {
      throw new V2LocalServiceError(
        "ASSET_TRUST_ASSET_MISMATCH",
        "The selected asset-trust record describes a different asset.",
      );
    }
    if (manifestRecord.manifest.rail !== expectedRail) {
      throw new V2LocalServiceError(
        "ASSET_TRUST_RAIL_MISMATCH",
        "The selected asset-trust record describes a different rail context.",
      );
    }
    const policy = parseAssetTrustPolicy(
      selection.policy ?? FAIL_CLOSED_ASSET_TRUST_POLICY,
    );
    const decision = evaluateAssetTrust(manifestRecord.manifest, policy);
    if (!decision.accepted) {
      throw new V2LocalServiceError(
        "ASSET_POLICY_REJECTED",
        `Local asset policy rejected ${expectedAssetId}.`,
        decision,
      );
    }
    return Object.freeze({
      decision,
      manifestDisclosure: manifestRecord.disclosure,
      binding: Object.freeze({
        manifest_record_id: manifestRecord.record_id,
        manifest_authority_key_id: manifestRecord.authority.key_id,
        policy,
        policy_hash: decision.policy_hash,
      }),
    });
  };

  return Object.freeze({
    async activateNode(
      input: ActivateNodeInput = {},
    ): Promise<VerifiedV2Record<NodeDescriptorCore>> {
      const issuedAt = localNow(now);
      const roles = normalizedRoles(input.roles);
      const existing = store.latestPublicNodeDescriptor();
      const node = await authorityProvider.ensure();
      if (
        existing !== null
        && existing.authority.key_id === node.authority.key_id
        && existing.roles.length === roles.length
        && existing.roles.every((role, index) => role === roles[index])
        && Date.parse(existing.issued_at) <= Date.parse(issuedAt)
        && Date.parse(issuedAt) < Date.parse(existing.expires_at)
      ) {
        return activeRecord(existing, issuedAt);
      }

      const context = await authorityProvider.signingContext();
      const record = await signV2Record(
        createNodeDescriptor({
          authority: context.authority,
          audience: "public",
          disclosure: "public",
          nonce: nonce(),
          issued_at: issuedAt,
          expires_at: expiry(
            issuedAt,
            selectedTtl(input.ttl_seconds, TTL.node),
          ),
          parent_record_id: null,
          roles,
          endpoints: [
            { rel: "record_read", path: "/v2/records/{record_id}" },
            { rel: "records_ingest", path: "/v2/records" },
          ],
        }),
        context.signer,
      );
      store.append(v2RecordBytes(record), "local");
      return record;
    },

    async createAssetTrustManifest(
      input: CreateAssetTrustManifestInput,
    ): Promise<VerifiedV2Record<AssetTrustManifestRecordCore>> {
      const issuedAt = localNow(now);
      const context = await authorityProvider.signingContext();
      const record = await signV2Record(
        createAssetTrustManifestRecord({
          authority: context.authority,
          audience: input.audience ?? context.authority.key_id,
          disclosure: input.disclosure ?? "private",
          nonce: nonce(),
          issued_at: issuedAt,
          expires_at: expiry(
            issuedAt,
            selectedTtl(input.ttl_seconds, TTL.asset),
          ),
          parent_record_id: null,
          manifest: input.manifest,
        }),
        context.signer,
      );
      store.append(v2RecordBytes(record), "local");
      return record;
    },

    evaluateAssetTrust(
      selection: AssetTrustSelection,
      expectedAssetId: string,
      expectedRail: string,
    ): AssetTrustDecision {
      return assetTrust(
        selection,
        expectedAssetId,
        expectedRail,
        localNow(now),
      ).decision;
    },

    async createPaymentRequest(
      input: CreatePaymentRequestInput,
    ): Promise<CreatedWithAssetTrust<VerifiedV2Record<PaymentRequestCore>>> {
      const issuedAt = localNow(now);
      const descriptor = await signingDescriptor(issuedAt, "merchant");
      const trust = assetTrust(
        input.asset_trust,
        input.asset_id,
        input.rail,
        issuedAt,
      );
      const disclosure = input.disclosure ?? "public";
      if (
        disclosure === "public"
        && trust.manifestDisclosure !== "public"
      ) {
        throw new V2LocalServiceError(
          "ASSET_TRUST_DISCLOSURE_MISMATCH",
          "A public payment request must bind a publicly retrievable asset-trust manifest.",
        );
      }
      const context = await authorityProvider.signingContext();
      const record = await signV2Record(
        createPaymentRequest({
          authority: context.authority,
          audience: input.audience ?? "public",
          disclosure,
          nonce: nonce(),
          issued_at: issuedAt,
          expires_at: expiry(
            issuedAt,
            selectedTtl(input.ttl_seconds, TTL.request),
          ),
          parent_record_id: descriptor.record_id,
          rail: input.rail,
          destination: input.destination,
          asset_id: input.asset_id,
          amount_atomic: input.amount_atomic,
          purpose_hash: input.purpose_hash as Sha256Id,
          asset_trust: trust.binding,
        }),
        context.signer,
      );
      store.append(v2RecordBytes(record), "local");
      return Object.freeze({ record, asset_trust: trust.decision });
    },

    async createPaymentIntent(
      input: CreatePaymentIntentInput,
    ): Promise<CreatedIntentWithAssetTrust> {
      const issuedAt = localNow(now);
      await signingDescriptor(issuedAt, "payer");
      assertSha256Id(input.request_record_id, "request_record_id");
      const storedRequest = store.getLocal(input.request_record_id);
      if (
        storedRequest === null
        || storedRequest.schema !== V2_SCHEMAS.payment_request
      ) {
        throw new V2LocalServiceError(
          "WRONG_RECORD_KIND",
          "The selected request is missing or has the wrong schema.",
        );
      }
      const request = activeRecord(
        storedRequest as VerifiedV2Record<PaymentRequestCore>,
        issuedAt,
      );
      const paymentTrust = assetTrust(
        input.payment_asset_trust,
        request.asset_id,
        request.rail,
        issuedAt,
      );
      const feeTrust = assetTrust(
        input.fee_asset_trust,
        input.fee_asset_id,
        request.rail,
        issuedAt,
      );
      const context = await authorityProvider.signingContext();
      const record = await signV2Record(
        createPaymentIntent({
          authority: context.authority,
          audience: request.authority.key_id,
          disclosure: "private",
          nonce: nonce(),
          issued_at: issuedAt,
          expires_at: expiry(
            issuedAt,
            selectedTtl(input.ttl_seconds, TTL.intent),
          ),
          parent_record_id: request.record_id,
          rail: request.rail,
          destination: request.destination,
          source_account: input.source_account,
          asset_id: request.asset_id,
          amount_atomic: request.amount_atomic,
          fee_asset_id: input.fee_asset_id,
          fee_limit_scope: "total_fee_asset_exposure",
          max_fee_atomic: input.max_fee_atomic,
          payment_asset_trust: paymentTrust.binding,
          fee_asset_trust: feeTrust.binding,
        }),
        context.signer,
      );
      store.append(v2RecordBytes(record), "local");
      return Object.freeze({
        record,
        payment_asset_trust: paymentTrust.decision,
        fee_asset_trust: feeTrust.decision,
      });
    },

    async createExecutionCommitment(
      input: CreateExecutionCommitmentInput,
    ): Promise<CreatedExecutionCommitment> {
      const issuedAt = localNow(now);
      const descriptor = await signingDescriptor(issuedAt, "payer");
      const context = await authorityProvider.signingContext();
      if (
        context.authority.key_id !== descriptor.authority.key_id
        || context.authority.public_key !== descriptor.authority.public_key
      ) {
        throw new V2LocalServiceError(
          "NODE_NOT_ACTIVATED",
          "The current signing authority does not match the active payer descriptor.",
        );
      }

      assertSha256Id(input.intent_record_id, "intent_record_id");
      assertSha256Id(input.reservation_id, "reservation_id");
      assertSha256Id(input.unsigned_payload_hash, "unsigned_payload_hash");
      try {
        assertTimestamp(input.expires_at, "expires_at");
      } catch (cause) {
        const error = new V2LocalServiceError(
          "INVALID_EXECUTION_WINDOW",
          "expires_at must be a real canonical RFC3339 UTC timestamp with milliseconds.",
        );
        error.cause = cause;
        throw error;
      }

      const storedIntent = store.localPaymentIntentById(
        input.intent_record_id,
        context.authority.key_id,
      );
      if (storedIntent === null) {
        throw new V2LocalServiceError(
          "LOCAL_PAYMENT_INTENT_REQUIRED",
          "Execution requires a locally authored payment intent signed by the current payer authority.",
        );
      }

      let intent: VerifiedV2Record<PaymentIntentCore>;
      try {
        intent = verifyV2Record(storedIntent, {
          now: issuedAt,
        }) as VerifiedV2Record<PaymentIntentCore>;
      } catch (cause) {
        const error = new V2LocalServiceError(
          "PAYMENT_INTENT_INACTIVE",
          "The locally authored payment intent is not active at commitment creation time.",
        );
        error.cause = cause;
        throw error;
      }

      if (
        Date.parse(input.expires_at) <= Date.parse(issuedAt)
        || Date.parse(input.expires_at) > Date.parse(intent.expires_at)
      ) {
        throw new V2LocalServiceError(
          "INVALID_EXECUTION_WINDOW",
          "Execution commitment expires_at must be later than issued_at and no later than the payment intent expiry.",
        );
      }

      const existing = store.localExecutionCommitmentFor(
        intent.record_id,
        context.authority.key_id,
      );
      if (existing !== null) {
        if (sameExecutionCommitmentInput(existing, input)) {
          return Object.freeze({ record: existing, reused: true });
        }
        throw executionCommitmentConflict(existing);
      }

      const record = await signV2Record(
        createExecutionCommitment({
          authority: context.authority,
          audience: intent.audience,
          disclosure: "private",
          nonce: nonce(),
          issued_at: issuedAt,
          expires_at: input.expires_at,
          parent_record_id: intent.record_id,
          rail: intent.rail,
          source_account: intent.source_account,
          destination: intent.destination,
          asset_id: intent.asset_id,
          amount_atomic: intent.amount_atomic,
          fee_asset_id: intent.fee_asset_id,
          fee_limit_scope: intent.fee_limit_scope,
          max_fee_atomic: intent.max_fee_atomic,
          reservation_id: input.reservation_id as Sha256Id,
          unsigned_payload_hash: input.unsigned_payload_hash as Sha256Id,
        }),
        context.signer,
      );

      try {
        store.append(v2RecordBytes(record), "local");
        return Object.freeze({ record, reused: false });
      } catch (cause) {
        if (
          cause instanceof V2RecordStoreError
          && cause.code === "TRANSITION_CONFLICT"
        ) {
          const winner = store.localExecutionCommitmentFor(
            intent.record_id,
            context.authority.key_id,
          );
          if (
            winner !== null
            && sameExecutionCommitmentInput(winner, input)
          ) {
            return Object.freeze({ record: winner, reused: true });
          }
          throw executionCommitmentConflict(winner, cause);
        }
        throw cause;
      }
    },
  });
}

export type V2LocalService = ReturnType<typeof createV2LocalService>;
