import {
  decodeFunctionResult,
  encodeFunctionData,
  parseAbi,
} from "viem";
import { resolveBlockchainChain } from "./registry.ts";
import type { BlockchainRpcClient } from "./rpc.ts";
import type { EvmReferenceBlock, ReferenceBlock } from "./types.ts";
import { chainSourceId } from "./chains.ts";
import {
  exactValue,
  referenceBlockIsStale,
  type LiquidityPool,
  type PoolToken,
} from "./model.ts";

export const UNISWAP_V3_SOURCE_ID = "uniswap-v3-contracts";
export const UNISWAP_V3_DEPLOYMENTS_URL = "https://github.com/Uniswap/v3-periphery/blob/main/deploys.md";

export interface UniswapPoolDefinition {
  chain_key: "ethereum" | "base" | "arbitrum" | "optimism";
  factory: `0x${string}`;
  expected_pool: `0x${string}`;
  usdc: `0x${string}`;
  weth: `0x${string}`;
  fee: 500;
}

export const UNISWAP_USDC_WETH_POOLS: readonly UniswapPoolDefinition[] = [
  {
    chain_key: "ethereum",
    factory: "0x1F98431c8aD98523631AE4a59f267346ea31F984",
    expected_pool: "0x88e6A0c2dDD26FEEb64F039a2c41296FcB3f5640",
    usdc: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
    weth: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
    fee: 500,
  },
  {
    chain_key: "base",
    factory: "0x33128a8fC17869897dcE68Ed026d694621f6FDfD",
    expected_pool: "0xd0b53D9277642d899DF5C87A3966A349A798F224",
    usdc: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    weth: "0x4200000000000000000000000000000000000006",
    fee: 500,
  },
  {
    chain_key: "arbitrum",
    factory: "0x1F98431c8aD98523631AE4a59f267346ea31F984",
    expected_pool: "0xC6962004f452bE9203591991D15f6b388e09E8D0",
    usdc: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831",
    weth: "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1",
    fee: 500,
  },
  {
    chain_key: "optimism",
    factory: "0x1F98431c8aD98523631AE4a59f267346ea31F984",
    expected_pool: "0x1fb3cf6e48F1E7B10213E7b6d87D4c073C7Fdb7b",
    usdc: "0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85",
    weth: "0x4200000000000000000000000000000000000006",
    fee: 500,
  },
] as const;

const FACTORY_ABI = parseAbi([
  "function getPool(address tokenA,address tokenB,uint24 fee) view returns (address pool)",
]);
const POOL_ABI = parseAbi([
  "function token0() view returns (address)",
  "function token1() view returns (address)",
  "function fee() view returns (uint24)",
  "function liquidity() view returns (uint128)",
  "function slot0() view returns (uint160 sqrtPriceX96,int24 tick,uint16 observationIndex,uint16 observationCardinality,uint16 observationCardinalityNext,uint8 feeProtocol,bool unlocked)",
]);
const ERC20_ABI = parseAbi([
  "function balanceOf(address account) view returns (uint256)",
]);

function findReference(key: string, references: ReadonlyMap<string, ReferenceBlock>): EvmReferenceBlock {
  const chain = resolveBlockchainChain(key);
  const reference = references.get(key) ?? (chain ? references.get(chain.caip2) : undefined);
  if (!reference || reference.family !== "evm") throw new Error(`no EVM reference block for ${key}`);
  return reference;
}

function byKey(results: readonly { key: string; data: `0x${string}` }[], key: string): `0x${string}` {
  const result = results.find((entry) => entry.key === key)?.data;
  if (!result) throw new Error(`missing Uniswap ${key} result`);
  return result;
}

function addressResult(data: `0x${string}`, fn: "getPool" | "token0" | "token1"): `0x${string}` {
  const abi = fn === "getPool" ? FACTORY_ABI : POOL_ABI;
  const value = decodeFunctionResult({ abi, functionName: fn, data });
  if (typeof value !== "string" || !/^0x[0-9a-f]{40}$/i.test(value)) {
    throw new Error(`malformed Uniswap ${fn} address`);
  }
  return value as `0x${string}`;
}

function token(
  address: `0x${string}`,
  definition: UniswapPoolDefinition,
  balance: bigint,
): PoolToken {
  const lowered = address.toLowerCase();
  if (lowered === definition.usdc.toLowerCase()) {
    return { symbol: "USDC", address, decimals: 6, contract_balance: exactValue(balance, 6, "USDC") };
  }
  if (lowered === definition.weth.toLowerCase()) {
    return { symbol: "WETH", address, decimals: 18, contract_balance: exactValue(balance, 18, "WETH") };
  }
  throw new Error("pool token does not match the curated USDC/WETH pair");
}

export async function readUniswapPool(
  definition: UniswapPoolDefinition,
  client: BlockchainRpcClient,
  references: ReadonlyMap<string, ReferenceBlock>,
  now = new Date(),
  signal?: AbortSignal,
): Promise<LiquidityPool> {
  const chain = resolveBlockchainChain(definition.chain_key);
  if (!chain) throw new Error("Uniswap chain registry entry unavailable");
  const reference = findReference(definition.chain_key, references);
  const discovery = await client.evmCallsAtReference(definition.chain_key, [{
    key: "factory-pool",
    to: definition.factory,
    data: encodeFunctionData({
      abi: FACTORY_ABI,
      functionName: "getPool",
      args: [definition.usdc, definition.weth, definition.fee],
    }),
  }], reference, { signal });
  const pool = addressResult(byKey(discovery.results, "factory-pool"), "getPool");
  if (pool.toLowerCase() !== definition.expected_pool.toLowerCase()) {
    throw new Error("Uniswap factory result differs from the verified curated pool");
  }

  const reads = await client.evmCallsAtReference(definition.chain_key, [
    { key: "token0", to: pool, data: encodeFunctionData({ abi: POOL_ABI, functionName: "token0" }) },
    { key: "token1", to: pool, data: encodeFunctionData({ abi: POOL_ABI, functionName: "token1" }) },
    { key: "fee", to: pool, data: encodeFunctionData({ abi: POOL_ABI, functionName: "fee" }) },
    { key: "liquidity", to: pool, data: encodeFunctionData({ abi: POOL_ABI, functionName: "liquidity" }) },
    { key: "slot0", to: pool, data: encodeFunctionData({ abi: POOL_ABI, functionName: "slot0" }) },
    {
      key: "usdc-balance",
      to: definition.usdc,
      data: encodeFunctionData({ abi: ERC20_ABI, functionName: "balanceOf", args: [pool] }),
    },
    {
      key: "weth-balance",
      to: definition.weth,
      data: encodeFunctionData({ abi: ERC20_ABI, functionName: "balanceOf", args: [pool] }),
    },
  ], reference, { signal });
  const token0Address = addressResult(byKey(reads.results, "token0"), "token0");
  const token1Address = addressResult(byKey(reads.results, "token1"), "token1");
  const fee = decodeFunctionResult({ abi: POOL_ABI, functionName: "fee", data: byKey(reads.results, "fee") });
  const liquidity = decodeFunctionResult({ abi: POOL_ABI, functionName: "liquidity", data: byKey(reads.results, "liquidity") });
  const slot0 = decodeFunctionResult({ abi: POOL_ABI, functionName: "slot0", data: byKey(reads.results, "slot0") });
  const usdcBalance = decodeFunctionResult({ abi: ERC20_ABI, functionName: "balanceOf", data: byKey(reads.results, "usdc-balance") });
  const wethBalance = decodeFunctionResult({ abi: ERC20_ABI, functionName: "balanceOf", data: byKey(reads.results, "weth-balance") });
  if (typeof fee !== "number" || fee !== definition.fee || fee % 100 !== 0 ||
      typeof liquidity !== "bigint" || typeof usdcBalance !== "bigint" || typeof wethBalance !== "bigint" ||
      !Array.isArray(slot0) || typeof slot0[0] !== "bigint" || typeof slot0[1] !== "number") {
    throw new Error("malformed Uniswap pool state");
  }
  const balanceByAddress = new Map<string, bigint>([
    [definition.usdc.toLowerCase(), usdcBalance],
    [definition.weth.toLowerCase(), wethBalance],
  ]);
  const token0Balance = balanceByAddress.get(token0Address.toLowerCase());
  const token1Balance = balanceByAddress.get(token1Address.toLowerCase());
  if (token0Balance === undefined || token1Balance === undefined) {
    throw new Error("curated pool token balance mapping failed");
  }
  const sourceIds = [chainSourceId(definition.chain_key), UNISWAP_V3_SOURCE_ID];
  const stale = referenceBlockIsStale(reads.reference, now);
  const limitations = [
    "Contract-held token balances are custody balances—not TVL, universally executable depth, or a quote for a trade size.",
    "Uniswap V3 liquidity is the active concentrated-liquidity parameter—not dollars, volume, yield, or all token inventory.",
    "No pool-implied spot price is promoted because a single pool state can be manipulated and is not a licensed composite market quote.",
  ];
  return {
    id: `uniswap-v3-usdc-weth-005-${definition.chain_key}`,
    protocol: "Uniswap V3",
    name: `USDC / WETH 0.05% · ${chain.label}`,
    chain: chain.caip2,
    chain_name: chain.label,
    pool_address: pool,
    fee_tier_bps: exactValue(BigInt(fee / 100), 0, "basis_points", "bps"),
    tokens: [
      token(token0Address, definition, token0Balance),
      token(token1Address, definition, token1Balance),
    ],
    active_liquidity: exactValue(liquidity, 0, "uniswap_v3_liquidity_units"),
    sqrt_price_x96: exactValue(slot0[0], 0, "sqrt_price_x96"),
    current_tick: exactValue(BigInt(slot0[1]), 0, "tick"),
    status: stale ? "partial" : "observed",
    stale,
    receipt: {
      id: `uniswap-v3-usdc-weth-005-${definition.chain_key}-receipt`,
      method: "observed_onchain",
      proof_state: "pinned-block",
      pinning: reads.pinning,
      observed_at: reference.block_time?.iso ?? null,
      fetched_at: reads.reference.fetched_at,
      reference_block: reads.reference,
      source_ids: sourceIds,
      contract_address: pool,
      method_or_event: "factory.getPool + pool.token0/token1/fee/liquidity/slot0 + ERC20.balanceOf",
      inputs: [definition.factory, definition.usdc, definition.weth, definition.fee.toString()],
      limitations,
    },
    source_id: UNISWAP_V3_SOURCE_ID,
    note: `A curated pool's contract state at one pinned block. Balances and active liquidity units remain explicitly distinct from TVL, depth, volume, or APY.${stale ? " The supplied chain reference exceeds its source-aware freshness allowance, so this observation is partial." : ""}`,
  };
}
