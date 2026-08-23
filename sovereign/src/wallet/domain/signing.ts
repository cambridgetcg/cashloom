import { base64 } from "@scure/base";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { z } from "zod";
import {
  caip10AccountIdSchema,
  chainIdFromAccountId,
  chainIdSchema,
  type Caip10AccountId,
  type ChainId,
} from "./identities";
import {
  canonicalizeJson,
  canonicalTimestampSchema,
  sha256DigestSchema,
  walletOpaqueIdSchema,
  type JsonValue,
  type Sha256Digest,
} from "./intent";
import { unsignedAtomicAmountSchema } from "./money";

declare const hexDataBrand: unique symbol;
export type HexData = string & { readonly [hexDataBrand]: true };

export const hexDataSchema = z
  .string()
  .regex(/^0x(?:[0-9a-f]{2})*$/, "expected canonical lowercase, byte-aligned hex data")
  .transform((value) => value as HexData);

const BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const BASE58_PATTERN = /^[1-9A-HJ-NP-Za-km-z]+$/;

const base64BytesSchema = z
  .string()
  .min(4)
  .regex(BASE64_PATTERN, "expected canonical padded base64")
  .refine((value) => {
    try {
      return base64.encode(base64.decode(value)) === value;
    } catch {
      return false;
    }
  }, "expected valid canonical padded base64");

const commonSignRequestShape = {
  schema_version: z.literal("cashloom.sign-request/1"),
  request_id: walletOpaqueIdSchema,
  intent_hash: sha256DigestSchema,
  authorization_id: walletOpaqueIdSchema,
  expires_at: canonicalTimestampSchema,
  quote_hash: sha256DigestSchema.optional(),
  simulation_hash: sha256DigestSchema.optional(),
};

const evmFeeSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("legacy"),
      gas_price_atomic: unsignedAtomicAmountSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("eip1559"),
      max_fee_per_gas_atomic: unsignedAtomicAmountSchema,
      max_priority_fee_per_gas_atomic: unsignedAtomicAmountSchema,
    })
    .strict(),
]);

const evmTransactionRequestSchema = z
  .object({
    ...commonSignRequestShape,
    kind: z.literal("evm-transaction"),
    chain_id: chainIdSchema,
    signer_account_id: caip10AccountIdSchema,
    to_account_id: caip10AccountIdSchema.nullable(),
    nonce: unsignedAtomicAmountSchema,
    value_atomic: unsignedAtomicAmountSchema,
    data: hexDataSchema,
    gas_limit: unsignedAtomicAmountSchema,
    fee: evmFeeSchema,
  })
  .strict();

export type LosslessJsonValue =
  | null
  | boolean
  | string
  | LosslessJsonValue[]
  | { [key: string]: LosslessJsonValue };

export const losslessJsonValueSchema: z.ZodType<LosslessJsonValue> = z.lazy(() =>
  z.union([
    z.null(),
    z.boolean(),
    z.string(),
    z.array(losslessJsonValueSchema),
    z.record(losslessJsonValueSchema),
  ]),
);

const eip712FieldSchema = z
  .object({
    name: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/),
    type: z.string().trim().min(1).max(128),
  })
  .strict();

const eip712RequestSchema = z
  .object({
    ...commonSignRequestShape,
    kind: z.literal("eip712"),
    chain_id: chainIdSchema,
    signer_account_id: caip10AccountIdSchema,
    domain: z.record(losslessJsonValueSchema),
    types: z.record(z.array(eip712FieldSchema).max(128)).refine(
      (types) => Object.keys(types).length > 0,
      "EIP-712 types cannot be empty",
    ),
    primary_type: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/),
    message: z.record(losslessJsonValueSchema),
  })
  .strict();

const bitcoinInputSchema = z
  .object({
    txid: z.string().regex(/^[0-9a-f]{64}$/, "expected a lowercase transaction id"),
    output_index: unsignedAtomicAmountSchema,
    sequence: unsignedAtomicAmountSchema.optional(),
    value_atomic: unsignedAtomicAmountSchema,
  })
  .strict();

const bitcoinOutputSchema = z
  .object({
    script_pubkey: hexDataSchema,
    address: z.string().trim().min(1).max(128).optional(),
    value_atomic: unsignedAtomicAmountSchema,
    role: z.enum(["recipient", "change", "data"]),
  })
  .strict();

const bitcoinPsbtRequestSchema = z
  .object({
    ...commonSignRequestShape,
    kind: z.literal("bitcoin-psbt"),
    chain_id: chainIdSchema,
    signer_account_id: caip10AccountIdSchema,
    psbt_base64: base64BytesSchema,
    psbt_sha256: sha256DigestSchema,
    inputs: z.array(bitcoinInputSchema).min(1).max(500),
    outputs: z.array(bitcoinOutputSchema).min(1).max(500),
    fee_atomic: unsignedAtomicAmountSchema,
  })
  .strict();

const solanaInstructionSchema = z
  .object({
    program_account_id: caip10AccountIdSchema,
    account_ids: z.array(caip10AccountIdSchema).max(256),
    data_base64: z.string().regex(BASE64_PATTERN).optional(),
  })
  .strict();

const solanaTransactionRequestSchema = z
  .object({
    ...commonSignRequestShape,
    kind: z.literal("solana-transaction"),
    chain_id: chainIdSchema,
    signer_account_id: caip10AccountIdSchema,
    fee_payer_account_id: caip10AccountIdSchema,
    transaction_base64: base64BytesSchema,
    transaction_sha256: sha256DigestSchema,
    recent_blockhash: z.string().min(32).max(64).regex(BASE58_PATTERN),
    last_valid_block_height: unsignedAtomicAmountSchema,
    instructions: z.array(solanaInstructionSchema).min(1).max(256),
  })
  .strict();

const rawBoundSignRequestSchema = z.discriminatedUnion("kind", [
  evmTransactionRequestSchema,
  eip712RequestSchema,
  bitcoinPsbtRequestSchema,
  solanaTransactionRequestSchema,
]);

const requireNamespace = (
  chainId: ChainId,
  namespace: string,
  path: (string | number)[],
  context: z.RefinementCtx,
): void => {
  if (!chainId.startsWith(`${namespace}:`)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path,
      message: `expected a ${namespace} chain id`,
    });
  }
};

const requireAccountChain = (
  accountId: Caip10AccountId,
  chainId: ChainId,
  path: (string | number)[],
  context: z.RefinementCtx,
): void => {
  const accountChain = chainIdFromAccountId(accountId);
  if (accountChain !== chainId) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path,
      message: `account is on ${accountChain}, request is on ${chainId}`,
    });
  }
};

const hashBytes = (bytes: Uint8Array): Sha256Digest =>
  sha256DigestSchema.parse(`sha256:${bytesToHex(sha256(bytes))}`);

export const boundSignRequestSchema = rawBoundSignRequestSchema
  .superRefine((request, context) => {
    requireAccountChain(
      request.signer_account_id,
      request.chain_id,
      ["signer_account_id"],
      context,
    );

    if (request.kind === "evm-transaction") {
      requireNamespace(request.chain_id, "eip155", ["chain_id"], context);
      if (
        request.fee.kind === "eip1559" &&
        BigInt(request.fee.max_priority_fee_per_gas_atomic) >
          BigInt(request.fee.max_fee_per_gas_atomic)
      ) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["fee", "max_priority_fee_per_gas_atomic"],
          message: "priority fee cannot exceed max fee",
        });
      }
      if (request.to_account_id !== null) {
        requireAccountChain(
          request.to_account_id,
          request.chain_id,
          ["to_account_id"],
          context,
        );
      }
      return;
    }

    if (request.kind === "eip712") {
      requireNamespace(request.chain_id, "eip155", ["chain_id"], context);
      if (!(request.primary_type in request.types)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["primary_type"],
          message: "primary type is not declared in types",
        });
      }
      const chainReference = request.chain_id.slice(request.chain_id.indexOf(":") + 1);
      const domainChainId = request.domain.chainId;
      if (typeof domainChainId === "string" && domainChainId !== chainReference) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["domain", "chainId"],
          message: `domain chainId must equal ${chainReference}`,
        });
      }
      return;
    }

    if (request.kind === "bitcoin-psbt") {
      requireNamespace(request.chain_id, "bip122", ["chain_id"], context);
      let bytes: Uint8Array;
      try {
        bytes = base64.decode(request.psbt_base64);
      } catch {
        return;
      }
      const magic = bytesToHex(bytes.slice(0, 5));
      if (magic !== "70736274ff") {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["psbt_base64"],
          message: "payload does not have the PSBT magic prefix",
        });
      }
      const expectedHash = hashBytes(bytes);
      if (request.psbt_sha256 !== expectedHash) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["psbt_sha256"],
          message: `PSBT hash mismatch: expected ${expectedHash}`,
        });
      }
      const inputTotal = request.inputs.reduce(
        (sum, input) => sum + BigInt(input.value_atomic),
        0n,
      );
      const outputTotal = request.outputs.reduce(
        (sum, output) => sum + BigInt(output.value_atomic),
        0n,
      );
      if (inputTotal - outputTotal !== BigInt(request.fee_atomic)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["fee_atomic"],
          message: "fee must equal the exact input total minus output total",
        });
      }
      const outpoints = new Set<string>();
      request.inputs.forEach((input, index) => {
        const outpoint = `${input.txid}:${input.output_index}`;
        if (outpoints.has(outpoint)) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["inputs", index],
            message: `duplicate input outpoint ${outpoint}`,
          });
        }
        outpoints.add(outpoint);
      });
      if (!request.outputs.some((output) => output.role === "recipient")) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["outputs"],
          message: "at least one recipient output is required",
        });
      }
      request.outputs.forEach((output, index) => {
        if (output.role === "data" && output.value_atomic !== "0") {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["outputs", index, "value_atomic"],
            message: "data outputs must have zero value",
          });
        }
      });
      return;
    }

    requireNamespace(request.chain_id, "solana", ["chain_id"], context);
    requireAccountChain(
      request.fee_payer_account_id,
      request.chain_id,
      ["fee_payer_account_id"],
      context,
    );
    request.instructions.forEach((instruction, index) => {
      requireAccountChain(
        instruction.program_account_id,
        request.chain_id,
        ["instructions", index, "program_account_id"],
        context,
      );
      instruction.account_ids.forEach((accountId, accountIndex) => {
        requireAccountChain(
          accountId,
          request.chain_id,
          ["instructions", index, "account_ids", accountIndex],
          context,
        );
      });
    });
    let bytes: Uint8Array;
    try {
      bytes = base64.decode(request.transaction_base64);
    } catch {
      return;
    }
    const expectedHash = hashBytes(bytes);
    if (request.transaction_sha256 !== expectedHash) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["transaction_sha256"],
        message: `transaction hash mismatch: expected ${expectedHash}`,
      });
    }
  })
  .readonly();

export type BoundSignRequest = z.infer<typeof boundSignRequestSchema>;
export type EvmTransactionSignRequest = Extract<
  BoundSignRequest,
  { readonly kind: "evm-transaction" }
>;
export type Eip712SignRequest = Extract<BoundSignRequest, { readonly kind: "eip712" }>;
export type BitcoinPsbtSignRequest = Extract<
  BoundSignRequest,
  { readonly kind: "bitcoin-psbt" }
>;
export type SolanaTransactionSignRequest = Extract<
  BoundSignRequest,
  { readonly kind: "solana-transaction" }
>;

export const parseBoundSignRequest = (input: unknown): BoundSignRequest =>
  boundSignRequestSchema.parse(input);

/** Digest the entire validated request for vault approval and TOCTOU defense. */
export const hashBoundSignRequest = (input: unknown): Sha256Digest => {
  const request = parseBoundSignRequest(input);
  const canonical = canonicalizeJson(request as unknown as JsonValue);
  return hashBytes(new TextEncoder().encode(canonical));
};
