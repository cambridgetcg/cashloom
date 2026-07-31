/**
 * Private, offline acceptance carrier for one public CashLoom Pay Link.
 *
 * This file is evidence, not execution. It deliberately embeds the complete
 * public offer plus a merchant-addressed payer manifest and PaymentIntent so
 * the merchant can verify everything before admitting any record locally.
 * The carrier is plaintext and must be shared only with the named merchant.
 */

import {
  assertTimestamp,
  assertSha256Id,
  canonicalJsonBytes,
  parseCanonicalJson,
  sha256Id,
  snapshotJsonData,
  type Sha256Id,
} from "@agenttool/wallet";
import {
  BITCOIN_MAINNET_ASSET_ID,
  BITCOIN_MAINNET_RAIL,
  parseBitcoinMainnetAddress,
  parseBitcoinPayLinkMaxFeeSatoshis,
  parseBitcoinPaymentTerms,
} from "./bitcoin-profile.ts";
import {
  FAIL_CLOSED_ASSET_TRUST_POLICY,
  evaluateAssetTrust,
} from "./asset-trust.ts";
import {
  verifyV2PayLinkBundle,
  v2PayLinkProjection,
  type V2PayLinkBundle,
  type V2PayLinkProjection,
  type VerifiedV2PayLink,
  type VerifiedV2PayLinkBundle,
} from "./pay-link.ts";
import {
  V2_SCHEMAS,
  verifyV2AssetTrustBinding,
  verifyV2Record,
  verifyV2RecordLink,
  type AssetTrustManifestRecordCore,
  type PaymentIntentCore,
  type SignedV2Record,
  type VerifiedV2Record,
} from "./records.ts";

export const V2_PAY_LINK_ACCEPTANCE_SCHEMA =
  "cashloom/pay-link-acceptance/v2" as const;
export const V2_PAY_LINK_ACCEPTANCE_MEDIA_TYPE =
  "application/cashloom-pay-link-acceptance+json" as const;
export const V2_PAY_LINK_ACCEPTANCE_FILE_EXTENSION =
  ".cashloom-accept" as const;
export const V2_PAY_LINK_ACCEPTANCE_MAX_BYTES = 64 * 1024;
export const V2_PAY_LINK_ACCEPTANCE_MAX_NESTING_DEPTH = 40;
export const V2_PAY_LINK_ACCEPTANCE_CONFIDENTIALITY =
  "sensitive-plaintext" as const;

export interface V2PayLinkAcceptanceRecords {
  readonly asset_trust_manifest:
    SignedV2Record<AssetTrustManifestRecordCore>;
  readonly payment_intent: SignedV2Record<PaymentIntentCore>;
}

export interface V2PayLinkAcceptanceBundle {
  readonly schema: typeof V2_PAY_LINK_ACCEPTANCE_SCHEMA;
  readonly pay_link: V2PayLinkBundle;
  readonly records: V2PayLinkAcceptanceRecords;
}

export interface VerifiedV2PayLinkAcceptanceRecords {
  readonly asset_trust_manifest:
    VerifiedV2Record<AssetTrustManifestRecordCore>;
  readonly payment_intent: VerifiedV2Record<PaymentIntentCore>;
}

export interface VerifiedV2PayLinkAcceptanceBundle {
  readonly schema: typeof V2_PAY_LINK_ACCEPTANCE_SCHEMA;
  readonly pay_link: VerifiedV2PayLinkBundle;
  readonly records: VerifiedV2PayLinkAcceptanceRecords;
}

export interface VerifyV2PayLinkAcceptanceOptions {
  /** Mandatory out-of-band/local merchant key pin. */
  readonly expectedMerchantKeyId: Sha256Id | string;
  /** Defaults to one captured local wall-clock value. */
  readonly now?: string;
}

export interface CreateV2PayLinkAcceptanceInput {
  readonly pay_link: V2PayLinkBundle | VerifiedV2PayLinkBundle;
  readonly records: V2PayLinkAcceptanceRecords;
}

export interface VerifiedV2PayLinkAcceptance {
  readonly bundle: VerifiedV2PayLinkAcceptanceBundle;
  readonly acceptance_id: Sha256Id;
  readonly pay_link: VerifiedV2PayLink;
  readonly intent_active_at_verification: boolean;
}

export interface V2PayLinkAcceptanceProjection {
  readonly acceptance_id: Sha256Id;
  readonly pay_link_id: Sha256Id;
  readonly request_record_id: Sha256Id;
  readonly merchant_key_id: Sha256Id;
  readonly payer_key_id: Sha256Id;
  readonly note: string | null;
  readonly rail: string;
  readonly destination: string;
  readonly asset_id: string;
  readonly amount_atomic: string;
  readonly source_account: string;
  readonly fee_asset_id: string;
  readonly max_fee_atomic: string;
  readonly intent_issued_at: string;
  readonly intent_expires_at: string;
  readonly intent_active_at_verification: boolean;
  readonly no_money_moved: true;
  readonly confidentiality:
    typeof V2_PAY_LINK_ACCEPTANCE_CONFIDENTIALITY;
  readonly request: V2PayLinkProjection;
}

export type V2PayLinkAcceptanceErrorCode =
  | "INVALID_ACCEPTANCE"
  | "INVALID_UTF8"
  | "EXCESS_NESTING"
  | "ACCEPTANCE_TOO_LARGE"
  | "WRONG_RECORD_SCHEMA"
  | "WRONG_AUDIENCE"
  | "PAYER_AUTHORITY_MISMATCH"
  | "DUPLICATE_RECORD"
  | "ISSUER_NONCE_REUSE"
  | "TRUST_MANIFEST_MISMATCH"
  | "WRONG_BITCOIN_PROFILE"
  | "UNSUPPORTED_FEE_ASSET";

export class V2PayLinkAcceptanceError extends Error {
  readonly code: V2PayLinkAcceptanceErrorCode;

  constructor(code: V2PayLinkAcceptanceErrorCode, message: string) {
    super(message);
    this.name = "V2PayLinkAcceptanceError";
    this.code = code;
  }
}

type JsonObject = Record<string, unknown>;

function fail(
  code: V2PayLinkAcceptanceErrorCode,
  message: string,
): never {
  throw new V2PayLinkAcceptanceError(code, message);
}

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
    return fail("INVALID_ACCEPTANCE", `${path} must be a plain object.`);
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
      "INVALID_ACCEPTANCE",
      `${path} has a closed schema with exactly: ${wanted.join(", ")}.`,
    );
  }
}

function assertDistinctCarrierRecords(
  records: readonly VerifiedV2Record[],
): void {
  if (
    new Set(records.map((record) => record.record_id)).size
    !== records.length
  ) {
    return fail(
      "DUPLICATE_RECORD",
      "An acceptance carrier must contain five distinct signed records.",
    );
  }
  const noncesByAuthority = new Map<string, Set<string>>();
  for (const record of records) {
    const seen = noncesByAuthority.get(record.authority.key_id)
      ?? new Set<string>();
    if (seen.has(record.nonce)) {
      return fail(
        "ISSUER_NONCE_REUSE",
        "One authority reused a replay nonce across acceptance-carrier records.",
      );
    }
    seen.add(record.nonce);
    noncesByAuthority.set(record.authority.key_id, seen);
  }
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === right.byteLength
    && left.every((byte, index) => byte === right[index]);
}

function assertValueNesting(value: unknown): void {
  const pending: Array<{
    value: unknown;
    depth: number;
    leaving: boolean;
  }> = [{ value, depth: 1, leaving: false }];
  const ancestors = new WeakSet<object>();
  while (pending.length > 0) {
    const current = pending.pop()!;
    if (current.value === null || typeof current.value !== "object") {
      continue;
    }
    if (current.leaving) {
      ancestors.delete(current.value);
      continue;
    }
    if (ancestors.has(current.value)) {
      return fail(
        "INVALID_ACCEPTANCE",
        "A CashLoom acceptance must be an acyclic JSON value.",
      );
    }
    if (current.depth > V2_PAY_LINK_ACCEPTANCE_MAX_NESTING_DEPTH) {
      return fail(
        "EXCESS_NESTING",
        `CashLoom acceptance nesting must not exceed ${V2_PAY_LINK_ACCEPTANCE_MAX_NESTING_DEPTH} levels.`,
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
      "A byte-encoded CashLoom acceptance must be valid UTF-8.",
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
      if (depth > V2_PAY_LINK_ACCEPTANCE_MAX_NESTING_DEPTH) {
        return fail(
          "EXCESS_NESTING",
          `CashLoom acceptance nesting must not exceed ${V2_PAY_LINK_ACCEPTANCE_MAX_NESTING_DEPTH} levels.`,
        );
      }
    } else if (character === "}" || character === "]") {
      depth -= 1;
    }
  }
}

function assertSize(bytes: Uint8Array): void {
  if (bytes.byteLength > V2_PAY_LINK_ACCEPTANCE_MAX_BYTES) {
    return fail(
      "ACCEPTANCE_TOO_LARGE",
      `CashLoom acceptance bundles must not exceed ${V2_PAY_LINK_ACCEPTANCE_MAX_BYTES} canonical bytes.`,
    );
  }
}

function inputSnapshot(value: unknown): unknown {
  if (value instanceof Uint8Array) {
    const bytes = Uint8Array.from(value);
    assertSize(bytes);
    assertByteInput(bytes);
    const parsed = parseCanonicalJson(bytes);
    assertValueNesting(parsed);
    if (!sameBytes(bytes, canonicalJsonBytes(parsed))) {
      return fail(
        "INVALID_ACCEPTANCE",
        "A byte-encoded CashLoom acceptance must be exact canonical JSON.",
      );
    }
    return snapshotJsonData(parsed);
  }
  assertValueNesting(value);
  const snapshot = snapshotJsonData(value);
  assertSize(canonicalJsonBytes(snapshot));
  return snapshot;
}

function parseBundle(value: unknown): V2PayLinkAcceptanceBundle {
  const bundle = asObject(value, "acceptance");
  exactKeys(bundle, ["schema", "pay_link", "records"], "acceptance");
  if (bundle.schema !== V2_PAY_LINK_ACCEPTANCE_SCHEMA) {
    return fail(
      "INVALID_ACCEPTANCE",
      `acceptance.schema must be ${V2_PAY_LINK_ACCEPTANCE_SCHEMA}.`,
    );
  }
  const records = asObject(bundle.records, "acceptance.records");
  exactKeys(
    records,
    ["asset_trust_manifest", "payment_intent"],
    "acceptance.records",
  );
  return {
    schema: V2_PAY_LINK_ACCEPTANCE_SCHEMA,
    pay_link: bundle.pay_link as V2PayLinkBundle,
    records: {
      asset_trust_manifest:
        records.asset_trust_manifest as
          SignedV2Record<AssetTrustManifestRecordCore>,
      payment_intent:
        records.payment_intent as SignedV2Record<PaymentIntentCore>,
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

export function createV2PayLinkAcceptance(
  input: CreateV2PayLinkAcceptanceInput,
  options: VerifyV2PayLinkAcceptanceOptions,
): Readonly<VerifiedV2PayLinkAcceptance> {
  return verifyV2PayLinkAcceptance({
    schema: V2_PAY_LINK_ACCEPTANCE_SCHEMA,
    pay_link: input.pay_link as V2PayLinkBundle,
    records: input.records,
  }, options);
}

export function verifyV2PayLinkAcceptance(
  value: unknown,
  options: VerifyV2PayLinkAcceptanceOptions,
): Readonly<VerifiedV2PayLinkAcceptance> {
  assertSha256Id(
    options.expectedMerchantKeyId,
    "expectedMerchantKeyId",
  );
  const merchantKeyId = options.expectedMerchantKeyId as Sha256Id;
  const parsed = parseBundle(inputSnapshot(value));

  const historicalIntent = verifyV2Record(
    parsed.records.payment_intent,
  );
  if (historicalIntent.schema !== V2_SCHEMAS.payment_intent) {
    return fail(
      "WRONG_RECORD_SCHEMA",
      "acceptance.records.payment_intent has the wrong signed schema.",
    );
  }
  const intentIssuedAt = historicalIntent.issued_at;
  const now = options.now ?? new Date().toISOString();
  assertTimestamp(now, "now");
  if (Date.parse(now) < Date.parse(intentIssuedAt)) {
    return fail(
      "INVALID_ACCEPTANCE",
      "The acceptance intent has not been issued yet.",
    );
  }
  const intentAtIssuance = verifyV2Record(
    historicalIntent,
    { now: intentIssuedAt },
  );
  const historicalManifest = verifyV2Record(
    parsed.records.asset_trust_manifest,
  );
  if (historicalManifest.schema !== V2_SCHEMAS.asset_trust_manifest) {
    return fail(
      "WRONG_RECORD_SCHEMA",
      "acceptance.records.asset_trust_manifest has the wrong signed schema.",
    );
  }
  const activeAtIntentManifest = verifyV2Record(
    historicalManifest,
    { now: intentIssuedAt },
  );

  const intent =
    intentAtIssuance as VerifiedV2Record<PaymentIntentCore>;
  const manifest =
    activeAtIntentManifest as
      VerifiedV2Record<AssetTrustManifestRecordCore>;
  const payLink = verifyV2PayLinkBundle(parsed.pay_link, {
    now: intentIssuedAt,
    expectedMerchantKeyId: merchantKeyId,
  });
  const request = payLink.bundle.records.payment_request;
  try {
    if (
      request.rail !== BITCOIN_MAINNET_RAIL
      || request.asset_id !== BITCOIN_MAINNET_ASSET_ID
    ) {
      return fail(
        "WRONG_BITCOIN_PROFILE",
        "The first acceptance profile supports Bitcoin mainnet only.",
      );
    }
    const terms = parseBitcoinPaymentTerms(
      request.destination,
      request.amount_atomic,
    );
    if (terms.destination !== request.destination) {
      return fail(
        "WRONG_BITCOIN_PROFILE",
        "The request destination is not canonical Bitcoin mainnet.",
      );
    }
    if (
      parseBitcoinMainnetAddress(intent.source_account)
      !== intent.source_account
    ) {
      return fail(
        "WRONG_BITCOIN_PROFILE",
        "The payer source is not canonical Bitcoin mainnet.",
      );
    }
    parseBitcoinPayLinkMaxFeeSatoshis(intent.max_fee_atomic);
  } catch (cause) {
    if (cause instanceof V2PayLinkAcceptanceError) throw cause;
    return fail(
      "WRONG_BITCOIN_PROFILE",
      cause instanceof Error
        ? cause.message
        : "The acceptance does not match the Bitcoin mainnet profile.",
    );
  }

  const offeredAssetDecision = evaluateAssetTrust(
    payLink.bundle.records.asset_trust_manifest.manifest,
    FAIL_CLOSED_ASSET_TRUST_POLICY,
  );
  const payerAssetDecision = evaluateAssetTrust(
    manifest.manifest,
    FAIL_CLOSED_ASSET_TRUST_POLICY,
  );
  if (!offeredAssetDecision.accepted || !payerAssetDecision.accepted) {
    return fail(
      "WRONG_BITCOIN_PROFILE",
      "The acceptance's asset manifests fail this node's built-in fail-closed Bitcoin policy.",
    );
  }

  if (
    intent.disclosure !== "private"
    || manifest.disclosure !== "private"
    || intent.audience !== merchantKeyId
    || manifest.audience !== merchantKeyId
  ) {
    return fail(
      "WRONG_AUDIENCE",
      "Every private acceptance record must address the explicitly pinned merchant key.",
    );
  }
  if (
    intent.authority.key_id !== manifest.authority.key_id
    || intent.authority.public_key !== manifest.authority.public_key
  ) {
    return fail(
      "PAYER_AUTHORITY_MISMATCH",
      "The acceptance manifest and intent must share one payer authority.",
    );
  }
  if (intent.nonce === manifest.nonce) {
    return fail(
      "PAYER_AUTHORITY_MISMATCH",
      "The payer authority reused one nonce across acceptance records.",
    );
  }

  assertDistinctCarrierRecords([
    payLink.bundle.records.node_descriptor,
    payLink.bundle.records.asset_trust_manifest,
    request,
    manifest,
    intent,
  ]);

  verifyV2RecordLink(intent, request);

  const paymentBinding = intent.payment_asset_trust;
  const feeBinding = intent.fee_asset_trust;
  if (
    paymentBinding.manifest_record_id !== manifest.record_id
    || feeBinding.manifest_record_id !== manifest.record_id
    || paymentBinding.manifest_authority_key_id
      !== manifest.authority.key_id
    || feeBinding.manifest_authority_key_id
      !== manifest.authority.key_id
  ) {
    return fail(
      "TRUST_MANIFEST_MISMATCH",
      "This BTC acceptance must carry the exact payer manifest referenced by both trust bindings.",
    );
  }
  if (
    request.asset_id !== BITCOIN_MAINNET_ASSET_ID
    || intent.fee_asset_id !== request.asset_id
  ) {
    return fail(
      "UNSUPPORTED_FEE_ASSET",
      "The first Pay Link acceptance profile requires BTC for both payment and total fee exposure.",
    );
  }

  verifyV2AssetTrustBinding(
    paymentBinding,
    manifest,
    { asset_id: intent.asset_id, rail: intent.rail },
    { now: intentIssuedAt },
  );
  verifyV2AssetTrustBinding(
    feeBinding,
    manifest,
    { asset_id: intent.fee_asset_id, rail: intent.rail },
    { now: intentIssuedAt },
  );

  const bundle = deepFreeze({
    schema: V2_PAY_LINK_ACCEPTANCE_SCHEMA,
    pay_link: payLink.bundle,
    records: {
      asset_trust_manifest: manifest,
      payment_intent: intent,
    },
  }) as VerifiedV2PayLinkAcceptanceBundle;
  const bytes = canonicalJsonBytes(bundle);
  assertSize(bytes);

  return deepFreeze({
    bundle,
    acceptance_id: sha256Id(bundle),
    pay_link: payLink,
    intent_active_at_verification:
      Date.parse(now) < Date.parse(intent.expires_at),
  });
}

export function v2PayLinkAcceptanceBytes(
  value: V2PayLinkAcceptanceBundle | VerifiedV2PayLinkAcceptanceBundle,
): Uint8Array {
  const parsed = parseBundle(inputSnapshot(value));
  const bytes = canonicalJsonBytes(parsed);
  assertSize(bytes);
  return Uint8Array.from(bytes);
}

export function v2PayLinkAcceptanceProjection(
  value: VerifiedV2PayLinkAcceptance,
): Readonly<V2PayLinkAcceptanceProjection> {
  const intent = value.bundle.records.payment_intent;
  const request = value.pay_link.bundle.records.payment_request;
  return deepFreeze({
    acceptance_id: value.acceptance_id,
    pay_link_id: value.pay_link.bundle_id,
    request_record_id: request.record_id,
    merchant_key_id: request.authority.key_id,
    payer_key_id: intent.authority.key_id,
    note: value.pay_link.bundle.purpose.note,
    rail: intent.rail,
    destination: intent.destination,
    asset_id: intent.asset_id,
    amount_atomic: intent.amount_atomic,
    source_account: intent.source_account,
    fee_asset_id: intent.fee_asset_id,
    max_fee_atomic: intent.max_fee_atomic,
    intent_issued_at: intent.issued_at,
    intent_expires_at: intent.expires_at,
    intent_active_at_verification:
      value.intent_active_at_verification,
    no_money_moved: true,
    confidentiality: V2_PAY_LINK_ACCEPTANCE_CONFIDENTIALITY,
    request: v2PayLinkProjection(value.pay_link),
  });
}
