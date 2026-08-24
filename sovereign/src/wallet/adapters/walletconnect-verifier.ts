/**
 * WalletConnect v2 verification boundary for Base EIP-1559 transactions.
 *
 * V1 deliberately supports only `eth_signTransaction`. A currently ACTIVE,
 * hash-identical session and the exact prepared request must be supplied with
 * the provider evidence. Pairing URIs, topics, relay URLs, symmetric keys, and
 * raw provider errors are intentionally absent from every accepted schema.
 */
import { z } from "zod";
import {
  boundSignRequestSchema,
  hashBoundSignRequest,
  type BoundSignRequest,
  type EvmTransactionSignRequest,
} from "../domain/signing.ts";
import {
  canonicalTimestampSchema,
  sha256DigestSchema,
  type JsonValue,
  type Sha256Digest,
} from "../domain/intent.ts";
import {
  IntegrationContractError,
  bytes32Schema,
  canonicalHexDataSchema,
  hashCanonicalContract,
  integrationOpaqueIdSchema,
  walletConnectRequestBindingSchema,
  walletConnectSessionBindingSchema,
  type WalletConnectRequestBinding,
  type WalletConnectSessionBinding,
} from "../integrations/index.ts";
import {
  BASE_MAINNET_CAIP2,
  verifyBaseEip1559Envelope,
} from "./hardware-evm-verifier.ts";

const boundedSignedTransactionSchema = canonicalHexDataSchema.refine(
  (value) => value !== "0x",
  "signed transaction cannot be empty",
);

export const walletConnectSessionStateSchema = z.object({
  session_id: integrationOpaqueIdSchema,
  binding_hash: sha256DigestSchema,
  status: z.enum(["ACTIVE", "REVOKED", "EXPIRED"]),
  expires_at: canonicalTimestampSchema,
}).strict().readonly();

export type WalletConnectSessionState = z.infer<
  typeof walletConnectSessionStateSchema
>;

/** Narrow durable projection that the coordinator must load with the session. */
export const walletConnectRequestStateSchema = z.object({
  session_id: integrationOpaqueIdSchema,
  request_id: integrationOpaqueIdSchema,
  request_hash: sha256DigestSchema,
  params_hash: sha256DigestSchema,
  status: z.enum(["PENDING", "CONSUMED", "REFUSED", "EXPIRED", "REVOKED"]),
  version: z.number().int().nonnegative(),
  expires_at: canonicalTimestampSchema,
}).strict().readonly();

export type WalletConnectRequestState = z.infer<
  typeof walletConnectRequestStateSchema
>;

const providerOutcomeShape = {
  schema_version: z.literal("cashloom.walletconnect-evidence/1"),
  session_id: integrationOpaqueIdSchema,
  request_id: integrationOpaqueIdSchema,
};

const signedEvidenceSchema = z.object({
  ...providerOutcomeShape,
  outcome: z.literal("SIGNED"),
  session_binding_hash: sha256DigestSchema,
  peer_public_key_hash: sha256DigestSchema,
  authorization_id: integrationOpaqueIdSchema,
  request_hash: sha256DigestSchema,
  params_hash: sha256DigestSchema,
  chain_id: z.literal(BASE_MAINNET_CAIP2),
  account_id: z.string().min(1).max(180),
  method: z.literal("eth_signTransaction"),
  expires_at: canonicalTimestampSchema,
  serialized_transaction: boundedSignedTransactionSchema,
  transaction_hash: bytes32Schema,
}).strict();

const refusedEvidenceSchema = z.object({
  ...providerOutcomeShape,
  outcome: z.enum(["REFUSED", "SESSION_CHANGED", "SESSION_REVOKED"]),
}).strict();

export const walletConnectProviderEvidenceSchema = z.discriminatedUnion(
  "outcome",
  [signedEvidenceSchema, refusedEvidenceSchema],
).readonly();

export type WalletConnectProviderEvidence = z.infer<
  typeof walletConnectProviderEvidenceSchema
>;

export interface VerifiedWalletConnectEvmArtifact {
  readonly schema_version: "cashloom.verified-external-evm-artifact/1";
  readonly source: "walletconnect";
  readonly session_id: string;
  readonly walletconnect_request_id: string;
  readonly session_binding_hash: Sha256Digest;
  readonly peer_public_key_hash: Sha256Digest;
  readonly authorization_id: string;
  readonly intent_hash: Sha256Digest;
  readonly request_id: string;
  readonly request_hash: Sha256Digest;
  readonly params_hash: Sha256Digest;
  readonly chain_id: typeof BASE_MAINNET_CAIP2;
  readonly signer_account_id: string;
  readonly encoding: "hex";
  readonly payload: `0x${string}`;
  readonly external_tx_id: `0x${string}`;
  readonly verified_at: string;
  /**
   * Persistence must atomically compare these values, consume the PENDING
   * request, re-check the ACTIVE session, and append the artifact. Verification
   * alone is deliberately not represented as replay protection.
   */
  readonly persistence_guard: Readonly<{
    readonly policy: "ACTIVE_SESSION_PENDING_REQUEST_ARTIFACT_CAS";
    readonly session_id: string;
    readonly session_binding_hash: Sha256Digest;
    readonly expected_session_status: "ACTIVE";
    readonly request_id: string;
    readonly expected_request_status: "PENDING";
    readonly expected_request_version: number;
    readonly request_hash: Sha256Digest;
    readonly params_hash: Sha256Digest;
    readonly authorization_id: string;
    readonly external_tx_id: `0x${string}`;
  }>;
}

/**
 * Domain-separated hash used when preparing the WalletConnect request. The
 * coordinator must create provider params from this same prepared request;
 * alternate JSON quantity/address spellings cannot weaken the later raw-wire
 * verification.
 */
export const hashWalletConnectTransactionParams = (
  input: BoundSignRequest,
): Sha256Digest => {
  const request = boundSignRequestSchema.parse(input);
  if (
    request.kind !== "evm-transaction" ||
    request.chain_id !== BASE_MAINNET_CAIP2 ||
    request.fee.kind !== "eip1559"
  ) {
    throw new IntegrationContractError("integration_contract_invalid");
  }
  return hashCanonicalContract({
    schema_version: "cashloom.walletconnect-eth-sign-transaction-params/1",
    method: "eth_signTransaction",
    chain_id: request.chain_id,
    account_id: request.signer_account_id,
    transaction: {
      type: "eip1559",
      from_account_id: request.signer_account_id,
      to_account_id: request.to_account_id,
      nonce: request.nonce,
      value_atomic: request.value_atomic,
      data: request.data,
      gas_limit: request.gas_limit,
      max_fee_per_gas_atomic: request.fee.max_fee_per_gas_atomic,
      max_priority_fee_per_gas_atomic:
        request.fee.max_priority_fee_per_gas_atomic,
    },
  } as JsonValue);
};

const requireContract = <T>(parse: () => T): T => {
  try {
    return parse();
  } catch (error) {
    if (error instanceof IntegrationContractError) throw error;
    throw new IntegrationContractError("integration_contract_invalid");
  }
};

export const verifyWalletConnectEvmSignedTransaction = async (input: {
  readonly session: WalletConnectSessionBinding;
  readonly session_state: WalletConnectSessionState;
  readonly request_state: WalletConnectRequestState;
  readonly request: WalletConnectRequestBinding;
  readonly prepared_request: BoundSignRequest;
  readonly evidence: WalletConnectProviderEvidence;
  readonly now?: Date;
}): Promise<VerifiedWalletConnectEvmArtifact> => {
  const session = requireContract(() =>
    walletConnectSessionBindingSchema.parse(input.session));
  const request = requireContract(() =>
    walletConnectRequestBindingSchema.parse(input.request));
  const prepared = requireContract(() =>
    boundSignRequestSchema.parse(input.prepared_request));

  let state: WalletConnectSessionState;
  try {
    state = walletConnectSessionStateSchema.parse(input.session_state);
  } catch {
    throw new IntegrationContractError("walletconnect_session_refused");
  }
  let requestState: WalletConnectRequestState;
  try {
    requestState = walletConnectRequestStateSchema.parse(input.request_state);
  } catch {
    throw new IntegrationContractError("walletconnect_session_refused");
  }
  let evidence: WalletConnectProviderEvidence;
  try {
    evidence = walletConnectProviderEvidenceSchema.parse(input.evidence);
  } catch {
    throw new IntegrationContractError("integration_evidence_rejected");
  }

  if (
    evidence.outcome !== "SIGNED" &&
    (evidence.session_id !== session.session_id ||
      evidence.request_id !== request.request_id)
  ) {
    throw new IntegrationContractError("integration_evidence_rejected");
  }
  if (evidence.outcome !== "SIGNED") {
    throw new IntegrationContractError("walletconnect_session_refused");
  }

  const now = input.now ?? new Date();
  const nowMs = now.getTime();
  const sessionHash = hashCanonicalContract(session as unknown as JsonValue);
  const namespace = session.namespaces[0];
  const exactV1Namespace =
    session.namespaces.length === 1 &&
    namespace?.chain_id === BASE_MAINNET_CAIP2 &&
    namespace.accounts.length === 1 &&
    namespace.accounts[0] === request.account_id &&
    namespace.methods.length === 1 &&
    namespace.methods[0] === "eth_signTransaction" &&
    namespace.events.length === 2 &&
    namespace.events.includes("accountsChanged") &&
    namespace.events.includes("chainChanged");

  if (
    !Number.isFinite(nowMs) ||
    state.status !== "ACTIVE" ||
    state.session_id !== session.session_id ||
    state.binding_hash !== sessionHash ||
    state.expires_at !== session.expires_at ||
    requestState.status !== "PENDING" ||
    requestState.session_id !== session.session_id ||
    requestState.request_id !== request.request_id ||
    requestState.request_hash !== request.request_hash ||
    requestState.params_hash !== request.params_hash ||
    requestState.expires_at !== request.expires_at ||
    nowMs >= Date.parse(session.expires_at) ||
    nowMs >= Date.parse(request.expires_at) ||
    Date.parse(request.expires_at) > Date.parse(session.expires_at) ||
    request.session_id !== session.session_id ||
    request.chain_id !== BASE_MAINNET_CAIP2 ||
    request.method !== "eth_signTransaction" ||
    !exactV1Namespace
  ) {
    throw new IntegrationContractError("walletconnect_session_refused");
  }

  if (
    prepared.kind !== "evm-transaction" ||
    prepared.chain_id !== BASE_MAINNET_CAIP2 ||
    prepared.fee.kind !== "eip1559"
  ) {
    throw new IntegrationContractError("external_signer_mismatch");
  }
  const evmRequest = prepared as EvmTransactionSignRequest;
  const preparedHash = hashBoundSignRequest(evmRequest);
  const paramsHash = hashWalletConnectTransactionParams(evmRequest);
  if (
    preparedHash !== request.request_hash ||
    request.authorization.request_hash !== preparedHash ||
    request.authorization.authorization_id !== evmRequest.authorization_id ||
    request.authorization.intent_hash !== evmRequest.intent_hash ||
    request.authorization.expires_at !== evmRequest.expires_at ||
    request.expires_at !== evmRequest.expires_at ||
    request.chain_id !== evmRequest.chain_id ||
    request.account_id !== evmRequest.signer_account_id ||
    request.params_hash !== paramsHash ||
    evidence.session_id !== session.session_id ||
    evidence.request_id !== request.request_id ||
    evidence.session_binding_hash !== sessionHash ||
    evidence.peer_public_key_hash !== session.peer_public_key_hash ||
    evidence.authorization_id !== evmRequest.authorization_id ||
    evidence.request_hash !== preparedHash ||
    evidence.params_hash !== paramsHash ||
    evidence.chain_id !== evmRequest.chain_id ||
    evidence.account_id !== evmRequest.signer_account_id ||
    evidence.method !== request.method ||
    evidence.expires_at !== request.expires_at
  ) {
    throw new IntegrationContractError("external_signer_mismatch");
  }

  const envelope = await verifyBaseEip1559Envelope({
    request: evmRequest,
    serialized_transaction: evidence.serialized_transaction,
    transaction_hash: evidence.transaction_hash,
  });

  const persistenceGuard = Object.freeze({
    policy: "ACTIVE_SESSION_PENDING_REQUEST_ARTIFACT_CAS" as const,
    session_id: session.session_id,
    session_binding_hash: sessionHash,
    expected_session_status: "ACTIVE" as const,
    request_id: request.request_id,
    expected_request_status: "PENDING" as const,
    expected_request_version: requestState.version,
    request_hash: preparedHash,
    params_hash: paramsHash,
    authorization_id: evmRequest.authorization_id,
    external_tx_id: envelope.external_tx_id,
  });
  return Object.freeze({
    schema_version: "cashloom.verified-external-evm-artifact/1",
    source: "walletconnect",
    session_id: session.session_id,
    walletconnect_request_id: request.request_id,
    session_binding_hash: sessionHash,
    peer_public_key_hash: session.peer_public_key_hash,
    authorization_id: evmRequest.authorization_id,
    intent_hash: evmRequest.intent_hash,
    request_id: evmRequest.request_id,
    request_hash: preparedHash,
    params_hash: paramsHash,
    chain_id: BASE_MAINNET_CAIP2,
    signer_account_id: evmRequest.signer_account_id,
    encoding: envelope.encoding,
    payload: envelope.payload,
    external_tx_id: envelope.external_tx_id,
    verified_at: now.toISOString(),
    persistence_guard: persistenceGuard,
  });
};
