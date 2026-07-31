/**
 * Payer-local Bitcoin execution adapter for one CashLoom v2 PaymentIntent.
 *
 * Portable Pay Link files remain evidence-only. This adapter accepts only the
 * content ID of an active intent authored by this node, binds its immutable
 * terms to one local BTC account and one canonical unsigned PSBT, then waits
 * for a separate explicit confirmation before any execution record, Bitcoin
 * signature, or broadcast exists.
 */

import type { Database } from "bun:sqlite";
import {
  assertSha256Id,
  assertTimestamp,
  equalBytes,
  sha256BytesId,
  sha256Id,
  type Sha256Id,
} from "@agenttool/wallet";
import {
  BITCOIN_MAINNET_ASSET_ID,
  BITCOIN_MAINNET_RAIL,
  parseBitcoinMainnetAddress,
  parseBitcoinPayLinkMaxFeeSatoshis,
  parseBitcoinPaymentTerms,
} from "../protocol/v2/bitcoin-profile.ts";
import {
  FAIL_CLOSED_ASSET_TRUST_POLICY,
  evaluateAssetTrust,
} from "../protocol/v2/asset-trust.ts";
import type { V2LocalService } from "../protocol/v2/local-service.ts";
import {
  V2RecordStoreError,
  type CashLoomV2RecordStore,
} from "../protocol/v2/record-store.ts";
import {
  V2_SCHEMAS,
  verifyV2Record,
  verifyV2RecordLink,
  type AssetTrustBinding,
  type AssetTrustManifestRecordCore,
  type ExecutionCommitmentCore,
  type NodeDescriptorCore,
  type PaymentIntentCore,
  type PaymentRequestCore,
  type VerifiedV2Record,
} from "../protocol/v2/records.ts";
import {
  confirmPayment,
  quotePayment,
  type PaymentQuoteDraft,
} from "../pay.ts";
import {
  bitcoinTxidForUnsignedPayload,
  bitcoinUnsignedPayloadFor,
} from "../senders/btc.sender.ts";
import type {
  PaymentInstruction,
  PaymentSender,
  SenderContext,
} from "../senders/types.ts";

export const BITCOIN_PAY_LINK_REVIEW_SCHEMA =
  "cashloom/bitcoin-pay-link-review/v1" as const;
export const BITCOIN_PAY_LINK_RESERVATION_SCHEMA =
  "cashloom/bitcoin-pay-link-reservation/v1" as const;

export type BitcoinPayLinkExecutionErrorCode =
  | "NODE_NOT_ACTIVATED"
  | "INTENT_NOT_LOCALLY_AUTHORED"
  | "INTENT_INACTIVE"
  | "WRONG_BITCOIN_PROFILE"
  | "ASSET_POLICY_REJECTED"
  | "ACCOUNT_SOURCE_MISMATCH"
  | "FEE_LIMIT_EXCEEDED"
  | "EXECUTION_CONFLICT"
  | "REVIEW_EXPIRED"
  | "PAYMENT_NOT_READY"
  | "STORAGE_INTEGRITY_FAILURE";

export class BitcoinPayLinkExecutionError extends Error {
  readonly code: BitcoinPayLinkExecutionErrorCode;

  constructor(code: BitcoinPayLinkExecutionErrorCode, message: string) {
    super(message);
    this.name = "BitcoinPayLinkExecutionError";
    this.code = code;
  }
}

export interface PrepareBitcoinPayLinkExecutionInput {
  readonly intent_record_id: string;
  readonly account_id: string;
}

export interface ConfirmBitcoinPayLinkExecutionInput {
  readonly payment_id: string;
  readonly review_id: string;
}

export interface BitcoinPayLinkExecutionReview {
  readonly review_id: Sha256Id;
  readonly payment_id: string;
  readonly intent_record_id: Sha256Id;
  readonly request_record_id: Sha256Id;
  readonly merchant_key_id: Sha256Id;
  readonly network: "Bitcoin mainnet";
  readonly account_id: string;
  readonly account_label: string;
  readonly source_address: string;
  readonly destination: string;
  readonly asset: "BTC";
  readonly amount_sats: string;
  readonly fee_sats: string;
  readonly total_sats: string;
  readonly max_fee_sats: string;
  readonly quote_expires_at: string;
  readonly intent_expires_at: string;
  readonly confirm_before: string;
  readonly fee_is_exact: true;
  readonly cashloom_fee_sats: "0";
  readonly no_money_moved: true;
  readonly transaction_not_signed: true;
}

export interface PreparedBitcoinPayLinkExecution {
  readonly review: Readonly<BitcoinPayLinkExecutionReview>;
  readonly reused: boolean;
}

export type BitcoinPayLinkExecutionStatus =
  | "broadcast"
  | "broadcast_unknown"
  | "failed";

export interface BitcoinPayLinkExecutionResult {
  readonly payment_id: string;
  readonly review_id: Sha256Id;
  readonly status: BitcoinPayLinkExecutionStatus;
  readonly tx_hash: string | null;
  readonly error: string | null;
}

export type BitcoinPayLinkExecutionSnapshotStatus =
  | BitcoinPayLinkExecutionStatus
  | "awaiting_confirmation"
  | "not_sent";

export interface BitcoinPayLinkExecutionSnapshot {
  readonly payment_id: string;
  readonly review_id: Sha256Id;
  readonly intent_record_id: Sha256Id;
  readonly status: BitcoinPayLinkExecutionSnapshotStatus;
  readonly can_confirm: boolean;
  readonly tx_hash: string | null;
  readonly error: string | null;
}

interface ExecutionAccountRow {
  id: string;
  rail: string;
  display_name: string;
  currency: string;
  decimals: number;
  external_account_id: string | null;
  vault_key_id: string | null;
  status: string;
  key_kind: string | null;
  key_address: string | null;
}

interface BindingRow {
  intent_record_id: Sha256Id;
  payment_id: string;
  account_id: string;
  review_id: Sha256Id;
  reservation_id: Sha256Id;
  unsigned_payload: Uint8Array;
  unsigned_payload_hash: Sha256Id;
  quote_expires_at: string;
  created_at: string;
}

interface PaymentRow {
  id: string;
  account_id: string;
  rail: string;
  to_addr: string;
  asset: string;
  amount_minor: string;
  fee_minor: string | null;
  status: string;
  tx_hash: string | null;
  error: string | null;
  detail: string | null;
  created_at: string;
}

interface ExecutionContext {
  readonly intent: VerifiedV2Record<PaymentIntentCore>;
  readonly request: VerifiedV2Record<PaymentRequestCore>;
  readonly account: ExecutionAccountRow;
}

interface UnsignedPayloadEvidence {
  readonly payload: Uint8Array;
  readonly hash: Sha256Id;
}

export interface BitcoinPayLinkExecutionDependencies {
  readonly database: Database;
  readonly store: () => CashLoomV2RecordStore;
  readonly localService: () => Promise<V2LocalService>;
  readonly now?: () => string;
  readonly senders?: readonly PaymentSender[];
  readonly quote?: typeof quotePayment;
  readonly confirm?: typeof confirmPayment;
  readonly unsignedPayloadFor?: (
    context: SenderContext,
    instruction: PaymentInstruction,
  ) => Promise<UnsignedPayloadEvidence>;
}

interface ReviewDigest {
  schema: typeof BITCOIN_PAY_LINK_REVIEW_SCHEMA;
  payment_id: string;
  intent_record_id: Sha256Id;
  request_record_id: Sha256Id;
  merchant_key_id: Sha256Id;
  account_id: string;
  source_address: string;
  destination: string;
  asset: "BTC";
  amount_sats: string;
  fee_sats: string;
  total_sats: string;
  max_fee_sats: string;
  reservation_id: Sha256Id;
  unsigned_payload_hash: Sha256Id;
  quote_expires_at: string;
  intent_expires_at: string;
  confirm_before: string;
}

const SATOSHIS = /^(0|[1-9][0-9]*)$/u;
const BITCOIN_TXID = /^[0-9a-f]{64}$/u;

function localNow(now: () => string): string {
  const value = now();
  assertTimestamp(value, "now");
  return value;
}

function earlierTimestamp(left: string, right: string): string {
  return Date.parse(left) <= Date.parse(right) ? left : right;
}

function storageFailure(message: string, cause?: unknown): never {
  const error = new BitcoinPayLinkExecutionError(
    "STORAGE_INTEGRITY_FAILURE",
    message,
  );
  if (cause !== undefined) error.cause = cause;
  throw error;
}

function bindingBytes(value: unknown): Uint8Array {
  if (!(value instanceof Uint8Array) || value.byteLength === 0) {
    return storageFailure(
      "The stored Bitcoin execution binding has no usable unsigned payload.",
    );
  }
  return Uint8Array.from(value);
}

function accountRow(database: Database, accountId: string): ExecutionAccountRow {
  const row = database
    .query(
      `SELECT a.id, a.rail, a.display_name, a.currency, a.decimals,
              a.external_account_id, a.vault_key_id, a.status,
              k.kind AS key_kind, k.address AS key_address
         FROM accounts AS a
         LEFT JOIN vault_keys AS k ON k.id = a.vault_key_id
        WHERE a.id = ?`,
    )
    .get(accountId) as ExecutionAccountRow | null;
  if (row === null) {
    throw new BitcoinPayLinkExecutionError(
      "ACCOUNT_SOURCE_MISMATCH",
      "Choose an existing local Bitcoin account for this payment.",
    );
  }
  return row;
}

function assertExecutionAccount(
  row: ExecutionAccountRow,
  sourceAccount: string,
): ExecutionAccountRow {
  const source = parseBitcoinMainnetAddress(sourceAccount);
  if (
    row.status !== "ACTIVE"
    || row.rail !== "CRYPTO"
    || row.currency !== "BTC"
    || row.decimals !== 8
    || row.vault_key_id === null
    || row.key_kind !== "btc"
    || row.key_address === null
  ) {
    throw new BitcoinPayLinkExecutionError(
      "ACCOUNT_SOURCE_MISMATCH",
      "The selected account must be an active 8-decimal BTC account backed by a local Bitcoin key.",
    );
  }
  let keyAddress: string;
  try {
    keyAddress = parseBitcoinMainnetAddress(row.key_address);
  } catch {
    throw new BitcoinPayLinkExecutionError(
      "ACCOUNT_SOURCE_MISMATCH",
      "The selected account's Bitcoin key has no valid mainnet address.",
    );
  }
  if (keyAddress !== source) {
    throw new BitcoinPayLinkExecutionError(
      "ACCOUNT_SOURCE_MISMATCH",
      "The selected account's local Bitcoin key does not match the source signed in this intent.",
    );
  }
  if (row.external_account_id !== null && row.external_account_id.trim() !== "") {
    let externalAddress: string;
    try {
      externalAddress = parseBitcoinMainnetAddress(row.external_account_id);
    } catch {
      throw new BitcoinPayLinkExecutionError(
        "ACCOUNT_SOURCE_MISMATCH",
        "The selected account's configured external address is not a valid Bitcoin mainnet address.",
      );
    }
    if (externalAddress !== source) {
      throw new BitcoinPayLinkExecutionError(
        "ACCOUNT_SOURCE_MISMATCH",
        "The selected account's configured external address conflicts with the source signed in this intent.",
      );
    }
  }
  return row;
}

function assertTrustBinding(
  store: CashLoomV2RecordStore,
  binding: AssetTrustBinding,
  expectedAsset: string,
  now?: string,
): void {
  const stored = store.getLocal(binding.manifest_record_id);
  if (
    stored === null
    || stored.schema !== V2_SCHEMAS.asset_trust_manifest
  ) {
    throw new BitcoinPayLinkExecutionError(
      "ASSET_POLICY_REJECTED",
      "The intent's local Bitcoin asset-trust evidence is unavailable.",
    );
  }
  const manifest = verifyV2Record(
    stored,
    now === undefined ? {} : { now },
  ) as
    VerifiedV2Record<AssetTrustManifestRecordCore>;
  if (
    manifest.authority.key_id !== binding.manifest_authority_key_id
    || manifest.manifest.asset_id !== expectedAsset
    || manifest.manifest.rail !== BITCOIN_MAINNET_RAIL
  ) {
    throw new BitcoinPayLinkExecutionError(
      "ASSET_POLICY_REJECTED",
      "The intent's Bitcoin asset-trust binding no longer matches its signed terms.",
    );
  }
  const decision = evaluateAssetTrust(
    manifest.manifest,
    binding.policy ?? FAIL_CLOSED_ASSET_TRUST_POLICY,
  );
  if (!decision.accepted || decision.policy_hash !== binding.policy_hash) {
    throw new BitcoinPayLinkExecutionError(
      "ASSET_POLICY_REJECTED",
      "This node's signed fail-closed asset policy rejects the execution.",
    );
  }
}

function assertBitcoinIntent(
  store: CashLoomV2RecordStore,
  intent: VerifiedV2Record<PaymentIntentCore>,
  now?: string,
): void {
  if (
    intent.rail !== BITCOIN_MAINNET_RAIL
    || intent.asset_id !== BITCOIN_MAINNET_ASSET_ID
    || intent.fee_asset_id !== BITCOIN_MAINNET_ASSET_ID
    || intent.fee_limit_scope !== "total_fee_asset_exposure"
  ) {
    throw new BitcoinPayLinkExecutionError(
      "WRONG_BITCOIN_PROFILE",
      "This execution adapter accepts the Bitcoin-mainnet Pay Link profile only.",
    );
  }
  const terms = parseBitcoinPaymentTerms(
    intent.destination,
    intent.amount_atomic,
  );
  const source = parseBitcoinMainnetAddress(intent.source_account);
  const maxFee = parseBitcoinPayLinkMaxFeeSatoshis(intent.max_fee_atomic);
  if (
    terms.destination !== intent.destination
    || terms.amount_sats !== intent.amount_atomic
    || source !== intent.source_account
    || maxFee !== intent.max_fee_atomic
  ) {
    throw new BitcoinPayLinkExecutionError(
      "WRONG_BITCOIN_PROFILE",
      "The signed intent does not use canonical Bitcoin-mainnet terms.",
    );
  }
  assertTrustBinding(
    store,
    intent.payment_asset_trust,
    BITCOIN_MAINNET_ASSET_ID,
    now,
  );
  assertTrustBinding(
    store,
    intent.fee_asset_trust,
    BITCOIN_MAINNET_ASSET_ID,
    now,
  );
}

function activeContext(
  database: Database,
  store: CashLoomV2RecordStore,
  intentRecordId: string,
  accountId: string,
  now: string,
): ExecutionContext {
  assertSha256Id(intentRecordId, "intent_record_id");
  const storedDescriptor = store.latestPublicNodeDescriptor();
  if (storedDescriptor === null) {
    throw new BitcoinPayLinkExecutionError(
      "NODE_NOT_ACTIVATED",
      "Activate this sovereign node's self-certifying payer key before preparing a payment.",
    );
  }
  let descriptor: VerifiedV2Record<NodeDescriptorCore>;
  try {
    descriptor = verifyV2Record(storedDescriptor, { now }) as
      VerifiedV2Record<NodeDescriptorCore>;
  } catch (cause) {
    const error = new BitcoinPayLinkExecutionError(
      "NODE_NOT_ACTIVATED",
      "Activate a fresh sovereign payer descriptor before preparing a payment.",
    );
    error.cause = cause;
    throw error;
  }
  if (!descriptor.roles.includes("payer")) {
    throw new BitcoinPayLinkExecutionError(
      "NODE_NOT_ACTIVATED",
      "The active sovereign descriptor does not declare the payer role.",
    );
  }
  const intent = store.localPaymentIntentById(
    intentRecordId,
    descriptor.authority.key_id,
  );
  if (intent === null) {
    throw new BitcoinPayLinkExecutionError(
      "INTENT_NOT_LOCALLY_AUTHORED",
      "Only a payment intent signed locally by this payer node can use its Bitcoin vault.",
    );
  }
  if (
    Date.parse(now) < Date.parse(intent.issued_at)
    || Date.parse(now) >= Date.parse(intent.expires_at)
  ) {
    throw new BitcoinPayLinkExecutionError(
      "INTENT_INACTIVE",
      "This payment intent is no longer active. Ask for a fresh Pay Link instead of silently renewing it.",
    );
  }
  try {
    verifyV2Record(intent, { now });
  } catch (cause) {
    const error = new BitcoinPayLinkExecutionError(
      "INTENT_INACTIVE",
      "This payment intent is not active at the local confirmation time.",
    );
    error.cause = cause;
    throw error;
  }
  assertBitcoinIntent(store, intent, now);
  if (intent.parent_record_id === null) {
    return storageFailure("The locally authored intent has no request parent.");
  }
  const parent = store.getLocal(intent.parent_record_id);
  if (parent === null || parent.schema !== V2_SCHEMAS.payment_request) {
    return storageFailure("The locally authored intent's request is unavailable.");
  }
  const request = parent as VerifiedV2Record<PaymentRequestCore>;
  verifyV2RecordLink(intent, request);
  const account = assertExecutionAccount(
    accountRow(database, accountId),
    intent.source_account,
  );
  return Object.freeze({ intent, request, account });
}

/**
 * Rebuild the immutable review context without requiring records or the
 * account to remain active. Durable post-claim recovery must survive ordinary
 * expiry/archival, while still failing closed if signed ancestry, policy, or
 * mutable payment terms no longer match the original binding.
 */
function historicalContext(
  database: Database,
  store: CashLoomV2RecordStore,
  intentRecordId: string,
  accountId: string,
): ExecutionContext {
  try {
    assertSha256Id(intentRecordId, "intent_record_id");
    const storedDescriptor = store.latestPublicNodeDescriptor();
    if (storedDescriptor === null) {
      return storageFailure(
        "The stored Bitcoin binding has no local node descriptor.",
      );
    }
    const descriptor = verifyV2Record(storedDescriptor) as
      VerifiedV2Record<NodeDescriptorCore>;
    const storedIntent = store.localPaymentIntentById(
      intentRecordId,
      descriptor.authority.key_id,
    );
    if (storedIntent === null) {
      return storageFailure(
        "The stored Bitcoin binding no longer resolves to its locally authored intent.",
      );
    }
    const intent = verifyV2Record(storedIntent) as
      VerifiedV2Record<PaymentIntentCore>;
    assertBitcoinIntent(store, intent);
    if (intent.parent_record_id === null) {
      return storageFailure(
        "The stored Bitcoin intent has no request parent.",
      );
    }
    const storedRequest = store.getLocal(intent.parent_record_id);
    if (
      storedRequest === null
      || storedRequest.schema !== V2_SCHEMAS.payment_request
    ) {
      return storageFailure(
        "The stored Bitcoin intent's request is unavailable.",
      );
    }
    const request = verifyV2Record(storedRequest) as
      VerifiedV2Record<PaymentRequestCore>;
    verifyV2RecordLink(intent, request);
    const account = accountRow(database, accountId);
    return Object.freeze({ intent, request, account });
  } catch (cause) {
    if (
      cause instanceof BitcoinPayLinkExecutionError
      && cause.code === "STORAGE_INTEGRITY_FAILURE"
    ) {
      throw cause;
    }
    return storageFailure(
      "The stored Bitcoin execution context no longer verifies.",
      cause,
    );
  }
}

function paymentRow(database: Database, paymentId: string): PaymentRow {
  const row = database
    .query(
      `SELECT id, account_id, rail, to_addr, asset, amount_minor, fee_minor,
              status, tx_hash, error, detail, created_at
         FROM payments
        WHERE id = ?`,
    )
    .get(paymentId) as PaymentRow | null;
  if (row === null) {
    return storageFailure(
      "The Bitcoin execution binding points to a missing payment.",
    );
  }
  return row;
}

function bindingForIntent(
  database: Database,
  intentRecordId: string,
): BindingRow | null {
  return database
    .query(
      `SELECT intent_record_id, payment_id, account_id, review_id,
              reservation_id, unsigned_payload, unsigned_payload_hash,
              quote_expires_at, created_at
         FROM cashloom_v2_btc_payment_bindings
        WHERE intent_record_id = ?`,
    )
    .get(intentRecordId) as BindingRow | null;
}

function bindingForReview(
  database: Database,
  paymentId: string,
  reviewId: string,
): BindingRow | null {
  return database
    .query(
      `SELECT intent_record_id, payment_id, account_id, review_id,
              reservation_id, unsigned_payload, unsigned_payload_hash,
              quote_expires_at, created_at
         FROM cashloom_v2_btc_payment_bindings
        WHERE payment_id = ? AND review_id = ?`,
    )
    .get(paymentId, reviewId) as BindingRow | null;
}

function reviewDigest(
  binding: BindingRow,
  payment: PaymentRow,
  context: ExecutionContext,
): ReviewDigest {
  if (
    payment.id !== binding.payment_id
    || payment.account_id !== binding.account_id
    || payment.account_id !== context.account.id
    || binding.intent_record_id !== context.intent.record_id
    || payment.rail !== "btc"
    || payment.asset !== "BTC"
    || payment.to_addr !== context.intent.destination
    || payment.amount_minor !== context.intent.amount_atomic
    || payment.fee_minor === null
    || !SATOSHIS.test(payment.fee_minor)
  ) {
    return storageFailure(
      "The stored Bitcoin quote no longer matches its signed Pay Link intent.",
    );
  }
  assertTimestamp(binding.quote_expires_at, "quote_expires_at");
  assertTimestamp(binding.created_at, "binding.created_at");
  assertSha256Id(binding.intent_record_id, "binding.intent_record_id");
  assertSha256Id(binding.review_id, "binding.review_id");
  assertSha256Id(binding.reservation_id, "binding.reservation_id");
  assertSha256Id(
    binding.unsigned_payload_hash,
    "binding.unsigned_payload_hash",
  );
  const payload = bindingBytes(binding.unsigned_payload);
  if (sha256BytesId(payload) !== binding.unsigned_payload_hash) {
    return storageFailure(
      "The exact unsigned Bitcoin payload no longer matches its stored hash.",
    );
  }
  const fee = BigInt(payment.fee_minor);
  if (fee > BigInt(context.intent.max_fee_atomic)) {
    throw new BitcoinPayLinkExecutionError(
      "FEE_LIMIT_EXCEEDED",
      "The exact Bitcoin network fee exceeds the maximum signed in this intent.",
    );
  }
  const confirmBefore = earlierTimestamp(
    binding.quote_expires_at,
    context.intent.expires_at,
  );
  return {
    schema: BITCOIN_PAY_LINK_REVIEW_SCHEMA,
    payment_id: payment.id,
    intent_record_id: context.intent.record_id,
    request_record_id: context.request.record_id,
    merchant_key_id: context.intent.audience as Sha256Id,
    account_id: context.account.id,
    source_address: context.intent.source_account,
    destination: context.intent.destination,
    asset: "BTC",
    amount_sats: context.intent.amount_atomic,
    fee_sats: payment.fee_minor,
    total_sats: (
      BigInt(context.intent.amount_atomic) + fee
    ).toString(),
    max_fee_sats: context.intent.max_fee_atomic,
    reservation_id: binding.reservation_id as Sha256Id,
    unsigned_payload_hash: binding.unsigned_payload_hash as Sha256Id,
    quote_expires_at: binding.quote_expires_at,
    intent_expires_at: context.intent.expires_at,
    confirm_before: confirmBefore,
  };
}

function executionReview(
  binding: BindingRow,
  payment: PaymentRow,
  context: ExecutionContext,
): Readonly<BitcoinPayLinkExecutionReview> {
  const digest = reviewDigest(binding, payment, context);
  const expectedReviewId = sha256Id(digest);
  if (expectedReviewId !== binding.review_id) {
    return storageFailure(
      "The stored Bitcoin payment review no longer matches its content ID.",
    );
  }
  return Object.freeze({
    review_id: expectedReviewId,
    payment_id: digest.payment_id,
    intent_record_id: digest.intent_record_id,
    request_record_id: digest.request_record_id,
    merchant_key_id: digest.merchant_key_id,
    network: "Bitcoin mainnet",
    account_id: digest.account_id,
    account_label: context.account.display_name,
    source_address: digest.source_address,
    destination: digest.destination,
    asset: "BTC",
    amount_sats: digest.amount_sats,
    fee_sats: digest.fee_sats,
    total_sats: digest.total_sats,
    max_fee_sats: digest.max_fee_sats,
    quote_expires_at: digest.quote_expires_at,
    intent_expires_at: digest.intent_expires_at,
    confirm_before: digest.confirm_before,
    fee_is_exact: true,
    cashloom_fee_sats: "0",
    no_money_moved: true,
    transaction_not_signed: true,
  });
}

function draftBinding(
  draft: PaymentQuoteDraft,
  context: ExecutionContext,
  now: string,
): Readonly<{
  binding: BindingRow;
  reviewId: Sha256Id;
}> {
  if (
    draft.accountId !== context.account.id
    || draft.vaultKeyId !== context.account.vault_key_id
    || draft.senderType !== "btc"
    || draft.to !== context.intent.destination
    || draft.asset !== "BTC"
    || draft.amountMinor !== context.intent.amount_atomic
    || draft.feeAsset !== "BTC"
    || !SATOSHIS.test(draft.feeMinor)
    || draft.unsignedPayload === null
    || draft.unsignedPayloadHash === null
  ) {
    throw new BitcoinPayLinkExecutionError(
      "EXECUTION_CONFLICT",
      "The prepared quote does not exactly match this Bitcoin Pay Link intent.",
    );
  }
  const payload = Uint8Array.from(draft.unsignedPayload);
  if (sha256BytesId(payload) !== draft.unsignedPayloadHash) {
    throw new BitcoinPayLinkExecutionError(
      "EXECUTION_CONFLICT",
      "The prepared Bitcoin payload does not match its exact byte hash.",
    );
  }
  if (BigInt(draft.feeMinor) > BigInt(context.intent.max_fee_atomic)) {
    throw new BitcoinPayLinkExecutionError(
      "FEE_LIMIT_EXCEEDED",
      "The exact Bitcoin network fee exceeds the maximum signed in this intent.",
    );
  }
  const confirmBefore = earlierTimestamp(
    draft.expiresAt,
    context.intent.expires_at,
  );
  if (Date.parse(now) >= Date.parse(confirmBefore)) {
    throw new BitcoinPayLinkExecutionError(
      "REVIEW_EXPIRED",
      "The intent expired while the exact Bitcoin quote was being prepared.",
    );
  }
  const reservationId = sha256Id({
    schema: BITCOIN_PAY_LINK_RESERVATION_SCHEMA,
    intent_record_id: context.intent.record_id,
    payment_id: draft.paymentId,
    account_id: context.account.id,
    unsigned_payload_hash: draft.unsignedPayloadHash,
  });
  const binding: BindingRow = {
    intent_record_id: context.intent.record_id,
    payment_id: draft.paymentId,
    account_id: context.account.id,
    review_id: `sha256:${"0".repeat(64)}`,
    reservation_id: reservationId,
    unsigned_payload: payload,
    unsigned_payload_hash: draft.unsignedPayloadHash,
    quote_expires_at: draft.expiresAt,
    created_at: draft.createdAt,
  };
  const payment: PaymentRow = {
    id: draft.paymentId,
    account_id: draft.accountId,
    rail: draft.senderType,
    to_addr: draft.to,
    asset: draft.asset,
    amount_minor: draft.amountMinor,
    fee_minor: draft.feeMinor,
    status: "quoted",
    tx_hash: null,
    error: null,
    detail: draft.detail,
    created_at: draft.createdAt,
  };
  const digest = reviewDigest(binding, payment, context);
  const reviewId = sha256Id(digest);
  binding.review_id = reviewId;
  return Object.freeze({ binding, reviewId });
}

function validateCommitment(
  commitment: VerifiedV2Record<ExecutionCommitmentCore>,
  context: ExecutionContext,
  binding: BindingRow,
  confirmBefore: string,
  now?: string,
): void {
  verifyV2Record(
    commitment,
    now === undefined ? {} : { now },
  );
  verifyV2RecordLink(commitment, context.intent);
  if (
    commitment.reservation_id !== binding.reservation_id
    || commitment.unsigned_payload_hash !== binding.unsigned_payload_hash
    || commitment.expires_at !== confirmBefore
  ) {
    throw new BitcoinPayLinkExecutionError(
      "EXECUTION_CONFLICT",
      "This intent already has a different execution commitment.",
    );
  }
}

function resultFromPayment(
  payment: PaymentRow,
  reviewId: Sha256Id,
): Readonly<BitcoinPayLinkExecutionResult> {
  const status: BitcoinPayLinkExecutionStatus =
    payment.status === "broadcast"
      ? "broadcast"
      : payment.status === "failed" && payment.tx_hash === null
        ? "failed"
        : "broadcast_unknown";
  const error = payment.error === null
    ? null
    : status === "broadcast"
      ? "Bitcoin broadcast was submitted, but local recording needs reconciliation. Do not resend."
      : status === "failed"
        ? "The Bitcoin payment failed before network egress. CashLoom did not retry it."
        : payment.tx_hash === null
          ? "The one-time Bitcoin send claim began, but no definitive signed transaction outcome was recorded. Do not retry this payment."
          : "The Bitcoin broadcast outcome is unknown. The transaction may be live; do not resend it.";
  return Object.freeze({
    payment_id: payment.id,
    review_id: reviewId,
    status,
    tx_hash: payment.tx_hash,
    error,
  });
}

function assertStoredBindingPayment(
  binding: BindingRow,
  payment: PaymentRow,
): void {
  if (
    binding.payment_id !== payment.id
    || binding.account_id !== payment.account_id
    || payment.rail !== "btc"
    || payment.asset !== "BTC"
    || !["quoted", "confirmed", "broadcast", "failed"].includes(payment.status)
  ) {
    return storageFailure(
      "The stored Bitcoin outcome no longer matches its execution binding.",
    );
  }
  if (
    (payment.tx_hash !== null && !BITCOIN_TXID.test(payment.tx_hash))
    || (payment.status === "quoted" && payment.tx_hash !== null)
    || (payment.status === "quoted" && payment.error !== null)
    || (payment.status === "broadcast" && payment.tx_hash === null)
    || (payment.status === "failed" && payment.error === null)
    || (payment.error !== null && typeof payment.error !== "string")
  ) {
    return storageFailure(
      "The stored Bitcoin payment has an impossible status, txid, or error shape.",
    );
  }
  assertTimestamp(payment.created_at, "payment.created_at");
  assertSha256Id(binding.intent_record_id, "binding.intent_record_id");
  assertSha256Id(binding.review_id, "binding.review_id");
  assertSha256Id(binding.reservation_id, "binding.reservation_id");
  assertSha256Id(
    binding.unsigned_payload_hash,
    "binding.unsigned_payload_hash",
  );
  if (
    sha256BytesId(bindingBytes(binding.unsigned_payload))
    !== binding.unsigned_payload_hash
  ) {
    return storageFailure(
      "The stored historical Bitcoin payload no longer matches its hash.",
    );
  }
}

function assertHistoricalExecution(
  database: Database,
  store: CashLoomV2RecordStore,
  binding: BindingRow,
  payment: PaymentRow,
): void {
  assertStoredBindingPayment(binding, payment);
  const context = historicalContext(
    database,
    store,
    binding.intent_record_id,
    binding.account_id,
  );
  const review = executionReview(
    binding,
    payment,
    context,
  );
  if (payment.status !== "quoted") {
    let commitment: VerifiedV2Record<ExecutionCommitmentCore> | null;
    try {
      commitment = store.localExecutionCommitmentFor(
        context.intent.record_id,
        context.intent.authority.key_id,
      );
      if (commitment === null) {
        return storageFailure(
          "The claimed Bitcoin payment has no exact local execution commitment.",
        );
      }
      validateCommitment(
        commitment,
        context,
        binding,
        review.confirm_before,
      );
    } catch (cause) {
      if (
        cause instanceof BitcoinPayLinkExecutionError
        && cause.code === "STORAGE_INTEGRITY_FAILURE"
      ) {
        throw cause;
      }
      return storageFailure(
        "The claimed Bitcoin payment no longer matches its signed execution commitment.",
        cause,
      );
    }
  }
  if (payment.tx_hash !== null) {
    let expectedTxid: string;
    try {
      expectedTxid = bitcoinTxidForUnsignedPayload(
        bindingBytes(binding.unsigned_payload),
      );
    } catch (cause) {
      return storageFailure(
        "The stored Bitcoin payload cannot derive its exact transaction ID.",
        cause,
      );
    }
    if (payment.tx_hash !== expectedTxid) {
      return storageFailure(
        "The stored Bitcoin transaction ID does not match its exact unsigned payload.",
      );
    }
  }
}

function snapshotFromResult(
  result: BitcoinPayLinkExecutionResult,
  intentRecordId: Sha256Id,
): Readonly<BitcoinPayLinkExecutionSnapshot> {
  return Object.freeze({
    ...result,
    intent_record_id: intentRecordId,
    can_confirm: false,
  });
}

export function createBitcoinPayLinkExecutionService(
  dependencies: BitcoinPayLinkExecutionDependencies,
) {
  const {
    database,
    store: currentStore,
    localService,
    senders,
  } = dependencies;
  const now = dependencies.now ?? (() => new Date().toISOString());
  const quote = dependencies.quote ?? quotePayment;
  const confirm = dependencies.confirm ?? confirmPayment;
  const unsignedPayloadFor =
    dependencies.unsignedPayloadFor ?? bitcoinUnsignedPayloadFor;

  return Object.freeze({
    async prepare(
      input: PrepareBitcoinPayLinkExecutionInput,
    ): Promise<Readonly<PreparedBitcoinPayLinkExecution>> {
      const preparedAt = localNow(now);
      const store = currentStore();
      const context = activeContext(
        database,
        store,
        input.intent_record_id,
        input.account_id,
        preparedAt,
      );
      const existing = bindingForIntent(
        database,
        context.intent.record_id,
      );
      if (existing !== null) {
        if (existing.account_id !== context.account.id) {
          throw new BitcoinPayLinkExecutionError(
            "EXECUTION_CONFLICT",
            "This intent is already bound to a different local account.",
          );
        }
        const existingPayment = paymentRow(
          database,
          existing.payment_id,
        );
        assertStoredBindingPayment(existing, existingPayment);
        if (existingPayment.status !== "quoted") {
          throw new BitcoinPayLinkExecutionError(
            "EXECUTION_CONFLICT",
            "This Pay Link intent already has a claimed payment. Check its exact local status; CashLoom will not prepare or sign another one.",
          );
        }
        return Object.freeze({
          review: executionReview(
            existing,
            existingPayment,
            context,
          ),
          reused: true,
        });
      }

      let insertedBinding: BindingRow | null = null;
      try {
        await quote(
          {
            accountId: context.account.id,
            to: context.intent.destination,
            amountMinor: context.intent.amount_atomic,
            asset: "BTC",
          },
          {
            ...(senders ? { senders } : {}),
            now,
            bind(draft) {
              const bindAt = localNow(now);
              const fresh = activeContext(
                database,
                currentStore(),
                context.intent.record_id,
                context.account.id,
                bindAt,
              );
              const { binding } = draftBinding(draft, fresh, bindAt);
              database
                .query(
                  `INSERT INTO cashloom_v2_btc_payment_bindings
                     (intent_record_id, payment_id, account_id, review_id,
                      reservation_id, unsigned_payload,
                      unsigned_payload_hash, quote_expires_at, created_at)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                )
                .run(
                  binding.intent_record_id,
                  binding.payment_id,
                  binding.account_id,
                  binding.review_id,
                  binding.reservation_id,
                  binding.unsigned_payload,
                  binding.unsigned_payload_hash,
                  binding.quote_expires_at,
                  binding.created_at,
                );
              insertedBinding = binding;
            },
          },
        );
      } catch (error) {
        const raced = bindingForIntent(
          database,
          context.intent.record_id,
        );
        if (raced === null) throw error;
        if (raced.account_id !== context.account.id) {
          throw new BitcoinPayLinkExecutionError(
            "EXECUTION_CONFLICT",
            "This intent was concurrently bound to a different local account.",
          );
        }
        const racedPayment = paymentRow(database, raced.payment_id);
        assertStoredBindingPayment(raced, racedPayment);
        if (racedPayment.status !== "quoted") {
          throw new BitcoinPayLinkExecutionError(
            "EXECUTION_CONFLICT",
            "This Pay Link intent already has a claimed payment. Check its exact local status; CashLoom will not prepare or sign another one.",
          );
        }
        return Object.freeze({
          review: executionReview(
            raced,
            racedPayment,
            activeContext(
              database,
              currentStore(),
              context.intent.record_id,
              context.account.id,
              localNow(now),
            ),
          ),
          reused: true,
        });
      }

      const finalizePrepared = database.transaction(() => {
        const binding =
          insertedBinding
          ?? bindingForIntent(database, context.intent.record_id);
        if (binding === null) {
          return storageFailure(
            "The exact Bitcoin quote completed without its durable intent binding.",
          );
        }
        const finalPayment = paymentRow(database, binding.payment_id);
        assertStoredBindingPayment(binding, finalPayment);
        if (finalPayment.status !== "quoted") {
          throw new BitcoinPayLinkExecutionError(
            "EXECUTION_CONFLICT",
            "This Pay Link intent was claimed while its review was being prepared. Check its exact local status; CashLoom will not return a stale unsigned review.",
          );
        }
        return Object.freeze({
          review: executionReview(
            binding,
            finalPayment,
            activeContext(
              database,
              currentStore(),
              context.intent.record_id,
              context.account.id,
              localNow(now),
            ),
          ),
          reused: false,
        });
      });
      return finalizePrepared.immediate();
    },

    async confirm(
      input: ConfirmBitcoinPayLinkExecutionInput,
    ): Promise<Readonly<BitcoinPayLinkExecutionResult>> {
      assertSha256Id(input.review_id, "review_id");
      const binding = bindingForReview(
        database,
        input.payment_id,
        input.review_id,
      );
      if (binding === null) {
        throw new BitcoinPayLinkExecutionError(
          "PAYMENT_NOT_READY",
          "No exact Bitcoin payment review matches this confirmation.",
        );
      }
      let payment = paymentRow(database, binding.payment_id);
      // Once a quote has been claimed, its durable outcome is the authority
      // for reconciliation. Do not hide a live/unknown transaction merely
      // because the short consent window or a supporting manifest expired
      // after signing. The exact payment+review lookup remains required.
      if (payment.status !== "quoted") {
        assertHistoricalExecution(
          database,
          currentStore(),
          binding,
          payment,
        );
        return resultFromPayment(payment, binding.review_id);
      }
      const confirmAt = localNow(now);
      const store = currentStore();
      const context = activeContext(
        database,
        store,
        binding.intent_record_id,
        binding.account_id,
        confirmAt,
      );
      const review = executionReview(binding, payment, context);
      if (review.review_id !== input.review_id) {
        return storageFailure(
          "The confirmation does not match the exact stored Bitcoin review.",
        );
      }
      if (payment.status !== "quoted") {
        return resultFromPayment(payment, review.review_id);
      }
      if (Date.parse(confirmAt) >= Date.parse(review.confirm_before)) {
        throw new BitcoinPayLinkExecutionError(
          "REVIEW_EXPIRED",
          "This exact Bitcoin review expired. No transaction was signed.",
        );
      }

      const instruction: PaymentInstruction = {
        to: payment.to_addr,
        amountMinor: payment.amount_minor,
        asset: payment.asset,
        detail: payment.detail,
      };
      const compiled = await unsignedPayloadFor(
        {
          vaultKeyId: context.account.vault_key_id!,
          paymentId: payment.id,
        },
        instruction,
      );
      const expectedPayload = bindingBytes(binding.unsigned_payload);
      if (
        compiled.hash !== binding.unsigned_payload_hash
        || !equalBytes(compiled.payload, expectedPayload)
      ) {
        throw new BitcoinPayLinkExecutionError(
          "EXECUTION_CONFLICT",
          "The exact Bitcoin transaction no longer matches the reviewed unsigned payload.",
        );
      }

      let commitment = store.localExecutionCommitmentFor(
        context.intent.record_id,
        context.intent.authority.key_id,
      );
      if (commitment === null) {
        try {
          commitment = (
            await (
              await localService()
            ).createExecutionCommitment({
              intent_record_id: context.intent.record_id,
              reservation_id: binding.reservation_id,
              unsigned_payload_hash: binding.unsigned_payload_hash,
              expires_at: review.confirm_before,
            })
          ).record;
        } catch (error) {
          if (
            !(error instanceof V2RecordStoreError)
            || error.code !== "TRANSITION_CONFLICT"
          ) {
            throw error;
          }
          commitment = store.localExecutionCommitmentFor(
            context.intent.record_id,
            context.intent.authority.key_id,
          );
          if (commitment === null) throw error;
        }
      }
      if (commitment === null) {
        return storageFailure(
          "The exact execution commitment was not retained locally.",
        );
      }
      validateCommitment(
        commitment,
        context,
        binding,
        review.confirm_before,
        localNow(now),
      );

      try {
        await confirm(payment.id, {
          ...(senders ? { senders } : {}),
          now,
          boundClaim: {
            intentRecordId: context.intent.record_id,
            reviewId: review.review_id,
            unsignedPayloadHash: binding.unsigned_payload_hash,
            assertClaim(claim) {
              const claimedAt = claim.claimedAt;
              const fresh = activeContext(
                database,
                currentStore(),
                binding.intent_record_id,
                binding.account_id,
                claimedAt,
              );
              const freshPayment = paymentRow(database, binding.payment_id);
              const freshReview = executionReview(
                binding,
                freshPayment,
                fresh,
              );
              if (
                freshReview.review_id !== review.review_id
                || Date.parse(claimedAt)
                  >= Date.parse(freshReview.confirm_before)
              ) {
                throw new BitcoinPayLinkExecutionError(
                  "REVIEW_EXPIRED",
                  "The Bitcoin review expired before the one-time signing claim.",
                );
              }
              const freshCommitment =
                currentStore().localExecutionCommitmentFor(
                  fresh.intent.record_id,
                  fresh.intent.authority.key_id,
                );
              if (freshCommitment === null) {
                return storageFailure(
                  "The exact execution commitment is missing at the signing claim.",
                );
              }
              validateCommitment(
                freshCommitment,
                fresh,
                binding,
                freshReview.confirm_before,
                claimedAt,
              );
            },
          },
        });
      } catch (error) {
        // A concurrent exact confirmer may have won the one-time CAS after
        // this call read "quoted". Surface the durable state conservatively
        // instead of turning an in-flight broadcast into a retry invitation.
        payment = paymentRow(database, binding.payment_id);
        if (payment.status !== "quoted") {
          assertHistoricalExecution(
            database,
            currentStore(),
            binding,
            payment,
          );
          return resultFromPayment(payment, review.review_id);
        }
        throw error;
      }
      payment = paymentRow(database, binding.payment_id);
      assertHistoricalExecution(
        database,
        currentStore(),
        binding,
        payment,
      );
      return resultFromPayment(payment, review.review_id);
    },

    status(
      input: ConfirmBitcoinPayLinkExecutionInput,
    ): Readonly<BitcoinPayLinkExecutionSnapshot> {
      assertSha256Id(input.review_id, "review_id");
      // BEGIN IMMEDIATE makes this a single point-in-time local snapshot with
      // respect to the quoted→confirmed writer CAS. It changes no rows. The
      // confirmer also takes its clock only after acquiring the same lock, so
      // an expired `not_sent` result cannot later be claimed with a timestamp
      // carried from before this check.
      const readStatus = database.transaction(() => {
        const binding = bindingForReview(
          database,
          input.payment_id,
          input.review_id,
        );
        if (binding === null) {
          throw new BitcoinPayLinkExecutionError(
            "PAYMENT_NOT_READY",
            "No exact Bitcoin payment review matches this status check.",
          );
        }
        const payment = paymentRow(database, binding.payment_id);
        const store = currentStore();
        assertHistoricalExecution(database, store, binding, payment);
        if (payment.status !== "quoted") {
          return snapshotFromResult(
            resultFromPayment(payment, binding.review_id),
            binding.intent_record_id,
          );
        }

        const checkedAt = localNow(now);
        try {
          const context = activeContext(
            database,
            store,
            binding.intent_record_id,
            binding.account_id,
            checkedAt,
          );
          const review = executionReview(binding, payment, context);
          if (Date.parse(checkedAt) >= Date.parse(review.confirm_before)) {
            return Object.freeze({
              payment_id: payment.id,
              review_id: binding.review_id,
              intent_record_id: binding.intent_record_id,
              status: "not_sent",
              can_confirm: false,
              tx_hash: null,
              error:
                "The exact Bitcoin review expired before it was claimed. Nothing was signed.",
            });
          }
          return Object.freeze({
            payment_id: payment.id,
            review_id: binding.review_id,
            intent_record_id: binding.intent_record_id,
            status: "awaiting_confirmation",
            can_confirm: true,
            tx_hash: null,
            error: null,
          });
        } catch (error) {
          if (
            error instanceof BitcoinPayLinkExecutionError
            && error.code !== "STORAGE_INTEGRITY_FAILURE"
          ) {
            return Object.freeze({
              payment_id: payment.id,
              review_id: binding.review_id,
              intent_record_id: binding.intent_record_id,
              status: "not_sent",
              can_confirm: false,
              tx_hash: null,
              error: error.message,
            });
          }
          throw error;
        }
      });
      return readStatus.immediate();
    },
  });
}

export type BitcoinPayLinkExecutionService =
  ReturnType<typeof createBitcoinPayLinkExecutionService>;
