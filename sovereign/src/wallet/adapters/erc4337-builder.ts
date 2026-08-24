/** Deterministic Base-only ERC-4337 v0.7 preparation. No RPC or submission. */
import { getUserOperationHash } from "viem/account-abstraction";
import type { Address, Hex } from "viem";
import {
  hashErc4337UserOperationBinding,
  parseErc4337UserOperationRequest,
  type Erc4337UserOperationRequest,
} from "../integrations/index.ts";

export const BASE_ERC4337_CHAIN_ID = "eip155:8453" as const;
export const BASE_ERC4337_CHAIN_NUMERIC_ID = 8453;

export interface PinnedEntryPointV07 {
  readonly chain_id: typeof BASE_ERC4337_CHAIN_ID;
  readonly version: "0.7";
  readonly address: `0x${string}`;
  /** Keccak-256 runtime bytecode hash supplied from trusted release config. */
  readonly runtime_code_hash: `0x${string}`;
}

export interface PreparedErc4337Operation {
  readonly schema_version: "cashloom.erc4337-prepared-operation/1";
  readonly request: Erc4337UserOperationRequest;
  readonly entry_point: PinnedEntryPointV07;
  /** EIP-4337 canonical hash, chain + EntryPoint domain separated. */
  readonly user_operation_hash: `0x${string}`;
}

const address = (value: string): Address => {
  if (!/^0x[0-9a-f]{40}$/.test(value)) throw new TypeError("ERC-4337 address is invalid.");
  return value as Address;
};
const hex = (value: string): Hex => {
  if (!/^0x(?:[0-9a-f]{2})*$/.test(value)) throw new TypeError("ERC-4337 hex is invalid.");
  return value as Hex;
};
const chainNumber = (value: string): number => {
  if (value !== BASE_ERC4337_CHAIN_ID) throw new TypeError("ERC-4337 is Base-only.");
  return BASE_ERC4337_CHAIN_NUMERIC_ID;
};
const exactEntryPoint = (registry: readonly PinnedEntryPointV07[], request: Erc4337UserOperationRequest): PinnedEntryPointV07 => {
  const entry = registry.find((candidate) => candidate.chain_id === request.chain_id && candidate.address === request.entry_point && candidate.version === "0.7");
  if (!entry) throw new TypeError("ERC-4337 EntryPoint is not pinned for Base.");
  if (!/^0x[0-9a-f]{64}$/.test(entry.runtime_code_hash)) throw new TypeError("Pinned EntryPoint runtime code hash is invalid.");
  return entry;
};

const asViemUserOperation = (request: Erc4337UserOperationRequest) => ({
  sender: address(request.user_operation.sender),
  nonce: BigInt(request.user_operation.nonce),
  factory: request.user_operation.factory ? address(request.user_operation.factory) : undefined,
  factoryData: request.user_operation.factory ? hex(`0x${request.user_operation.init_code.slice(42)}`) : undefined,
  callData: hex(request.user_operation.call_data),
  callGasLimit: BigInt(request.user_operation.call_gas_limit),
  verificationGasLimit: BigInt(request.user_operation.verification_gas_limit),
  preVerificationGas: BigInt(request.user_operation.pre_verification_gas),
  maxFeePerGas: BigInt(request.user_operation.max_fee_per_gas),
  maxPriorityFeePerGas: BigInt(request.user_operation.max_priority_fee_per_gas),
  paymaster: request.user_operation.paymaster ? address(request.user_operation.paymaster) : undefined,
  paymasterVerificationGasLimit: request.user_operation.paymaster_verification_gas_limit ? BigInt(request.user_operation.paymaster_verification_gas_limit) : undefined,
  paymasterPostOpGasLimit: request.user_operation.paymaster_post_op_gas_limit ? BigInt(request.user_operation.paymaster_post_op_gas_limit) : undefined,
  paymasterData: request.user_operation.paymaster ? hex(`0x${request.user_operation.paymaster_and_data.slice(106)}`) : undefined,
  signature: hex(request.user_operation.signature),
});

export const createErc4337Builder = (dependencies: { readonly entry_points: readonly PinnedEntryPointV07[] }) => {
  if (!dependencies || !Array.isArray(dependencies.entry_points) || dependencies.entry_points.length < 1 || dependencies.entry_points.length > 8) throw new TypeError("A bounded pinned EntryPoint registry is required.");
  return Object.freeze({
    prepare(input: unknown): PreparedErc4337Operation {
      const request = parseErc4337UserOperationRequest(input);
      if (hashErc4337UserOperationBinding(request) !== request.user_operation_binding_hash) throw new TypeError("ERC-4337 local request binding changed.");
      const entryPoint = exactEntryPoint(dependencies.entry_points, request);
      const user_operation_hash = getUserOperationHash({
        chainId: chainNumber(request.chain_id),
        entryPointAddress: address(entryPoint.address),
        entryPointVersion: "0.7",
        userOperation: asViemUserOperation(request),
      });
      return Object.freeze({ schema_version: "cashloom.erc4337-prepared-operation/1", request, entry_point: entryPoint, user_operation_hash });
    },
  });
};
