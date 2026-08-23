import { decodeAbiParameters } from "viem";
import { listBlockchainChains, resolveBlockchainChain } from "./registry.ts";
import type { BlockchainRpcClient } from "./rpc.ts";
import type {
  EvmReferenceBlock,
  ReferenceBlock,
  SolanaReferenceBlock,
} from "./types.ts";
import {
  exactValue,
  referenceBlockIsStale,
  type StablecoinObservation,
} from "./model.ts";
import { chainSourceId } from "./chains.ts";

export const CIRCLE_USDC_REGISTRY_SOURCE_ID = "circle-usdc-contract-registry";
export const CIRCLE_USDC_REGISTRY_URL = "https://developers.circle.com/stablecoins/usdc-contract-addresses";

export interface NativeUsdcDeployment {
  chain_key: "ethereum" | "base" | "arbitrum" | "optimism" | "polygon" | "solana";
  token_address: string;
  decimals: 6;
}

export const NATIVE_USDC_DEPLOYMENTS: readonly NativeUsdcDeployment[] = [
  { chain_key: "ethereum", token_address: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", decimals: 6 },
  { chain_key: "base", token_address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", decimals: 6 },
  { chain_key: "arbitrum", token_address: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831", decimals: 6 },
  { chain_key: "optimism", token_address: "0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85", decimals: 6 },
  { chain_key: "polygon", token_address: "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359", decimals: 6 },
  { chain_key: "solana", token_address: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", decimals: 6 },
] as const;

const TOTAL_SUPPLY_SELECTOR = "0x18160ddd" as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function referenceFor(
  chainKey: string,
  references: ReadonlyMap<string, ReferenceBlock>,
): ReferenceBlock | undefined {
  return references.get(chainKey) ?? references.get(resolveBlockchainChain(chainKey)?.caip2 ?? "");
}

async function readEvmUsdc(
  deployment: NativeUsdcDeployment,
  client: BlockchainRpcClient,
  reference: EvmReferenceBlock,
  now: Date,
  signal?: AbortSignal,
): Promise<StablecoinObservation> {
  const chain = resolveBlockchainChain(deployment.chain_key);
  if (!chain) throw new Error("USDC chain registry entry unavailable");
  const result = await client.evmCallsAtReference(deployment.chain_key, [{
    key: "total-supply",
    to: deployment.token_address as `0x${string}`,
    data: TOTAL_SUPPLY_SELECTOR,
  }], reference, { signal });
  const raw = result.results[0]?.data;
  if (!raw) throw new Error("USDC totalSupply did not return data");
  const [supply] = decodeAbiParameters([{ type: "uint256" }], raw) as readonly [bigint];
  const stale = referenceBlockIsStale(result.reference, now);
  return {
    id: `usdc-supply-${deployment.chain_key}`,
    name: `Native USDC on ${chain.label}`,
    symbol: "USDC",
    chain: chain.caip2,
    chain_name: chain.label,
    token_address: deployment.token_address,
    representation: "native_issued",
    status: stale ? "partial" : "observed",
    stale,
    supply: exactValue(supply, deployment.decimals, "USDC"),
    receipt: {
      id: `usdc-supply-${deployment.chain_key}-receipt`,
      method: "observed_onchain",
      proof_state: "pinned-block",
      pinning: result.pinning,
      observed_at: reference.block_time?.iso ?? null,
      fetched_at: result.reference.fetched_at,
      reference_block: result.reference,
      source_ids: [chainSourceId(deployment.chain_key), CIRCLE_USDC_REGISTRY_SOURCE_ID],
      contract_address: deployment.token_address,
      method_or_event: "ERC20.totalSupply()",
      limitations: [
        "This is the token contract's totalSupply at one pinned block—not proof of reserves, redeemability, circulating supply, market capitalization, or a one-dollar price.",
        "Only Circle-listed native USDC is included; wrapped and legacy bridge representations are intentionally excluded.",
      ],
    },
    source_id: CIRCLE_USDC_REGISTRY_SOURCE_ID,
    note: `Native-issued USDC contract supply at one pinned chain block. Wrapped and legacy bridge representations are not combined.${stale ? " The supplied chain reference exceeds its source-aware freshness allowance, so this observation is partial." : ""}`,
  };
}

function safeSlot(value: unknown): bigint {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error("malformed Solana context slot");
  }
  return BigInt(value);
}

async function solanaReferenceAt(
  client: BlockchainRpcClient,
  baseReference: SolanaReferenceBlock,
  slot: bigint,
  signal?: AbortSignal,
): Promise<SolanaReferenceBlock> {
  if (slot === BigInt(baseReference.height)) return baseReference;
  if (slot > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("Solana slot exceeds JSON safe integer range");
  const raw = await client.solanaRead("solana", "getBlock", [Number(slot), {
    commitment: "finalized",
    transactionDetails: "none",
    rewards: false,
  }], { signal });
  if (!isRecord(raw) || typeof raw.blockhash !== "string" ||
      !/^[1-9A-HJ-NP-Za-km-z]{32,64}$/.test(raw.blockhash)) {
    throw new Error("Solana supply slot block is unavailable");
  }
  let blockTime: SolanaReferenceBlock["block_time"] = null;
  if (raw.blockTime !== null) {
    if (typeof raw.blockTime !== "number" || !Number.isSafeInteger(raw.blockTime) || raw.blockTime < 0) {
      throw new Error("malformed Solana block time");
    }
    blockTime = {
      unix_seconds: BigInt(raw.blockTime).toString() as `${bigint}`,
      iso: new Date(raw.blockTime * 1000).toISOString(),
    };
  }
  return {
    ...baseReference,
    height: slot.toString() as `${bigint}`,
    hash: raw.blockhash,
    block_time: blockTime,
    finality: { ...baseReference.finality, fallback_used: slot !== BigInt(baseReference.height) },
  };
}

async function readSolanaUsdc(
  deployment: NativeUsdcDeployment,
  client: BlockchainRpcClient,
  baseReference: SolanaReferenceBlock,
  now: Date,
  signal?: AbortSignal,
): Promise<StablecoinObservation> {
  const minimumSlot = BigInt(baseReference.height);
  if (minimumSlot > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("Solana slot exceeds JSON safe integer range");
  const raw = await client.solanaRead("solana", "getTokenSupply", [deployment.token_address, {
    commitment: "finalized",
    minContextSlot: Number(minimumSlot),
  }], { signal });
  if (!isRecord(raw) || !isRecord(raw.context) || !isRecord(raw.value)) {
    throw new Error("malformed Solana token-supply response");
  }
  const slot = safeSlot(raw.context.slot);
  const amount = raw.value.amount;
  const decimals = raw.value.decimals;
  if (typeof amount !== "string" || !/^\d+$/.test(amount) || decimals !== deployment.decimals) {
    throw new Error("malformed Solana USDC supply or decimals mismatch");
  }
  const reference = await solanaReferenceAt(client, baseReference, slot, signal);
  const chain = resolveBlockchainChain("solana")!;
  const stale = referenceBlockIsStale(reference, now);
  return {
    id: "usdc-supply-solana",
    name: "Native USDC on Solana",
    symbol: "USDC",
    chain: chain.caip2,
    chain_name: chain.label,
    token_address: deployment.token_address,
    representation: "native_issued",
    status: stale ? "partial" : "observed",
    stale,
    supply: exactValue(amount, deployment.decimals, "USDC"),
    receipt: {
      id: "usdc-supply-solana-receipt",
      method: "observed_onchain",
      proof_state: "finalized-slot",
      observed_at: reference.block_time?.iso ?? null,
      fetched_at: baseReference.fetched_at,
      reference_block: reference,
      source_ids: [chainSourceId("solana"), CIRCLE_USDC_REGISTRY_SOURCE_ID],
      contract_address: deployment.token_address,
      method_or_event: "getTokenSupply(finalized)",
      limitations: [
        "This is the mint's total token supply at a finalized RPC context—not proof of reserves, redeemability, circulating supply, market capitalization, or a one-dollar price.",
        "Only Circle-listed native USDC is included; wrapped and legacy bridge representations are intentionally excluded.",
      ],
    },
    source_id: CIRCLE_USDC_REGISTRY_SOURCE_ID,
    note: `Native-issued USDC mint supply at one finalized Solana context. Wrapped representations are not combined.${stale ? " The finalized context exceeds its source-aware freshness allowance, so this observation is partial." : ""}`,
  };
}

export async function readNativeUsdcSupply(
  deployment: NativeUsdcDeployment,
  client: BlockchainRpcClient,
  references: ReadonlyMap<string, ReferenceBlock>,
  now = new Date(),
  signal?: AbortSignal,
): Promise<StablecoinObservation> {
  const reference = referenceFor(deployment.chain_key, references);
  if (!reference) throw new Error(`no reference block for ${deployment.chain_key}`);
  if (deployment.chain_key === "solana") {
    if (reference.family !== "solana") throw new Error("Solana reference family mismatch");
    return readSolanaUsdc(deployment, client, reference, now, signal);
  }
  if (reference.family !== "evm") throw new Error("EVM reference family mismatch");
  return readEvmUsdc(deployment, client, reference, now, signal);
}

export function supportedNativeUsdcChains(): string[] {
  const supported = new Set(NATIVE_USDC_DEPLOYMENTS.map((entry) => entry.chain_key));
  return listBlockchainChains().filter((entry) => supported.has(entry.key as NativeUsdcDeployment["chain_key"]))
    .map((entry) => entry.caip2);
}
