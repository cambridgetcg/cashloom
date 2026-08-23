/**
 * Shared contracts for CashLoom's read-only blockchain substrate.
 *
 * Values that originate as chain integers are kept as decimal or hexadecimal
 * strings.  JSON numbers and IEEE-754 arithmetic never touch balances, block
 * heights, slots, timestamps, or RPC quantities after validation.
 */

export type ChainKey =
  | "bitcoin"
  | "ethereum"
  | "base"
  | "arbitrum"
  | "optimism"
  | "polygon"
  | "bsc"
  | "solana";

export type EvmChainKey = Exclude<ChainKey, "bitcoin" | "solana">;
export type ChainFamily = "bitcoin" | "evm" | "solana";

export type Caip2Id = `${string}:${string}`;
export type DecimalIntegerString = `${bigint}`;
export type HexQuantity = `0x${string}`;
export type HexData = `0x${string}`;

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export interface ChainDocumentation {
  /** Canonical project or foundation site. */
  official_url: string;
  /** Human-facing block explorer; never used as an RPC endpoint. */
  explorer_url: string;
  /** Network/RPC documentation used to reproduce the read. */
  rpc_documentation_url: string;
}

export interface NativeAssetMetadata {
  symbol: string;
  name: string;
  decimals: number;
  caip19: string;
}

export interface ChainRegistryEntry {
  key: ChainKey;
  caip2: Caip2Id;
  family: ChainFamily;
  label: string;
  aliases: readonly string[];
  native_asset: NativeAssetMetadata;
  documentation: ChainDocumentation;
  /** Environment variable read only by the server-side registry resolver. */
  rpc_env: string;
  /** Decimal EIP-155 chain ID. Present only for EVM chains. */
  evm_chain_id?: DecimalIntegerString;
  /** Full genesis hash used to verify Bitcoin/Solana configured endpoints. */
  genesis_hash?: string;
  /** Ordered upstream block tags. Unsupported tags are recorded before fallback. */
  reference_tags?: readonly EvmReferenceTag[];
  reference_cache_ms: number;
}

/** Safe to serialize: no configured or default endpoint is included. */
export interface RpcSourceReceipt {
  readonly chain: Caip2Id;
  readonly provider: string;
  readonly transport: "json-rpc" | "esplora-http";
  readonly configuration: "environment" | "public-default";
  readonly rpc_documentation_url: string;
  readonly explorer_url: string;
  readonly endpoint_disclosed: false;
}

export type EvmReferenceTag = "finalized" | "safe" | "latest";

export interface ReferenceSelectionAttempt {
  readonly tag: EvmReferenceTag;
  readonly outcome: "selected" | "unsupported" | "empty";
}

export interface ReferenceFinality {
  /** A narrowly stated observation, not an independent CashLoom guarantee. */
  readonly claim:
    | "upstream-finalized"
    | "upstream-safe"
    | "upstream-latest-unfinalized"
    | "solana-finalized-commitment"
    | "bitcoin-proof-of-work-tip";
  readonly basis: "json-rpc-block-tag" | "solana-rpc-commitment" | "esplora-chain-tip";
  readonly requested_tag?: EvmReferenceTag;
  readonly resolved_tag?: EvmReferenceTag;
  readonly fallback_used: boolean;
  readonly attempts: readonly ReferenceSelectionAttempt[];
}

export interface ReferenceBlockBase {
  readonly chain_key: ChainKey;
  readonly chain: Caip2Id;
  readonly family: ChainFamily;
  /** Decimal block number, block height, or slot according to height_kind. */
  readonly height: DecimalIntegerString;
  readonly height_kind: "block-number" | "block-height" | "slot";
  readonly hash: string;
  readonly block_time: {
    readonly unix_seconds: DecimalIntegerString;
    readonly iso: string;
  } | null;
  readonly fetched_at: string;
  readonly finality: ReferenceFinality;
  readonly source: RpcSourceReceipt;
}

export interface EvmReferenceBlock extends ReferenceBlockBase {
  readonly chain_key: EvmChainKey;
  readonly family: "evm";
  readonly height_kind: "block-number";
  readonly height_hex: HexQuantity;
  readonly hash: HexData;
}

export interface BitcoinReferenceBlock extends ReferenceBlockBase {
  readonly chain_key: "bitcoin";
  readonly family: "bitcoin";
  readonly height_kind: "block-height";
}

export interface SolanaReferenceBlock extends ReferenceBlockBase {
  readonly chain_key: "solana";
  readonly family: "solana";
  readonly height_kind: "slot";
}

export type ReferenceBlock = EvmReferenceBlock | BitcoinReferenceBlock | SolanaReferenceBlock;

/**
 * Contract calls are supplied by server-owned adapters, never copied directly
 * from HTTP query/body input. Runtime validation is still strict and bounded.
 */
export interface EvmReadCall {
  /** Stable, non-secret adapter-local key returned alongside the result. */
  key: string;
  to: HexData;
  data: HexData;
}

export interface EvmReadResult {
  key: string;
  data: HexData;
}

export interface EvmCallsAtReference {
  readonly chain: Caip2Id;
  readonly reference: EvmReferenceBlock;
  readonly results: readonly EvmReadResult[];
  readonly transport: "json-rpc-batch" | "parallel-fallback";
  readonly pinning: "block-hash-canonical" | "height-with-canonical-pre-postcheck";
  readonly source: RpcSourceReceipt;
}

export interface BitcoinMempoolSnapshot {
  chain: Caip2Id;
  transaction_count: DecimalIntegerString;
  virtual_size_bytes: DecimalIntegerString;
  total_fee_sats: DecimalIntegerString;
  fetched_at: string;
  source: RpcSourceReceipt;
}

export interface BitcoinFeeEstimate {
  chain: Caip2Id;
  target_blocks: "3";
  /** Exact decimal token reported by Esplora; unit is satoshis per vbyte. */
  sat_per_vbyte: string;
  fetched_at: string;
  source: RpcSourceReceipt;
}

export type BitcoinReadResult = BitcoinMempoolSnapshot | BitcoinFeeEstimate;

export interface SolanaPerformanceSample {
  slot: DecimalIntegerString;
  transactions: DecimalIntegerString;
  non_vote_transactions?: DecimalIntegerString;
  slots: DecimalIntegerString;
  sample_period_seconds: DecimalIntegerString;
}

export interface SolanaPerformanceSamples {
  chain: Caip2Id;
  samples: readonly SolanaPerformanceSample[];
  fetched_at: string;
  source: RpcSourceReceipt;
}

export interface SolanaPrioritizationFee {
  slot: DecimalIntegerString;
  /** Micro-lamports per compute unit, exactly as returned by the RPC. */
  micro_lamports_per_compute_unit: DecimalIntegerString;
}

export interface SolanaPrioritizationFees {
  chain: Caip2Id;
  fees: readonly SolanaPrioritizationFee[];
  fetched_at: string;
  source: RpcSourceReceipt;
}

export type EvmReadMethod =
  | "eth_blockNumber"
  | "eth_call"
  | "eth_chainId"
  | "eth_gasPrice"
  | "eth_getBalance"
  | "eth_getBlockByNumber"
  | "eth_getCode"
  | "eth_getStorageAt"
  | "eth_getTransactionCount";

export type SolanaReadMethod =
  | "getAccountInfo"
  | "getBalance"
  | "getBlock"
  | "getBlockTime"
  | "getGenesisHash"
  | "getLatestBlockhash"
  | "getRecentPerformanceSamples"
  | "getRecentPrioritizationFees"
  | "getSlot"
  | "getTokenAccountBalance"
  | "getTokenSupply";

export interface RpcCallOptions {
  signal?: AbortSignal;
  timeout_ms?: number;
  max_response_bytes?: number;
}

export type BlockchainRpcErrorCode =
  | "CHAIN_NOT_FOUND"
  | "CHAIN_FAMILY_MISMATCH"
  | "RPC_CONFIGURATION_INVALID"
  | "RPC_ABORTED"
  | "RPC_TIMEOUT"
  | "RPC_NETWORK_ERROR"
  | "RPC_HTTP_STATUS"
  | "RPC_REQUEST_TOO_LARGE"
  | "RPC_RESPONSE_TOO_LARGE"
  | "RPC_MALFORMED_RESPONSE"
  | "RPC_REMOTE_ERROR"
  | "RPC_BATCH_UNSUPPORTED"
  | "RPC_CHAIN_MISMATCH"
  | "RPC_REFERENCE_UNAVAILABLE"
  | "RPC_INVALID_CALL";
