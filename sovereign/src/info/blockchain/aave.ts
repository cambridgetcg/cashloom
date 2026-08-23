import {
  decodeFunctionResult,
  encodeFunctionData,
  parseAbi,
} from "viem";
import { divHalfEven } from "../../utils/minor-units.ts";
import { resolveBlockchainChain } from "./registry.ts";
import type { BlockchainRpcClient } from "./rpc.ts";
import type { EvmReferenceBlock, ReferenceBlock } from "./types.ts";
import { chainSourceId } from "./chains.ts";
import {
  exactValue,
  referenceBlockIsStale,
  type LendingMarket,
} from "./model.ts";

export const AAVE_ADDRESS_BOOK_SOURCE_ID = "aave-v3-address-book";
export const AAVE_ADDRESS_BOOK_URL = "https://github.com/aave-dao/aave-address-book";
export const AAVE_ADDRESS_BOOK_VERIFIED_AT = "2026-08-20T00:00:00.000Z";

export interface AaveUsdcMarketDefinition {
  chain_key: "ethereum" | "base" | "arbitrum" | "optimism";
  data_provider: `0x${string}`;
  usdc: `0x${string}`;
}

/**
 * Transcribed from the official MIT Aave Address Book release on the verified
 * date above. Native Circle USDC is selected by underlying address, never by
 * the ambiguous `USDC`/`USDC.e` display key.
 */
export const AAVE_USDC_MARKETS: readonly AaveUsdcMarketDefinition[] = [
  {
    chain_key: "ethereum",
    data_provider: "0x0a16f2FCC0D44FaE41cc54e079281D84A363bECD",
    usdc: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
  },
  {
    chain_key: "base",
    data_provider: "0x0F43731EB8d45A581f4a36DD74F5f358bc90C73A",
    usdc: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  },
  {
    chain_key: "arbitrum",
    data_provider: "0x243Aa95cAC2a25651eda86e80bEe66114413c43b",
    usdc: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831",
  },
  {
    chain_key: "optimism",
    data_provider: "0x243Aa95cAC2a25651eda86e80bEe66114413c43b",
    usdc: "0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85",
  },
] as const;

const DATA_PROVIDER_ABI = parseAbi([
  "function getReserveData(address asset) view returns (uint256 unbacked,uint256 accruedToTreasuryScaled,uint256 totalAToken,uint256 totalStableDebt,uint256 totalVariableDebt,uint256 liquidityRate,uint256 variableBorrowRate,uint256 stableBorrowRate,uint256 averageStableBorrowRate,uint256 liquidityIndex,uint256 variableBorrowIndex,uint40 lastUpdateTimestamp)",
]);

function findReference(
  key: string,
  references: ReadonlyMap<string, ReferenceBlock>,
): EvmReferenceBlock {
  const chain = resolveBlockchainChain(key);
  const reference = references.get(key) ?? (chain ? references.get(chain.caip2) : undefined);
  if (!reference || reference.family !== "evm") throw new Error(`no EVM reference block for ${key}`);
  return reference;
}

export async function readAaveUsdcMarket(
  definition: AaveUsdcMarketDefinition,
  client: BlockchainRpcClient,
  references: ReadonlyMap<string, ReferenceBlock>,
  now = new Date(),
  signal?: AbortSignal,
): Promise<LendingMarket> {
  const chain = resolveBlockchainChain(definition.chain_key);
  if (!chain) throw new Error("Aave chain registry entry unavailable");
  const reference = findReference(definition.chain_key, references);
  const data = encodeFunctionData({
    abi: DATA_PROVIDER_ABI,
    functionName: "getReserveData",
    args: [definition.usdc],
  });
  const batch = await client.evmCallsAtReference(definition.chain_key, [{
    key: "reserve-data",
    to: definition.data_provider,
    data,
  }], reference, { signal });
  const encoded = batch.results[0]?.data;
  if (!encoded) throw new Error("Aave reserve data was empty");
  if (encoded === "0x") throw new Error("Aave reserve data was empty");
  const decodedResult = decodeFunctionResult({
    abi: DATA_PROVIDER_ABI,
    functionName: "getReserveData",
    data: encoded,
  }) as readonly (bigint | number)[];
  if (!Array.isArray(decodedResult) || decodedResult.length !== 12 || decodedResult.some((value) =>
    (typeof value !== "bigint" && (typeof value !== "number" || !Number.isSafeInteger(value))) || value < 0
  )) {
    throw new Error("Aave reserve data was malformed");
  }
  const decoded = decodedResult.map((value) => typeof value === "bigint" ? value : BigInt(value));
  const totalSupplied = decoded[2];
  const stableDebt = decoded[3];
  const variableDebt = decoded[4];
  const liquidityRateRay = decoded[5];
  const variableBorrowRateRay = decoded[6];
  const lastUpdateTimestamp = decoded[11];
  if (totalSupplied === 0n) throw new Error("Aave native-USDC market reports zero supplied units");
  // Percent with six decimal places: debt / supplied × 100.
  const utilizationScaled = divHalfEven((stableDebt + variableDebt) * 100_000_000n, totalSupplied);
  const stale = referenceBlockIsStale(batch.reference, now);
  const sourceIds = [chainSourceId(definition.chain_key), AAVE_ADDRESS_BOOK_SOURCE_ID];
  const limitations = [
    "Gross aToken supply and variable debt are not combined or labeled as protocol TVL.",
    "The displayed rates are current onchain rate parameters in Aave's RAY scale; incentive rewards, compounding, user health, and future realized yield are excluded.",
    "Utilization is derived as stable debt plus variable debt divided by gross aToken supply for this selected native-USDC reserve.",
  ];
  return {
    id: `aave-v3-usdc-${definition.chain_key}`,
    protocol: "Aave V3",
    name: `Aave V3 native USDC · ${chain.label}`,
    chain: chain.caip2,
    chain_name: chain.label,
    asset: "USDC",
    asset_address: definition.usdc,
    data_provider_address: definition.data_provider,
    status: stale ? "partial" : "observed",
    stale,
    total_supplied: exactValue(totalSupplied, 6, "USDC"),
    stable_debt: exactValue(stableDebt, 6, "USDC"),
    variable_debt: exactValue(variableDebt, 6, "USDC"),
    utilization: exactValue(utilizationScaled, 6, "percent", "%"),
    current_supply_rate: exactValue(liquidityRateRay * 100n, 27, "percent_per_annum", "% p.a."),
    current_variable_borrow_rate: exactValue(variableBorrowRateRay * 100n, 27, "percent_per_annum", "% p.a."),
    receipt: {
      id: `aave-v3-usdc-${definition.chain_key}-receipt`,
      method: "derived_onchain",
      proof_state: "pinned-block",
      pinning: batch.pinning,
      observed_at: reference.block_time?.iso ?? null,
      fetched_at: batch.reference.fetched_at,
      reference_block: batch.reference,
      source_ids: sourceIds,
      contract_address: definition.data_provider,
      method_or_event: "AaveProtocolDataProvider.getReserveData(native USDC)",
      formula: "utilization_percent = round_half_even((totalStableDebt + totalVariableDebt) / totalAToken × 100, 6dp); annual rate percent = ray × 100 / 10^27",
      inputs: decoded.map((value) => value.toString()),
      limitations: [...limitations, `Reserve lastUpdateTimestamp returned by Aave: ${lastUpdateTimestamp.toString()}.`],
    },
    source_id: AAVE_ADDRESS_BOOK_SOURCE_ID,
    note: `A selected native-USDC credit market at one pinned block. Supplied assets, debt, utilization, and current rate parameters remain separate facts.${stale ? " The supplied chain reference exceeds its source-aware freshness allowance, so this observation is partial." : ""}`,
  };
}
