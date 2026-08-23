/**
 * Evidence-only observer for CashLoom's locally signed Base transactions.
 *
 * This adapter deliberately has no persistence or broadcast capability. It
 * accepts the immutable wire bytes that the vault already signed, derives the
 * signer and economic call locally, and asks two independently configured RPC
 * endpoints for corroborating inclusion/finality evidence. RPC URLs and raw
 * provider failures never cross the adapter boundary.
 */

import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";
import {
  encodeFunctionData,
  isAddress,
  isHex,
  keccak256,
  parseTransaction,
  recoverTransactionAddress,
  type Address,
  type Hex,
  type TransactionSerialized,
} from "viem";
import { canonicalizeJson, type JsonValue } from "../domain/intent.ts";

export const BASE_MAINNET_CHAIN_ID = 8453n;
export const BASE_NATIVE_USDC_ADDRESS =
  "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913" as const;
export const BASE_GAS_PRICE_ORACLE_ADDRESS =
  "0x420000000000000000000000000000000000000f" as const;

const TRANSFER_SELECTOR = "a9059cbb";
const TRANSFER_TOPIC =
  "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const BASE_CHAIN_HEX = "0x2105";
const DEFAULT_PRIMARY_RPC = "https://mainnet.base.org";
const DEFAULT_CONFIRMATION_RPC = "https://base-rpc.publicnode.com";
const DEFAULT_DEADLINE_MS = 12_000;
const DEFAULT_MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_SIGNED_TRANSACTION_BYTES = 128 * 1024;
const MAX_LOGS = 4_096;
const MAX_BLOCK_TRANSACTIONS = 32_768;
const MAX_UINT256 = (1n << 256n) - 1n;

type BaseAsset = "ETH" | "USDC";
type ProviderErrorCode =
  | "aborted"
  | "deadline_exceeded"
  | "network_unavailable"
  | "response_too_large"
  | "malformed_rpc"
  | "wrong_chain"
  | "transaction_mismatch"
  | "receipt_mismatch"
  | "block_mismatch"
  | "fee_evidence_unavailable";

export interface BaseEconomicPayment {
  readonly asset: BaseAsset;
  readonly from: Address;
  readonly beneficiary: Address;
  /** Wei for ETH or the native Circle USDC contract's 6-decimal units. */
  readonly amount_atomic: string;
}

export interface BaseTransactionObservationRequest {
  readonly signed_transaction: Hex;
  readonly expected_transaction_hash: `0x${string}`;
  readonly payment: BaseEconomicPayment;
}

/** Configuration is fixed when the observer is constructed, never accepted
 * from an observation request. `url` is intentionally absent from every
 * outward-facing type. */
export interface BaseRpcProviderConfig {
  readonly id: string;
  readonly url: string;
}

export interface BaseObserverDependencies {
  readonly providers?: readonly BaseRpcProviderConfig[];
  readonly fetch?: typeof globalThis.fetch;
  readonly now?: () => number;
  readonly deadline_ms?: number;
  readonly max_response_bytes?: number;
}

export interface BaseFinalityEvidence {
  readonly status: "confirmed" | "not_confirmed" | "unavailable";
  readonly head_block_number?: string;
  readonly head_block_hash?: `0x${string}`;
}

export interface BaseCoreEvidence {
  readonly schema_version: "cashloom.base-evidence/1";
  readonly transaction: {
    readonly hash: `0x${string}`;
    readonly from: Address;
    readonly to: Address;
    readonly nonce: string;
    readonly value_wei: string;
    readonly calldata: Hex;
    readonly gas_limit: string;
    readonly max_fee_per_gas_wei: string;
    readonly max_priority_fee_per_gas_wei: string;
    readonly access_list: readonly {
      readonly address: Address;
      readonly storage_keys: readonly `0x${string}`[];
    }[];
  };
  readonly inclusion: {
    readonly block_hash: `0x${string}`;
    readonly block_number: string;
    /** Exact Unix timestamp in seconds from the canonical Base block header. */
    readonly block_timestamp: string;
    readonly transaction_index: string;
  };
  readonly outcome: "success" | "reverted";
  readonly economic_effect: {
    readonly asset: BaseAsset;
    readonly beneficiary: Address;
    /** Zero for a reverted call; otherwise the exact authorized amount. */
    readonly amount_atomic: string;
    readonly transfer_log_index?: string;
  };
  readonly fees: {
    readonly gas_used: string;
    readonly effective_gas_price_wei: string;
    readonly l2_execution_fee_wei: string;
    readonly l1_data_fee_wei: string;
    readonly operator_fee_wei: string;
    readonly total_fee_wei: string;
  };
  readonly evidence_hash: `sha256:${string}`;
}

export type BaseProviderObservation =
  | {
      readonly provider_id: string;
      readonly state: "pending";
      readonly reason: "transaction_not_visible" | "receipt_pending";
    }
  | {
      readonly provider_id: string;
      readonly state: "unavailable";
      readonly error_code: ProviderErrorCode;
    }
  | {
      readonly provider_id: string;
      readonly state: "included";
      readonly evidence: BaseCoreEvidence;
      readonly finality: {
        readonly latest: BaseFinalityEvidence;
        readonly safe: BaseFinalityEvidence;
        readonly finalized: BaseFinalityEvidence;
      };
    };

export interface BaseEvidenceGroup {
  readonly evidence_hash: `sha256:${string}`;
  readonly provider_ids: readonly string[];
  readonly finalized_provider_ids: readonly string[];
}

/** Persistence-friendly projection. A provider transport failure is not a
 * sighting and remains represented only in `providers`; in particular it is
 * never rewritten as NOT_FOUND. `quorum` is a canonical decimal string in the
 * consensus projection, like other externally persisted integer quantities. */
export interface BaseProviderSighting {
  readonly provider_id: string;
  readonly visibility: "NOT_FOUND" | "MEMPOOL" | "INCLUDED";
  readonly outcome: "UNKNOWN" | "SUCCESS" | "REVERTED";
  readonly security_level: "UNSAFE" | "SAFE" | "FINALIZED";
  readonly block_number: string | null;
  readonly block_hash: `0x${string}` | null;
  readonly evidence_hash: `sha256:${string}`;
  readonly body: JsonValue;
  readonly observed_at: string;
  readonly fetched_at: string;
}

export interface BaseFinalizedConsensus {
  readonly provider_ids: readonly string[];
  readonly quorum: "2";
  readonly evidence_hash: `sha256:${string}`;
  readonly outcome: "SUCCESS" | "REVERTED";
  readonly security_level: "FINALIZED";
  readonly block_number: string;
  readonly block_hash: `0x${string}`;
  readonly body: BaseCoreEvidence;
  readonly observed_at: string;
}

export interface BaseTransactionObservation {
  readonly schema_version: "cashloom.base-observation/1";
  /** `partial` is explicitly nonterminal; this adapter never infers dropped. */
  readonly state: "pending" | "partial" | "settled";
  readonly transaction_hash: `0x${string}`;
  readonly observed_at: string;
  readonly quorum: {
    readonly required_distinct_providers: "2";
    readonly groups: readonly BaseEvidenceGroup[];
  };
  readonly providers: readonly BaseProviderObservation[];
  readonly sightings: readonly BaseProviderSighting[];
  readonly evidence?: BaseCoreEvidence;
  readonly consensus?: BaseFinalizedConsensus;
}

export interface BaseEvidenceObserver {
  observe(
    request: BaseTransactionObservationRequest,
    signal?: AbortSignal,
  ): Promise<BaseTransactionObservation>;
}

interface ParsedAuthorization {
  readonly signed: TransactionSerialized;
  readonly hash: `0x${string}`;
  readonly from: Address;
  readonly beneficiary: Address;
  readonly asset: BaseAsset;
  readonly amount: bigint;
  readonly nonce: bigint;
  readonly to: Address;
  readonly value: bigint;
  readonly calldata: Hex;
  readonly gas: bigint;
  readonly maxFeePerGas: bigint;
  readonly maxPriorityFeePerGas: bigint;
  readonly accessList: readonly {
    readonly address: Address;
    readonly storageKeys: readonly `0x${string}`[];
  }[];
  readonly r: bigint;
  readonly s: bigint;
  readonly yParity: bigint;
}

interface RpcTransaction {
  readonly hash: `0x${string}`;
  readonly from: Address;
  readonly to: Address;
  readonly nonce: bigint;
  readonly value: bigint;
  readonly input: Hex;
  readonly gas: bigint;
  readonly maxFeePerGas: bigint;
  readonly maxPriorityFeePerGas: bigint;
  readonly blockHash: `0x${string}`;
  readonly blockNumber: bigint;
  readonly transactionIndex: bigint;
  readonly chainId: bigint;
  readonly accessList: readonly {
    readonly address: Address;
    readonly storageKeys: readonly `0x${string}`[];
  }[];
  readonly r: bigint;
  readonly s: bigint;
  readonly yParity: bigint;
}

interface RpcLog {
  readonly address: Address;
  readonly topics: readonly `0x${string}`[];
  readonly data: Hex;
  readonly blockHash: `0x${string}`;
  readonly blockNumber: bigint;
  readonly transactionHash: `0x${string}`;
  readonly transactionIndex: bigint;
  readonly logIndex: bigint;
  readonly removed: boolean;
}

interface RpcReceipt {
  readonly transactionHash: `0x${string}`;
  readonly blockHash: `0x${string}`;
  readonly blockNumber: bigint;
  readonly transactionIndex: bigint;
  readonly from: Address;
  readonly to: Address;
  readonly status: "success" | "reverted";
  readonly gasUsed: bigint;
  readonly effectiveGasPrice: bigint;
  readonly l1Fee: bigint;
  readonly logs: readonly RpcLog[];
}

interface RpcBlock {
  readonly hash: `0x${string}`;
  readonly number: bigint;
  readonly timestamp: bigint;
  readonly transactions: readonly `0x${string}`[];
}

class EvidenceFault extends Error {
  constructor(readonly code: ProviderErrorCode) {
    super(code);
    this.name = "EvidenceFault";
  }
}

class ExplicitAbort extends Error {
  constructor() {
    super("Base observation aborted.");
    this.name = "AbortError";
  }
}

const isPlainObject = (value: unknown): value is Record<string, unknown> => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};

const exactKeys = (value: Record<string, unknown>, keys: readonly string[]): boolean => {
  const actual = Object.keys(value);
  return actual.length === keys.length && actual.every((key) => keys.includes(key));
};

const normalizeAddress = (value: unknown, code: ProviderErrorCode): Address => {
  if (typeof value !== "string" || !isAddress(value, { strict: true })) {
    throw new EvidenceFault(code);
  }
  return value.toLowerCase() as Address;
};

const normalizeHash = (value: unknown, code: ProviderErrorCode): `0x${string}` => {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(value)) {
    throw new EvidenceFault(code);
  }
  return value.toLowerCase() as `0x${string}`;
};

const normalizeData = (
  value: unknown,
  code: ProviderErrorCode,
  maxBytes = MAX_SIGNED_TRANSACTION_BYTES,
): Hex => {
  if (
    typeof value !== "string" ||
    !isHex(value, { strict: true }) ||
    value.length % 2 !== 0 ||
    (value.length - 2) / 2 > maxBytes
  ) {
    throw new EvidenceFault(code);
  }
  return value.toLowerCase() as Hex;
};

const quantity = (
  value: unknown,
  code: ProviderErrorCode,
  max = MAX_UINT256,
): bigint => {
  if (typeof value !== "string" || !/^0x(?:0|[1-9a-f][0-9a-f]*)$/.test(value)) {
    throw new EvidenceFault(code);
  }
  const parsed = BigInt(value);
  if (parsed > max) throw new EvidenceFault(code);
  return parsed;
};

const uint256Word = (value: unknown, code: ProviderErrorCode): bigint => {
  if (typeof value !== "string" || !/^0x[0-9a-f]{64}$/.test(value)) {
    throw new EvidenceFault(code);
  }
  return BigInt(value);
};

const hashJson = (value: JsonValue): `sha256:${string}` =>
  `sha256:${bytesToHex(sha256(utf8ToBytes(canonicalizeJson(value))))}`;

const hashCore = (core: Omit<BaseCoreEvidence, "evidence_hash">): `sha256:${string}` =>
  hashJson(core as unknown as JsonValue);

const parseRequest = async (
  candidate: BaseTransactionObservationRequest,
): Promise<ParsedAuthorization> => {
  if (!isPlainObject(candidate) || !exactKeys(candidate, [
    "signed_transaction",
    "expected_transaction_hash",
    "payment",
  ])) {
    throw new TypeError("Base observation request has an invalid shape.");
  }
  if (!isPlainObject(candidate.payment) || !exactKeys(candidate.payment, [
    "asset",
    "from",
    "beneficiary",
    "amount_atomic",
  ])) {
    throw new TypeError("Base economic payment has an invalid shape.");
  }
  const payment = candidate.payment;
  if (payment.asset !== "ETH" && payment.asset !== "USDC") {
    throw new TypeError("Base observer supports native ETH and Circle USDC only.");
  }
  if (typeof payment.amount_atomic !== "string" || !/^[1-9][0-9]*$/.test(payment.amount_atomic)) {
    throw new TypeError("Base payment amount must be a positive canonical atomic string.");
  }
  const amount = BigInt(payment.amount_atomic);
  if (amount > MAX_UINT256) throw new TypeError("Base payment amount exceeds uint256.");
  if (typeof payment.from !== "string" || !isAddress(payment.from, { strict: true })) {
    throw new TypeError("Base payment sender is invalid.");
  }
  if (typeof payment.beneficiary !== "string" || !isAddress(payment.beneficiary, { strict: true })) {
    throw new TypeError("Base payment beneficiary is invalid.");
  }
  const from = payment.from.toLowerCase() as Address;
  const beneficiary = payment.beneficiary.toLowerCase() as Address;
  let signed: TransactionSerialized;
  try {
    signed = normalizeData(
      candidate.signed_transaction,
      "transaction_mismatch",
    ) as TransactionSerialized;
  } catch {
    throw new TypeError("Signed Base transaction is not bounded canonical hex.");
  }
  if ((signed.length - 2) / 2 === 0) {
    throw new TypeError("Signed Base transaction is empty.");
  }
  const expectedHash = typeof candidate.expected_transaction_hash === "string" &&
    /^0x[0-9a-fA-F]{64}$/.test(candidate.expected_transaction_hash)
    ? candidate.expected_transaction_hash.toLowerCase() as `0x${string}`
    : undefined;
  if (!expectedHash) throw new TypeError("Expected Base transaction hash is invalid.");

  let parsed: ReturnType<typeof parseTransaction>;
  let recovered: Address;
  try {
    parsed = parseTransaction(signed);
    recovered = (await recoverTransactionAddress({ serializedTransaction: signed })).toLowerCase() as Address;
  } catch {
    throw new TypeError("Signed Base transaction cannot be parsed or authenticated.");
  }
  const hash = keccak256(signed).toLowerCase() as `0x${string}`;
  if (hash !== expectedHash) throw new TypeError("Signed Base transaction hash does not match authorization.");
  if (parsed.type !== "eip1559" || BigInt(parsed.chainId) !== BASE_MAINNET_CHAIN_ID) {
    throw new TypeError("Signed transaction is not Base mainnet EIP-1559.");
  }
  if (recovered !== from) throw new TypeError("Signed Base transaction signer does not match authorization.");
  if (
    parsed.to === undefined ||
    parsed.to === null ||
    parsed.gas === undefined ||
    parsed.maxFeePerGas === undefined ||
    parsed.r === undefined ||
    parsed.s === undefined ||
    parsed.yParity === undefined
  ) {
    throw new TypeError("Signed Base EIP-1559 envelope is incomplete.");
  }
  const nonce = parsed.nonce ?? 0;
  const value = parsed.value ?? 0n;
  const maxPriorityFeePerGas = parsed.maxPriorityFeePerGas ?? 0n;
  if (!Number.isSafeInteger(nonce) || nonce < 0 || parsed.gas === 0n || parsed.maxFeePerGas === 0n) {
    throw new TypeError("Signed Base EIP-1559 envelope is incomplete.");
  }
  const to = parsed.to.toLowerCase() as Address;
  const calldata = (parsed.data ?? "0x").toLowerCase() as Hex;
  if (maxPriorityFeePerGas > parsed.maxFeePerGas) {
    throw new TypeError("Signed Base fee envelope is invalid.");
  }
  if (payment.asset === "ETH") {
    if (to !== beneficiary || value !== amount || calldata !== "0x") {
      throw new TypeError("Signed Base transaction does not match the authorized ETH payment.");
    }
  } else {
    const expectedCalldata = (`0x${TRANSFER_SELECTOR}${beneficiary.slice(2).padStart(64, "0")}${amount
      .toString(16)
      .padStart(64, "0")}`) as Hex;
    if (
      to !== BASE_NATIVE_USDC_ADDRESS ||
      value !== 0n ||
      calldata !== expectedCalldata
    ) {
      throw new TypeError("Signed Base transaction does not match the authorized Circle USDC payment.");
    }
  }
  const accessList = (parsed.accessList ?? []).map((entry) => ({
    address: entry.address.toLowerCase() as Address,
    storageKeys: entry.storageKeys.map((key) => key.toLowerCase() as `0x${string}`),
  }));
  return {
    signed,
    hash,
    from,
    beneficiary,
    asset: payment.asset,
    amount,
    nonce: BigInt(nonce),
    to,
    value,
    calldata,
    gas: parsed.gas,
    maxFeePerGas: parsed.maxFeePerGas,
    maxPriorityFeePerGas,
    accessList,
    r: BigInt(parsed.r),
    s: BigInt(parsed.s),
    yParity: BigInt(parsed.yParity),
  };
};

const parseAccessList = (
  value: unknown,
  code: ProviderErrorCode,
): RpcTransaction["accessList"] => {
  if (!Array.isArray(value) || value.length > 1_024) throw new EvidenceFault(code);
  return value.map((candidate) => {
    if (!isPlainObject(candidate) || !Array.isArray(candidate.storageKeys)) {
      throw new EvidenceFault(code);
    }
    const address = normalizeAddress(candidate.address, code);
    if (candidate.storageKeys.length > 1_024) throw new EvidenceFault(code);
    const storageKeys = candidate.storageKeys.map((key) => normalizeHash(key, code));
    return { address, storageKeys };
  });
};

const parseRpcTransaction = (value: unknown): RpcTransaction => {
  const code = "transaction_mismatch" as const;
  if (!isPlainObject(value)) throw new EvidenceFault(code);
  if (value.type !== "0x2") throw new EvidenceFault(code);
  const to = normalizeAddress(value.to, code);
  const blockHash = normalizeHash(value.blockHash, code);
  const blockNumber = quantity(value.blockNumber, code);
  const transactionIndex = quantity(value.transactionIndex, code);
  const chainId = quantity(value.chainId, code);
  const v = quantity(value.v, code, 1n);
  const yParity = value.yParity === undefined ? v : quantity(value.yParity, code, 1n);
  if (v !== yParity) throw new EvidenceFault(code);
  return {
    hash: normalizeHash(value.hash, code),
    from: normalizeAddress(value.from, code),
    to,
    nonce: quantity(value.nonce, code, (1n << 64n) - 1n),
    value: quantity(value.value, code),
    input: normalizeData(value.input, code),
    gas: quantity(value.gas, code),
    maxFeePerGas: quantity(value.maxFeePerGas, code),
    maxPriorityFeePerGas: quantity(value.maxPriorityFeePerGas, code),
    blockHash,
    blockNumber,
    transactionIndex,
    chainId,
    accessList: parseAccessList(value.accessList, code),
    r: uint256Word(value.r, code),
    s: uint256Word(value.s, code),
    yParity,
  };
};

const parseRpcLog = (value: unknown): RpcLog => {
  const code = "receipt_mismatch" as const;
  if (!isPlainObject(value) || !Array.isArray(value.topics) || value.topics.length > 4) {
    throw new EvidenceFault(code);
  }
  if (typeof value.removed !== "boolean") throw new EvidenceFault(code);
  return {
    address: normalizeAddress(value.address, code),
    topics: value.topics.map((topic) => normalizeHash(topic, code)),
    data: normalizeData(value.data, code),
    blockHash: normalizeHash(value.blockHash, code),
    blockNumber: quantity(value.blockNumber, code),
    transactionHash: normalizeHash(value.transactionHash, code),
    transactionIndex: quantity(value.transactionIndex, code),
    logIndex: quantity(value.logIndex, code),
    removed: value.removed,
  };
};

const parseReceipt = (value: unknown): RpcReceipt => {
  const code = "receipt_mismatch" as const;
  if (!isPlainObject(value) || !Array.isArray(value.logs) || value.logs.length > MAX_LOGS) {
    throw new EvidenceFault(code);
  }
  if (value.type !== "0x2" || value.contractAddress !== null) throw new EvidenceFault(code);
  const status = value.status === "0x1"
    ? "success"
    : value.status === "0x0"
      ? "reverted"
      : undefined;
  if (!status) throw new EvidenceFault(code);
  return {
    transactionHash: normalizeHash(value.transactionHash, code),
    blockHash: normalizeHash(value.blockHash, code),
    blockNumber: quantity(value.blockNumber, code),
    transactionIndex: quantity(value.transactionIndex, code),
    from: normalizeAddress(value.from, code),
    to: normalizeAddress(value.to, code),
    status,
    gasUsed: quantity(value.gasUsed, code),
    effectiveGasPrice: quantity(value.effectiveGasPrice, code),
    l1Fee: quantity(value.l1Fee, code),
    logs: value.logs.map(parseRpcLog),
  };
};

const parseBlock = (value: unknown, includeTransactions: boolean): RpcBlock => {
  const code = "block_mismatch" as const;
  if (!isPlainObject(value) || !Array.isArray(value.transactions)) throw new EvidenceFault(code);
  if (value.transactions.length > MAX_BLOCK_TRANSACTIONS) throw new EvidenceFault(code);
  const transactions = includeTransactions
    ? value.transactions.map((entry) => normalizeHash(entry, code))
    : [];
  return {
    hash: normalizeHash(value.hash, code),
    number: quantity(value.number, code),
    timestamp: quantity(value.timestamp, code, (1n << 64n) - 1n),
    transactions,
  };
};

const sameAccessList = (
  left: RpcTransaction["accessList"],
  right: ParsedAuthorization["accessList"],
): boolean =>
  left.length === right.length && left.every((entry, index) => {
    const expected = right[index];
    return expected !== undefined &&
      entry.address === expected.address &&
      entry.storageKeys.length === expected.storageKeys.length &&
      entry.storageKeys.every((key, keyIndex) => key === expected.storageKeys[keyIndex]);
  });

const bindTransaction = (rpc: RpcTransaction, local: ParsedAuthorization): void => {
  if (
    rpc.hash !== local.hash ||
    rpc.chainId !== BASE_MAINNET_CHAIN_ID ||
    rpc.from !== local.from ||
    rpc.to !== local.to ||
    rpc.nonce !== local.nonce ||
    rpc.value !== local.value ||
    rpc.input !== local.calldata ||
    rpc.gas !== local.gas ||
    rpc.maxFeePerGas !== local.maxFeePerGas ||
    rpc.maxPriorityFeePerGas !== local.maxPriorityFeePerGas ||
    rpc.r !== local.r ||
    rpc.s !== local.s ||
    rpc.yParity !== local.yParity ||
    !sameAccessList(rpc.accessList, local.accessList)
  ) {
    throw new EvidenceFault("transaction_mismatch");
  }
};

const bindReceipt = (
  receipt: RpcReceipt,
  transaction: RpcTransaction,
  local: ParsedAuthorization,
): void => {
  if (
    receipt.transactionHash !== local.hash ||
    receipt.blockHash !== transaction.blockHash ||
    receipt.blockNumber !== transaction.blockNumber ||
    receipt.transactionIndex !== transaction.transactionIndex ||
    receipt.from !== local.from ||
    receipt.to !== local.to ||
    receipt.gasUsed > local.gas ||
    receipt.effectiveGasPrice > local.maxFeePerGas
  ) {
    throw new EvidenceFault("receipt_mismatch");
  }
  for (const log of receipt.logs) {
    if (
      log.removed ||
      log.blockHash !== receipt.blockHash ||
      log.blockNumber !== receipt.blockNumber ||
      log.transactionHash !== receipt.transactionHash ||
      log.transactionIndex !== receipt.transactionIndex
    ) {
      throw new EvidenceFault("receipt_mismatch");
    }
  }
  if (receipt.status === "reverted" && receipt.logs.length !== 0) {
    throw new EvidenceFault("receipt_mismatch");
  }
};

const transferEffect = (
  receipt: RpcReceipt,
  local: ParsedAuthorization,
): { readonly amount: bigint; readonly logIndex?: bigint } => {
  if (receipt.status === "reverted") return { amount: 0n };
  if (local.asset === "ETH") return { amount: local.amount };
  const circleTransfers = receipt.logs.filter(
    (log) => log.address === BASE_NATIVE_USDC_ADDRESS && log.topics[0] === TRANSFER_TOPIC,
  );
  if (circleTransfers.length !== 1) throw new EvidenceFault("receipt_mismatch");
  const transfer = circleTransfers[0]!;
  const expectedFrom = `0x${local.from.slice(2).padStart(64, "0")}`;
  const expectedBeneficiary = `0x${local.beneficiary.slice(2).padStart(64, "0")}`;
  if (
    transfer.topics.length !== 3 ||
    transfer.topics[1] !== expectedFrom ||
    transfer.topics[2] !== expectedBeneficiary ||
    !/^0x[0-9a-f]{64}$/.test(transfer.data) ||
    BigInt(transfer.data) !== local.amount
  ) {
    throw new EvidenceFault("receipt_mismatch");
  }
  return { amount: local.amount, logIndex: transfer.logIndex };
};

class JsonRpcClient {
  #id = 0;

  constructor(
    private readonly provider: BaseRpcProviderConfig,
    private readonly fetcher: typeof globalThis.fetch,
    private readonly now: () => number,
    private readonly deadlineAt: number,
    private readonly maxResponseBytes: number,
    private readonly externalSignal?: AbortSignal,
  ) {}

  async call(method: string, params: readonly unknown[]): Promise<unknown> {
    if (this.externalSignal?.aborted) throw new ExplicitAbort();
    const remaining = this.deadlineAt - this.now();
    if (remaining <= 0) throw new EvidenceFault("deadline_exceeded");
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    this.externalSignal?.addEventListener("abort", onAbort, { once: true });
    const timeout = setTimeout(() => controller.abort(), remaining);
    const id = `${this.provider.id}:${++this.#id}`;
    try {
      let response: Response;
      try {
        response = await this.fetcher(this.provider.url, {
          method: "POST",
          headers: { "content-type": "application/json", accept: "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
          signal: controller.signal,
          // The provider registry is the network capability boundary. Never
          // follow a response to an unreviewed host or credential-bearing URL.
          redirect: "error",
        });
      } catch {
        if (this.externalSignal?.aborted) throw new ExplicitAbort();
        if (this.now() >= this.deadlineAt || controller.signal.aborted) {
          throw new EvidenceFault("deadline_exceeded");
        }
        throw new EvidenceFault("network_unavailable");
      }
      if (!response.ok) throw new EvidenceFault("network_unavailable");
      const declaredLength = response.headers.get("content-length");
      if (declaredLength !== null) {
        if (!/^(?:0|[1-9][0-9]*)$/.test(declaredLength)) {
          throw new EvidenceFault("malformed_rpc");
        }
        if (BigInt(declaredLength) > BigInt(this.maxResponseBytes)) {
          throw new EvidenceFault("response_too_large");
        }
      }
      const text = await this.#boundedText(response);
      let envelope: unknown;
      try {
        envelope = JSON.parse(text);
      } catch {
        throw new EvidenceFault("malformed_rpc");
      }
      if (!isPlainObject(envelope) || envelope.jsonrpc !== "2.0" || envelope.id !== id) {
        throw new EvidenceFault("malformed_rpc");
      }
      const keys = Object.keys(envelope);
      if (keys.some((key) => !["jsonrpc", "id", "result", "error"].includes(key))) {
        throw new EvidenceFault("malformed_rpc");
      }
      const hasResult = Object.prototype.hasOwnProperty.call(envelope, "result");
      const hasError = Object.prototype.hasOwnProperty.call(envelope, "error");
      if (hasResult === hasError || !hasResult || keys.length !== 3) {
        throw new EvidenceFault("malformed_rpc");
      }
      return envelope.result;
    } finally {
      clearTimeout(timeout);
      this.externalSignal?.removeEventListener("abort", onAbort);
    }
  }

  async #boundedText(response: Response): Promise<string> {
    if (!response.body) return "";
    const reader = response.body.getReader();
    const decoder = new TextDecoder("utf-8", { fatal: true });
    let bytes = 0;
    let output = "";
    try {
      while (true) {
        let chunk;
        try {
          chunk = await reader.read();
        } catch {
          if (this.externalSignal?.aborted) throw new ExplicitAbort();
          if (this.now() >= this.deadlineAt) throw new EvidenceFault("deadline_exceeded");
          throw new EvidenceFault("network_unavailable");
        }
        if (chunk.done) break;
        bytes += chunk.value.byteLength;
        if (bytes > this.maxResponseBytes) {
          await reader.cancel().catch(() => undefined);
          throw new EvidenceFault("response_too_large");
        }
        try {
          output += decoder.decode(chunk.value, { stream: true });
        } catch {
          throw new EvidenceFault("malformed_rpc");
        }
      }
      try {
        output += decoder.decode();
      } catch {
        throw new EvidenceFault("malformed_rpc");
      }
      return output;
    } finally {
      reader.releaseLock();
    }
  }
}

const blockTagEvidence = async (
  rpc: JsonRpcClient,
  tag: "latest" | "safe" | "finalized",
  inclusion: RpcTransaction,
): Promise<BaseFinalityEvidence> => {
  try {
    const raw = await rpc.call("eth_getBlockByNumber", [tag, false]);
    if (raw === null) return { status: "unavailable" };
    const block = parseBlock(raw, false);
    if (block.number === inclusion.blockNumber && block.hash !== inclusion.blockHash) {
      return {
        status: "not_confirmed",
        head_block_number: block.number.toString(),
        head_block_hash: block.hash,
      };
    }
    return {
      status: block.number >= inclusion.blockNumber ? "confirmed" : "not_confirmed",
      head_block_number: block.number.toString(),
      head_block_hash: block.hash,
    };
  } catch (error) {
    if (error instanceof ExplicitAbort) throw error;
    return { status: "unavailable" };
  }
};

const headNumber = (evidence: BaseFinalityEvidence): bigint | undefined =>
  evidence.head_block_number === undefined ? undefined : BigInt(evidence.head_block_number);

const finalityIsConsistent = (
  latest: BaseFinalityEvidence,
  safe: BaseFinalityEvidence,
  finalized: BaseFinalityEvidence,
): boolean => {
  // `latest` is mandatory. Safe/finalized may be unavailable on a limited
  // provider, but any heads that do exist must respect canonical ordering and
  // agree on their hash whenever they name the same height.
  if (latest.status === "unavailable") return false;
  const rows = [latest, safe, finalized];
  for (let leftIndex = 0; leftIndex < rows.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < rows.length; rightIndex += 1) {
      const left = rows[leftIndex]!;
      const right = rows[rightIndex]!;
      const leftNumber = headNumber(left);
      const rightNumber = headNumber(right);
      if (
        leftNumber !== undefined &&
        rightNumber !== undefined &&
        leftNumber === rightNumber &&
        left.head_block_hash !== right.head_block_hash
      ) return false;
    }
  }
  const latestNumber = headNumber(latest)!;
  const safeNumber = headNumber(safe);
  const finalizedNumber = headNumber(finalized);
  if (safeNumber !== undefined && safeNumber > latestNumber) return false;
  if (finalizedNumber !== undefined && finalizedNumber > latestNumber) return false;
  if (safeNumber !== undefined && finalizedNumber !== undefined && finalizedNumber > safeNumber) {
    return false;
  }
  if (safe.status === "confirmed" && latest.status !== "confirmed") return false;
  if (
    finalized.status === "confirmed" &&
    (latest.status !== "confirmed" || safe.status !== "confirmed")
  ) return false;
  return true;
};

const getOperatorFee = async (
  rpc: JsonRpcClient,
  gasUsed: bigint,
  blockNumber: bigint,
): Promise<bigint> => {
  const calldata = encodeFunctionData({
    abi: [{
      type: "function",
      name: "getOperatorFee",
      stateMutability: "view",
      inputs: [{ name: "gasUsed", type: "uint256" }],
      outputs: [{ name: "", type: "uint256" }],
    }],
    functionName: "getOperatorFee",
    args: [gasUsed],
  });
  const raw = await rpc.call("eth_call", [
    { to: BASE_GAS_PRICE_ORACLE_ADDRESS, data: calldata },
    `0x${blockNumber.toString(16)}`,
  ]);
  return uint256Word(raw, "fee_evidence_unavailable");
};

const evidenceFromProvider = async (
  provider: BaseRpcProviderConfig,
  fetcher: typeof globalThis.fetch,
  now: () => number,
  deadlineAt: number,
  maxResponseBytes: number,
  local: ParsedAuthorization,
  signal?: AbortSignal,
): Promise<BaseProviderObservation> => {
  const rpc = new JsonRpcClient(provider, fetcher, now, deadlineAt, maxResponseBytes, signal);
  try {
    const rawChain = await rpc.call("eth_chainId", []);
    if (rawChain !== BASE_CHAIN_HEX) throw new EvidenceFault("wrong_chain");
    const [rawTransaction, rawReceipt] = await Promise.all([
      rpc.call("eth_getTransactionByHash", [local.hash]),
      rpc.call("eth_getTransactionReceipt", [local.hash]),
    ]);
    if (rawTransaction === null && rawReceipt === null) {
      return { provider_id: provider.id, state: "pending", reason: "transaction_not_visible" };
    }
    if (rawReceipt === null) {
      if (rawTransaction !== null) {
        const pendingTransaction = parseRpcTransaction(valueWithPendingDefaults(rawTransaction));
        bindTransaction(pendingTransaction, local);
      }
      return { provider_id: provider.id, state: "pending", reason: "receipt_pending" };
    }
    if (rawTransaction === null) throw new EvidenceFault("transaction_mismatch");
    const transaction = parseRpcTransaction(rawTransaction);
    const receipt = parseReceipt(rawReceipt);
    bindTransaction(transaction, local);
    bindReceipt(receipt, transaction, local);

    const byHashRaw = await rpc.call("eth_getBlockByHash", [transaction.blockHash, false]);
    if (byHashRaw === null) throw new EvidenceFault("block_mismatch");
    const byHash = parseBlock(byHashRaw, true);
    if (
      byHash.hash !== transaction.blockHash ||
      byHash.number !== transaction.blockNumber ||
      transaction.transactionIndex >= BigInt(byHash.transactions.length) ||
      byHash.transactions[Number(transaction.transactionIndex)] !== local.hash ||
      byHash.transactions.filter((hash) => hash === local.hash).length !== 1
    ) {
      throw new EvidenceFault("block_mismatch");
    }

    const blockNumberTag = `0x${transaction.blockNumber.toString(16)}`;
    const canonicalBeforeRaw = await rpc.call("eth_getBlockByNumber", [blockNumberTag, false]);
    if (canonicalBeforeRaw === null) throw new EvidenceFault("block_mismatch");
    const canonicalBefore = parseBlock(canonicalBeforeRaw, false);
    if (
      canonicalBefore.hash !== byHash.hash ||
      canonicalBefore.number !== byHash.number ||
      canonicalBefore.timestamp !== byHash.timestamp
    ) {
      throw new EvidenceFault("block_mismatch");
    }

    const operatorFee = await getOperatorFee(rpc, receipt.gasUsed, transaction.blockNumber);

    const canonicalAfterRaw = await rpc.call("eth_getBlockByNumber", [blockNumberTag, false]);
    if (canonicalAfterRaw === null) throw new EvidenceFault("block_mismatch");
    const canonicalAfter = parseBlock(canonicalAfterRaw, false);
    if (
      canonicalAfter.hash !== canonicalBefore.hash ||
      canonicalAfter.number !== canonicalBefore.number ||
      canonicalAfter.timestamp !== canonicalBefore.timestamp
    ) {
      throw new EvidenceFault("block_mismatch");
    }

    const [latest, safe, finalized] = await Promise.all([
      blockTagEvidence(rpc, "latest", transaction),
      blockTagEvidence(rpc, "safe", transaction),
      blockTagEvidence(rpc, "finalized", transaction),
    ]);
    if (!finalityIsConsistent(latest, safe, finalized)) {
      throw new EvidenceFault("block_mismatch");
    }
    // Guard once more after reading the heads. This closes the window in
    // which a reorg could otherwise occur after the operator-fee guard but
    // before a provider claims safe/finalized confirmation.
    const canonicalFinalRaw = await rpc.call("eth_getBlockByNumber", [blockNumberTag, false]);
    if (canonicalFinalRaw === null) throw new EvidenceFault("block_mismatch");
    const canonicalFinal = parseBlock(canonicalFinalRaw, false);
    if (
      canonicalFinal.hash !== canonicalAfter.hash ||
      canonicalFinal.number !== canonicalAfter.number ||
      canonicalFinal.timestamp !== canonicalAfter.timestamp
    ) {
      throw new EvidenceFault("block_mismatch");
    }
    const effect = transferEffect(receipt, local);
    const l2Fee = receipt.gasUsed * receipt.effectiveGasPrice;
    const totalFee = l2Fee + receipt.l1Fee + operatorFee;
    const coreWithoutHash: Omit<BaseCoreEvidence, "evidence_hash"> = {
      schema_version: "cashloom.base-evidence/1",
      transaction: {
        hash: local.hash,
        from: local.from,
        to: local.to,
        nonce: local.nonce.toString(),
        value_wei: local.value.toString(),
        calldata: local.calldata,
        gas_limit: local.gas.toString(),
        max_fee_per_gas_wei: local.maxFeePerGas.toString(),
        max_priority_fee_per_gas_wei: local.maxPriorityFeePerGas.toString(),
        access_list: local.accessList.map((entry) => ({
          address: entry.address,
          storage_keys: entry.storageKeys,
        })),
      },
      inclusion: {
        block_hash: transaction.blockHash,
        block_number: transaction.blockNumber.toString(),
        block_timestamp: byHash.timestamp.toString(),
        transaction_index: transaction.transactionIndex.toString(),
      },
      outcome: receipt.status,
      economic_effect: {
        asset: local.asset,
        beneficiary: local.beneficiary,
        amount_atomic: effect.amount.toString(),
        ...(effect.logIndex === undefined ? {} : { transfer_log_index: effect.logIndex.toString() }),
      },
      fees: {
        gas_used: receipt.gasUsed.toString(),
        effective_gas_price_wei: receipt.effectiveGasPrice.toString(),
        l2_execution_fee_wei: l2Fee.toString(),
        l1_data_fee_wei: receipt.l1Fee.toString(),
        operator_fee_wei: operatorFee.toString(),
        total_fee_wei: totalFee.toString(),
      },
    };
    const evidence: BaseCoreEvidence = {
      ...coreWithoutHash,
      evidence_hash: hashCore(coreWithoutHash),
    };
    return {
      provider_id: provider.id,
      state: "included",
      evidence,
      finality: { latest, safe, finalized },
    };
  } catch (error) {
    if (error instanceof ExplicitAbort) throw error;
    const code = error instanceof EvidenceFault ? error.code : "malformed_rpc";
    return { provider_id: provider.id, state: "unavailable", error_code: code };
  }
};

/** A pending transaction has null inclusion fields. We only validate its
 * immutable wire-derived fields; synthetic inclusion values are deliberately
 * impossible to settle because the observation returns before using them. */
const valueWithPendingDefaults = (value: unknown): unknown => {
  if (!isPlainObject(value)) return value;
  if (value.blockHash !== null || value.blockNumber !== null || value.transactionIndex !== null) {
    return value;
  }
  return {
    ...value,
    blockHash: `0x${"0".repeat(64)}`,
    blockNumber: "0x0",
    transactionIndex: "0x0",
  };
};

const defaultProviders = (): readonly BaseRpcProviderConfig[] => [
  {
    id: "base-primary",
    url: process.env.CASHLOOM_BASE_RPC_URL?.trim() || DEFAULT_PRIMARY_RPC,
  },
  {
    id: "base-confirmation",
    url: process.env.CASHLOOM_BASE_CONFIRMATION_RPC_URL?.trim() || DEFAULT_CONFIRMATION_RPC,
  },
];

const validateProviders = (
  candidate: readonly BaseRpcProviderConfig[],
): readonly BaseRpcProviderConfig[] => {
  if (!Array.isArray(candidate) || candidate.length < 2 || candidate.length > 8) {
    throw new TypeError("Base observer requires two to eight fixed providers.");
  }
  const ids = new Set<string>();
  const urls = new Set<string>();
  const origins = new Set<string>();
  const result = candidate.map((provider) => {
    if (
      !isPlainObject(provider) ||
      !exactKeys(provider, ["id", "url"]) ||
      typeof provider.id !== "string" ||
      typeof provider.url !== "string" ||
      !/^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/.test(provider.id)
    ) {
      throw new TypeError("Base observer provider configuration is invalid.");
    }
    let parsed: URL;
    try {
      parsed = new URL(provider.url);
    } catch {
      throw new TypeError("Base observer provider configuration is invalid.");
    }
    if (
      parsed.protocol !== "https:" ||
      parsed.username !== "" ||
      parsed.password !== "" ||
      parsed.hash !== ""
    ) {
      throw new TypeError("Base observer provider configuration is invalid.");
    }
    const endpointKey = parsed.href;
    if (ids.has(provider.id) || urls.has(endpointKey) || origins.has(parsed.origin)) {
      throw new TypeError(
        "Base observer providers must have distinct IDs, endpoints, and network origins.",
      );
    }
    ids.add(provider.id);
    urls.add(endpointKey);
    origins.add(parsed.origin);
    return Object.freeze({ id: provider.id, url: parsed.href });
  });
  return Object.freeze(result);
};

export const createBaseEvidenceObserver = (
  dependencies: BaseObserverDependencies = {},
): BaseEvidenceObserver => {
  const providers = validateProviders(dependencies.providers ?? defaultProviders());
  const fetcher = dependencies.fetch ?? globalThis.fetch;
  if (typeof fetcher !== "function") throw new TypeError("Base observer fetch implementation is unavailable.");
  const now = dependencies.now ?? Date.now;
  if (typeof now !== "function") throw new TypeError("Base observer clock is invalid.");
  const deadlineMs = dependencies.deadline_ms ?? DEFAULT_DEADLINE_MS;
  const maxResponseBytes = dependencies.max_response_bytes ?? DEFAULT_MAX_RESPONSE_BYTES;
  if (!Number.isSafeInteger(deadlineMs) || deadlineMs < 100 || deadlineMs > 60_000) {
    throw new TypeError("Base observer deadline is invalid.");
  }
  if (
    !Number.isSafeInteger(maxResponseBytes) ||
    maxResponseBytes < 1_024 ||
    maxResponseBytes > 16 * 1024 * 1024
  ) {
    throw new TypeError("Base observer response limit is invalid.");
  }

  return Object.freeze({
    async observe(
      request: BaseTransactionObservationRequest,
      signal?: AbortSignal,
    ): Promise<BaseTransactionObservation> {
      if (signal?.aborted) throw new ExplicitAbort();
      const local = await parseRequest(request);
      const startedAt = now();
      if (!Number.isFinite(startedAt)) throw new TypeError("Base observer clock is invalid.");
      const deadlineAt = startedAt + deadlineMs;
      const observations = await Promise.all(
        providers.map((provider) => evidenceFromProvider(
          provider,
          fetcher,
          now,
          deadlineAt,
          maxResponseBytes,
          local,
          signal,
        )),
      );
      if (signal?.aborted) throw new ExplicitAbort();

      const grouped = new Map<`sha256:${string}`, {
        evidence: BaseCoreEvidence;
        providerIds: string[];
        finalizedProviderIds: string[];
      }>();
      for (const observation of observations) {
        if (observation.state !== "included") continue;
        const hash = observation.evidence.evidence_hash;
        const group = grouped.get(hash) ?? {
          evidence: observation.evidence,
          providerIds: [],
          finalizedProviderIds: [],
        };
        group.providerIds.push(observation.provider_id);
        if (
          observation.finality.latest.status === "confirmed" &&
          observation.finality.safe.status === "confirmed" &&
          observation.finality.finalized.status === "confirmed"
        ) {
          group.finalizedProviderIds.push(observation.provider_id);
        }
        grouped.set(hash, group);
      }
      const groups: BaseEvidenceGroup[] = [...grouped.values()]
        .map((group) => ({
          evidence_hash: group.evidence.evidence_hash,
          provider_ids: [...group.providerIds].sort(),
          finalized_provider_ids: [...group.finalizedProviderIds].sort(),
        }))
        .sort((a, b) => a.evidence_hash.localeCompare(b.evidence_hash));
      const settlementCandidates = [...grouped.values()].filter(
        (group) => new Set(group.finalizedProviderIds).size >= 2,
      );
      // A competing included body is split-brain evidence, even if another
      // body independently reached the numeric threshold.
      const settledGroup = settlementCandidates.length === 1 && grouped.size === 1
        ? settlementCandidates[0]
        : undefined;
      const allPending = observations.every((observation) => observation.state === "pending");
      const observedAt = new Date(startedAt).toISOString();
      const finishedAt = now();
      if (!Number.isFinite(finishedAt)) throw new TypeError("Base observer clock is invalid.");
      const fetchedAt = new Date(finishedAt).toISOString();
      const sightings: BaseProviderSighting[] = [];
      for (const observation of observations) {
        if (observation.state === "unavailable") continue;
        if (observation.state === "pending") {
          const visibility = observation.reason === "transaction_not_visible"
            ? "NOT_FOUND" as const
            : "MEMPOOL" as const;
          const body: JsonValue = {
            schema_version: "cashloom.base-sighting/1",
            transaction_hash: local.hash,
            visibility,
            authorized_payment: {
              asset: local.asset,
              from: local.from,
              beneficiary: local.beneficiary,
              amount_atomic: local.amount.toString(),
            },
          };
          sightings.push({
            provider_id: observation.provider_id,
            visibility,
            outcome: "UNKNOWN" as const,
            security_level: "UNSAFE" as const,
            block_number: null,
            block_hash: null,
            evidence_hash: hashJson(body),
            body,
            observed_at: observedAt,
            fetched_at: fetchedAt,
          });
          continue;
        }
        const securityLevel = observation.finality.finalized.status === "confirmed"
          ? "FINALIZED" as const
          : observation.finality.safe.status === "confirmed"
            ? "SAFE" as const
            : "UNSAFE" as const;
        sightings.push({
          provider_id: observation.provider_id,
          visibility: "INCLUDED" as const,
          outcome: observation.evidence.outcome === "success"
            ? "SUCCESS" as const
            : "REVERTED" as const,
          security_level: securityLevel,
          block_number: observation.evidence.inclusion.block_number,
          block_hash: observation.evidence.inclusion.block_hash,
          evidence_hash: observation.evidence.evidence_hash,
          body: {
            schema_version: "cashloom.base-included-sighting/2",
            evidence: observation.evidence,
            security_level: securityLevel,
          } as unknown as JsonValue,
          observed_at: observedAt,
          fetched_at: fetchedAt,
        });
      }
      const consensus: BaseFinalizedConsensus | undefined = settledGroup
        ? {
            provider_ids: [...new Set(settledGroup.finalizedProviderIds)].sort(),
            quorum: "2",
            evidence_hash: settledGroup.evidence.evidence_hash,
            outcome: settledGroup.evidence.outcome === "success" ? "SUCCESS" : "REVERTED",
            security_level: "FINALIZED",
            block_number: settledGroup.evidence.inclusion.block_number,
            block_hash: settledGroup.evidence.inclusion.block_hash,
            body: settledGroup.evidence,
            observed_at: observedAt,
          }
        : undefined;
      return {
        schema_version: "cashloom.base-observation/1",
        state: settledGroup ? "settled" : allPending ? "pending" : "partial",
        transaction_hash: local.hash,
        observed_at: observedAt,
        quorum: {
          required_distinct_providers: "2",
          groups,
        },
        providers: observations,
        sightings,
        ...(settledGroup ? { evidence: settledGroup.evidence } : {}),
        ...(consensus ? { consensus } : {}),
      };
    },
  });
};
