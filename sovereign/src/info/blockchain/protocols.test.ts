import { describe, expect, it } from "vitest";
import { encodeAbiParameters } from "viem";
import type { BlockchainRpcClient } from "./rpc.ts";
import type { EvmCallsAtReference, EvmReferenceBlock, ReferenceBlock, SolanaReferenceBlock } from "./types.ts";
import { AAVE_USDC_MARKETS, readAaveUsdcMarket } from "./aave.ts";
import { NATIVE_USDC_DEPLOYMENTS, readNativeUsdcSupply } from "./stablecoins.ts";
import { readUniswapPool, UNISWAP_USDC_WETH_POOLS } from "./uniswap.ts";

const SOURCE = {
  chain: "eip155:1" as const,
  provider: "Fixture",
  transport: "json-rpc" as const,
  configuration: "public-default" as const,
  rpc_documentation_url: "https://example.test/docs",
  explorer_url: "https://example.test/explorer",
  endpoint_disclosed: false as const,
};

const NOW = new Date("2026-08-20T18:00:00.000Z");
const STALE_NOW = new Date("2026-08-21T18:00:00.000Z");

function evmReference(chainKey = "ethereum", chain = "eip155:1"): EvmReferenceBlock {
  return {
    chain_key: chainKey as EvmReferenceBlock["chain_key"],
    chain: chain as EvmReferenceBlock["chain"],
    family: "evm",
    height: "123",
    height_hex: "0x7b",
    height_kind: "block-number",
    hash: `0x${"11".repeat(32)}`,
    block_time: { unix_seconds: "1787248790", iso: "2026-08-20T17:59:50.000Z" },
    fetched_at: "2026-08-20T18:00:00.000Z",
    finality: {
      claim: "upstream-finalized",
      basis: "json-rpc-block-tag",
      requested_tag: "finalized",
      resolved_tag: "finalized",
      fallback_used: false,
      attempts: [{ tag: "finalized", outcome: "selected" }],
    },
    source: { ...SOURCE, chain: chain as EvmReferenceBlock["chain"] },
  };
}

function batch(reference: EvmReferenceBlock, results: Array<{ key: string; data: `0x${string}` }>): EvmCallsAtReference {
  return {
    chain: reference.chain,
    reference,
    results,
    transport: "json-rpc-batch",
    pinning: "block-hash-canonical",
    source: reference.source,
  };
}

describe("direct onchain protocol adapters", () => {
  it("reads Aave's exact reserve integers and derives rates without Number", async () => {
    const definition = AAVE_USDC_MARKETS[0];
    const ref = evmReference();
    const encoded = encodeAbiParameters(
      [
        { type: "uint256" }, { type: "uint256" }, { type: "uint256" }, { type: "uint256" },
        { type: "uint256" }, { type: "uint256" }, { type: "uint256" }, { type: "uint256" },
        { type: "uint256" }, { type: "uint256" }, { type: "uint256" }, { type: "uint40" },
      ],
      [0n, 0n, 2_000_000n, 200_000n, 800_000n, 50_000_000_000_000_000_000_000_000n,
        75_000_000_000_000_000_000_000_000n, 0n, 0n, 1n, 1n, 1_787_248_790],
    );
    const client = {
      evmCallsAtReference: async () => batch(ref, [{ key: "reserve-data", data: encoded }]),
    } as unknown as BlockchainRpcClient;
    const market = await readAaveUsdcMarket(
      definition,
      client,
      new Map<string, ReferenceBlock>([["ethereum", ref]]),
      STALE_NOW,
    );
    expect(market.total_supplied.decimal).toBe("2");
    expect(market.stable_debt.decimal).toBe("0.2");
    expect(market.variable_debt.decimal).toBe("0.8");
    expect(market.utilization.decimal).toBe("50");
    expect(market.current_supply_rate.decimal).toBe("5");
    expect(market.current_variable_borrow_rate.decimal).toBe("7.5");
    expect(market).toMatchObject({ status: "partial", stale: true, data_provider_address: definition.data_provider });
    expect(JSON.stringify(market).toLowerCase()).not.toContain('"tvl"');
    expect(JSON.stringify(market).toLowerCase()).not.toContain('"apy"');
  });

  it("reads native EVM and Solana USDC supply with representation limits", async () => {
    const evmDeployment = NATIVE_USDC_DEPLOYMENTS[0];
    const evmRef = evmReference();
    const evmClient = {
      evmCallsAtReference: async () => batch(evmRef, [{
        key: "total-supply",
        data: encodeAbiParameters([{ type: "uint256" }], [12_345_678_901_234n]),
      }]),
    } as unknown as BlockchainRpcClient;
    const evm = await readNativeUsdcSupply(
      evmDeployment,
      evmClient,
      new Map([["ethereum", evmRef]]),
      STALE_NOW,
    );
    expect(evm.supply).toMatchObject({ raw: "12345678901234", decimal: "12345678.901234", decimals: 6 });
    expect(evm.representation).toBe("native_issued");
    expect(evm).toMatchObject({ status: "partial", stale: true });

    const solDeployment = NATIVE_USDC_DEPLOYMENTS.find((entry) => entry.chain_key === "solana")!;
    const solRef: SolanaReferenceBlock = {
      chain_key: "solana",
      chain: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvd",
      family: "solana",
      height: "123",
      height_kind: "slot",
      hash: "5HueCGU8rMjxEXxiPuD5BDuRa1LqVYw9K7R1mJ4hYQx",
      block_time: { unix_seconds: "1787248790", iso: "2026-08-20T17:59:50.000Z" },
      fetched_at: "2026-08-20T18:00:00.000Z",
      finality: { claim: "solana-finalized-commitment", basis: "solana-rpc-commitment", fallback_used: false, attempts: [] },
      source: { ...SOURCE, chain: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvd" },
    };
    const solClient = {
      solanaRead: async (_selector: string, method: string) => {
        if (method !== "getTokenSupply") throw new Error("unexpected method");
        return { context: { slot: 123 }, value: { amount: "999000001", decimals: 6, uiAmountString: "999.000001" } };
      },
    } as unknown as BlockchainRpcClient;
    const sol = await readNativeUsdcSupply(solDeployment, solClient, new Map([["solana", solRef]]), NOW);
    expect(sol.supply.decimal).toBe("999.000001");
    expect(sol.receipt.proof_state).toBe("finalized-slot");
  });

  it("verifies a curated Uniswap pool through its factory and keeps pool fields semantically narrow", async () => {
    const definition = UNISWAP_USDC_WETH_POOLS[0];
    const ref = evmReference();
    let call = 0;
    const client = {
      evmCallsAtReference: async () => {
        call += 1;
        if (call === 1) {
          return batch(ref, [{ key: "factory-pool", data: encodeAbiParameters([{ type: "address" }], [definition.expected_pool]) }]);
        }
        return batch(ref, [
          { key: "token0", data: encodeAbiParameters([{ type: "address" }], [definition.usdc]) },
          { key: "token1", data: encodeAbiParameters([{ type: "address" }], [definition.weth]) },
          { key: "fee", data: encodeAbiParameters([{ type: "uint24" }], [definition.fee]) },
          { key: "liquidity", data: encodeAbiParameters([{ type: "uint128" }], [12345678901234567890n]) },
          {
            key: "slot0",
            data: encodeAbiParameters(
              [{ type: "uint160" }, { type: "int24" }, { type: "uint16" }, { type: "uint16" }, { type: "uint16" }, { type: "uint8" }, { type: "bool" }],
              [79228162514264337593543950336n, -1234, 1, 2, 3, 0, true],
            ),
          },
          { key: "usdc-balance", data: encodeAbiParameters([{ type: "uint256" }], [123_456_789n]) },
          { key: "weth-balance", data: encodeAbiParameters([{ type: "uint256" }], [2_000_000_000_000_000_000n]) },
        ]);
      },
    } as unknown as BlockchainRpcClient;
    const pool = await readUniswapPool(definition, client, new Map([["ethereum", ref]]), STALE_NOW);
    expect(pool.pool_address).toBe(definition.expected_pool);
    expect(pool.fee_tier_bps.decimal).toBe("5");
    expect(pool.tokens.map((token) => [token.symbol, token.contract_balance.decimal])).toEqual([
      ["USDC", "123.456789"],
      ["WETH", "2"],
    ]);
    expect(pool.current_tick.raw).toBe("-1234");
    expect(pool).toMatchObject({ status: "partial", stale: true });
    const serialized = JSON.stringify(pool).toLowerCase();
    expect(serialized).not.toContain('"tvl"');
    expect(serialized).not.toContain('"volume"');
    expect(serialized).not.toContain('"apy"');
  });
});
