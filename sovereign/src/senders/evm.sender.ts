/** EVM sender — Base mainnet. Native ETH and Circle-issued USDC.
 *
 * The quote persists the complete EIP-1559 wire request. Confirmation hashes
 * that same request, obtains one bound vault signature, records the signed
 * hash through onSigned, and only then broadcasts raw bytes. No private key or
 * RPC error (which can contain an API-bearing URL) crosses this boundary.
 */

import {
  createPublicClient,
  encodeFunctionData,
  erc20Abi,
  http,
  isAddress,
  isHex,
  keccak256,
  parseTransaction,
  recoverTransactionAddress,
  serializeTransaction,
  type Hex,
  type TransactionSerialized,
} from "viem";
import { base } from "viem/chains";
import {
  hashPreparedEvmTransaction,
  signEvmTransaction,
  type PreparedEvmTransaction,
  type SignedEvmTransaction,
  type SigningBinding,
} from "../vault.ts";
import type {
  PaymentInstruction,
  PaymentQuote,
  PaymentReceipt,
  PaymentSender,
  SenderContext,
  SignedTransactionEnvelope,
  PaymentFeeTerms,
} from "./types.ts";
import { AmbiguousBroadcastError } from "./types.ts";

// Native USDC on Base (Circle-issued), 6 decimals.
export const BASE_USDC_ADDRESS = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" as const;
const USDC_DECIMALS = 6;
const EIP1559 = "eip1559" as const;
export const BASE_GAS_PRICE_ORACLE =
  "0x420000000000000000000000000000000000000F" as const;
const BASE_FEE_ESTIMATE_METHOD = "base-gas-price-oracle-predeploy/1" as const;
const L1_FEE_METHOD = "getL1FeeUpperBound(uint256)" as const;
const OPERATOR_FEE_METHOD = "getOperatorFee(uint256)" as const;

const GAS_PRICE_ORACLE_ABI = [
  {
    type: "function",
    name: "getL1FeeUpperBound",
    stateMutability: "view",
    inputs: [{ name: "_unsignedTxSize", type: "uint256" }],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "getOperatorFee",
    stateMutability: "view",
    inputs: [{ name: "_gasUsed", type: "uint256" }],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const;

// A private RPC URL commonly embeds an API key. Use it, but never include it
// (or a provider exception that may repeat it) in an outward-facing error.
const rpcUrl = (): string =>
  process.env.CASHLOOM_BASE_RPC_URL?.trim() || "https://mainnet.base.org";

interface EstimateRequest {
  account: `0x${string}`;
  to: `0x${string}`;
  value: bigint;
  data?: `0x${string}`;
}

export interface EvmRpcClient {
  estimateGas(request: EstimateRequest): Promise<bigint>;
  estimateFeesPerGas(): Promise<{
    maxFeePerGas: bigint;
    maxPriorityFeePerGas: bigint;
  }>;
  getTransactionCount(request: {
    address: `0x${string}`;
    blockTag: "pending";
  }): Promise<number>;
  /** Estimate the non-execution Base protocol terms at one fixed latest
   * block. Production reads both methods from the official GasPriceOracle
   * predeploy; injected adapters must preserve the same fixed-state contract. */
  estimateBaseProtocolFees(request: {
    unsignedTransactionSizeBytes: bigint;
    gasLimit: bigint;
  }): Promise<{
    l1FeeUpperBound: bigint;
    operatorFeeUpperBound: bigint;
    sourceBlockNumber: bigint;
  }>;
  sendRawTransaction(request: { serializedTransaction: Hex }): Promise<`0x${string}`>;
}

export interface EvmSenderDependencies {
  createRpcClient: () => EvmRpcClient;
  resolveSenderAddress: (ctx: SenderContext) => Promise<`0x${string}`>;
  signTransaction: (
    keyId: string,
    request: PreparedEvmTransaction,
    binding: SigningBinding,
  ) => Promise<SignedEvmTransaction>;
}

const createDefaultRpcClient = (): EvmRpcClient => {
  const client = createPublicClient({ chain: base, transport: http(rpcUrl()) });
  return {
    estimateGas: (request) => client.estimateGas(request),
    estimateFeesPerGas: async () => {
      const fees = await client.estimateFeesPerGas();
      return {
        maxFeePerGas: fees.maxFeePerGas,
        maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
      };
    },
    getTransactionCount: (request) => client.getTransactionCount(request),
    estimateBaseProtocolFees: async ({ unsignedTransactionSizeBytes, gasLimit }) => {
      // Resolve `latest` once, then pin both contract reads to that exact Base
      // block so the component estimate cannot mix two protocol states.
      const sourceBlockNumber = await client.getBlockNumber();
      const [l1FeeUpperBound, operatorFeeUpperBound] = await Promise.all([
        client.readContract({
          address: BASE_GAS_PRICE_ORACLE,
          abi: GAS_PRICE_ORACLE_ABI,
          functionName: "getL1FeeUpperBound",
          args: [unsignedTransactionSizeBytes],
          blockNumber: sourceBlockNumber,
        }),
        client.readContract({
          address: BASE_GAS_PRICE_ORACLE,
          abi: GAS_PRICE_ORACLE_ABI,
          functionName: "getOperatorFee",
          args: [gasLimit],
          blockNumber: sourceBlockNumber,
        }),
      ]);
      return { l1FeeUpperBound, operatorFeeUpperBound, sourceBlockNumber };
    },
    sendRawTransaction: (request) => client.sendRawTransaction(request),
  };
};

const AMOUNT_PATTERN = /^[1-9][0-9]*$/;
const HASH_PATTERN = /^sha256:[0-9a-f]{64}$/;
const TX_HASH_PATTERN = /^0x[0-9a-fA-F]{64}$/;
const MAX_UINT256 = (1n << 256n) - 1n;
const ZERO_ADDRESS = `0x${"0".repeat(40)}`;
// This sender only creates ETH transfers and ERC-20 transfer calls (< 1 KiB).
// Leave ample headroom while refusing an unbounded recovery payload.
const MAX_SIGNED_TRANSACTION_BYTES = 128 * 1024;

const formatAtomic = (amount: bigint, decimals: number): string => {
  const scale = 10n ** BigInt(decimals);
  const whole = amount / scale;
  const fraction = (amount % scale).toString().padStart(decimals, "0").replace(/0+$/, "");
  return fraction === "" ? whole.toString() : `${whole}.${fraction}`;
};

const parseInstruction = (instruction: PaymentInstruction) => {
  if (!isAddress(instruction.to)) {
    throw new Error("Destination is not a valid EVM address.");
  }
  if (instruction.to.toLowerCase() === ZERO_ADDRESS) {
    throw new Error("The EVM zero address is not a payable destination.");
  }
  if (!AMOUNT_PATTERN.test(instruction.amountMinor)) {
    throw new Error(
      "amountMinor must be a positive integer minor-unit string (no decimals, no zero).",
    );
  }
  const amount = BigInt(instruction.amountMinor);
  if (amount > MAX_UINT256) {
    throw new Error("amountMinor exceeds the EVM uint256 atomic-unit limit.");
  }
  const asset = instruction.asset.trim().toUpperCase();
  if (asset !== "ETH" && asset !== "USDC") {
    throw new Error("EVM sender moves ETH and USDC only.");
  }
  return {
    to: instruction.to as `0x${string}`,
    amount,
    asset: asset as "ETH" | "USDC",
  };
};

/** The value-bearing request shared by quote and send. For USDC, the actual
 * transaction recipient is the fixed Circle contract while `recipient`
 * remains the payment beneficiary encoded into calldata. */
const buildRequest = (to: `0x${string}`, amount: bigint, asset: "ETH" | "USDC") =>
  asset === "ETH"
    ? { to, value: amount, data: undefined as `0x${string}` | undefined }
    : {
        to: BASE_USDC_ADDRESS as `0x${string}`,
        value: 0n,
        data: encodeFunctionData({
          abi: erc20Abi,
          functionName: "transfer",
          args: [to, amount],
        }),
      };

interface EvmQuoteTransactionFields {
  /** Forces type-2 fee semantics; legacy and access-list quotes are refused. */
  transactionType: typeof EIP1559;
  /** Base mainnet (EIP-155 chain id 8453). */
  chainId: number;
  /** Vault-derived signer address. */
  from: `0x${string}`;
  /** Human-approved beneficiary (distinct from `to` for USDC). */
  recipient: `0x${string}`;
  asset: "ETH" | "USDC";
  /** Positive canonical atomic units: wei for ETH, 6-decimal units for USDC. */
  amountAtomic: string;
  /** Actual EVM call target: beneficiary for ETH, Circle contract for USDC. */
  to: `0x${string}`;
  /** Native wei attached to the call (zero for USDC). */
  value: string;
  /** Exact calldata, or null when the quoted native transfer has none. */
  data: `0x${string}` | null;
  /** Exact gas limit and EIP-1559 price caps, all unsigned decimal strings. */
  gas: string;
  maxFeePerGas: string;
  maxPriorityFeePerGas: string;
  /** Pending-account nonce; a safe integer because the EVM field is not money. */
  nonce: number;
  /** SHA-256 domain-separated digest of PreparedEvmTransaction. */
  requestHash: `sha256:${string}`;
}

/** Fee fields captured at quote time and bound by CashLoom's outer quote
 * hash. The execution cap is transaction-intrinsic. Oracle values are
 * estimates at `sourceBlockNumber`; even their sum is not a hard maximum. */
export interface EvmQuoteFeeEstimate {
  method: typeof BASE_FEE_ESTIMATE_METHOD;
  oracleAddress: typeof BASE_GAS_PRICE_ORACLE;
  l1FeeMethod: typeof L1_FEE_METHOD;
  operatorFeeMethod: typeof OPERATOR_FEE_METHOD;
  sourceBlockNumber: string;
  unsignedTransactionSizeBytes: string;
  hardExecutionCapAtomic: string;
  estimatedL1UpperBoundAtomic: string;
  estimatedOperatorUpperBoundAtomic: string;
  estimatedTotalAtomic: string;
  totalIsHardCap: false;
}

/** Legacy persisted Base quote. It remains readable so already-approved
 * transactions can be recovered, but no new v1 quote is produced. */
export interface EvmQuoteDetailV1 extends EvmQuoteTransactionFields {
  v: 1;
}

/** Exact JSON persisted for every newly-created Base EIP-1559 quote. */
export interface EvmQuoteDetailV2 extends EvmQuoteTransactionFields {
  v: 2;
  feeEstimate: EvmQuoteFeeEstimate;
}

export type EvmQuoteDetail = EvmQuoteDetailV1 | EvmQuoteDetailV2;

type EvmQuoteEnvelopeV2 = Omit<EvmQuoteDetailV2, "requestHash">;

const DETAIL_KEYS_V1 = new Set([
  "v",
  "transactionType",
  "chainId",
  "from",
  "recipient",
  "asset",
  "amountAtomic",
  "to",
  "value",
  "data",
  "gas",
  "maxFeePerGas",
  "maxPriorityFeePerGas",
  "nonce",
  "requestHash",
]);

const DETAIL_KEYS_V2 = new Set([...DETAIL_KEYS_V1, "feeEstimate"]);

const FEE_ESTIMATE_KEYS = new Set<keyof EvmQuoteFeeEstimate>([
  "method",
  "oracleAddress",
  "l1FeeMethod",
  "operatorFeeMethod",
  "sourceBlockNumber",
  "unsignedTransactionSizeBytes",
  "hardExecutionCapAtomic",
  "estimatedL1UpperBoundAtomic",
  "estimatedOperatorUpperBoundAtomic",
  "estimatedTotalAtomic",
  "totalIsHardCap",
]);

const unsignedBigInt = (value: unknown, label: string, allowZero = false): bigint => {
  if (typeof value !== "string" || !/^(0|[1-9][0-9]*)$/.test(value)) {
    throw new Error(`Stored EVM quote has an invalid ${label}.`);
  }
  const parsed = BigInt(value);
  if (!allowZero && parsed === 0n) {
    throw new Error(`Stored EVM quote has a non-positive ${label}.`);
  }
  return parsed;
};

const preparedTransaction = (
  detail: EvmQuoteTransactionFields | Omit<EvmQuoteTransactionFields, "requestHash">,
): PreparedEvmTransaction => ({
  kind: "cashloom.evm-transaction/1",
  chainId: detail.chainId,
  from: detail.from,
  to: detail.to,
  valueAtomic: detail.value,
  data: detail.data ?? "0x",
  gasLimit: detail.gas,
  maxFeePerGas: detail.maxFeePerGas,
  maxPriorityFeePerGas: detail.maxPriorityFeePerGas,
  nonce: detail.nonce,
});

/** Viem's canonical unsigned type-2 serialization is the exact input size
 * expected by GasPriceOracle.getL1FeeUpperBound. The predeploy itself adds
 * the signature allowance; callers must not guess or add those bytes. */
const unsignedTransactionSizeBytes = (
  detail: EvmQuoteTransactionFields | Omit<EvmQuoteTransactionFields, "requestHash">,
): bigint => {
  const serialized = serializeTransaction({
    type: EIP1559,
    chainId: detail.chainId,
    nonce: detail.nonce,
    gas: BigInt(detail.gas),
    maxFeePerGas: BigInt(detail.maxFeePerGas),
    maxPriorityFeePerGas: BigInt(detail.maxPriorityFeePerGas),
    to: detail.to,
    value: BigInt(detail.value),
    data: detail.data ?? "0x",
    accessList: [],
  });
  return BigInt((serialized.length - 2) / 2);
};

const parseFeeEstimate = (
  value: unknown,
  detail: EvmQuoteTransactionFields,
): EvmQuoteFeeEstimate => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Stored EVM quote has an invalid Base fee estimate.");
  }
  const keys = Object.keys(value);
  if (
    keys.length !== FEE_ESTIMATE_KEYS.size ||
    keys.some((key) => !FEE_ESTIMATE_KEYS.has(key as keyof EvmQuoteFeeEstimate))
  ) {
    throw new Error("Stored EVM quote has an invalid Base fee estimate.");
  }
  const fee = value as Partial<EvmQuoteFeeEstimate>;
  if (
    fee.method !== BASE_FEE_ESTIMATE_METHOD ||
    fee.oracleAddress !== BASE_GAS_PRICE_ORACLE ||
    fee.l1FeeMethod !== L1_FEE_METHOD ||
    fee.operatorFeeMethod !== OPERATOR_FEE_METHOD ||
    fee.totalIsHardCap !== false
  ) {
    throw new Error("Stored EVM quote has an invalid Base fee estimate.");
  }

  const sourceBlockNumber = unsignedBigInt(
    fee.sourceBlockNumber,
    "Base fee source block",
    true,
  );
  const unsignedSize = unsignedBigInt(
    fee.unsignedTransactionSizeBytes,
    "unsigned transaction size",
  );
  const executionCap = unsignedBigInt(fee.hardExecutionCapAtomic, "execution fee cap");
  const l1UpperBound = unsignedBigInt(
    fee.estimatedL1UpperBoundAtomic,
    "L1 fee upper bound",
    true,
  );
  const operatorUpperBound = unsignedBigInt(
    fee.estimatedOperatorUpperBoundAtomic,
    "operator fee upper bound",
    true,
  );
  const estimatedTotal = unsignedBigInt(fee.estimatedTotalAtomic, "estimated total fee");
  if (
    sourceBlockNumber > MAX_UINT256 ||
    unsignedSize > MAX_UINT256 ||
    l1UpperBound > MAX_UINT256 ||
    operatorUpperBound > MAX_UINT256 ||
    executionCap !== BigInt(detail.gas) * BigInt(detail.maxFeePerGas) ||
    estimatedTotal !== executionCap + l1UpperBound + operatorUpperBound ||
    unsignedSize !== unsignedTransactionSizeBytes(detail)
  ) {
    throw new Error("Stored EVM quote has inconsistent Base fee components.");
  }
  return fee as EvmQuoteFeeEstimate;
};

const parseQuoteDetail = (
  raw: string | null | undefined,
  expected: ReturnType<typeof parseInstruction>,
): EvmQuoteDetail => {
  if (!raw) {
    throw new Error("This EVM quote has no stored transaction envelope — request a fresh quote.");
  }
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error("Stored EVM quote is not valid JSON — refusing to sign.");
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Stored EVM quote has an invalid transaction shape — refusing to sign.");
  }
  const record = value as Record<string, unknown>;
  const expectedKeys = record.v === 1
    ? DETAIL_KEYS_V1
    : record.v === 2
      ? DETAIL_KEYS_V2
      : null;
  const keys = Object.keys(record);
  if (
    !expectedKeys ||
    keys.length !== expectedKeys.size ||
    keys.some((key) => !expectedKeys.has(key))
  ) {
    throw new Error("Stored EVM quote has an invalid transaction shape — refusing to sign.");
  }
  const d = record as unknown as EvmQuoteDetail;
  if (
    (d.v !== 1 && d.v !== 2) ||
    d.transactionType !== EIP1559 ||
    d.chainId !== base.id ||
    typeof d.from !== "string" ||
    !isAddress(d.from) ||
    typeof d.recipient !== "string" ||
    !isAddress(d.recipient) ||
    typeof d.to !== "string" ||
    !isAddress(d.to) ||
    (d.asset !== "ETH" && d.asset !== "USDC") ||
    (d.data !== null && (typeof d.data !== "string" || !isHex(d.data))) ||
    typeof d.nonce !== "number" ||
    !Number.isSafeInteger(d.nonce) ||
    d.nonce < 0 ||
    typeof d.requestHash !== "string" ||
    !HASH_PATTERN.test(d.requestHash)
  ) {
    throw new Error("Stored EVM quote has an invalid transaction shape — refusing to sign.");
  }

  const amountAtomic = unsignedBigInt(d.amountAtomic, "amount");
  const storedValue = unsignedBigInt(d.value, "value", true);
  const gas = unsignedBigInt(d.gas, "gas");
  const maxFeePerGas = unsignedBigInt(d.maxFeePerGas, "max fee per gas");
  const maxPriorityFeePerGas = unsignedBigInt(
    d.maxPriorityFeePerGas,
    "priority fee per gas",
    true,
  );
  if (maxPriorityFeePerGas > maxFeePerGas) {
    throw new Error("Stored EVM quote has a priority fee above its max fee.");
  }
  if ([amountAtomic, storedValue, gas, maxFeePerGas, maxPriorityFeePerGas].some((n) => n > MAX_UINT256)) {
    throw new Error("Stored EVM quote contains a value above the uint256 limit.");
  }

  const rebuilt = buildRequest(expected.to, expected.amount, expected.asset);
  if (
    d.asset !== expected.asset ||
    d.recipient.toLowerCase() !== expected.to.toLowerCase() ||
    amountAtomic !== expected.amount ||
    d.to.toLowerCase() !== rebuilt.to.toLowerCase() ||
    storedValue !== rebuilt.value ||
    (d.data ?? undefined) !== rebuilt.data
  ) {
    throw new Error("Stored EVM transaction no longer matches the quoted payment — refusing to sign.");
  }

  const detail = d as EvmQuoteDetail;
  if (detail.v === 2) {
    // Recreate a common detail type only after every transaction field above
    // has been validated. This also binds each component to the exact
    // serialized quote shape and rejects internally inconsistent mutation.
    parseFeeEstimate(detail.feeEstimate, detail);
  }
  const requestHash = hashPreparedEvmTransaction(preparedTransaction(detail));
  if (requestHash !== detail.requestHash) {
    throw new Error("Stored EVM transaction hash no longer matches its quoted envelope.");
  }
  return detail;
};

/** Strictly parse an opaque quote detail and reconstruct the exact request
 * agents and the vault must bind. No account lookup or network call occurs. */
export const parsePreparedEvmQuote = (
  instruction: PaymentInstruction,
): Readonly<{
  detail: EvmQuoteDetail;
  request: PreparedEvmTransaction;
  requestHash: `sha256:${string}`;
}> => {
  const detail = parseQuoteDetail(instruction.detail, parseInstruction(instruction));
  return {
    detail,
    request: preparedTransaction(detail),
    requestHash: detail.requestHash,
  };
};

const validateSenderAddress = (address: string): `0x${string}` => {
  if (!isAddress(address)) {
    throw new Error("The selected vault account has no valid EVM signing address.");
  }
  return address as `0x${string}`;
};

const defaultResolveSenderAddress = async (ctx: SenderContext): Promise<`0x${string}`> => {
  // Address is public derivable data; only the vault row is read here.
  const { db } = await import("../db.ts");
  const row = db
    .query("SELECT address FROM vault_keys WHERE id = ? AND kind = 'evm'")
    .get(ctx.vaultKeyId) as { address: string | null } | null;
  if (!row?.address) {
    throw new Error("The selected account has no matching EVM vault key.");
  }
  return validateSenderAddress(row.address);
};

const createDependencies = (
  overrides: Partial<EvmSenderDependencies>,
): EvmSenderDependencies => ({
  createRpcClient: overrides.createRpcClient ?? createDefaultRpcClient,
  resolveSenderAddress: overrides.resolveSenderAddress ?? defaultResolveSenderAddress,
  signTransaction: overrides.signTransaction ?? signEvmTransaction,
});

const canonicalPayload = (payload: unknown, requireCanonicalCase = false): Hex => {
  if (
    typeof payload !== "string" ||
    !isHex(payload) ||
    payload === "0x" ||
    (payload.length - 2) % 2 !== 0 ||
    (payload.length - 2) / 2 > MAX_SIGNED_TRANSACTION_BYTES ||
    (requireCanonicalCase && payload !== payload.toLowerCase())
  ) {
    throw new Error("Signed EVM envelope is malformed or exceeds the recovery limit.");
  }
  return payload.toLowerCase() as Hex;
};

const validateSignedTransaction = async (
  signed: SignedEvmTransaction,
  request: PreparedEvmTransaction,
): Promise<{ payload: Hex; hash: `0x${string}` }> => {
  const payload = canonicalPayload(signed.serialized);
  const hash = keccak256(payload);
  if (
    !TX_HASH_PATTERN.test(signed.hash) ||
    hash.toLowerCase() !== signed.hash.toLowerCase() ||
    !isAddress(signed.from)
  ) {
    throw new Error("Vault signer returned an envelope that does not match the authorized request.");
  }

  try {
    const transaction = parseTransaction(payload as TransactionSerialized);
    const recovered = await recoverTransactionAddress({
      serializedTransaction: payload as TransactionSerialized,
    });
    if (
      transaction.type !== EIP1559 ||
      transaction.chainId !== request.chainId ||
      transaction.to?.toLowerCase() !== request.to.toLowerCase() ||
      (transaction.value ?? 0n) !== BigInt(request.valueAtomic) ||
      (transaction.data ?? "0x") !== request.data ||
      transaction.gas !== BigInt(request.gasLimit) ||
      transaction.maxFeePerGas !== BigInt(request.maxFeePerGas) ||
      transaction.maxPriorityFeePerGas !== BigInt(request.maxPriorityFeePerGas) ||
      transaction.nonce !== request.nonce ||
      (transaction.accessList?.length ?? 0) !== 0 ||
      recovered.toLowerCase() !== request.from.toLowerCase() ||
      signed.from.toLowerCase() !== recovered.toLowerCase()
    ) {
      throw new Error("mismatch");
    }
  } catch {
    throw new Error("Vault signer returned an envelope that does not match the authorized request.");
  }
  return { payload, hash };
};

const validateRecoveryEnvelope = async (
  envelope: SignedTransactionEnvelope,
  expectedExternalId: string,
  request: PreparedEvmTransaction,
): Promise<{ payload: Hex; hash: `0x${string}` }> => {
  if (envelope.encoding !== "hex" || !TX_HASH_PATTERN.test(expectedExternalId)) {
    throw new Error("Signed EVM recovery evidence is malformed.");
  }
  const payload = canonicalPayload(envelope.payload, true);
  const hash = keccak256(payload);
  if (hash.toLowerCase() !== expectedExternalId.toLowerCase()) {
    throw new Error("Signed EVM recovery payload does not match its expected transaction hash.");
  }
  try {
    const transaction = parseTransaction(payload as TransactionSerialized);
    const recovered = await recoverTransactionAddress({
      serializedTransaction: payload as TransactionSerialized,
    });
    if (
      transaction.type !== EIP1559 ||
      transaction.chainId !== request.chainId ||
      transaction.to?.toLowerCase() !== request.to.toLowerCase() ||
      (transaction.value ?? 0n) !== BigInt(request.valueAtomic) ||
      (transaction.data ?? "0x") !== request.data ||
      transaction.gas !== BigInt(request.gasLimit) ||
      transaction.maxFeePerGas !== BigInt(request.maxFeePerGas) ||
      transaction.maxPriorityFeePerGas !== BigInt(request.maxPriorityFeePerGas) ||
      transaction.nonce !== request.nonce ||
      (transaction.accessList?.length ?? 0) !== 0 ||
      recovered.toLowerCase() !== request.from.toLowerCase()
    ) {
      throw new Error("recovery transaction differs from prepared request");
    }
  } catch {
    throw new Error("Signed EVM recovery payload does not match the prepared Base EIP-1559 request.");
  }
  return { payload, hash };
};

/** Build a sender around narrow effects. Production uses the defaults below;
 * tests and alternate node runtimes can inject a networkless RPC adapter
 * without gaining access to vault plaintext. */
export const createEvmSender = (
  overrides: Partial<EvmSenderDependencies> = {},
): PaymentSender => {
  const dependencies = createDependencies(overrides);

  const broadcast = async (
    payload: Hex,
    hash: `0x${string}`,
  ): Promise<PaymentReceipt> => {
    try {
      const returned = await dependencies
        .createRpcClient()
        .sendRawTransaction({ serializedTransaction: payload });
      if (!TX_HASH_PATTERN.test(returned) || returned.toLowerCase() !== hash.toLowerCase()) {
        throw new Error("unexpected transaction hash");
      }
    } catch {
      throw new AmbiguousBroadcastError(
        `Broadcast outcome unknown. Check transaction ${hash} on Base before quoting again — it may have been accepted.`,
        hash,
      );
    }
    return { externalId: hash, status: "broadcast" };
  };

  const senderAddress = async (ctx: SenderContext): Promise<`0x${string}`> =>
    validateSenderAddress(await dependencies.resolveSenderAddress(ctx));

  const detailFor = async (
    ctx: SenderContext,
    instruction: PaymentInstruction,
  ): Promise<EvmQuoteDetail> => {
    const { detail } = parsePreparedEvmQuote(instruction);
    const from = await senderAddress(ctx);
    if (from.toLowerCase() !== detail.from.toLowerCase()) {
      throw new Error("The quote was prepared for a different EVM signer — request a fresh quote.");
    }
    if (detail.recipient.toLowerCase() === from.toLowerCase()) {
      throw new Error("Refusing an EVM payment back to its own sending account.");
    }
    return detail;
  };

  return {
    type: "evm-base",
    assets: ["ETH", "USDC"],

    async quote(ctx: SenderContext, instruction: PaymentInstruction): Promise<PaymentQuote> {
      const { to, amount, asset } = parseInstruction(instruction);
      const from = await senderAddress(ctx);
      if (to.toLowerCase() === from.toLowerCase()) {
        throw new Error("Refusing an EVM payment back to its own sending account.");
      }
      const request = buildRequest(to, amount, asset);

      let gas: bigint;
      let maxFeePerGas: bigint;
      let maxPriorityFeePerGas: bigint;
      let nonce: number;
      let client: EvmRpcClient;
      try {
        client = dependencies.createRpcClient();
        [gas, { maxFeePerGas, maxPriorityFeePerGas }, nonce] = await Promise.all([
          client.estimateGas({ account: from, ...request }),
          client.estimateFeesPerGas(),
          client.getTransactionCount({ address: from, blockTag: "pending" }),
        ]);
      } catch {
        throw new Error(
          "Base RPC could not prepare this quote. No transaction was signed; retry with a healthy RPC endpoint.",
        );
      }

      if (
        typeof gas !== "bigint" ||
        typeof maxFeePerGas !== "bigint" ||
        typeof maxPriorityFeePerGas !== "bigint" ||
        typeof nonce !== "number" ||
        gas <= 0n ||
        maxFeePerGas <= 0n ||
        maxPriorityFeePerGas < 0n ||
        maxPriorityFeePerGas > maxFeePerGas ||
        gas > MAX_UINT256 ||
        maxFeePerGas > MAX_UINT256 ||
        maxPriorityFeePerGas > MAX_UINT256 ||
        !Number.isSafeInteger(nonce) ||
        nonce < 0
      ) {
        throw new Error("Base RPC returned an invalid EIP-1559 estimate; refusing to create a quote.");
      }

      const transactionFields: Omit<EvmQuoteTransactionFields, "requestHash"> = {
        transactionType: EIP1559,
        chainId: base.id,
        from,
        recipient: to,
        asset,
        amountAtomic: amount.toString(),
        to: request.to,
        value: request.value.toString(),
        data: request.data ?? null,
        gas: gas.toString(),
        maxFeePerGas: maxFeePerGas.toString(),
        maxPriorityFeePerGas: maxPriorityFeePerGas.toString(),
        nonce,
      };
      let unsignedSize: bigint;
      try {
        unsignedSize = unsignedTransactionSizeBytes(transactionFields);
      } catch {
        throw new Error("Base RPC returned an invalid EIP-1559 estimate; refusing to create a quote.");
      }

      let l1FeeUpperBound: bigint;
      let operatorFeeUpperBound: bigint;
      let sourceBlockNumber: bigint;
      try {
        ({ l1FeeUpperBound, operatorFeeUpperBound, sourceBlockNumber } =
          await client.estimateBaseProtocolFees({
            unsignedTransactionSizeBytes: unsignedSize,
            gasLimit: gas,
          }));
      } catch {
        throw new Error(
          "Base RPC could not prepare this quote. No transaction was signed; retry with a healthy RPC endpoint.",
        );
      }
      if (
        typeof l1FeeUpperBound !== "bigint" ||
        typeof operatorFeeUpperBound !== "bigint" ||
        typeof sourceBlockNumber !== "bigint" ||
        l1FeeUpperBound < 0n ||
        operatorFeeUpperBound < 0n ||
        sourceBlockNumber < 0n ||
        l1FeeUpperBound > MAX_UINT256 ||
        operatorFeeUpperBound > MAX_UINT256 ||
        sourceBlockNumber > MAX_UINT256
      ) {
        throw new Error("Base RPC returned invalid protocol fee components; refusing to create a quote.");
      }

      const executionCap = gas * maxFeePerGas;
      const estimatedTotal = executionCap + l1FeeUpperBound + operatorFeeUpperBound;
      const sourceBlock = sourceBlockNumber.toString();
      const feeEstimate: EvmQuoteFeeEstimate = {
        method: BASE_FEE_ESTIMATE_METHOD,
        oracleAddress: BASE_GAS_PRICE_ORACLE,
        l1FeeMethod: L1_FEE_METHOD,
        operatorFeeMethod: OPERATOR_FEE_METHOD,
        sourceBlockNumber: sourceBlock,
        unsignedTransactionSizeBytes: unsignedSize.toString(),
        hardExecutionCapAtomic: executionCap.toString(),
        estimatedL1UpperBoundAtomic: l1FeeUpperBound.toString(),
        estimatedOperatorUpperBoundAtomic: operatorFeeUpperBound.toString(),
        estimatedTotalAtomic: estimatedTotal.toString(),
        totalIsHardCap: false,
      };
      const envelope: EvmQuoteEnvelopeV2 = {
        v: 2,
        ...transactionFields,
        feeEstimate,
      };
      const requestHash = hashPreparedEvmTransaction(preparedTransaction(envelope));
      const detail: EvmQuoteDetailV2 = { ...envelope, requestHash };

      const feeTerms: PaymentFeeTerms = {
        schema_version: "cashloom.payment-fee-terms/1",
        hard_execution_cap_atomic: executionCap.toString(),
        estimated_l1_upper_bound_atomic: l1FeeUpperBound.toString(),
        estimated_operator_upper_bound_atomic: operatorFeeUpperBound.toString(),
        estimated_total_atomic: estimatedTotal.toString(),
        total_is_hard_cap: false,
        components: [
          {
            kind: "l2_execution",
            amount_atomic: executionCap.toString(),
            classification: "hard_cap",
            method: "eip1559.gas_limit_x_max_fee_per_gas",
          },
          {
            kind: "l1_data_security",
            amount_atomic: l1FeeUpperBound.toString(),
            classification: "estimated_upper_bound",
            method: `GasPriceOracle.${L1_FEE_METHOD}`,
            source_block: sourceBlock,
          },
          {
            kind: "operator",
            amount_atomic: operatorFeeUpperBound.toString(),
            classification: "estimated_upper_bound",
            method: `GasPriceOracle.${OPERATOR_FEE_METHOD}`,
            source_block: sourceBlock,
          },
        ],
      };
      const amountHuman = `${formatAtomic(amount, asset === "USDC" ? USDC_DECIMALS : 18)} ${asset}`;
      return {
        // Compatibility callers receive the conservative estimated sum. It
        // must never be labeled or interpreted as a total hard maximum.
        feeMinor: estimatedTotal.toString(),
        feeAsset: "ETH(wei)",
        summary: `Send ${amountHuman} on Base to ${to} — estimated Base protocol fee ${estimatedTotal} wei (${formatAtomic(estimatedTotal, 18)} ETH): L2 execution hard cap ${executionCap} wei + L1 data/security upper-bound estimate ${l1FeeUpperBound} wei + operator upper-bound estimate ${operatorFeeUpperBound} wei at Base block ${sourceBlock}. The estimated total is not a hard maximum because Base protocol inputs can change before inclusion. No CashLoom fee, ever.`,
        feeTerms,
        detail: JSON.stringify(detail),
      };
    },

    async signingRequestHash(ctx: SenderContext, instruction: PaymentInstruction) {
      const detail = await detailFor(ctx, instruction);
      // parseQuoteDetail independently recomputed and matched this digest.
      return detail.requestHash;
    },

    async reservationClaims(ctx: SenderContext, instruction: PaymentInstruction) {
      const detail = await detailFor(ctx, instruction);
      return [
        {
          kind: "NONCE" as const,
          resourceKey: `eip155:${detail.chainId}:${detail.from.toLowerCase()}:${detail.nonce}`,
          amountAtomic: detail.amountAtomic,
        },
      ];
    },

    async send(ctx: SenderContext, instruction: PaymentInstruction, hooks): Promise<PaymentReceipt> {
      if (!ctx.signingBinding) {
        throw new Error("EVM signing requires a bound payment authorization.");
      }
      const detail = await detailFor(ctx, instruction);
      const request = preparedTransaction(detail);
      const signed = await dependencies.signTransaction(
        ctx.vaultKeyId,
        request,
        ctx.signingBinding,
      );
      const validated = await validateSignedTransaction(signed, request);

      // Persistence happens before the first byte reaches an RPC. If the hook
      // fails, do not broadcast; if broadcast is attempted, any uncertain
      // answer retains this stable hash for reconciliation.
      hooks?.onSigned?.(validated.hash, { encoding: "hex", payload: validated.payload });
      return broadcast(validated.payload, validated.hash);
    },

    async resumeBroadcast(ctx, instruction, envelope, expectedExternalId): Promise<PaymentReceipt> {
      const detail = await detailFor(ctx, instruction);
      const validated = await validateRecoveryEnvelope(
        envelope,
        expectedExternalId,
        preparedTransaction(detail),
      );
      return broadcast(validated.payload, validated.hash);
    },
  };
};

export const evmSender: PaymentSender = createEvmSender();
