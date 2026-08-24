/**
 * Networkless verification boundary for externally signed Base transactions.
 *
 * A hardware transport is only a way to obtain hostile signed bytes; without
 * vendor/device attestation it is not proof that hardware produced them. This
 * module independently decodes those bytes, recovers the signer, and compares
 * every type-2 transaction field with the immutable Wallet Kernel request. It
 * never opens a device, signs, persists, or broadcasts anything.
 */
import {
  isAddress,
  keccak256,
  parseTransaction,
  recoverTransactionAddress,
  type TransactionSerialized,
} from "viem";
import { z } from "zod";
import {
  hashBoundSignRequest,
  type EvmTransactionSignRequest,
} from "../domain/signing.ts";
import {
  sha256DigestSchema,
  type Sha256Digest,
} from "../domain/intent.ts";
import {
  IntegrationContractError,
  bytes32Schema,
  canonicalHexDataSchema,
  hardwareSigningHandoffSchema,
  integrationOpaqueIdSchema,
  type HardwareSigningHandoff,
} from "../integrations/index.ts";

export const BASE_MAINNET_CAIP2 = "eip155:8453" as const;
const BASE_MAINNET_CHAIN_ID = 8453;
const BASE_ACCOUNT_PREFIX = `${BASE_MAINNET_CAIP2}:`;

const boundedSignedTransactionSchema = canonicalHexDataSchema.refine(
  (value) => value !== "0x",
  "signed transaction cannot be empty",
);

/**
 * Public evidence returned by the browser/device bridge. Device secrets,
 * APDUs, derivation material, provider errors, and transport URLs have no
 * representation in this strict contract.
 */
export const hardwareEvmProviderEvidenceSchema = z.object({
  schema_version: z.literal("cashloom.hardware-evm-evidence/1"),
  handoff_id: integrationOpaqueIdSchema,
  signer_id: integrationOpaqueIdSchema,
  device_binding_hash: sha256DigestSchema,
  transport: z.enum(["usb", "nfc", "ble", "hid"]),
  authorization_id: integrationOpaqueIdSchema,
  request_id: integrationOpaqueIdSchema,
  request_hash: sha256DigestSchema,
  chain_id: z.literal(BASE_MAINNET_CAIP2),
  account_id: z.string().min(1).max(180),
  serialized_transaction: boundedSignedTransactionSchema,
  transaction_hash: bytes32Schema,
}).strict().readonly();

export type HardwareEvmProviderEvidence = z.infer<
  typeof hardwareEvmProviderEvidenceSchema
>;

export interface VerifiedBaseEip1559Envelope {
  readonly encoding: "hex";
  readonly payload: `0x${string}`;
  readonly external_tx_id: `0x${string}`;
  readonly recovered_address: `0x${string}`;
}

export interface VerifiedHardwareEvmArtifact {
  readonly schema_version: "cashloom.verified-external-evm-artifact/1";
  readonly source: "external_evm_signer";
  readonly transport_assurance: "unattested_hardware_handoff";
  readonly handoff_id: string;
  readonly signer_id: string;
  readonly device_binding_hash: Sha256Digest;
  readonly claimed_transport: "usb" | "nfc" | "ble" | "hid";
  readonly authorization_id: string;
  readonly intent_hash: Sha256Digest;
  readonly request_id: string;
  readonly request_hash: Sha256Digest;
  readonly chain_id: typeof BASE_MAINNET_CAIP2;
  readonly signer_account_id: string;
  readonly encoding: "hex";
  readonly payload: `0x${string}`;
  readonly external_tx_id: `0x${string}`;
  readonly verified_at: string;
}

const accountAddress = (accountId: string): `0x${string}` => {
  if (!accountId.startsWith(BASE_ACCOUNT_PREFIX)) {
    throw new IntegrationContractError("external_signer_mismatch");
  }
  const address = accountId.slice(BASE_ACCOUNT_PREFIX.length);
  if (!isAddress(address, { strict: false })) {
    throw new IntegrationContractError("external_signer_mismatch");
  }
  return address as `0x${string}`;
};

const sameAddress = (left: string, right: string): boolean =>
  left.toLowerCase() === right.toLowerCase();

/**
 * Narrow shared decoder used by both hardware and WalletConnect adapters.
 * The evidence transaction hash is independently derived from the raw bytes.
 */
export const verifyBaseEip1559Envelope = async (input: {
  readonly request: EvmTransactionSignRequest;
  readonly serialized_transaction: string;
  readonly transaction_hash: string;
}): Promise<VerifiedBaseEip1559Envelope> => {
  try {
    const payload = boundedSignedTransactionSchema.parse(
      input.serialized_transaction,
    ) as `0x${string}`;
    const expectedHash = bytes32Schema.parse(input.transaction_hash) as `0x${string}`;
    const signer = accountAddress(input.request.signer_account_id);
    const recipient = input.request.to_account_id === null
      ? null
      : accountAddress(input.request.to_account_id);

    if (
      input.request.chain_id !== BASE_MAINNET_CAIP2 ||
      input.request.fee.kind !== "eip1559" ||
      keccak256(payload) !== expectedHash
    ) {
      throw new IntegrationContractError("integration_evidence_rejected");
    }

    const transaction = parseTransaction(payload as TransactionSerialized);
    const recovered = await recoverTransactionAddress({
      serializedTransaction: payload as TransactionSerialized,
    });
    const actualRecipient = transaction.to ?? null;
    const recipientMatches = recipient === null
      ? actualRecipient === null
      : actualRecipient !== null && sameAddress(actualRecipient, recipient);

    if (
      transaction.type !== "eip1559" ||
      transaction.chainId !== BASE_MAINNET_CHAIN_ID ||
      !recipientMatches ||
      (transaction.value ?? 0n) !== BigInt(input.request.value_atomic) ||
      (transaction.data ?? "0x") !== input.request.data ||
      transaction.gas !== BigInt(input.request.gas_limit) ||
      transaction.maxFeePerGas !== BigInt(
        input.request.fee.max_fee_per_gas_atomic,
      ) ||
      transaction.maxPriorityFeePerGas !== BigInt(
        input.request.fee.max_priority_fee_per_gas_atomic,
      ) ||
      transaction.nonce === undefined ||
      BigInt(transaction.nonce) !== BigInt(input.request.nonce) ||
      (transaction.accessList?.length ?? 0) !== 0 ||
      !sameAddress(recovered, signer)
    ) {
      throw new IntegrationContractError("integration_evidence_rejected");
    }

    return Object.freeze({
      encoding: "hex",
      payload,
      external_tx_id: expectedHash,
      recovered_address: recovered.toLowerCase() as `0x${string}`,
    });
  } catch (error) {
    if (error instanceof IntegrationContractError) throw error;
    throw new IntegrationContractError("integration_evidence_rejected");
  }
};

export const verifyHardwareEvmSignedTransaction = async (input: {
  readonly handoff: HardwareSigningHandoff;
  readonly evidence: HardwareEvmProviderEvidence;
  readonly now?: Date;
}): Promise<VerifiedHardwareEvmArtifact> => {
  let handoff: HardwareSigningHandoff;
  try {
    handoff = hardwareSigningHandoffSchema.parse(input.handoff);
  } catch {
    throw new IntegrationContractError("integration_contract_invalid");
  }

  let evidence: HardwareEvmProviderEvidence;
  try {
    evidence = hardwareEvmProviderEvidenceSchema.parse(input.evidence);
  } catch {
    throw new IntegrationContractError("integration_evidence_rejected");
  }

  const now = input.now ?? new Date();
  const nowMs = now.getTime();
  const request = handoff.request;
  if (
    !Number.isFinite(nowMs) ||
    nowMs >= Date.parse(handoff.expires_at) ||
    request.kind !== "evm-transaction" ||
    request.chain_id !== BASE_MAINNET_CAIP2 ||
    request.fee.kind !== "eip1559" ||
    hashBoundSignRequest(request) !== handoff.request_hash ||
    handoff.authorization.request_hash !== handoff.request_hash ||
    handoff.authorization.authorization_id !== request.authorization_id ||
    handoff.authorization.intent_hash !== request.intent_hash ||
    handoff.authorization.expires_at !== request.expires_at ||
    handoff.expires_at !== request.expires_at ||
    evidence.handoff_id !== handoff.handoff_id ||
    evidence.signer_id !== handoff.signer_id ||
    evidence.device_binding_hash !== handoff.device_binding_hash ||
    evidence.transport !== handoff.transport ||
    evidence.authorization_id !== request.authorization_id ||
    evidence.request_id !== request.request_id ||
    evidence.request_hash !== handoff.request_hash ||
    evidence.chain_id !== request.chain_id ||
    evidence.account_id !== request.signer_account_id
  ) {
    throw new IntegrationContractError("external_signer_mismatch");
  }

  const envelope = await verifyBaseEip1559Envelope({
    request,
    serialized_transaction: evidence.serialized_transaction,
    transaction_hash: evidence.transaction_hash,
  });

  return Object.freeze({
    schema_version: "cashloom.verified-external-evm-artifact/1",
    source: "external_evm_signer",
    transport_assurance: "unattested_hardware_handoff",
    handoff_id: handoff.handoff_id,
    signer_id: handoff.signer_id,
    device_binding_hash: handoff.device_binding_hash,
    claimed_transport: handoff.transport,
    authorization_id: request.authorization_id,
    intent_hash: request.intent_hash,
    request_id: request.request_id,
    request_hash: handoff.request_hash,
    chain_id: BASE_MAINNET_CAIP2,
    signer_account_id: request.signer_account_id,
    encoding: envelope.encoding,
    payload: envelope.payload,
    external_tx_id: envelope.external_tx_id,
    verified_at: now.toISOString(),
  });
};
