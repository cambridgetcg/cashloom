/**
 * CashLoom v2 signed records.
 *
 * This module is deliberately pure: no database, vault, network, resolver, or
 * global identity registry. Every authority is self-certifying from the
 * Ed25519 public key carried by the record. Transports may move these records;
 * they cannot become authoritative by doing so.
 */

import {
  WalletProtocolError,
  assertAmount,
  assertCaip19,
  assertSha256Id,
  assertTimestamp,
  base64UrlEncode,
  canonicalJsonBytes,
  decodeFixedBase64Url,
  keyIdForPublicKey,
  parseCanonicalJson,
  publicKeyFromBase64Url,
  sha256Id,
  signatureFromBase64Url,
  strictEd25519Verify,
  signingDigest,
  snapshotJsonData,
  type JsonValue,
  type RecordSigner,
  type Sha256Id,
} from "@agenttool/wallet";
import {
  assetTrustPolicyHash,
  evaluateAssetTrust,
  parseAssetTrustManifest,
  parseAssetTrustPolicy,
  type AssetTrustDecision,
  type AssetTrustManifest,
  type AssetTrustPolicy,
} from "./asset-trust.ts";
import {
  parseServiceAttestation,
  parseServiceProfile,
  type ServiceAttestation,
  type ServiceProfile,
} from "./service-trust.ts";
import {
  parseKarmaObservation,
  type KarmaObservation,
} from "./karma.ts";

export const V2_SCHEMAS = Object.freeze({
  node_descriptor: "cashloom/node-descriptor/v2",
  payment_request: "cashloom/payment-request/v2",
  payment_intent: "cashloom/payment-intent/v2",
  execution_commitment: "cashloom/execution-commitment/v2",
  submission_receipt: "cashloom/submission-receipt/v2",
  settlement_receipt: "cashloom/settlement-receipt/v2",
  asset_trust_manifest: "cashloom/asset-trust-manifest/v2",
  service_profile: "cashloom/service-profile/v2",
  service_attestation: "cashloom/service-attestation/v2",
  karma_observation: "cashloom/karma-observation/v2",
} as const);

export type V2Schema = (typeof V2_SCHEMAS)[keyof typeof V2_SCHEMAS];

const SIGNING_DOMAINS: Readonly<Record<V2Schema, string>> = Object.freeze({
  [V2_SCHEMAS.node_descriptor]: "cashloom-v2/node-descriptor",
  [V2_SCHEMAS.payment_request]: "cashloom-v2/payment-request",
  [V2_SCHEMAS.payment_intent]: "cashloom-v2/payment-intent",
  [V2_SCHEMAS.execution_commitment]: "cashloom-v2/execution-commitment",
  [V2_SCHEMAS.submission_receipt]: "cashloom-v2/submission-receipt",
  [V2_SCHEMAS.settlement_receipt]: "cashloom-v2/settlement-receipt",
  [V2_SCHEMAS.asset_trust_manifest]: "cashloom-v2/asset-trust-manifest",
  [V2_SCHEMAS.service_profile]: "cashloom-v2/service-profile",
  [V2_SCHEMAS.service_attestation]: "cashloom-v2/service-attestation",
  [V2_SCHEMAS.karma_observation]: "cashloom-v2/karma-observation",
});

export const V2_MAX_RECORD_BYTES = 32 * 1024;
const MAX_ENDPOINTS = 8;
const MAX_STRING_BYTES = 2_048;
const NONCE_BYTES = 16;
const RAIL = /^[a-z][a-z0-9._:-]{0,63}$/u;
const COORDINATE = /^[\x21-\x7e]{1,512}$/u;
const FIAT_ASSET = /^fiat:iso4217\/[A-Z]{3}$/u;
const NODE_ROLES = Object.freeze(["merchant", "payer", "relay", "watcher"] as const);
const ENDPOINT_RELS = Object.freeze(["record_read", "records_ingest"] as const);
const SUBMISSION_STATES = Object.freeze(["submitted", "submission_unknown"] as const);
// This first chain has one exclusive settlement successor. Reversal/dispute
// needs a future signed adjustment/supersession schema; pretending it is a
// sibling receipt would make two incompatible leaves simultaneously valid.
const SETTLEMENT_OUTCOMES = Object.freeze(["settled"] as const);
const SETTLEMENT_EVIDENCE_KINDS = Object.freeze([
  "chain_finality_reference",
  "provider_event_reference",
  "merchant_observation",
] as const);

const MAX_LIFETIME_MS: Readonly<Record<V2Schema, number>> = Object.freeze({
  [V2_SCHEMAS.node_descriptor]: 30 * 24 * 60 * 60 * 1_000,
  [V2_SCHEMAS.payment_request]: 24 * 60 * 60 * 1_000,
  [V2_SCHEMAS.payment_intent]: 10 * 60 * 1_000,
  [V2_SCHEMAS.execution_commitment]: 10 * 60 * 1_000,
  [V2_SCHEMAS.submission_receipt]: 7 * 24 * 60 * 60 * 1_000,
  [V2_SCHEMAS.settlement_receipt]: 365 * 24 * 60 * 60 * 1_000,
  [V2_SCHEMAS.asset_trust_manifest]: 30 * 24 * 60 * 60 * 1_000,
  [V2_SCHEMAS.service_profile]: 30 * 24 * 60 * 60 * 1_000,
  [V2_SCHEMAS.service_attestation]: 365 * 24 * 60 * 60 * 1_000,
  [V2_SCHEMAS.karma_observation]: 365 * 24 * 60 * 60 * 1_000,
});

export type NodeRole = (typeof NODE_ROLES)[number];
export type NodeEndpointRel = (typeof ENDPOINT_RELS)[number];
export type SubmissionState = (typeof SUBMISSION_STATES)[number];
export type SettlementOutcome = (typeof SETTLEMENT_OUTCOMES)[number];
export type SettlementEvidenceKind =
  (typeof SETTLEMENT_EVIDENCE_KINDS)[number];
export type SettlementAttestationScope = "issuer_assertion_only";
export type V2Audience = "public" | Sha256Id;
export type V2Disclosure = "public" | "private";
export type V2FeeLimitScope = "total_fee_asset_exposure";

export interface SelfCertifyingAuthority {
  algorithm: "Ed25519";
  key_id: Sha256Id;
  public_key: string;
}

export interface V2Signature {
  algorithm: "Ed25519";
  value: string;
}

export interface NodeEndpoint {
  rel: NodeEndpointRel;
  path: string;
}

/**
 * Content-addressed local trust input bound into payment consent.
 *
 * The manifest remains an independently signed record. Exact policy bytes are
 * embedded and content-addressed so no policy label or registry is authority.
 */
export interface AssetTrustBinding {
  manifest_record_id: Sha256Id;
  manifest_authority_key_id: Sha256Id;
  policy: AssetTrustPolicy;
  policy_hash: Sha256Id;
}

interface CommonCore<S extends V2Schema> {
  schema: S;
  authority: SelfCertifyingAuthority;
  audience: V2Audience;
  disclosure: V2Disclosure;
  nonce: string;
  issued_at: string;
  expires_at: string;
  parent_record_id: Sha256Id | null;
}

export interface NodeDescriptorCore
  extends CommonCore<typeof V2_SCHEMAS.node_descriptor> {
  roles: NodeRole[];
  endpoints: NodeEndpoint[];
}

export interface PaymentRequestCore
  extends CommonCore<typeof V2_SCHEMAS.payment_request> {
  rail: string;
  destination: string;
  asset_id: string;
  amount_atomic: string;
  purpose_hash: Sha256Id;
  asset_trust: AssetTrustBinding;
}

export interface PaymentIntentCore
  extends CommonCore<typeof V2_SCHEMAS.payment_intent> {
  rail: string;
  destination: string;
  source_account: string;
  asset_id: string;
  amount_atomic: string;
  fee_asset_id: string;
  fee_limit_scope: V2FeeLimitScope;
  max_fee_atomic: string;
  payment_asset_trust: AssetTrustBinding;
  fee_asset_trust: AssetTrustBinding;
}

export interface ExecutionCommitmentCore
  extends CommonCore<typeof V2_SCHEMAS.execution_commitment> {
  rail: string;
  source_account: string;
  destination: string;
  asset_id: string;
  amount_atomic: string;
  fee_asset_id: string;
  fee_limit_scope: V2FeeLimitScope;
  max_fee_atomic: string;
  reservation_id: Sha256Id;
  unsigned_payload_hash: Sha256Id;
}

export interface SubmissionReceiptCore
  extends CommonCore<typeof V2_SCHEMAS.submission_receipt> {
  signed_payload_hash: Sha256Id;
  operation_id: string;
  state: SubmissionState;
  submitted_at: string;
}

export interface SettlementReceiptCore
  extends CommonCore<typeof V2_SCHEMAS.settlement_receipt> {
  /** The issuer's signed claim; the generic verifier does not prove finality. */
  asserted_outcome: SettlementOutcome;
  attestation_scope: SettlementAttestationScope;
  evidence_kind: SettlementEvidenceKind;
  evidence_hash: Sha256Id;
  observed_at: string;
}

export interface AssetTrustManifestRecordCore
  extends CommonCore<typeof V2_SCHEMAS.asset_trust_manifest> {
  manifest: AssetTrustManifest;
}

export interface ServiceProfileRecordCore
  extends CommonCore<typeof V2_SCHEMAS.service_profile> {
  profile: ServiceProfile;
}

export interface ServiceAttestationRecordCore
  extends CommonCore<typeof V2_SCHEMAS.service_attestation> {
  attestation: ServiceAttestation;
}

export interface KarmaObservationRecordCore
  extends CommonCore<typeof V2_SCHEMAS.karma_observation> {
  observation: KarmaObservation;
}

export type V2RecordCore =
  | NodeDescriptorCore
  | PaymentRequestCore
  | PaymentIntentCore
  | ExecutionCommitmentCore
  | SubmissionReceiptCore
  | SettlementReceiptCore
  | AssetTrustManifestRecordCore
  | ServiceProfileRecordCore
  | ServiceAttestationRecordCore
  | KarmaObservationRecordCore;

export type SignedV2Record<T extends V2RecordCore = V2RecordCore> = T & {
  signature: V2Signature;
  record_id: Sha256Id;
};

declare const verifiedV2RecordBrand: unique symbol;
export type VerifiedV2Record<T extends V2RecordCore = V2RecordCore> =
  Readonly<SignedV2Record<T>> & {
    readonly [verifiedV2RecordBrand]: true;
  };

export interface VerifiedV2Chain {
  node_descriptor: VerifiedV2Record<NodeDescriptorCore>;
  payment_request: VerifiedV2Record<PaymentRequestCore>;
  payment_intent: VerifiedV2Record<PaymentIntentCore>;
  execution_commitment: VerifiedV2Record<ExecutionCommitmentCore>;
  submission_receipt: VerifiedV2Record<SubmissionReceiptCore>;
  settlement_receipt: VerifiedV2Record<SettlementReceiptCore>;
}

export interface VerifyV2Options {
  /**
   * When present, require the record to be active at this canonical timestamp.
   * Omitting it permits later cryptographic verification of historical evidence.
   */
  now?: string;
}

type JsonObject = Record<string, unknown>;

function protocolError(
  code: "INVALID_INPUT" | "LIMIT_EXCEEDED" | "INTEGRITY_FAILURE"
    | "SIGNATURE_INVALID" | "AUTHORITY_MISMATCH" | "INVALID_STATE_TRANSITION",
  message: string,
  path?: string,
): never {
  throw new WalletProtocolError(code, message, path ? { path } : undefined);
}

function invalid(message: string, path?: string): never {
  return protocolError("INVALID_INPUT", message, path);
}

function asObject(value: unknown, path: string): JsonObject {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return invalid(`${path} must be an object.`, path);
  }
  return value as JsonObject;
}

function exactKeys(value: JsonObject, expected: readonly string[], path: string): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (
    actual.length !== wanted.length
    || actual.some((key, index) => key !== wanted[index])
  ) {
    const unknown = actual.filter((key) => !wanted.includes(key));
    const missing = wanted.filter((key) => !actual.includes(key));
    return invalid(
      `${path} has a closed schema.`
      + (unknown.length > 0 ? ` Unknown: ${unknown.join(", ")}.` : "")
      + (missing.length > 0 ? ` Missing: ${missing.join(", ")}.` : ""),
      path,
    );
  }
}

function boundedString(
  value: unknown,
  path: string,
  maxBytes = MAX_STRING_BYTES,
): string {
  if (
    typeof value !== "string"
    || value.length === 0
    || new TextEncoder().encode(value).byteLength > maxBytes
    || value.includes("\0")
  ) {
    return invalid(`${path} must be a non-empty bounded UTF-8 string.`, path);
  }
  return value;
}

function exactLiteral<T extends string>(
  value: unknown,
  literal: T,
  path: string,
): T {
  if (value !== literal) return invalid(`${path} must be "${literal}".`, path);
  return literal;
}

function oneOf<T extends string>(
  value: unknown,
  allowed: readonly T[],
  path: string,
): T {
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    return invalid(`${path} must be one of: ${allowed.join(", ")}.`, path);
  }
  return value as T;
}

function shaId(value: unknown, path: string): Sha256Id {
  assertSha256Id(value, path);
  return value;
}

function timestamp(value: unknown, path: string): string {
  assertTimestamp(value, path);
  return value;
}

function audience(value: unknown, path: string): V2Audience {
  if (value === "public") return "public";
  return shaId(value, path);
}

function disclosure(value: unknown, path: string): V2Disclosure {
  return oneOf(value, ["public", "private"] as const, path);
}

function parentId(value: unknown, path: string): Sha256Id | null {
  if (value === null) return null;
  return shaId(value, path);
}

function nonce(value: unknown, path: string): string {
  const encoded = boundedString(value, path, 64);
  decodeFixedBase64Url(encoded, NONCE_BYTES, path);
  return encoded;
}

function authority(value: unknown, path: string): SelfCertifyingAuthority {
  const object = asObject(value, path);
  exactKeys(object, ["algorithm", "key_id", "public_key"], path);
  const algorithm = exactLiteral(object.algorithm, "Ed25519", `${path}.algorithm`);
  const publicKey = boundedString(object.public_key, `${path}.public_key`, 64);
  publicKeyFromBase64Url(publicKey);
  const keyId = shaId(object.key_id, `${path}.key_id`);
  if (keyIdForPublicKey(publicKey) !== keyId) {
    return protocolError(
      "AUTHORITY_MISMATCH",
      `${path}.key_id is not self-certifying for ${path}.public_key.`,
      `${path}.key_id`,
    );
  }
  return { algorithm, key_id: keyId, public_key: publicKey };
}

function signature(value: unknown, path: string): V2Signature {
  const object = asObject(value, path);
  exactKeys(object, ["algorithm", "value"], path);
  const algorithm = exactLiteral(object.algorithm, "Ed25519", `${path}.algorithm`);
  const encoded = boundedString(object.value, `${path}.value`, 128);
  signatureFromBase64Url(encoded);
  return { algorithm, value: encoded };
}

function assertRecordSize(value: unknown): void {
  if (canonicalJsonBytes(value).byteLength > V2_MAX_RECORD_BYTES) {
    return protocolError(
      "LIMIT_EXCEEDED",
      `CashLoom v2 records must not exceed ${V2_MAX_RECORD_BYTES} canonical bytes.`,
    );
  }
}

function common<S extends V2Schema>(
  object: JsonObject,
  schema: S,
): CommonCore<S> {
  const parsedSchema = exactLiteral(object.schema, schema, "record.schema");
  const issuedAt = timestamp(object.issued_at, "record.issued_at");
  const expiresAt = timestamp(object.expires_at, "record.expires_at");
  const issuedMs = Date.parse(issuedAt);
  const expiresMs = Date.parse(expiresAt);
  if (expiresMs <= issuedMs) {
    return invalid("record.expires_at must be later than record.issued_at.", "record.expires_at");
  }
  if (expiresMs - issuedMs > MAX_LIFETIME_MS[schema]) {
    return invalid("The record lifetime exceeds the bound for its schema.", "record.expires_at");
  }
  return {
    schema: parsedSchema,
    authority: authority(object.authority, "record.authority"),
    audience: audience(object.audience, "record.audience"),
    disclosure: disclosure(object.disclosure, "record.disclosure"),
    nonce: nonce(object.nonce, "record.nonce"),
    issued_at: issuedAt,
    expires_at: expiresAt,
    parent_record_id: parentId(object.parent_record_id, "record.parent_record_id"),
  };
}

function assertPositiveAmount(value: unknown, path: string): string {
  assertAmount(value, path);
  if (BigInt(value) === 0n) return invalid(`${path} must be greater than zero.`, path);
  return value;
}

function amount(value: unknown, path: string): string {
  assertAmount(value, path);
  return value;
}

function assetId(value: unknown, path: string): string {
  const asset = boundedString(value, path, 256);
  if (!FIAT_ASSET.test(asset)) assertCaip19(asset, path);
  return asset;
}

function rail(value: unknown, path: string): string {
  const parsed = boundedString(value, path, 64);
  if (!RAIL.test(parsed)) return invalid(`${path} is not a canonical rail identifier.`, path);
  return parsed;
}

function coordinate(value: unknown, path: string): string {
  const parsed = boundedString(value, path, 512);
  if (!COORDINATE.test(parsed)) {
    return invalid(`${path} must be a bounded printable rail coordinate.`, path);
  }
  return parsed;
}

function nodeRoles(value: unknown): NodeRole[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > NODE_ROLES.length) {
    return invalid("record.roles must contain one to four roles.", "record.roles");
  }
  const roles = value.map((entry, index) =>
    oneOf(entry, NODE_ROLES, `record.roles[${index}]`));
  const sorted = [...roles].sort();
  if (new Set(roles).size !== roles.length || roles.some((role, index) => role !== sorted[index])) {
    return invalid("record.roles must be unique and lexicographically sorted.", "record.roles");
  }
  return roles;
}

function endpoint(value: unknown, path: string): NodeEndpoint {
  const object = asObject(value, path);
  exactKeys(object, ["rel", "path"], path);
  const rel = oneOf(object.rel, ENDPOINT_RELS, `${path}.rel`);
  const relativePath = boundedString(object.path, `${path}.path`, 512);
  if (
    !relativePath.startsWith("/")
    || relativePath.startsWith("//")
    || relativePath.includes("?")
    || relativePath.includes("#")
    || relativePath.includes("\\")
    || /(?:^|\/)\.\.?($|\/)/u.test(relativePath)
  ) {
    return invalid(
      `${path}.path must be a canonical origin-relative path without query, fragment, or traversal.`,
      `${path}.path`,
    );
  }
  return { rel, path: relativePath };
}

function endpoints(value: unknown): NodeEndpoint[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_ENDPOINTS) {
    return invalid(`record.endpoints must contain one to ${MAX_ENDPOINTS} endpoints.`, "record.endpoints");
  }
  const parsed = value.map((entry, index) => endpoint(entry, `record.endpoints[${index}]`));
  const identities = parsed.map(({ rel, path }) => `${rel}\0${path}`);
  const sorted = [...identities].sort();
  if (
    new Set(identities).size !== identities.length
    || identities.some((identity, index) => identity !== sorted[index])
  ) {
    return invalid(
      "record.endpoints must be unique and lexicographically sorted by rel then path.",
      "record.endpoints",
    );
  }
  for (const required of ENDPOINT_RELS) {
    if (parsed.filter(({ rel }) => rel === required).length !== 1) {
      return invalid(
        `record.endpoints must contain exactly one ${required} relation.`,
        "record.endpoints",
      );
    }
  }
  return parsed;
}

function assetTrustBinding(value: unknown, path: string): AssetTrustBinding {
  const object = asObject(value, path);
  exactKeys(object, [
    "manifest_record_id",
    "manifest_authority_key_id",
    "policy",
    "policy_hash",
  ], path);
  const policy = parseAssetTrustPolicy(object.policy);
  const policyHash = shaId(object.policy_hash, `${path}.policy_hash`);
  if (assetTrustPolicyHash(policy) !== policyHash) {
    return protocolError(
      "INTEGRITY_FAILURE",
      `${path}.policy_hash does not match the exact embedded policy.`,
      `${path}.policy_hash`,
    );
  }
  return {
    manifest_record_id: shaId(
      object.manifest_record_id,
      `${path}.manifest_record_id`,
    ),
    manifest_authority_key_id: shaId(
      object.manifest_authority_key_id,
      `${path}.manifest_authority_key_id`,
    ),
    policy: snapshotJsonData(policy) as unknown as AssetTrustPolicy,
    policy_hash: policyHash,
  };
}

function validateNodeDescriptor(value: unknown): NodeDescriptorCore {
  const object = asObject(value, "record");
  exactKeys(object, [
    "schema", "authority", "audience", "disclosure", "nonce", "issued_at",
    "expires_at", "parent_record_id", "roles", "endpoints",
  ], "record");
  const base = common(object, V2_SCHEMAS.node_descriptor);
  if (base.audience !== "public") {
    return invalid("A node descriptor audience must be public.", "record.audience");
  }
  if (base.disclosure !== "public") {
    return invalid("A node descriptor disclosure must be public.", "record.disclosure");
  }
  if (base.parent_record_id !== null) {
    return invalid(
      "This bounded node descriptor primitive does not infer key continuity; parent_record_id must be null.",
      "record.parent_record_id",
    );
  }
  return { ...base, roles: nodeRoles(object.roles), endpoints: endpoints(object.endpoints) };
}

function validatePaymentRequest(value: unknown): PaymentRequestCore {
  const object = asObject(value, "record");
  exactKeys(object, [
    "schema", "authority", "audience", "disclosure", "nonce", "issued_at",
    "expires_at", "parent_record_id", "rail", "destination", "asset_id",
    "amount_atomic", "purpose_hash", "asset_trust",
  ], "record");
  const base = common(object, V2_SCHEMAS.payment_request);
  if (base.parent_record_id === null) {
    return invalid("A payment request must name its node descriptor parent.", "record.parent_record_id");
  }
  return {
    ...base,
    rail: rail(object.rail, "record.rail"),
    destination: coordinate(object.destination, "record.destination"),
    asset_id: assetId(object.asset_id, "record.asset_id"),
    amount_atomic: assertPositiveAmount(object.amount_atomic, "record.amount_atomic"),
    purpose_hash: shaId(object.purpose_hash, "record.purpose_hash"),
    asset_trust: assetTrustBinding(object.asset_trust, "record.asset_trust"),
  };
}

function validatePaymentIntent(value: unknown): PaymentIntentCore {
  const object = asObject(value, "record");
  exactKeys(object, [
    "schema", "authority", "audience", "disclosure", "nonce", "issued_at",
    "expires_at", "parent_record_id", "rail", "destination",
    "source_account", "asset_id",
    "amount_atomic", "fee_asset_id", "fee_limit_scope", "max_fee_atomic",
    "payment_asset_trust", "fee_asset_trust",
  ], "record");
  const base = common(object, V2_SCHEMAS.payment_intent);
  if (base.audience === "public" || base.parent_record_id === null) {
    return invalid(
      "A payment intent must target one authority and name one request parent.",
      "record",
    );
  }
  return {
    ...base,
    rail: rail(object.rail, "record.rail"),
    destination: coordinate(object.destination, "record.destination"),
    source_account: coordinate(object.source_account, "record.source_account"),
    asset_id: assetId(object.asset_id, "record.asset_id"),
    amount_atomic: assertPositiveAmount(object.amount_atomic, "record.amount_atomic"),
    fee_asset_id: assetId(object.fee_asset_id, "record.fee_asset_id"),
    fee_limit_scope: exactLiteral(
      object.fee_limit_scope,
      "total_fee_asset_exposure",
      "record.fee_limit_scope",
    ),
    max_fee_atomic: amount(object.max_fee_atomic, "record.max_fee_atomic"),
    payment_asset_trust: assetTrustBinding(
      object.payment_asset_trust,
      "record.payment_asset_trust",
    ),
    fee_asset_trust: assetTrustBinding(
      object.fee_asset_trust,
      "record.fee_asset_trust",
    ),
  };
}

function validateExecutionCommitment(value: unknown): ExecutionCommitmentCore {
  const object = asObject(value, "record");
  exactKeys(object, [
    "schema", "authority", "audience", "disclosure", "nonce", "issued_at",
    "expires_at", "parent_record_id", "rail", "source_account", "destination",
    "asset_id", "amount_atomic", "fee_asset_id", "fee_limit_scope",
    "max_fee_atomic",
    "reservation_id", "unsigned_payload_hash",
  ], "record");
  const base = common(object, V2_SCHEMAS.execution_commitment);
  if (base.audience === "public" || base.parent_record_id === null) {
    return invalid(
      "An execution commitment must target one authority and name one intent parent.",
      "record",
    );
  }
  return {
    ...base,
    rail: rail(object.rail, "record.rail"),
    source_account: coordinate(object.source_account, "record.source_account"),
    destination: coordinate(object.destination, "record.destination"),
    asset_id: assetId(object.asset_id, "record.asset_id"),
    amount_atomic: assertPositiveAmount(object.amount_atomic, "record.amount_atomic"),
    fee_asset_id: assetId(object.fee_asset_id, "record.fee_asset_id"),
    fee_limit_scope: exactLiteral(
      object.fee_limit_scope,
      "total_fee_asset_exposure",
      "record.fee_limit_scope",
    ),
    max_fee_atomic: amount(object.max_fee_atomic, "record.max_fee_atomic"),
    reservation_id: shaId(object.reservation_id, "record.reservation_id"),
    unsigned_payload_hash: shaId(
      object.unsigned_payload_hash,
      "record.unsigned_payload_hash",
    ),
  };
}

function validateSubmissionReceipt(value: unknown): SubmissionReceiptCore {
  const object = asObject(value, "record");
  exactKeys(object, [
    "schema", "authority", "audience", "disclosure", "nonce", "issued_at",
    "expires_at", "parent_record_id", "signed_payload_hash", "operation_id",
    "state", "submitted_at",
  ], "record");
  const base = common(object, V2_SCHEMAS.submission_receipt);
  if (base.audience === "public" || base.parent_record_id === null) {
    return invalid(
      "A submission receipt must target one authority and name one commitment parent.",
      "record",
    );
  }
  const submittedAt = timestamp(object.submitted_at, "record.submitted_at");
  if (Date.parse(submittedAt) > Date.parse(base.issued_at)) {
    return invalid(
      "record.submitted_at cannot be later than the receipt's record.issued_at.",
      "record.submitted_at",
    );
  }
  return {
    ...base,
    signed_payload_hash: shaId(
      object.signed_payload_hash,
      "record.signed_payload_hash",
    ),
    operation_id: coordinate(object.operation_id, "record.operation_id"),
    state: oneOf(object.state, SUBMISSION_STATES, "record.state"),
    submitted_at: submittedAt,
  };
}

function validateSettlementReceipt(value: unknown): SettlementReceiptCore {
  const object = asObject(value, "record");
  exactKeys(object, [
    "schema", "authority", "audience", "disclosure", "nonce", "issued_at",
    "expires_at", "parent_record_id", "asserted_outcome",
    "attestation_scope", "evidence_kind", "evidence_hash", "observed_at",
  ], "record");
  const base = common(object, V2_SCHEMAS.settlement_receipt);
  if (base.audience === "public" || base.parent_record_id === null) {
    return invalid(
      "A settlement receipt must target one authority and name one submission parent.",
      "record",
    );
  }
  const observedAt = timestamp(object.observed_at, "record.observed_at");
  if (Date.parse(observedAt) > Date.parse(base.issued_at)) {
    return invalid(
      "record.observed_at cannot be later than the receipt's record.issued_at.",
      "record.observed_at",
    );
  }
  return {
    ...base,
    asserted_outcome: oneOf(
      object.asserted_outcome,
      SETTLEMENT_OUTCOMES,
      "record.asserted_outcome",
    ),
    attestation_scope: exactLiteral(
      object.attestation_scope,
      "issuer_assertion_only",
      "record.attestation_scope",
    ),
    evidence_kind: oneOf(
      object.evidence_kind,
      SETTLEMENT_EVIDENCE_KINDS,
      "record.evidence_kind",
    ),
    evidence_hash: shaId(object.evidence_hash, "record.evidence_hash"),
    observed_at: observedAt,
  };
}

function validateAssetTrustManifestRecord(
  value: unknown,
): AssetTrustManifestRecordCore {
  const object = asObject(value, "record");
  exactKeys(object, [
    "schema", "authority", "audience", "disclosure", "nonce", "issued_at",
    "expires_at", "parent_record_id", "manifest",
  ], "record");
  const base = common(object, V2_SCHEMAS.asset_trust_manifest);
  if (base.parent_record_id !== null) {
    return invalid(
      "An asset trust manifest is an independent assertion and must not name a payment parent.",
      "record.parent_record_id",
    );
  }
  const parsedManifest = parseAssetTrustManifest(object.manifest);
  if (Date.parse(parsedManifest.provenance.assessed_at) > Date.parse(base.issued_at)) {
    return invalid(
      "The embedded assessment cannot postdate its signed record.",
      "record.manifest.provenance.assessed_at",
    );
  }
  return {
    ...base,
    manifest: snapshotJsonData(parsedManifest) as unknown as AssetTrustManifest,
  };
}

function validateServiceProfileRecord(
  value: unknown,
): ServiceProfileRecordCore {
  const object = asObject(value, "record");
  exactKeys(object, [
    "schema", "authority", "audience", "disclosure", "nonce", "issued_at",
    "expires_at", "parent_record_id", "profile",
  ], "record");
  const base = common(object, V2_SCHEMAS.service_profile);
  if (base.parent_record_id !== null) {
    return invalid(
      "A service profile is an independent self-assertion and must not name an authority parent.",
      "record.parent_record_id",
    );
  }
  const parsedProfile = parseServiceProfile(object.profile);
  if (parsedProfile.service_key_id !== base.authority.key_id) {
    return protocolError(
      "AUTHORITY_MISMATCH",
      "The service profile key must match its self-certifying record authority.",
      "record.profile.service_key_id",
    );
  }
  if (Date.parse(parsedProfile.provenance.asserted_at) > Date.parse(base.issued_at)) {
    return invalid(
      "The self-assertion cannot postdate its signed record.",
      "record.profile.provenance.asserted_at",
    );
  }
  return {
    ...base,
    profile: snapshotJsonData(parsedProfile) as unknown as ServiceProfile,
  };
}

function validateServiceAttestationRecord(
  value: unknown,
): ServiceAttestationRecordCore {
  const object = asObject(value, "record");
  exactKeys(object, [
    "schema", "authority", "audience", "disclosure", "nonce", "issued_at",
    "expires_at", "parent_record_id", "attestation",
  ], "record");
  const base = common(object, V2_SCHEMAS.service_attestation);
  if (base.parent_record_id === null) {
    return invalid(
      "A service attestation must name the exact service profile it discusses.",
      "record.parent_record_id",
    );
  }
  const parsedAttestation = parseServiceAttestation(object.attestation);
  if (parsedAttestation.issuer_key_id !== base.authority.key_id) {
    return protocolError(
      "AUTHORITY_MISMATCH",
      "The attestation issuer key must match its self-certifying record authority.",
      "record.attestation.issuer_key_id",
    );
  }
  if (parsedAttestation.profile_record_id !== base.parent_record_id) {
    return protocolError(
      "INTEGRITY_FAILURE",
      "The attestation and record envelope must name the same profile record.",
      "record.attestation.profile_record_id",
    );
  }
  if (Date.parse(parsedAttestation.observed_at) > Date.parse(base.issued_at)) {
    return invalid(
      "The attestation observation cannot postdate its signed record.",
      "record.attestation.observed_at",
    );
  }
  return {
    ...base,
    attestation: snapshotJsonData(parsedAttestation) as unknown as ServiceAttestation,
  };
}

function validateKarmaObservationRecord(
  value: unknown,
): KarmaObservationRecordCore {
  const object = asObject(value, "record");
  exactKeys(object, [
    "schema", "authority", "audience", "disclosure", "nonce", "issued_at",
    "expires_at", "parent_record_id", "observation",
  ], "record");
  const base = common(object, V2_SCHEMAS.karma_observation);
  if (base.parent_record_id !== null) {
    return invalid(
      "A KARMA observation is an independent issuer claim and must not name an authority or payment parent.",
      "record.parent_record_id",
    );
  }
  const parsedObservation = parseKarmaObservation(object.observation);
  if (parsedObservation.issuer_key_id !== base.authority.key_id) {
    return protocolError(
      "AUTHORITY_MISMATCH",
      "The KARMA observation issuer must match its self-certifying record authority.",
      "record.observation.issuer_key_id",
    );
  }
  if (Date.parse(parsedObservation.observed_at) > Date.parse(base.issued_at)) {
    return invalid(
      "The KARMA observation cannot postdate its signed record.",
      "record.observation.observed_at",
    );
  }
  return {
    ...base,
    observation: snapshotJsonData(parsedObservation) as unknown as KarmaObservation,
  };
}

function schemaOf(value: unknown): V2Schema {
  const object = asObject(value, "record");
  const schema = boundedString(object.schema, "record.schema", 64);
  if (!Object.values(V2_SCHEMAS).includes(schema as V2Schema)) {
    return invalid(`Unknown CashLoom v2 schema: ${schema}.`, "record.schema");
  }
  return schema as V2Schema;
}

function validateCore(value: unknown): V2RecordCore {
  switch (schemaOf(value)) {
    case V2_SCHEMAS.node_descriptor:
      return validateNodeDescriptor(value);
    case V2_SCHEMAS.payment_request:
      return validatePaymentRequest(value);
    case V2_SCHEMAS.payment_intent:
      return validatePaymentIntent(value);
    case V2_SCHEMAS.execution_commitment:
      return validateExecutionCommitment(value);
    case V2_SCHEMAS.submission_receipt:
      return validateSubmissionReceipt(value);
    case V2_SCHEMAS.settlement_receipt:
      return validateSettlementReceipt(value);
    case V2_SCHEMAS.asset_trust_manifest:
      return validateAssetTrustManifestRecord(value);
    case V2_SCHEMAS.service_profile:
      return validateServiceProfileRecord(value);
    case V2_SCHEMAS.service_attestation:
      return validateServiceAttestationRecord(value);
    case V2_SCHEMAS.karma_observation:
      return validateKarmaObservationRecord(value);
  }
}

function inputSnapshot(value: unknown): JsonValue {
  const snapshot = value instanceof Uint8Array
    ? parseCanonicalJson(value)
    : snapshotJsonData(value);
  assertRecordSize(snapshot);
  return snapshotJsonData(snapshot);
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function activeAt(record: V2RecordCore, now: string): void {
  assertTimestamp(now, "now");
  const at = Date.parse(now);
  if (at < Date.parse(record.issued_at) || at >= Date.parse(record.expires_at)) {
    return protocolError(
      "INVALID_STATE_TRANSITION",
      "The record is not active at the requested verification time.",
      "now",
    );
  }
}

export function createSelfCertifyingAuthority(publicKey: string): SelfCertifyingAuthority {
  publicKeyFromBase64Url(publicKey);
  return deepFreeze({
    algorithm: "Ed25519",
    key_id: keyIdForPublicKey(publicKey),
    public_key: publicKey,
  });
}

export function createNodeDescriptor(
  input: Omit<NodeDescriptorCore, "schema">,
): Readonly<NodeDescriptorCore> {
  return deepFreeze(validateNodeDescriptor({ schema: V2_SCHEMAS.node_descriptor, ...input }));
}

export function createPaymentRequest(
  input: Omit<PaymentRequestCore, "schema">,
): Readonly<PaymentRequestCore> {
  return deepFreeze(validatePaymentRequest({ schema: V2_SCHEMAS.payment_request, ...input }));
}

export function createPaymentIntent(
  input: Omit<PaymentIntentCore, "schema">,
): Readonly<PaymentIntentCore> {
  return deepFreeze(validatePaymentIntent({ schema: V2_SCHEMAS.payment_intent, ...input }));
}

export function createExecutionCommitment(
  input: Omit<ExecutionCommitmentCore, "schema">,
): Readonly<ExecutionCommitmentCore> {
  return deepFreeze(validateExecutionCommitment({
    schema: V2_SCHEMAS.execution_commitment,
    ...input,
  }));
}

export function createSubmissionReceipt(
  input: Omit<SubmissionReceiptCore, "schema">,
): Readonly<SubmissionReceiptCore> {
  return deepFreeze(validateSubmissionReceipt({
    schema: V2_SCHEMAS.submission_receipt,
    ...input,
  }));
}

export function createSettlementReceipt(
  input: Omit<SettlementReceiptCore, "schema">,
): Readonly<SettlementReceiptCore> {
  return deepFreeze(validateSettlementReceipt({
    schema: V2_SCHEMAS.settlement_receipt,
    ...input,
  }));
}

export function createAssetTrustManifestRecord(
  input: Omit<AssetTrustManifestRecordCore, "schema">,
): Readonly<AssetTrustManifestRecordCore> {
  return deepFreeze(validateAssetTrustManifestRecord({
    schema: V2_SCHEMAS.asset_trust_manifest,
    ...input,
  }));
}

export function createServiceProfileRecord(
  input: Omit<ServiceProfileRecordCore, "schema">,
): Readonly<ServiceProfileRecordCore> {
  return deepFreeze(validateServiceProfileRecord({
    schema: V2_SCHEMAS.service_profile,
    ...input,
  }));
}

export function createServiceAttestationRecord(
  input: Omit<ServiceAttestationRecordCore, "schema">,
): Readonly<ServiceAttestationRecordCore> {
  return deepFreeze(validateServiceAttestationRecord({
    schema: V2_SCHEMAS.service_attestation,
    ...input,
  }));
}

export function createKarmaObservationRecord(
  input: Omit<KarmaObservationRecordCore, "schema">,
): Readonly<KarmaObservationRecordCore> {
  return deepFreeze(validateKarmaObservationRecord({
    schema: V2_SCHEMAS.karma_observation,
    ...input,
  }));
}

export function v2RecordDigest(core: V2RecordCore): Uint8Array {
  const validated = validateCore(inputSnapshot(core));
  return signingDigest(SIGNING_DOMAINS[validated.schema], validated);
}

export async function signV2Record<T extends V2RecordCore>(
  core: T,
  signer: RecordSigner,
): Promise<VerifiedV2Record<T>> {
  const validated = validateCore(inputSnapshot(core));
  if (signer.public_key !== validated.authority.public_key) {
    return protocolError(
      "AUTHORITY_MISMATCH",
      "The signer public key does not match the record's self-certifying authority.",
      "record.authority",
    );
  }
  const digest = signingDigest(SIGNING_DOMAINS[validated.schema], validated);
  const signatureValue = await signer.sign_digest(Uint8Array.from(digest));
  const recordSignature = signature({ algorithm: "Ed25519", value: signatureValue }, "record.signature");
  if (
    !strictEd25519Verify(
      signatureFromBase64Url(recordSignature.value),
      digest,
      publicKeyFromBase64Url(validated.authority.public_key),
    )
  ) {
    return protocolError(
      "SIGNATURE_INVALID",
      "The signer returned an invalid Ed25519 signature.",
      "record.signature",
    );
  }
  const withoutId = { ...validated, signature: recordSignature };
  return verifyV2Record({
    ...withoutId,
    record_id: sha256Id(withoutId),
  }) as unknown as VerifiedV2Record<T>;
}

export function verifyV2Record(
  value: unknown,
  options: VerifyV2Options = {},
): VerifiedV2Record {
  const object = asObject(inputSnapshot(value), "record");
  const { record_id: rawRecordId, signature: rawSignature, ...rawCore } = object;
  const core = validateCore(rawCore);
  const recordSignature = signature(rawSignature, "record.signature");
  const recordId = shaId(rawRecordId, "record.record_id");
  const withoutId = { ...core, signature: recordSignature };
  if (sha256Id(withoutId) !== recordId) {
    return protocolError(
      "INTEGRITY_FAILURE",
      "record.record_id does not match the canonical signed record.",
      "record.record_id",
    );
  }
  if (
    !strictEd25519Verify(
      signatureFromBase64Url(recordSignature.value),
      signingDigest(SIGNING_DOMAINS[core.schema], core),
      publicKeyFromBase64Url(core.authority.public_key),
    )
  ) {
    return protocolError(
      "SIGNATURE_INVALID",
      "The CashLoom v2 record signature is invalid.",
      "record.signature",
    );
  }
  if (options.now !== undefined) activeAt(core, options.now);
  return deepFreeze({
    ...core,
    signature: recordSignature,
    record_id: recordId,
  }) as VerifiedV2Record;
}

/**
 * Resolve and replay one signed asset-policy gate.
 *
 * The six-record payment-chain verifier deliberately has no resolver. A
 * consumer that wants to rely on an asset-trust binding supplies the referenced
 * manifest record explicitly; this function verifies its signature/content ID,
 * authority pin, rail/asset context, exact embedded policy hash, and decision.
 */
export function verifyV2AssetTrustBinding(
  bindingValue: unknown,
  manifestRecordValue: unknown,
  expected: {
    readonly asset_id: string;
    readonly rail: string;
  },
  options: VerifyV2Options = {},
): Readonly<AssetTrustDecision> {
  const binding = assetTrustBinding(bindingValue, "asset_trust");
  const manifestRecord = verifyV2Record(manifestRecordValue, options);
  if (manifestRecord.schema !== V2_SCHEMAS.asset_trust_manifest) {
    return invalid(
      "The asset-trust binding must resolve to an asset trust manifest record.",
      "asset_trust.manifest_record_id",
    );
  }
  if (manifestRecord.record_id !== binding.manifest_record_id) {
    return protocolError(
      "INTEGRITY_FAILURE",
      "The resolved manifest does not match the bound content ID.",
      "asset_trust.manifest_record_id",
    );
  }
  if (
    manifestRecord.authority.key_id !== binding.manifest_authority_key_id
  ) {
    return protocolError(
      "AUTHORITY_MISMATCH",
      "The resolved manifest issuer does not match the bound authority pin.",
      "asset_trust.manifest_authority_key_id",
    );
  }
  const expectedAssetId = assetId(expected.asset_id, "expected.asset_id");
  const expectedRail = rail(expected.rail, "expected.rail");
  if (
    manifestRecord.manifest.asset_id !== expectedAssetId
    || manifestRecord.manifest.rail !== expectedRail
  ) {
    return protocolError(
      "INTEGRITY_FAILURE",
      "The resolved manifest does not describe the bound payment asset and rail.",
      "asset_trust.manifest_record_id",
    );
  }
  const decision = evaluateAssetTrust(
    manifestRecord.manifest,
    binding.policy,
  );
  if (!decision.accepted || decision.policy_hash !== binding.policy_hash) {
    return protocolError(
      "INVALID_STATE_TRANSITION",
      "The exact bound asset policy does not accept the resolved manifest.",
      "asset_trust.policy",
    );
  }
  return deepFreeze(decision);
}

function expectSchema<S extends V2Schema>(
  record: VerifiedV2Record,
  schema: S,
): VerifiedV2Record<Extract<V2RecordCore, { schema: S }>> {
  if (record.schema !== schema) {
    return invalid(`Expected ${schema}; got ${record.schema}.`, "record.schema");
  }
  return record as VerifiedV2Record<Extract<V2RecordCore, { schema: S }>>;
}

function sameAuthority(
  left: SelfCertifyingAuthority,
  right: SelfCertifyingAuthority,
  path: string,
): void {
  if (left.key_id !== right.key_id || left.public_key !== right.public_key) {
    return protocolError(
      "AUTHORITY_MISMATCH",
      "The record authority does not match the authority established by its chain.",
      path,
    );
  }
}

function parentOf(
  child: VerifiedV2Record,
  parent: VerifiedV2Record,
  requireParentActive = true,
): void {
  if (child.parent_record_id !== parent.record_id) {
    return protocolError(
      "INTEGRITY_FAILURE",
      "The child record does not name the supplied parent.",
      "record.parent_record_id",
    );
  }
  const childIssued = Date.parse(child.issued_at);
  if (childIssued < Date.parse(parent.issued_at)) {
    return invalid("A child record cannot predate its parent.", "record.issued_at");
  }
  if (requireParentActive && childIssued >= Date.parse(parent.expires_at)) {
    return protocolError(
      "INVALID_STATE_TRANSITION",
      "The parent had expired before the child was issued.",
      "record.issued_at",
    );
  }
}

function samePaymentField(
  label: string,
  ...values: readonly string[]
): void {
  if (new Set(values).size !== 1) {
    return protocolError(
      "INTEGRITY_FAILURE",
      `The signed record chain disagrees on ${label}.`,
      label,
    );
  }
}

function assertImmediateLink(
  child: VerifiedV2Record,
  parent: VerifiedV2Record,
): void {
  if (child.disclosure === "public" && parent.disclosure !== "public") {
    return protocolError(
      "INVALID_STATE_TRANSITION",
      "A public record cannot depend on a private parent that public retrieval must withhold.",
      "record.disclosure",
    );
  }
  if (
    child.authority.key_id === parent.authority.key_id
    && child.nonce === parent.nonce
  ) {
    return protocolError(
      "INTEGRITY_FAILURE",
      "One authority must not reuse its parent's replay nonce.",
      "record.nonce",
    );
  }

  switch (child.schema) {
    case V2_SCHEMAS.payment_request: {
      if (parent.schema !== V2_SCHEMAS.node_descriptor) {
        return invalid("A payment request parent must be a node descriptor.", "record.parent_record_id");
      }
      const request = child as VerifiedV2Record<PaymentRequestCore>;
      const descriptor = parent as VerifiedV2Record<NodeDescriptorCore>;
      parentOf(request, descriptor);
      if (!descriptor.roles.includes("merchant")) {
        return protocolError(
          "AUTHORITY_MISMATCH",
          "The request parent does not declare the merchant role.",
          "record.roles",
        );
      }
      sameAuthority(request.authority, descriptor.authority, "payment_request.authority");
      return;
    }
    case V2_SCHEMAS.payment_intent: {
      if (parent.schema !== V2_SCHEMAS.payment_request) {
        return invalid("A payment intent parent must be a payment request.", "record.parent_record_id");
      }
      const intent = child as VerifiedV2Record<PaymentIntentCore>;
      const request = parent as VerifiedV2Record<PaymentRequestCore>;
      parentOf(intent, request);
      if (intent.audience !== request.authority.key_id) {
        return protocolError(
          "AUTHORITY_MISMATCH",
          "The payment intent does not address the request authority.",
          "payment_intent.audience",
        );
      }
      if (request.audience !== "public" && request.audience !== intent.authority.key_id) {
        return protocolError(
          "AUTHORITY_MISMATCH",
          "The targeted request does not address the intent authority.",
          "payment_request.audience",
        );
      }
      samePaymentField("asset_id", request.asset_id, intent.asset_id);
      samePaymentField("amount_atomic", request.amount_atomic, intent.amount_atomic);
      samePaymentField("rail", request.rail, intent.rail);
      samePaymentField("destination", request.destination, intent.destination);
      return;
    }
    case V2_SCHEMAS.execution_commitment: {
      if (parent.schema !== V2_SCHEMAS.payment_intent) {
        return invalid(
          "An execution commitment parent must be a payment intent.",
          "record.parent_record_id",
        );
      }
      const commitment = child as VerifiedV2Record<ExecutionCommitmentCore>;
      const intent = parent as VerifiedV2Record<PaymentIntentCore>;
      parentOf(commitment, intent);
      sameAuthority(commitment.authority, intent.authority, "execution_commitment.authority");
      if (commitment.audience !== intent.audience) {
        return protocolError(
          "AUTHORITY_MISMATCH",
          "The execution commitment must retain the intent audience.",
          "execution_commitment.audience",
        );
      }
      samePaymentField("source_account", intent.source_account, commitment.source_account);
      samePaymentField("rail", intent.rail, commitment.rail);
      samePaymentField("destination", intent.destination, commitment.destination);
      samePaymentField("asset_id", intent.asset_id, commitment.asset_id);
      samePaymentField("amount_atomic", intent.amount_atomic, commitment.amount_atomic);
      samePaymentField("fee_asset_id", intent.fee_asset_id, commitment.fee_asset_id);
      samePaymentField(
        "fee_limit_scope",
        intent.fee_limit_scope,
        commitment.fee_limit_scope,
      );
      samePaymentField("max_fee_atomic", intent.max_fee_atomic, commitment.max_fee_atomic);
      return;
    }
    case V2_SCHEMAS.submission_receipt: {
      if (parent.schema !== V2_SCHEMAS.execution_commitment) {
        return invalid(
          "A submission receipt parent must be an execution commitment.",
          "record.parent_record_id",
        );
      }
      const submission = child as VerifiedV2Record<SubmissionReceiptCore>;
      const commitment = parent as VerifiedV2Record<ExecutionCommitmentCore>;
      parentOf(submission, commitment);
      if (Date.parse(submission.submitted_at) < Date.parse(commitment.issued_at)) {
        return protocolError(
          "INVALID_STATE_TRANSITION",
          "A submission cannot predate the execution commitment it realizes.",
          "submission_receipt.submitted_at",
        );
      }
      sameAuthority(submission.authority, commitment.authority, "submission_receipt.authority");
      if (submission.audience !== commitment.audience) {
        return protocolError(
          "AUTHORITY_MISMATCH",
          "The submission receipt must retain the commitment audience.",
          "submission_receipt.audience",
        );
      }
      return;
    }
    case V2_SCHEMAS.settlement_receipt: {
      if (parent.schema !== V2_SCHEMAS.submission_receipt) {
        return invalid(
          "A settlement receipt parent must be a submission receipt.",
          "record.parent_record_id",
        );
      }
      const settlement = child as VerifiedV2Record<SettlementReceiptCore>;
      const submission = parent as VerifiedV2Record<SubmissionReceiptCore>;
      parentOf(settlement, submission, false);
      if (Date.parse(settlement.observed_at) < Date.parse(submission.submitted_at)) {
        return protocolError(
          "INVALID_STATE_TRANSITION",
          "A settlement observation cannot predate submission.",
          "settlement_receipt.observed_at",
        );
      }
      if (
        settlement.authority.key_id !== submission.audience
        || settlement.audience !== submission.authority.key_id
      ) {
        return protocolError(
          "AUTHORITY_MISMATCH",
          "Settlement must be issued by the submission audience back to its issuer.",
          "settlement_receipt.authority",
        );
      }
      return;
    }
    case V2_SCHEMAS.service_attestation: {
      if (parent.schema !== V2_SCHEMAS.service_profile) {
        return invalid(
          "A service attestation parent must be a service profile.",
          "record.parent_record_id",
        );
      }
      const attestation = child as VerifiedV2Record<ServiceAttestationRecordCore>;
      const profile = parent as VerifiedV2Record<ServiceProfileRecordCore>;
      // A trader may publish historical interaction evidence after the profile
      // expires. The exact profile bytes remain the immutable context.
      parentOf(attestation, profile, false);
      if (
        attestation.attestation.profile_record_id !== profile.record_id
        || attestation.attestation.subject_key_id !== profile.authority.key_id
        || profile.profile.service_key_id !== profile.authority.key_id
      ) {
        return protocolError(
          "AUTHORITY_MISMATCH",
          "The attestation subject must be the authority of its exact profile parent.",
          "record.attestation.subject_key_id",
        );
      }
      return;
    }
    case V2_SCHEMAS.node_descriptor:
    case V2_SCHEMAS.asset_trust_manifest:
    case V2_SCHEMAS.service_profile:
    case V2_SCHEMAS.karma_observation:
      return invalid(`${child.schema} is an independent root and cannot be linked as a child.`, "record.schema");
  }
}

/**
 * Verify one immediate parent edge for append-only ingest. This deliberately
 * requires no resolver or full chain: the store can refuse malformed ancestry
 * as each child arrives.
 */
export function verifyV2RecordLink(
  childValue: unknown,
  parentValue: unknown,
): Readonly<{ child: VerifiedV2Record; parent: VerifiedV2Record }> {
  const child = verifyV2Record(childValue);
  const parent = verifyV2Record(parentValue);
  assertImmediateLink(child, parent);
  return deepFreeze({ child, parent });
}

/**
 * Verify the minimal merchant→payer→merchant authority chain. Discovery,
 * relays, RPCs, and cashloom.io are intentionally absent from this decision.
 */
export function verifyV2RecordChain(
  values: readonly unknown[],
  options: VerifyV2Options = {},
): Readonly<VerifiedV2Chain> {
  if (values.length !== 6) {
    return invalid("A complete CashLoom v2 chain contains exactly six records.", "records");
  }
  const records = values.map((value) => verifyV2Record(value));
  const descriptor = expectSchema(records[0]!, V2_SCHEMAS.node_descriptor);
  const request = expectSchema(records[1]!, V2_SCHEMAS.payment_request);
  const intent = expectSchema(records[2]!, V2_SCHEMAS.payment_intent);
  const commitment = expectSchema(records[3]!, V2_SCHEMAS.execution_commitment);
  const submission = expectSchema(records[4]!, V2_SCHEMAS.submission_receipt);
  const settlement = expectSchema(records[5]!, V2_SCHEMAS.settlement_receipt);

  if (!descriptor.roles.includes("merchant")) {
    return protocolError(
      "AUTHORITY_MISMATCH",
      "The request authority descriptor does not declare the merchant role.",
      "record.roles",
    );
  }

  assertImmediateLink(request, descriptor);
  assertImmediateLink(intent, request);
  assertImmediateLink(commitment, intent);
  assertImmediateLink(submission, commitment);
  assertImmediateLink(settlement, submission);

  sameAuthority(request.authority, descriptor.authority, "payment_request.authority");
  if (request.audience !== "public" && request.audience !== intent.authority.key_id) {
    return protocolError(
      "AUTHORITY_MISMATCH",
      "The targeted payment request does not address the intent authority.",
      "payment_request.audience",
    );
  }
  if (intent.audience !== descriptor.authority.key_id) {
    return protocolError(
      "AUTHORITY_MISMATCH",
      "The payment intent audience is not the merchant authority.",
      "payment_intent.audience",
    );
  }

  sameAuthority(commitment.authority, intent.authority, "execution_commitment.authority");
  sameAuthority(submission.authority, intent.authority, "submission_receipt.authority");
  if (
    commitment.audience !== descriptor.authority.key_id
    || submission.audience !== descriptor.authority.key_id
  ) {
    return protocolError(
      "AUTHORITY_MISMATCH",
      "Execution evidence must address the merchant authority.",
      "record.audience",
    );
  }

  sameAuthority(settlement.authority, descriptor.authority, "settlement_receipt.authority");
  if (settlement.audience !== intent.authority.key_id) {
    return protocolError(
      "AUTHORITY_MISMATCH",
      "The settlement receipt must address the payer authority.",
      "settlement_receipt.audience",
    );
  }

  samePaymentField("asset_id", request.asset_id, intent.asset_id, commitment.asset_id);
  samePaymentField(
    "amount_atomic",
    request.amount_atomic,
    intent.amount_atomic,
    commitment.amount_atomic,
  );
  samePaymentField("source_account", intent.source_account, commitment.source_account);
  samePaymentField("fee_asset_id", intent.fee_asset_id, commitment.fee_asset_id);
  samePaymentField(
    "fee_limit_scope",
    intent.fee_limit_scope,
    commitment.fee_limit_scope,
  );
  samePaymentField("max_fee_atomic", intent.max_fee_atomic, commitment.max_fee_atomic);
  samePaymentField("rail", request.rail, commitment.rail);
  samePaymentField("destination", request.destination, commitment.destination);

  const noncesByAuthority = new Map<string, Set<string>>();
  for (const record of records) {
    const seen = noncesByAuthority.get(record.authority.key_id) ?? new Set<string>();
    if (seen.has(record.nonce)) {
      return protocolError(
        "INTEGRITY_FAILURE",
        "One authority reused a replay nonce in the CashLoom v2 chain.",
        "record.nonce",
      );
    }
    seen.add(record.nonce);
    noncesByAuthority.set(record.authority.key_id, seen);
  }

  if (options.now !== undefined) {
    // Historical parents remain evidence after expiry; the leaf is the current
    // assertion whose acceptance window the caller asked to check.
    activeAt(settlement, options.now);
  }

  return deepFreeze({
    node_descriptor: descriptor,
    payment_request: request,
    payment_intent: intent,
    execution_commitment: commitment,
    submission_receipt: submission,
    settlement_receipt: settlement,
  });
}

/** Canonical bytes suitable for content-addressed storage or transport. */
export function v2RecordBytes(record: VerifiedV2Record): Uint8Array {
  return canonicalJsonBytes(record);
}

/** Generate a canonical 128-bit replay nonce from caller-supplied entropy. */
export function v2Nonce(entropy: Uint8Array): string {
  if (entropy.byteLength !== NONCE_BYTES) {
    return invalid(`CashLoom v2 nonces require exactly ${NONCE_BYTES} bytes.`, "entropy");
  }
  return base64UrlEncode(entropy);
}
