/**
 * Portable public CashLoom v2 payment offers.
 *
 * A pay-link bundle is a carrier, not a new authority record. Its payment
 * request signature binds the exact purpose preimage, descriptor parent, and
 * asset-trust reference. The three embedded signed records remain authority
 * when the `.cashloom-pay` file is copied, mirrored, or handed over offline.
 *
 * Notes in this public profile are public data. They must not be used for
 * secrets, legal identity, agent memory, or other sensitive context.
 */

import {
  assertSha256Id,
  canonicalJsonBytes,
  parseCanonicalJson,
  sha256Id,
  snapshotJsonData,
  type Sha256Id,
} from "@agenttool/wallet";

import type { AssetTrustDecision } from "./asset-trust.ts";
import {
  V2_SCHEMAS,
  verifyV2AssetTrustBinding,
  verifyV2Record,
  verifyV2RecordLink,
  type AssetTrustManifestRecordCore,
  type NodeDescriptorCore,
  type PaymentRequestCore,
  type SignedV2Record,
  type VerifiedV2Record,
} from "./records.ts";

export const V2_PAY_LINK_BUNDLE_SCHEMA =
  "cashloom/pay-link-bundle/v2" as const;
export const V2_PAY_LINK_PURPOSE_SCHEMA =
  "cashloom/pay-link-purpose/v2" as const;
export const V2_PAY_LINK_MEDIA_TYPE =
  "application/cashloom-pay-link+json" as const;
export const V2_PAY_LINK_FILE_EXTENSION = ".cashloom-pay" as const;
export const V2_PAY_LINK_MAX_BYTES = 64 * 1024;
export const V2_PAY_LINK_NOTE_MAX_BYTES = 160;
export const V2_PAY_LINK_MAX_NESTING_DEPTH = 32;
export const V2_PAY_LINK_NOTE_VISIBILITY = "public" as const;
export const V2_PAY_LINK_IDENTITY_ASSURANCE =
  "self-certifying-key-only" as const;

export type V2PayLinkMerchantKeyStatus = "first-contact" | "matched-pin";

export interface V2PayLinkOfflineReplyTo {
  readonly kind: "offline";
}

/**
 * The note is deliberately part of a public purpose preimage. Its hash is
 * signed by PaymentRequest; including the preimage makes it readable, not
 * private.
 */
export interface V2PayLinkPurpose {
  readonly schema: typeof V2_PAY_LINK_PURPOSE_SCHEMA;
  readonly note: string | null;
  readonly reply_to: V2PayLinkOfflineReplyTo;
}

export interface V2PayLinkBundleRecords {
  readonly node_descriptor: SignedV2Record<NodeDescriptorCore>;
  readonly asset_trust_manifest:
    SignedV2Record<AssetTrustManifestRecordCore>;
  readonly payment_request: SignedV2Record<PaymentRequestCore>;
}

export interface V2PayLinkBundle {
  readonly schema: typeof V2_PAY_LINK_BUNDLE_SCHEMA;
  readonly purpose: V2PayLinkPurpose;
  readonly records: V2PayLinkBundleRecords;
}

export interface VerifiedV2PayLinkBundleRecords {
  readonly node_descriptor: VerifiedV2Record<NodeDescriptorCore>;
  readonly asset_trust_manifest:
    VerifiedV2Record<AssetTrustManifestRecordCore>;
  readonly payment_request: VerifiedV2Record<PaymentRequestCore>;
}

export interface VerifiedV2PayLinkBundle {
  readonly schema: typeof V2_PAY_LINK_BUNDLE_SCHEMA;
  readonly purpose: Readonly<V2PayLinkPurpose>;
  readonly records: Readonly<VerifiedV2PayLinkBundleRecords>;
}

export interface VerifyV2PayLinkOptions {
  /** Defaults to the local wall clock; every embedded record must be active. */
  readonly now?: string;
  /**
   * Optional key fingerprint selected through a prior contact or another
   * caller-chosen path. A match authenticates only that key, never a person,
   * company, account, or legal identity.
   */
  readonly expectedMerchantKeyId?: Sha256Id | string;
}

export interface CreateV2PayLinkBundleInput {
  readonly purpose: V2PayLinkPurpose;
  readonly records: V2PayLinkBundleRecords;
}

export interface VerifiedV2PayLink {
  readonly bundle: Readonly<VerifiedV2PayLinkBundle>;
  readonly bundle_id: Sha256Id;
  readonly purpose_hash: Sha256Id;
  readonly usable_until: string;
  readonly merchant_key_status: V2PayLinkMerchantKeyStatus;
  readonly asset_trust: Readonly<AssetTrustDecision>;
}

export interface V2PayLinkProjection {
  readonly bundle_id: Sha256Id;
  readonly request_record_id: Sha256Id;
  readonly merchant_key_id: Sha256Id;
  readonly merchant_key_status: V2PayLinkMerchantKeyStatus;
  readonly identity_assurance: typeof V2_PAY_LINK_IDENTITY_ASSURANCE;
  readonly note: string | null;
  readonly note_visibility: typeof V2_PAY_LINK_NOTE_VISIBILITY;
  readonly rail: string;
  readonly destination: string;
  readonly asset_id: string;
  readonly amount_atomic: string;
  readonly request_issued_at: string;
  readonly request_expires_at: string;
  readonly usable_until: string;
  readonly asset_trust_manifest_record_id: Sha256Id;
  readonly asset_trust_policy_id: string;
  readonly asset_trust_policy_hash: Sha256Id;
}

export type V2PayLinkErrorCode =
  | "INVALID_BUNDLE"
  | "BUNDLE_TOO_LARGE"
  | "WRONG_RECORD_SCHEMA"
  | "NON_PUBLIC_OFFER"
  | "PURPOSE_MISMATCH"
  | "MERCHANT_KEY_MISMATCH"
  | "DUPLICATE_RECORD"
  | "ISSUER_NONCE_REUSE"
  | "EXCESS_NESTING"
  | "INVALID_UTF8";

export class V2PayLinkError extends Error {
  readonly code: V2PayLinkErrorCode;

  constructor(code: V2PayLinkErrorCode, message: string) {
    super(message);
    this.name = "V2PayLinkError";
    this.code = code;
  }
}

type JsonObject = Record<string, unknown>;

const fail = (code: V2PayLinkErrorCode, message: string): never => {
  throw new V2PayLinkError(code, message);
};

function asObject(value: unknown, path: string): JsonObject {
  const prototype =
    value !== null && typeof value === "object"
      ? Object.getPrototypeOf(value)
      : undefined;
  if (
    value === null
    || typeof value !== "object"
    || Array.isArray(value)
    || (prototype !== Object.prototype && prototype !== null)
  ) {
    return fail("INVALID_BUNDLE", `${path} must be a plain object.`);
  }
  return value as JsonObject;
}

function exactKeys(
  value: JsonObject,
  expected: readonly string[],
  path: string,
): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (
    actual.length !== wanted.length
    || actual.some((key, index) => key !== wanted[index])
  ) {
    return fail(
      "INVALID_BUNDLE",
      `${path} has a closed schema with exactly: ${wanted.join(", ")}.`,
    );
  }
}

function isWellFormedUnicode(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) return false;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return false;
    }
  }
  return true;
}

function parsePurpose(value: unknown): Readonly<V2PayLinkPurpose> {
  const purpose = asObject(value, "bundle.purpose");
  exactKeys(purpose, ["schema", "note", "reply_to"], "bundle.purpose");
  if (purpose.schema !== V2_PAY_LINK_PURPOSE_SCHEMA) {
    return fail(
      "INVALID_BUNDLE",
      `bundle.purpose.schema must be ${V2_PAY_LINK_PURPOSE_SCHEMA}.`,
    );
  }
  if (
    purpose.note !== null
    && (
      typeof purpose.note !== "string"
      || purpose.note.includes("\0")
      || !isWellFormedUnicode(purpose.note)
      || new TextEncoder().encode(purpose.note).byteLength
        > V2_PAY_LINK_NOTE_MAX_BYTES
    )
  ) {
    return fail(
      "INVALID_BUNDLE",
      `bundle.purpose.note must be null or at most ${V2_PAY_LINK_NOTE_MAX_BYTES} well-formed public UTF-8 bytes.`,
    );
  }

  const replyTo = asObject(purpose.reply_to, "bundle.purpose.reply_to");
  exactKeys(replyTo, ["kind"], "bundle.purpose.reply_to");
  if (replyTo.kind !== "offline") {
    return fail(
      "INVALID_BUNDLE",
      'bundle.purpose.reply_to.kind must be "offline".',
    );
  }

  return deepFreeze({
    schema: V2_PAY_LINK_PURPOSE_SCHEMA,
    note: purpose.note as string | null,
    reply_to: { kind: "offline" },
  });
}

function assertBundleSize(bytes: Uint8Array): void {
  if (bytes.byteLength > V2_PAY_LINK_MAX_BYTES) {
    return fail(
      "BUNDLE_TOO_LARGE",
      `CashLoom pay-link bundles must not exceed ${V2_PAY_LINK_MAX_BYTES} canonical bytes.`,
    );
  }
}

function assertValueNesting(value: unknown): void {
  const pending: Array<{
    value: unknown;
    depth: number;
    leaving: boolean;
  }> = [
    { value, depth: 1, leaving: false },
  ];
  const ancestors = new WeakSet<object>();

  while (pending.length > 0) {
    const current = pending.pop()!;
    if (
      current.value === null
      || typeof current.value !== "object"
    ) {
      continue;
    }
    if (current.leaving) {
      ancestors.delete(current.value);
      continue;
    }
    if (ancestors.has(current.value)) {
      return fail(
        "INVALID_BUNDLE",
        "A CashLoom pay-link must be an acyclic JSON value.",
      );
    }
    if (current.depth > V2_PAY_LINK_MAX_NESTING_DEPTH) {
      return fail(
        "EXCESS_NESTING",
        `CashLoom pay-link nesting must not exceed ${V2_PAY_LINK_MAX_NESTING_DEPTH} levels.`,
      );
    }
    ancestors.add(current.value);
    pending.push({
      value: current.value,
      depth: current.depth,
      leaving: true,
    });
    for (const child of Object.values(current.value)) {
      pending.push({
        value: child,
        depth: current.depth + 1,
        leaving: false,
      });
    }
  }
}

function assertByteInput(value: Uint8Array): void {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(value);
  } catch {
    return fail(
      "INVALID_UTF8",
      "A byte-encoded CashLoom pay-link must be valid UTF-8.",
    );
  }

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (const character of text) {
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === '"') {
        inString = false;
      }
      continue;
    }
    if (character === '"') {
      inString = true;
    } else if (character === "{" || character === "[") {
      depth += 1;
      if (depth > V2_PAY_LINK_MAX_NESTING_DEPTH) {
        return fail(
          "EXCESS_NESTING",
          `CashLoom pay-link nesting must not exceed ${V2_PAY_LINK_MAX_NESTING_DEPTH} levels.`,
        );
      }
    } else if (character === "}" || character === "]") {
      depth -= 1;
    }
  }
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === right.byteLength
    && left.every((byte, index) => byte === right[index]);
}

function inputSnapshot(value: unknown): unknown {
  if (value instanceof Uint8Array) {
    const exactBytes = Uint8Array.from(value);
    assertBundleSize(exactBytes);
    assertByteInput(exactBytes);
    const parsed = parseCanonicalJson(exactBytes);
    assertValueNesting(parsed);
    const canonical = canonicalJsonBytes(parsed);
    if (!sameBytes(exactBytes, canonical)) {
      return fail(
        "INVALID_BUNDLE",
        "A byte-encoded CashLoom pay-link must be exact canonical JSON.",
      );
    }
    return snapshotJsonData(parsed);
  }

  assertValueNesting(value);
  const snapshot = snapshotJsonData(value);
  assertBundleSize(canonicalJsonBytes(snapshot));
  return snapshot;
}

function parseBundle(value: unknown): Readonly<V2PayLinkBundle> {
  const bundle = asObject(value, "bundle");
  exactKeys(bundle, ["schema", "purpose", "records"], "bundle");
  if (bundle.schema !== V2_PAY_LINK_BUNDLE_SCHEMA) {
    return fail(
      "INVALID_BUNDLE",
      `bundle.schema must be ${V2_PAY_LINK_BUNDLE_SCHEMA}.`,
    );
  }

  const records = asObject(bundle.records, "bundle.records");
  exactKeys(
    records,
    ["node_descriptor", "asset_trust_manifest", "payment_request"],
    "bundle.records",
  );

  return {
    schema: V2_PAY_LINK_BUNDLE_SCHEMA,
    purpose: parsePurpose(bundle.purpose),
    records: {
      node_descriptor:
        records.node_descriptor as SignedV2Record<NodeDescriptorCore>,
      asset_trust_manifest:
        records.asset_trust_manifest as
          SignedV2Record<AssetTrustManifestRecordCore>,
      payment_request:
        records.payment_request as SignedV2Record<PaymentRequestCore>,
    },
  };
}

function deepFreeze<T>(value: T): Readonly<T> {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) {
      deepFreeze(child);
    }
    Object.freeze(value);
  }
  return value;
}

function usableUntil(
  descriptor: VerifiedV2Record<NodeDescriptorCore>,
  manifest: VerifiedV2Record<AssetTrustManifestRecordCore>,
  request: VerifiedV2Record<PaymentRequestCore>,
): string {
  return [descriptor.expires_at, manifest.expires_at, request.expires_at]
    .reduce((earliest, candidate) =>
      Date.parse(candidate) < Date.parse(earliest) ? candidate : earliest);
}

function assertDistinctRecordsAndNonces(
  records: readonly VerifiedV2Record[],
): void {
  const recordIds = new Set(records.map((record) => record.record_id));
  if (recordIds.size !== records.length) {
    return fail(
      "DUPLICATE_RECORD",
      "A pay-link bundle must contain three distinct signed records.",
    );
  }

  const noncesByAuthority = new Map<string, Set<string>>();
  for (const record of records) {
    const seen = noncesByAuthority.get(record.authority.key_id)
      ?? new Set<string>();
    if (seen.has(record.nonce)) {
      return fail(
        "ISSUER_NONCE_REUSE",
        "One authority reused a replay nonce across pay-link records.",
      );
    }
    seen.add(record.nonce);
    noncesByAuthority.set(record.authority.key_id, seen);
  }
}

export function createV2PayLinkPurpose(
  note: string | null,
): Readonly<V2PayLinkPurpose> {
  return parsePurpose({
    schema: V2_PAY_LINK_PURPOSE_SCHEMA,
    note,
    reply_to: { kind: "offline" },
  });
}

export function v2PayLinkPurposeHash(value: unknown): Sha256Id {
  assertValueNesting(value);
  return sha256Id(parsePurpose(snapshotJsonData(value)));
}

export function createV2PayLinkBundle(
  input: CreateV2PayLinkBundleInput,
  options: VerifyV2PayLinkOptions = {},
): Readonly<VerifiedV2PayLink> {
  return verifyV2PayLinkBundle({
    schema: V2_PAY_LINK_BUNDLE_SCHEMA,
    purpose: input.purpose,
    records: input.records,
  }, options);
}

export function verifyV2PayLinkBundle(
  value: unknown,
  options: VerifyV2PayLinkOptions = {},
): Readonly<VerifiedV2PayLink> {
  const parsed = parseBundle(inputSnapshot(value));
  const now = options.now ?? new Date().toISOString();

  const descriptorValue = verifyV2Record(
    parsed.records.node_descriptor,
    { now },
  );
  const manifestValue = verifyV2Record(
    parsed.records.asset_trust_manifest,
    { now },
  );
  const requestValue = verifyV2Record(
    parsed.records.payment_request,
    { now },
  );

  // Distinct content IDs are established before nonce comparison (and before
  // interpreting record slots) so repeated bytes cannot be misreported as
  // nonce reuse.
  assertDistinctRecordsAndNonces([
    descriptorValue,
    manifestValue,
    requestValue,
  ]);

  if (descriptorValue.schema !== V2_SCHEMAS.node_descriptor) {
    return fail(
      "WRONG_RECORD_SCHEMA",
      "bundle.records.node_descriptor has the wrong signed schema.",
    );
  }
  if (manifestValue.schema !== V2_SCHEMAS.asset_trust_manifest) {
    return fail(
      "WRONG_RECORD_SCHEMA",
      "bundle.records.asset_trust_manifest has the wrong signed schema.",
    );
  }
  if (requestValue.schema !== V2_SCHEMAS.payment_request) {
    return fail(
      "WRONG_RECORD_SCHEMA",
      "bundle.records.payment_request has the wrong signed schema.",
    );
  }

  const descriptor =
    descriptorValue as VerifiedV2Record<NodeDescriptorCore>;
  const manifest =
    manifestValue as VerifiedV2Record<AssetTrustManifestRecordCore>;
  const request =
    requestValue as VerifiedV2Record<PaymentRequestCore>;

  if (
    descriptor.disclosure !== "public"
    || manifest.disclosure !== "public"
    || request.disclosure !== "public"
    || descriptor.audience !== "public"
    || manifest.audience !== "public"
    || request.audience !== "public"
  ) {
    return fail(
      "NON_PUBLIC_OFFER",
      "A public pay-link requires public descriptor, manifest, and request disclosure and audiences.",
    );
  }

  verifyV2RecordLink(request, descriptor);

  const purposeHash = v2PayLinkPurposeHash(parsed.purpose);
  if (request.purpose_hash !== purposeHash) {
    return fail(
      "PURPOSE_MISMATCH",
      "The public purpose preimage does not match the signed payment request.",
    );
  }

  const assetTrust = verifyV2AssetTrustBinding(
    request.asset_trust,
    manifest,
    { asset_id: request.asset_id, rail: request.rail },
    { now },
  );

  let merchantKeyStatus: V2PayLinkMerchantKeyStatus = "first-contact";
  if (options.expectedMerchantKeyId !== undefined) {
    try {
      assertSha256Id(
        options.expectedMerchantKeyId,
        "expectedMerchantKeyId",
      );
    } catch {
      return fail(
        "MERCHANT_KEY_MISMATCH",
        "The expected merchant key pin is not a valid SHA-256 key id.",
      );
    }
    if (descriptor.authority.key_id !== options.expectedMerchantKeyId) {
      return fail(
        "MERCHANT_KEY_MISMATCH",
        "The pay-link merchant key does not match the caller-selected key pin.",
      );
    }
    merchantKeyStatus = "matched-pin";
  }

  const bundle = deepFreeze({
    schema: V2_PAY_LINK_BUNDLE_SCHEMA,
    purpose: parsed.purpose,
    records: {
      node_descriptor: descriptor,
      asset_trust_manifest: manifest,
      payment_request: request,
    },
  }) as Readonly<VerifiedV2PayLinkBundle>;
  const bytes = canonicalJsonBytes(bundle);
  assertBundleSize(bytes);

  return deepFreeze({
    bundle,
    bundle_id: sha256Id(bundle),
    purpose_hash: purposeHash,
    usable_until: usableUntil(descriptor, manifest, request),
    merchant_key_status: merchantKeyStatus,
    asset_trust: assetTrust,
  });
}

export function v2PayLinkBytes(
  value: V2PayLinkBundle | VerifiedV2PayLinkBundle,
): Uint8Array {
  const parsed = parseBundle(inputSnapshot(value));
  const bytes = canonicalJsonBytes(parsed);
  assertBundleSize(bytes);
  return Uint8Array.from(bytes);
}

export function v2PayLinkId(
  value: V2PayLinkBundle | VerifiedV2PayLinkBundle,
): Sha256Id {
  return sha256Id(parseBundle(inputSnapshot(value)));
}

export function v2PayLinkProjection(
  value: VerifiedV2PayLink,
): Readonly<V2PayLinkProjection> {
  const request = value.bundle.records.payment_request;
  return deepFreeze({
    bundle_id: value.bundle_id,
    request_record_id: request.record_id,
    merchant_key_id: request.authority.key_id,
    merchant_key_status: value.merchant_key_status,
    identity_assurance: V2_PAY_LINK_IDENTITY_ASSURANCE,
    note: value.bundle.purpose.note,
    note_visibility: V2_PAY_LINK_NOTE_VISIBILITY,
    rail: request.rail,
    destination: request.destination,
    asset_id: request.asset_id,
    amount_atomic: request.amount_atomic,
    request_issued_at: request.issued_at,
    request_expires_at: request.expires_at,
    usable_until: value.usable_until,
    asset_trust_manifest_record_id:
      value.bundle.records.asset_trust_manifest.record_id,
    asset_trust_policy_id: value.asset_trust.policy_id,
    asset_trust_policy_hash: value.asset_trust.policy_hash,
  });
}
