/**
 * Closed, human-oriented Pay Link workflows.
 *
 * These helpers orchestrate existing signed-record primitives. They do not
 * expose a generic signer, fetch a carrier URL, execute a rail payload, submit
 * a transaction, or claim that a self-certifying key is a legal identity.
 */

import { assertTimestamp, type Sha256Id } from "@agenttool/wallet";
import {
  FAIL_CLOSED_ASSET_TRUST_POLICY,
  evaluateAssetTrust,
  type AssetTrustDecision,
} from "./asset-trust.ts";
import {
  BITCOIN_MAINNET_ASSET_ID,
  BITCOIN_MAINNET_RAIL,
  bitcoinMainnetTrustManifest,
  parseBitcoinMainnetAddress,
  parseBitcoinPayLinkMaxFeeSatoshis,
  parseBitcoinPaymentTerms,
} from "./bitcoin-profile.ts";
import type { V2LocalService } from "./local-service.ts";
import {
  V2_PAY_LINK_ACCEPTANCE_FILE_EXTENSION,
  createV2PayLinkAcceptance,
  v2PayLinkAcceptanceBytes,
  v2PayLinkAcceptanceProjection,
  verifyV2PayLinkAcceptance,
  type V2PayLinkAcceptanceProjection,
  type VerifiedV2PayLinkAcceptance,
} from "./pay-link-acceptance.ts";
import {
  V2_PAY_LINK_FILE_EXTENSION,
  createV2PayLinkBundle,
  createV2PayLinkPurpose,
  v2PayLinkBytes,
  v2PayLinkProjection,
  v2PayLinkPurposeHash,
  verifyV2PayLinkBundle,
  type V2PayLinkProjection,
  type VerifiedV2PayLink,
} from "./pay-link.ts";
import {
  V2RecordStoreError,
  type AppendV2RecordResult,
  type CashLoomV2RecordStore,
} from "./record-store.ts";
import {
  V2_SCHEMAS,
  v2RecordBytes,
  type AssetTrustManifestRecordCore,
  type PaymentIntentCore,
  type VerifiedV2Record,
} from "./records.ts";

export interface V2PayLinkServiceDependencies {
  readonly store: () => CashLoomV2RecordStore;
  readonly localService: () => Promise<V2LocalService>;
  readonly now?: () => string;
}

export interface CreateBitcoinPayLinkInput {
  readonly destination: string;
  readonly amount_sats: string;
  readonly note?: string;
  readonly ttl_seconds?: number;
}

export interface AcceptBitcoinPayLinkInput {
  readonly bundle: Uint8Array;
  readonly source_account: string;
  readonly max_fee_sats: string;
}

export interface V2PayLinkArtifact {
  readonly bundle: string;
  readonly filename: string;
  readonly projection: V2PayLinkRequestApiProjection;
}

export interface V2PayLinkAcceptanceArtifact {
  readonly bundle: string;
  readonly filename: string;
  readonly projection: V2PayLinkAcceptanceApiProjection;
  readonly reused: boolean;
}

export interface V2PayLinkRequestApiProjection
  extends Omit<V2PayLinkProjection, "identity_assurance"> {
  readonly kind: "request";
  readonly identity_assurance: "first-contact-key" | "matched-key";
  readonly issued_at: string;
  readonly expires_at: string;
  readonly signature_valid: true;
  readonly asset_policy_accepted: true;
  readonly no_money_moved: true;
}

export interface V2PayLinkAcceptanceApiProjection
  extends Omit<V2PayLinkAcceptanceProjection, "request"> {
  readonly kind: "acceptance";
  readonly issued_at: string;
  readonly expires_at: string;
  readonly no_money_moved: true;
}

export interface ImportedPayLinkAcceptance {
  readonly projection: V2PayLinkAcceptanceApiProjection;
  readonly inserted_count: number;
}

export type V2PayLinkWorkflowErrorCode =
  | "WRONG_PAY_LINK_PROFILE"
  | "LOCAL_ASSET_POLICY_REJECTED"
  | "NODE_NOT_ACTIVATED"
  | "ACCEPTANCE_CONFLICT";

export class V2PayLinkWorkflowError extends Error {
  readonly code: V2PayLinkWorkflowErrorCode;
  readonly decision?: AssetTrustDecision;

  constructor(
    code: V2PayLinkWorkflowErrorCode,
    message: string,
    decision?: AssetTrustDecision,
  ) {
    super(message);
    this.name = "V2PayLinkWorkflowError";
    this.code = code;
    this.decision = decision;
  }
}

const fatalTextDecoder = new TextDecoder("utf-8", { fatal: true });

function localNow(now: () => string): string {
  const value = now();
  assertTimestamp(value, "now");
  return value;
}

function portableString(bytes: Uint8Array): string {
  return fatalTextDecoder.decode(bytes);
}

function artifactName(
  prefix: string,
  id: string,
  extension: string,
): string {
  return `${prefix}-${id.slice("sha256:".length, "sha256:".length + 16)}${extension}`;
}

function requestApiProjection(
  verified: VerifiedV2PayLink,
): Readonly<V2PayLinkRequestApiProjection> {
  const projection = v2PayLinkProjection(verified);
  return Object.freeze({
    ...projection,
    kind: "request",
    identity_assurance:
      verified.merchant_key_status === "matched-pin"
        ? "matched-key"
        : "first-contact-key",
    issued_at: projection.request_issued_at,
    expires_at: projection.request_expires_at,
    signature_valid: true,
    asset_policy_accepted: true,
    no_money_moved: true,
  });
}

function acceptanceApiProjection(
  verified: VerifiedV2PayLinkAcceptance,
): Readonly<V2PayLinkAcceptanceApiProjection> {
  const { request: _request, ...projection } =
    v2PayLinkAcceptanceProjection(verified);
  return Object.freeze({
    ...projection,
    kind: "acceptance",
    issued_at: projection.intent_issued_at,
    expires_at: projection.intent_expires_at,
    no_money_moved: true,
  });
}

function assertBitcoinOffer(
  verified: VerifiedV2PayLink,
): Readonly<AssetTrustDecision> {
  const request = verified.bundle.records.payment_request;
  if (
    request.rail !== BITCOIN_MAINNET_RAIL
    || request.asset_id !== BITCOIN_MAINNET_ASSET_ID
  ) {
    throw new V2PayLinkWorkflowError(
      "WRONG_PAY_LINK_PROFILE",
      "This first human Pay Link workflow accepts Bitcoin mainnet offers only.",
    );
  }
  const terms = parseBitcoinPaymentTerms(
    request.destination,
    request.amount_atomic,
  );
  if (terms.destination !== request.destination) {
    throw new V2PayLinkWorkflowError(
      "WRONG_PAY_LINK_PROFILE",
      "This Pay Link does not use the canonical Bitcoin mainnet destination.",
    );
  }
  const localDecision = evaluateAssetTrust(
    verified.bundle.records.asset_trust_manifest.manifest,
    FAIL_CLOSED_ASSET_TRUST_POLICY,
  );
  if (!localDecision.accepted) {
    throw new V2PayLinkWorkflowError(
      "LOCAL_ASSET_POLICY_REJECTED",
      "This node's fail-closed asset policy rejected the offered manifest.",
      localDecision,
    );
  }
  return localDecision;
}

function appendOffer(
  store: CashLoomV2RecordStore,
  verified: VerifiedV2PayLink,
): readonly AppendV2RecordResult[] {
  const records = verified.bundle.records;
  return store.appendBatch([
    {
      canonicalBytes: v2RecordBytes(records.node_descriptor),
      source: "remote",
    },
    {
      canonicalBytes: v2RecordBytes(records.asset_trust_manifest),
      source: "remote",
    },
    {
      canonicalBytes: v2RecordBytes(records.payment_request),
      source: "remote",
    },
  ]);
}

function assertExistingIntentMatches(
  intent: VerifiedV2Record<PaymentIntentCore>,
  sourceAccount: string,
  maxFeeSats: string,
): void {
  if (
    intent.source_account !== sourceAccount
    || intent.fee_asset_id !== BITCOIN_MAINNET_ASSET_ID
    || intent.max_fee_atomic !== maxFeeSats
  ) {
    throw new V2PayLinkWorkflowError(
      "ACCEPTANCE_CONFLICT",
      "This node already signed different acceptance terms for the same Pay Link.",
    );
  }
}

export function inspectV2PayLink(
  bundle: Uint8Array,
  options: {
    readonly now?: string;
    readonly expectedMerchantKeyId?: Sha256Id | string;
  } = {},
): Readonly<V2PayLinkRequestApiProjection> {
  const verified = verifyV2PayLinkBundle(bundle, options);
  assertBitcoinOffer(verified);
  return requestApiProjection(verified);
}

export function inspectV2PayLinkAcceptance(
  bundle: Uint8Array,
  options: {
    readonly now?: string;
    readonly expectedMerchantKeyId: Sha256Id | string;
  },
): Readonly<V2PayLinkAcceptanceApiProjection> {
  return acceptanceApiProjection(
    verifyV2PayLinkAcceptance(bundle, options),
  );
}

export function createV2PayLinkService(
  dependencies: V2PayLinkServiceDependencies,
) {
  const now = dependencies.now ?? (() => new Date().toISOString());

  return Object.freeze({
    async createBitcoinPayLink(
      input: CreateBitcoinPayLinkInput,
    ): Promise<Readonly<V2PayLinkArtifact>> {
      const terms = parseBitcoinPaymentTerms(
        input.destination,
        input.amount_sats,
      );
      const note = input.note?.trim() || null;
      const purpose = createV2PayLinkPurpose(note);
      const service = await dependencies.localService();
      const descriptor = await service.activateNode();
      const manifest = await service.createAssetTrustManifest({
        manifest: bitcoinMainnetTrustManifest(localNow(now)),
        audience: "public",
        disclosure: "public",
      });
      const created = await service.createPaymentRequest({
        rail: BITCOIN_MAINNET_RAIL,
        destination: terms.destination,
        asset_id: BITCOIN_MAINNET_ASSET_ID,
        amount_atomic: terms.amount_sats,
        purpose_hash: v2PayLinkPurposeHash(purpose),
        asset_trust: {
          record_id: manifest.record_id,
          trusted_authority_key_id: manifest.authority.key_id,
        },
        audience: "public",
        disclosure: "public",
        ttl_seconds: input.ttl_seconds,
      });
      const verified = createV2PayLinkBundle(
        {
          purpose,
          records: {
            node_descriptor: descriptor,
            asset_trust_manifest: manifest,
            payment_request: created.record,
          },
        },
        { now: localNow(now) },
      );
      assertBitcoinOffer(verified);
      const bytes = v2PayLinkBytes(verified.bundle);
      return Object.freeze({
        bundle: portableString(bytes),
        filename: artifactName(
          "cashloom-pay",
          created.record.record_id,
          V2_PAY_LINK_FILE_EXTENSION,
        ),
        projection: requestApiProjection(verified),
      });
    },

    importPayLink(bundle: Uint8Array): Readonly<V2PayLinkRequestApiProjection> {
      const verified = verifyV2PayLinkBundle(bundle, {
        now: localNow(now),
      });
      assertBitcoinOffer(verified);
      appendOffer(dependencies.store(), verified);
      return requestApiProjection(verified);
    },

    async acceptBitcoinPayLink(
      input: AcceptBitcoinPayLinkInput,
    ): Promise<Readonly<V2PayLinkAcceptanceArtifact>> {
      const acceptedAt = localNow(now);
      const payLink = verifyV2PayLinkBundle(input.bundle, {
        now: acceptedAt,
      });
      assertBitcoinOffer(payLink);
      const sourceAccount = parseBitcoinMainnetAddress(
        input.source_account,
      );
      const maxFeeSats = parseBitcoinPayLinkMaxFeeSatoshis(
        input.max_fee_sats,
      );

      appendOffer(dependencies.store(), payLink);
      const service = await dependencies.localService();
      const payerDescriptor = await service.activateNode();
      const store = dependencies.store();
      const request = payLink.bundle.records.payment_request;
      let intent = store.localPaymentIntentFor(
        request.record_id,
        payerDescriptor.authority.key_id,
      );
      let reused = intent !== null;

      if (intent === null) {
        const manifest = await service.createAssetTrustManifest({
          manifest: bitcoinMainnetTrustManifest(acceptedAt),
          audience: request.authority.key_id,
          disclosure: "private",
        });
        try {
          intent = (
            await service.createPaymentIntent({
              request_record_id: request.record_id,
              source_account: sourceAccount,
              fee_asset_id: BITCOIN_MAINNET_ASSET_ID,
              max_fee_atomic: maxFeeSats,
              payment_asset_trust: {
                record_id: manifest.record_id,
                trusted_authority_key_id: manifest.authority.key_id,
              },
              fee_asset_trust: {
                record_id: manifest.record_id,
                trusted_authority_key_id: manifest.authority.key_id,
              },
            })
          ).record;
        } catch (error) {
          if (
            !(error instanceof V2RecordStoreError)
            || error.code !== "TRANSITION_CONFLICT"
          ) {
            throw error;
          }
          intent = store.localPaymentIntentFor(
            request.record_id,
            payerDescriptor.authority.key_id,
          );
          if (intent === null) throw error;
          reused = true;
        }
      }

      assertExistingIntentMatches(intent, sourceAccount, maxFeeSats);
      const manifestValue = store.getLocal(
        intent.payment_asset_trust.manifest_record_id,
      );
      if (
        manifestValue === null
        || manifestValue.schema !== V2_SCHEMAS.asset_trust_manifest
      ) {
        throw new V2PayLinkWorkflowError(
          "ACCEPTANCE_CONFLICT",
          "The existing intent's private asset-trust manifest is unavailable.",
        );
      }
      const manifest =
        manifestValue as VerifiedV2Record<AssetTrustManifestRecordCore>;
      const acceptance = createV2PayLinkAcceptance(
        {
          pay_link: payLink.bundle,
          records: {
            asset_trust_manifest: manifest,
            payment_intent: intent,
          },
        },
        {
          expectedMerchantKeyId: request.authority.key_id,
          now: localNow(now),
        },
      );
      const bytes = v2PayLinkAcceptanceBytes(acceptance.bundle);
      return Object.freeze({
        bundle: portableString(bytes),
        filename: artifactName(
          "cashloom-accept",
          acceptance.acceptance_id,
          V2_PAY_LINK_ACCEPTANCE_FILE_EXTENSION,
        ),
        projection: acceptanceApiProjection(acceptance),
        reused,
      });
    },

    importPayLinkAcceptance(
      bundle: Uint8Array,
    ): Readonly<ImportedPayLinkAcceptance> {
      const store = dependencies.store();
      const descriptor = store.latestPublicNodeDescriptor();
      if (descriptor === null) {
        throw new V2PayLinkWorkflowError(
          "NODE_NOT_ACTIVATED",
          "Create a Pay Link on this merchant node before importing its acceptance.",
        );
      }
      const verified = verifyV2PayLinkAcceptance(bundle, {
        expectedMerchantKeyId: descriptor.authority.key_id,
        now: localNow(now),
      });

      // Full carrier verification above precedes one atomic batch. Import is
      // evidence only; it invokes no execution adapter.
      const offer = verified.pay_link.bundle.records;
      const privateRecords = verified.bundle.records;
      const results = store.appendBatch([
        {
          canonicalBytes: v2RecordBytes(offer.node_descriptor),
          source: "remote",
        },
        {
          canonicalBytes: v2RecordBytes(offer.asset_trust_manifest),
          source: "remote",
        },
        {
          canonicalBytes: v2RecordBytes(offer.payment_request),
          source: "remote",
        },
        {
          canonicalBytes: v2RecordBytes(
            privateRecords.asset_trust_manifest,
          ),
          source: "remote",
        },
        {
          canonicalBytes: v2RecordBytes(
            privateRecords.payment_intent,
          ),
          source: "remote",
        },
      ]);
      const insertedCount = results
        .filter((result) => result.inserted).length;
      return Object.freeze({
        projection: acceptanceApiProjection(verified),
        inserted_count: insertedCount,
      });
    },
  });
}

export type V2PayLinkService = ReturnType<typeof createV2PayLinkService>;
