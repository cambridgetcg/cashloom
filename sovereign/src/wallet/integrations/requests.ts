/** Strict, networkless contracts for future external execution adapters. */
import { z } from "zod";
import { caip10AccountIdSchema, chainIdFromAccountId, chainIdSchema } from "../domain/identities";
import { canonicalTimestampSchema, sha256DigestSchema, type JsonValue, type Sha256Digest, walletOpaqueIdSchema } from "../domain/intent";
import { positiveMoneySchema } from "../domain/money";
import { boundSignRequestSchema, hashBoundSignRequest } from "../domain/signing";
import {
  boundedString,
  bytes32Schema,
  canonicalBase64UrlSchema,
  canonicalHexDataSchema,
  evmAddressSchema,
  hashCanonicalContract,
  hashHexData,
  integrationOpaqueIdSchema,
  unsignedIntegerSchema,
  webAuthnRpIdSchema,
} from "./model";

const futureTimestamp = (value: string, context: z.RefinementCtx, path: (string | number)[]) => {
  if (Date.parse(value) <= Date.parse(new Date(0).toISOString())) {
    context.addIssue({ code: z.ZodIssueCode.custom, path, message: "expiry must be after the Unix epoch" });
  }
};

const authorizationBindingSchema = z.object({
  authorization_id: walletOpaqueIdSchema,
  intent_hash: sha256DigestSchema,
  request_hash: sha256DigestSchema,
  expires_at: canonicalTimestampSchema,
}).strict().readonly();
export type ExternalAuthorizationBinding = z.infer<typeof authorizationBindingSchema>;

const webAuthnCommon = {
  ceremony_id: integrationOpaqueIdSchema,
  signer_id: integrationOpaqueIdSchema,
  account_id: caip10AccountIdSchema,
  rp_id: webAuthnRpIdSchema,
  origin_hash: sha256DigestSchema,
  challenge_hash: sha256DigestSchema,
  expires_at: canonicalTimestampSchema,
};

export const webAuthnRegistrationCeremonySchema = z.object({
  schema_version: z.literal("cashloom.webauthn-registration/1"),
  ...webAuthnCommon,
  kind: z.literal("registration"),
  require_user_verification: z.literal(true),
  attestation_policy: z.enum(["none", "enterprise_pinned"]),
}).strict().superRefine((value, context) => futureTimestamp(value.expires_at, context, ["expires_at"])).readonly();
export type WebAuthnRegistrationCeremony = z.infer<typeof webAuthnRegistrationCeremonySchema>;

export const webAuthnAssertionCeremonySchema = z.object({
  schema_version: z.literal("cashloom.webauthn-assertion/1"),
  ...webAuthnCommon,
  kind: z.literal("assertion"),
  credential_id: canonicalBase64UrlSchema.max(2048),
  authorization: authorizationBindingSchema,
  require_user_presence: z.literal(true),
  require_user_verification: z.literal(true),
  prior_sign_count: unsignedIntegerSchema,
}).strict().superRefine((value, context) => {
  futureTimestamp(value.expires_at, context, ["expires_at"]);
  if (value.authorization.expires_at !== value.expires_at) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["authorization", "expires_at"], message: "ceremony and authorization expiry must match" });
  }
}).readonly();
export type WebAuthnAssertionCeremony = z.infer<typeof webAuthnAssertionCeremonySchema>;
export const webAuthnCeremonySchema = z.union([webAuthnRegistrationCeremonySchema, webAuthnAssertionCeremonySchema]).readonly();
export type WebAuthnCeremony = z.infer<typeof webAuthnCeremonySchema>;

/** Sanitized verifier output: no challenge, clientData JSON, COSE key, or attestation blob. */
export const webAuthnVerifiedEvidenceSchema = z.object({
  schema_version: z.literal("cashloom.webauthn-evidence/1"),
  ceremony_id: integrationOpaqueIdSchema,
  credential_id: canonicalBase64UrlSchema.max(2048),
  rp_id: webAuthnRpIdSchema,
  origin_hash: sha256DigestSchema,
  user_present: z.literal(true),
  user_verified: z.literal(true),
  sign_count: unsignedIntegerSchema,
  authenticator_data_hash: sha256DigestSchema,
  signature_hash: sha256DigestSchema,
  verified_at: canonicalTimestampSchema,
}).strict().readonly();
export type WebAuthnVerifiedEvidence = z.infer<typeof webAuthnVerifiedEvidenceSchema>;

export const hardwareSigningHandoffSchema = z.object({
  schema_version: z.literal("cashloom.hardware-signing-handoff/1"),
  handoff_id: integrationOpaqueIdSchema,
  signer_id: integrationOpaqueIdSchema,
  device_binding_hash: sha256DigestSchema,
  transport: z.enum(["usb", "nfc", "ble", "hid"]),
  authorization: authorizationBindingSchema,
  request: boundSignRequestSchema,
  request_hash: sha256DigestSchema,
  expires_at: canonicalTimestampSchema,
}).strict().superRefine((value, context) => {
  futureTimestamp(value.expires_at, context, ["expires_at"]);
  if (hashBoundSignRequest(value.request) !== value.request_hash || value.authorization.request_hash !== value.request_hash) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["request_hash"], message: "hardware handoff must bind the exact prepared request" });
  }
  if (value.authorization.intent_hash !== value.request.intent_hash || value.authorization.authorization_id !== value.request.authorization_id) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["authorization"], message: "hardware handoff authorization must match request intent and authorization" });
  }
  if (value.authorization.expires_at !== value.expires_at || value.request.expires_at !== value.expires_at) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["expires_at"], message: "hardware handoff expiry must match its request and authorization" });
  }
}).readonly();
export type HardwareSigningHandoff = z.infer<typeof hardwareSigningHandoffSchema>;

const wcMethodSchema = z.enum(["eth_sendTransaction", "eth_signTransaction", "eth_signTypedData_v4"]);
const wcEventSchema = z.enum(["accountsChanged", "chainChanged"]);
const wcNamespaceSchema = z.object({
  chain_id: chainIdSchema,
  accounts: z.array(caip10AccountIdSchema).min(1).max(32),
  methods: z.array(wcMethodSchema).min(1).max(8),
  events: z.array(wcEventSchema).max(2),
}).strict().superRefine((value, context) => {
  if (new Set(value.accounts).size !== value.accounts.length || new Set(value.methods).size !== value.methods.length || new Set(value.events).size !== value.events.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: [], message: "WalletConnect namespace values must be unique" });
  }
  value.accounts.forEach((account, index) => {
    if (chainIdFromAccountId(account) !== value.chain_id) context.addIssue({ code: z.ZodIssueCode.custom, path: ["accounts", index], message: "WalletConnect account must belong to namespace chain" });
  });
}).readonly();

export const walletConnectSessionBindingSchema = z.object({
  schema_version: z.literal("cashloom.walletconnect-session/2"),
  session_id: integrationOpaqueIdSchema,
  peer_public_key_hash: sha256DigestSchema,
  namespaces: z.array(wcNamespaceSchema).min(1).max(16),
  expires_at: canonicalTimestampSchema,
}).strict().superRefine((value, context) => {
  futureTimestamp(value.expires_at, context, ["expires_at"]);
  if (new Set(value.namespaces.map((entry) => entry.chain_id)).size !== value.namespaces.length) context.addIssue({ code: z.ZodIssueCode.custom, path: ["namespaces"], message: "WalletConnect chains must not repeat" });
}).readonly();
export type WalletConnectSessionBinding = z.infer<typeof walletConnectSessionBindingSchema>;

export const walletConnectRequestBindingSchema = z.object({
  schema_version: z.literal("cashloom.walletconnect-request/2"),
  session_id: integrationOpaqueIdSchema,
  request_id: integrationOpaqueIdSchema,
  chain_id: chainIdSchema,
  account_id: caip10AccountIdSchema,
  method: wcMethodSchema,
  params_hash: sha256DigestSchema,
  authorization: authorizationBindingSchema,
  request_hash: sha256DigestSchema,
  expires_at: canonicalTimestampSchema,
}).strict().superRefine((value, context) => {
  futureTimestamp(value.expires_at, context, ["expires_at"]);
  if (chainIdFromAccountId(value.account_id) !== value.chain_id) context.addIssue({ code: z.ZodIssueCode.custom, path: ["account_id"], message: "WalletConnect account must match request chain" });
  if (value.authorization.request_hash !== value.request_hash || value.authorization.expires_at !== value.expires_at) context.addIssue({ code: z.ZodIssueCode.custom, path: ["authorization"], message: "WalletConnect request must bind the exact authorization and expiry" });
}).readonly();
export type WalletConnectRequestBinding = z.infer<typeof walletConnectRequestBindingSchema>;

const UINT128_MAX = (1n << 128n) - 1n;
const UINT64_MAX = (1n << 64n) - 1n;
const uint128 = (value: string, path: (string | number)[], context: z.RefinementCtx): bigint | null => {
  const parsed = BigInt(value);
  if (parsed > UINT128_MAX) {
    context.addIssue({ code: z.ZodIssueCode.custom, path, message: "value exceeds uint128" });
    return null;
  }
  return parsed;
};
const asUint128Hex = (value: bigint): string => value.toString(16).padStart(32, "0");

export const packedUserOperationV07Schema = z.object({
  sender: evmAddressSchema,
  nonce: unsignedIntegerSchema,
  init_code: canonicalHexDataSchema,
  factory: evmAddressSchema.nullable(),
  factory_data_hash: sha256DigestSchema.nullable(),
  call_data: canonicalHexDataSchema,
  call_data_hash: sha256DigestSchema,
  account_gas_limits: bytes32Schema,
  call_gas_limit: unsignedIntegerSchema,
  verification_gas_limit: unsignedIntegerSchema,
  pre_verification_gas: unsignedIntegerSchema,
  gas_fees: bytes32Schema,
  max_fee_per_gas: unsignedIntegerSchema,
  max_priority_fee_per_gas: unsignedIntegerSchema,
  paymaster_and_data: canonicalHexDataSchema,
  paymaster: evmAddressSchema.nullable(),
  paymaster_verification_gas_limit: unsignedIntegerSchema.nullable(),
  paymaster_post_op_gas_limit: unsignedIntegerSchema.nullable(),
  paymaster_data_hash: sha256DigestSchema.nullable(),
  signature: canonicalHexDataSchema,
}).strict().superRefine((value, context) => {
  const callLimit = uint128(value.call_gas_limit, ["call_gas_limit"], context);
  const verificationLimit = uint128(value.verification_gas_limit, ["verification_gas_limit"], context);
  const maxFee = uint128(value.max_fee_per_gas, ["max_fee_per_gas"], context);
  const priorityFee = uint128(value.max_priority_fee_per_gas, ["max_priority_fee_per_gas"], context);
  if (maxFee !== null && priorityFee !== null && priorityFee > maxFee) context.addIssue({ code: z.ZodIssueCode.custom, path: ["max_priority_fee_per_gas"], message: "priority fee cannot exceed max fee" });
  if (value.call_data_hash !== hashHexData(value.call_data)) context.addIssue({ code: z.ZodIssueCode.custom, path: ["call_data_hash"], message: "call data hash mismatch" });
  if (callLimit !== null && verificationLimit !== null && maxFee !== null && priorityFee !== null) {
    if (value.account_gas_limits !== `0x${asUint128Hex(verificationLimit)}${asUint128Hex(callLimit)}`) context.addIssue({ code: z.ZodIssueCode.custom, path: ["account_gas_limits"], message: "PackedUserOperation accountGasLimits mismatch" });
    if (value.gas_fees !== `0x${asUint128Hex(priorityFee)}${asUint128Hex(maxFee)}`) context.addIssue({ code: z.ZodIssueCode.custom, path: ["gas_fees"], message: "PackedUserOperation gasFees mismatch" });
  }
  const factoryPresent = value.factory !== null || value.factory_data_hash !== null;
  if (factoryPresent) {
    if (!value.factory || !value.factory_data_hash || value.init_code.length < 42 || value.init_code.slice(0, 42) !== value.factory) context.addIssue({ code: z.ZodIssueCode.custom, path: ["factory"], message: "factory must match init code and its data hash" });
    else if (value.factory_data_hash !== hashHexData(`0x${value.init_code.slice(42)}`)) context.addIssue({ code: z.ZodIssueCode.custom, path: ["factory_data_hash"], message: "factory data hash mismatch" });
  } else if (value.init_code !== "0x") context.addIssue({ code: z.ZodIssueCode.custom, path: ["init_code"], message: "init code requires a factory binding" });
  const paymasterFields = [value.paymaster, value.paymaster_verification_gas_limit, value.paymaster_post_op_gas_limit, value.paymaster_data_hash];
  const present = paymasterFields.filter((entry) => entry !== null).length;
  if ((value.paymaster_and_data === "0x" && present !== 0) || (value.paymaster_and_data !== "0x" && present !== 4)) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["paymaster_and_data"], message: "paymaster fields must be present exactly when paymaster data is present" });
  } else if (present === 4 && value.paymaster && value.paymaster_verification_gas_limit && value.paymaster_post_op_gas_limit && value.paymaster_data_hash) {
    const verification = uint128(value.paymaster_verification_gas_limit, ["paymaster_verification_gas_limit"], context);
    const postOp = uint128(value.paymaster_post_op_gas_limit, ["paymaster_post_op_gas_limit"], context);
    if (verification !== null && postOp !== null) {
      const expectedPrefix = `0x${value.paymaster.slice(2)}${asUint128Hex(verification)}${asUint128Hex(postOp)}`;
      if (!value.paymaster_and_data.startsWith(expectedPrefix) || value.paymaster_data_hash !== hashHexData(`0x${value.paymaster_and_data.slice(expectedPrefix.length)}`)) context.addIssue({ code: z.ZodIssueCode.custom, path: ["paymaster_and_data"], message: "paymaster packed data does not match semantic fields" });
    }
  }
}).readonly();
export type PackedUserOperationV07 = z.infer<typeof packedUserOperationV07Schema>;

const erc4337HashBody = (input: {
  chain_id: string; entry_point: string; account_id: string; nonce_key: string; nonce_sequence: string; user_operation: PackedUserOperationV07;
}): JsonValue => {
  // EIP-4337's UserOperation hash excludes `signature`; the local binding
  // follows that property so a validated passkey signature cannot mutate the
  // owner-approved operation it authorizes.
  const { signature: _signature, ...unsignedOperation } = input.user_operation;
  return { schema_version: "cashloom.erc4337-userop-binding/1", chain_id: input.chain_id, entry_point: input.entry_point, account_id: input.account_id, nonce_key: input.nonce_key, nonce_sequence: input.nonce_sequence, user_operation: unsignedOperation as unknown as JsonValue };
};

export const hashErc4337UserOperationBinding = (input: {
  readonly chain_id: string;
  readonly entry_point: string;
  readonly account_id: string;
  readonly nonce_key: string;
  readonly nonce_sequence: string;
  readonly user_operation: PackedUserOperationV07;
}): Sha256Digest => hashCanonicalContract(erc4337HashBody(input));

export const erc4337UserOperationRequestSchema = z.object({
  schema_version: z.literal("cashloom.erc4337-userop/0.7"),
  request_id: integrationOpaqueIdSchema,
  intent_hash: sha256DigestSchema,
  authorization: authorizationBindingSchema,
  chain_id: chainIdSchema.refine((value) => value.startsWith("eip155:"), "expected an EVM CAIP-2 chain"),
  entry_point: evmAddressSchema,
  account_id: caip10AccountIdSchema,
  nonce_key: unsignedIntegerSchema,
  nonce_sequence: unsignedIntegerSchema,
  user_operation: packedUserOperationV07Schema,
  user_operation_binding_hash: sha256DigestSchema,
  expires_at: canonicalTimestampSchema,
}).strict().superRefine((value, context) => {
  futureTimestamp(value.expires_at, context, ["expires_at"]);
  if (chainIdFromAccountId(value.account_id) !== value.chain_id || value.account_id.slice(value.account_id.lastIndexOf(":") + 1) !== value.user_operation.sender) context.addIssue({ code: z.ZodIssueCode.custom, path: ["account_id"], message: "smart account identity must match chain and UserOperation sender" });
  const key = BigInt(value.nonce_key);
  const sequence = BigInt(value.nonce_sequence);
  if (key > ((1n << 192n) - 1n) || sequence > UINT64_MAX || ((key << 64n) | sequence).toString() !== value.user_operation.nonce) context.addIssue({ code: z.ZodIssueCode.custom, path: ["nonce"], message: "UserOperation nonce must equal its 192-bit key and 64-bit sequence" });
  if (value.authorization.intent_hash !== value.intent_hash || value.authorization.expires_at !== value.expires_at) context.addIssue({ code: z.ZodIssueCode.custom, path: ["authorization"], message: "smart-account authorization must bind intent and expiry" });
  const bindingHash = hashErc4337UserOperationBinding(value);
  if (value.user_operation_binding_hash !== bindingHash) context.addIssue({ code: z.ZodIssueCode.custom, path: ["user_operation_binding_hash"], message: "local ERC-4337 binding hash mismatch" });
  if (value.authorization.request_hash !== bindingHash) context.addIssue({ code: z.ZodIssueCode.custom, path: ["authorization", "request_hash"], message: "authorization must bind the exact unsigned ERC-4337 operation" });
}).readonly();
export type Erc4337UserOperationRequest = z.infer<typeof erc4337UserOperationRequestSchema>;

const fiatReferenceSchema = boundedString(256, /^[A-Za-z0-9][A-Za-z0-9._:-]*$/, "expected an opaque provider reference");
export const fiatRedirectBindingSchema = z.object({
  schema_version: z.literal("cashloom.fiat-redirect-binding/1"),
  flow_id: integrationOpaqueIdSchema,
  provider_id: integrationOpaqueIdSchema,
  issuer_hash: sha256DigestSchema,
  redirect_uri_hash: sha256DigestSchema,
  state_hash: sha256DigestSchema,
  pkce_verifier_hash: sha256DigestSchema,
  expires_at: canonicalTimestampSchema,
}).strict().superRefine((value, context) => futureTimestamp(value.expires_at, context, ["expires_at"])).readonly();
export type FiatRedirectBinding = z.infer<typeof fiatRedirectBindingSchema>;

export const regulatedFiatPaymentAuthorizationSchema = z.object({
  schema_version: z.literal("cashloom.regulated-fiat-payment-authorization/1"),
  authorization_id: integrationOpaqueIdSchema,
  intent_hash: sha256DigestSchema,
  provider_id: integrationOpaqueIdSchema,
  connection_id: integrationOpaqueIdSchema,
  provider_account_ref_hash: sha256DigestSchema,
  beneficiary_ref_hash: sha256DigestSchema,
  amount: positiveMoneySchema.refine((value) => value.asset.kind === "fiat", "expected an ISO 4217 fiat amount"),
  fee_ceiling_atomic: unsignedIntegerSchema.optional(),
  provider_idempotency_key_hash: sha256DigestSchema,
  redirect_flow_id: integrationOpaqueIdSchema.optional(),
  expires_at: canonicalTimestampSchema,
}).strict().superRefine((value, context) => futureTimestamp(value.expires_at, context, ["expires_at"])).readonly();
export type RegulatedFiatPaymentAuthorization = z.infer<typeof regulatedFiatPaymentAuthorizationSchema>;

export const fiatWebhookEvidenceSchema = z.object({
  schema_version: z.literal("cashloom.fiat-webhook-evidence/1"),
  provider_id: integrationOpaqueIdSchema,
  delivery_id: fiatReferenceSchema,
  event_type: boundedString(128, /^[A-Za-z][A-Za-z0-9._:-]*$/, "expected a provider event type"),
  provider_payment_ref: fiatReferenceSchema,
  payload_hash: sha256DigestSchema,
  signature_key_id: boundedString(256, /^[A-Za-z0-9][A-Za-z0-9._:-]*$/, "expected a signature key id"),
  signature_hash: sha256DigestSchema,
  occurred_at: canonicalTimestampSchema,
  received_at: canonicalTimestampSchema,
  state: z.enum(["pending", "accepted", "settled", "failed", "reversed", "refunded", "charged_back"]),
}).strict().superRefine((value, context) => {
  if (Date.parse(value.received_at) < Date.parse(value.occurred_at)) context.addIssue({ code: z.ZodIssueCode.custom, path: ["received_at"], message: "webhook receipt cannot precede provider occurrence" });
}).readonly();
export type FiatWebhookEvidence = z.infer<typeof fiatWebhookEvidenceSchema>;

export const parseWebAuthnCeremony = (input: unknown): WebAuthnCeremony => webAuthnCeremonySchema.parse(input);
export const parseHardwareSigningHandoff = (input: unknown): HardwareSigningHandoff => hardwareSigningHandoffSchema.parse(input);
export const parseWalletConnectSessionBinding = (input: unknown): WalletConnectSessionBinding => walletConnectSessionBindingSchema.parse(input);
export const parseWalletConnectRequestBinding = (input: unknown): WalletConnectRequestBinding => walletConnectRequestBindingSchema.parse(input);
export const parseErc4337UserOperationRequest = (input: unknown): Erc4337UserOperationRequest => erc4337UserOperationRequestSchema.parse(input);
export const parseRegulatedFiatPaymentAuthorization = (input: unknown): RegulatedFiatPaymentAuthorization => regulatedFiatPaymentAuthorizationSchema.parse(input);
export const parseFiatRedirectBinding = (input: unknown): FiatRedirectBinding => fiatRedirectBindingSchema.parse(input);
export const parseFiatWebhookEvidence = (input: unknown): FiatWebhookEvidence => fiatWebhookEvidenceSchema.parse(input);
