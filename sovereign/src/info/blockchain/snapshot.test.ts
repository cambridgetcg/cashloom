import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import { listBlockchainChains } from "./registry.ts";
import type { BlockchainRpcClient } from "./rpc.ts";
import type { ChainRegistryEntry, ReferenceBlock } from "./types.ts";
import { exactValue, ONCHAIN_MEDIA_TYPE, ONCHAIN_SECTION_MEDIA_TYPE, type BridgeRoute, type ChainPulse, type LendingMarket, type LiquidityPool, type MetricReceipt, type StablecoinObservation } from "./model.ts";
import { AAVE_USDC_MARKETS } from "./aave.ts";
import { CCTP_ROUTES } from "./bridges.ts";
import { NATIVE_USDC_DEPLOYMENTS } from "./stablecoins.ts";
import { UNISWAP_USDC_WETH_POOLS } from "./uniswap.ts";
import { buildOnchainSnapshot, type OnchainDependencies } from "./snapshot.ts";
import { mountOnchainDoor, onchainSnapshotCacheTtl } from "./door.ts";

const NOW = new Date("2026-08-20T18:00:00.000Z");

function reference(row: ChainRegistryEntry): ReferenceBlock {
  const base = {
    chain_key: row.key,
    chain: row.caip2,
    family: row.family,
    height: "123" as const,
    height_kind: row.family === "solana" ? "slot" as const : row.family === "bitcoin" ? "block-height" as const : "block-number" as const,
    hash: row.family === "solana" ? "5HueCGU8rMjxEXxiPuD5BDuRa1LqVYw9K7R1mJ4hYQx" : "0x" + "11".repeat(32),
    block_time: { unix_seconds: "1787248790" as const, iso: "2026-08-20T17:59:50.000Z" },
    fetched_at: NOW.toISOString(),
    finality: {
      claim: row.family === "solana" ? "solana-finalized-commitment" as const : row.family === "bitcoin" ? "bitcoin-proof-of-work-tip" as const : "upstream-finalized" as const,
      basis: row.family === "solana" ? "solana-rpc-commitment" as const : row.family === "bitcoin" ? "esplora-chain-tip" as const : "json-rpc-block-tag" as const,
      fallback_used: false,
      attempts: [],
    },
    source: {
      chain: row.caip2,
      provider: "Fixture",
      transport: row.family === "bitcoin" ? "esplora-http" as const : "json-rpc" as const,
      configuration: "public-default" as const,
      rpc_documentation_url: row.documentation.rpc_documentation_url,
      explorer_url: row.documentation.explorer_url,
      endpoint_disclosed: false as const,
    },
  };
  if (row.family === "evm") {
    return { ...base, family: "evm", height_kind: "block-number", height_hex: "0x7b", hash: `0x${"11".repeat(32)}` } as ReferenceBlock;
  }
  return base as ReferenceBlock;
}

function receipt(id: string, ref?: ReferenceBlock): MetricReceipt {
  return {
    id,
    method: ref ? "observed_onchain" : "official_reference",
    proof_state: ref ? (ref.family === "solana" ? "finalized-slot" : ref.family === "bitcoin" ? "chain-tip" : "pinned-block") : "external-reference",
    observed_at: ref?.block_time?.iso ?? null,
    fetched_at: NOW.toISOString(),
    ...(ref ? { reference_block: ref } : {}),
    source_ids: [id.split("-receipt")[0]],
    limitations: ["fixture limitation"],
  };
}

function chainFixture(row: ChainRegistryEntry): ChainPulse {
  const ref = reference(row);
  return {
    id: `network-${row.key}`,
    chain: row.caip2,
    name: row.label,
    family: row.family,
    native_symbol: row.native_asset.symbol,
    status: "observed",
    stale: false,
    reference_block: ref,
    metrics: [],
    source_id: `chain-state-${row.key}`,
    note: "fixture",
  };
}

function stableFixture(definition: (typeof NATIVE_USDC_DEPLOYMENTS)[number]): StablecoinObservation {
  const row = listBlockchainChains().find((chain) => chain.key === definition.chain_key)!;
  const ref = reference(row);
  return {
    id: `usdc-supply-${definition.chain_key}`,
    name: `USDC ${row.label}`,
    symbol: "USDC",
    chain: row.caip2,
    chain_name: row.label,
    token_address: definition.token_address,
    representation: "native_issued",
    status: "observed",
    stale: false,
    supply: exactValue("1000000", 6, "USDC"),
    receipt: receipt(`usdc-supply-${definition.chain_key}-receipt`, ref),
    source_id: "circle-usdc-contract-registry",
    note: "fixture",
  };
}

function lendingFixture(definition: (typeof AAVE_USDC_MARKETS)[number]): LendingMarket {
  const row = listBlockchainChains().find((chain) => chain.key === definition.chain_key)!;
  const value = exactValue("1000000", 6, "USDC");
  return {
    id: `aave-v3-usdc-${definition.chain_key}`,
    protocol: "Aave V3",
    name: `Aave ${row.label}`,
    chain: row.caip2,
    chain_name: row.label,
    asset: "USDC",
    asset_address: definition.usdc,
    data_provider_address: definition.data_provider,
    status: "observed",
    stale: false,
    total_supplied: value,
    stable_debt: exactValue("0", 6, "USDC"),
    variable_debt: value,
    utilization: exactValue("50", 0, "percent"),
    current_supply_rate: exactValue("5", 0, "percent_per_annum"),
    current_variable_borrow_rate: exactValue("6", 0, "percent_per_annum"),
    receipt: receipt(`aave-${definition.chain_key}-receipt`, reference(row)),
    source_id: "aave-v3-address-book",
    note: "fixture",
  };
}

function poolFixture(definition: (typeof UNISWAP_USDC_WETH_POOLS)[number]): LiquidityPool {
  const row = listBlockchainChains().find((chain) => chain.key === definition.chain_key)!;
  return {
    id: `pool-${definition.chain_key}`,
    protocol: "Uniswap V3",
    name: `Pool ${row.label}`,
    chain: row.caip2,
    chain_name: row.label,
    pool_address: definition.expected_pool,
    fee_tier_bps: exactValue("5", 0, "basis_points"),
    tokens: [
      { symbol: "USDC", address: definition.usdc, decimals: 6, contract_balance: exactValue("1000000", 6, "USDC") },
      { symbol: "WETH", address: definition.weth, decimals: 18, contract_balance: exactValue("1000000000000000000", 18, "WETH") },
    ],
    active_liquidity: exactValue("1", 0, "uniswap_v3_liquidity_units"),
    sqrt_price_x96: exactValue("1", 0, "sqrt_price_x96"),
    current_tick: exactValue("1", 0, "tick"),
    status: "observed",
    stale: false,
    receipt: receipt(`pool-${definition.chain_key}-receipt`, reference(row)),
    source_id: "uniswap-v3-contracts",
    note: "fixture",
  };
}

function bridgeFixture(definition: (typeof CCTP_ROUTES)[number]): BridgeRoute {
  const source = listBlockchainChains().find((row) => row.key === definition.source)!;
  const destination = listBlockchainChains().find((row) => row.key === definition.destination)!;
  return {
    id: `cctp-v2-${definition.source}-${definition.destination}`,
    protocol: "Circle CCTP V2",
    name: `${source.label} → ${destination.label}`,
    source_chain: source.caip2,
    source_chain_name: source.label,
    destination_chain: destination.caip2,
    destination_chain_name: destination.label,
    asset: "USDC",
    mechanism: "burn-and-mint",
    status: "reference",
    fees: [{ mode: "standard", fee_bps: exactValue("0", 0, "basis_points"), finality_threshold: "2000", status: "available" }],
    observed_at: null,
    fetched_at: NOW.toISOString(),
    source_id: "circle-cctp-v2-fees",
    receipt: receipt(`cctp-${definition.source}-${definition.destination}-receipt`),
    note: "fixture",
  };
}

function fixtureDeps(): Partial<OnchainDependencies> {
  return {
    client: {} as BlockchainRpcClient,
    now: () => new Date(NOW),
    chain: async (row) => chainFixture(row),
    stablecoin: async (definition) => stableFixture(definition),
    lending: async (definition) => lendingFixture(definition),
    pool: async (definition) => poolFixture(definition),
    bridges: async () => ({ routes: CCTP_ROUTES.map(bridgeFixture), failures: [], fetched_at: NOW.toISOString() }),
  };
}

describe("onchain snapshot", () => {
  it("assembles a complete, typed latest-state snapshot", async () => {
    const snapshot = await buildOnchainSnapshot(fixtureDeps());
    expect(snapshot.schema).toBe("cashloom.onchain/1");
    expect(snapshot.status).toMatchObject({ state: "ready", complete: true, available_sources: 12, total_sources: 12 });
    expect(snapshot).toMatchObject({ chains: { length: 8 }, stablecoins: { length: 6 }, lending_markets: { length: 4 }, pools: { length: 4 }, bridge_routes: { length: 10 } });
    expect(JSON.stringify(snapshot)).not.toContain("RPC_URL");
  });

  it("keeps verified transcriptions distinct from live fetch timestamps", async () => {
    const snapshot = await buildOnchainSnapshot(fixtureDeps());
    const transcriptions = snapshot.sources.filter((source) => source.retrieval === "verified_transcription");
    expect(transcriptions).toHaveLength(3);
    transcriptions.forEach((source) => {
      expect(source.verified_at).toBe("2026-08-20T00:00:00.000Z");
      expect(source).not.toHaveProperty("fetched_at");
    });
    expect(snapshot.sources.find((source) => source.id === "circle-usdc-contract-registry")?.terms_url)
      .toBe("https://console.circle.com/legal/developer-terms");
    expect(snapshot.sources.find((source) => source.id === "chain-state-ethereum")?.fetched_at)
      .toBe(NOW.toISOString());
    expect(snapshot.sources.find((source) => source.id === "circle-cctp-v2-fees")?.fetched_at)
      .toBe(NOW.toISOString());
  });

  it("propagates stale supplied references through dependent sections, sources, briefing, and global state", async () => {
    const deps = fixtureDeps();
    const staleReceipt = (value: MetricReceipt): MetricReceipt => {
      const staleAt = new Date("2026-08-20T15:59:59.000Z");
      const staleReference = {
        ...value.reference_block!,
        block_time: {
          unix_seconds: Math.floor(staleAt.getTime() / 1_000).toString() as `${bigint}`,
          iso: staleAt.toISOString(),
        },
      } as ReferenceBlock;
      return { ...value, reference_block: staleReference };
    };
    deps.stablecoin = async (definition) => {
      const observation = stableFixture(definition);
      if (definition.chain_key !== "ethereum") return observation;
      return {
        ...observation,
        receipt: staleReceipt(observation.receipt),
      };
    };
    deps.lending = async (definition) => {
      const observation = lendingFixture(definition);
      return definition.chain_key === "ethereum"
        ? { ...observation, receipt: staleReceipt(observation.receipt) }
        : observation;
    };
    deps.pool = async (definition) => {
      const observation = poolFixture(definition);
      return definition.chain_key === "ethereum"
        ? { ...observation, receipt: staleReceipt(observation.receipt) }
        : observation;
    };
    const snapshot = await buildOnchainSnapshot(deps);
    const ethereum = snapshot.stablecoins.find((row) => row.chain_name === "Ethereum");
    expect(ethereum).toMatchObject({ status: "partial", stale: true });
    expect(snapshot.status.sections.stablecoins).toEqual({ state: "partial", available: 6, expected: 6 });
    expect(snapshot.status.sections.lending_markets).toEqual({ state: "partial", available: 4, expected: 4 });
    expect(snapshot.status.sections.pools).toEqual({ state: "partial", available: 4, expected: 4 });
    expect(snapshot.sources.find((source) => source.id === "circle-usdc-contract-registry")?.status).toBe("partial");
    expect(snapshot.sources.find((source) => source.id === "aave-v3-address-book")?.status).toBe("partial");
    expect(snapshot.sources.find((source) => source.id === "uniswap-v3-contracts")?.status).toBe("partial");
    expect(snapshot.briefing.find((brief) => brief.id === "brief-pool-state")?.status).toBe("derived");
    expect(snapshot.status).toMatchObject({ state: "partial", complete: false, stale_count: 3 });
    expect(snapshot.status.unavailable).toContainEqual(expect.objectContaining({
      id: "usdc-supply-ethereum-partial",
      section: "stablecoins",
    }));
  });

  it("settles at the hard shared deadline even when a dependency ignores cancellation", async () => {
    const deps = fixtureDeps();
    let sharedSignal: AbortSignal | undefined;
    deps.snapshot_window_ms = 25;
    deps.bridges = (signal) => {
      sharedSignal = signal;
      return new Promise<never>(() => { /* deliberately ignores abort */ });
    };
    const started = Date.now();
    const snapshot = await buildOnchainSnapshot(deps);
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(sharedSignal?.aborted).toBe(true);
    expect(snapshot.status.sections.bridge_routes).toEqual({ state: "unavailable", available: 0, expected: 10 });
    expect(snapshot.status.sections.stablecoins.state).toBe("ready");
    expect(snapshot.status.state).toBe("partial");
  });

  it("keeps a single source failure partial and never leaks its error detail", async () => {
    const deps = fixtureDeps();
    deps.chain = async (row) => {
      if (row.key === "polygon") throw new Error("https://rpc.host/private-secret-key");
      return chainFixture(row);
    };
    const snapshot = await buildOnchainSnapshot(deps);
    expect(snapshot.status.state).toBe("partial");
    expect(snapshot.status.sections.chains).toEqual({ state: "partial", available: 7, expected: 8 });
    expect(snapshot.briefing.find((brief) => brief.id === "brief-network-references")?.status).toBe("derived");
    expect(snapshot.status.unavailable).toContainEqual(expect.objectContaining({ id: "network-polygon", section: "chains" }));
    expect(JSON.stringify(snapshot)).not.toContain("private-secret-key");
  });

  it("serves the vendor JSON composite and section doors", async () => {
    const snapshot = await buildOnchainSnapshot(fixtureDeps());
    const app = new Hono();
    mountOnchainDoor(app, async () => snapshot);
    const composite = await app.request("/v1/onchain");
    expect(composite.status).toBe(200);
    expect(composite.headers.get("content-type")).toContain(ONCHAIN_MEDIA_TYPE);
    expect((await composite.json()).schema).toBe("cashloom.onchain/1");
    const section = await app.request("/v1/onchain/pools");
    expect(section.status).toBe(200);
    expect(section.headers.get("content-type")).toBe(ONCHAIN_SECTION_MEDIA_TYPE);
    const sectionBody = await section.json();
    expect(sectionBody).toMatchObject({ schema: "cashloom.onchain-section/1", section: "pools", items: { length: 4 } });
    expect(sectionBody.sources.map((source: { id: string }) => source.id).sort()).toEqual([
      "chain-state-arbitrum",
      "chain-state-base",
      "chain-state-ethereum",
      "chain-state-optimism",
      "uniswap-v3-contracts",
    ]);
    expect((await app.request("/v1/onchain/not-real")).status).toBe(404);
  });

  it("retains explicit section provenance when items are unavailable or partial", async () => {
    const snapshot = await buildOnchainSnapshot(fixtureDeps());
    for (const items of [[], snapshot.pools.slice(0, 1)]) {
      const state = items.length === 0 ? "unavailable" as const : "partial" as const;
      const app = new Hono();
      mountOnchainDoor(app, async () => ({
        ...snapshot,
        pools: items,
        status: {
          ...snapshot.status,
          state: "partial",
          complete: false,
          sections: {
            ...snapshot.status.sections,
            pools: { state, available: items.length, expected: 4 },
          },
        },
      }));
      const response = await app.request("/v1/onchain/pools");
      const body = await response.json();
      expect(body.sources.map((source: { id: string }) => source.id).sort()).toEqual([
        "chain-state-arbitrum",
        "chain-state-base",
        "chain-state-ethereum",
        "chain-state-optimism",
        "uniswap-v3-contracts",
      ]);
    }
  });

  it("backs off degraded snapshot refreshes instead of amplifying upstream failures", () => {
    expect(onchainSnapshotCacheTtl("ready")).toBe(20_000);
    expect(onchainSnapshotCacheTtl("partial")).toBe(30_000);
    expect(onchainSnapshotCacheTtl("unavailable")).toBe(30_000);
  });
});
