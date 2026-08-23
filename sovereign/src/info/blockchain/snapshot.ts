import { AAVE_ADDRESS_BOOK_SOURCE_ID, AAVE_ADDRESS_BOOK_URL, AAVE_USDC_MARKETS, readAaveUsdcMarket, type AaveUsdcMarketDefinition } from "./aave.ts";
import { CCTP_DOMAINS_URL, CCTP_FEES_DOCS_URL, CCTP_ROUTES, CCTP_SOURCE_ID, CIRCLE_DEVELOPER_TERMS_URL, readCctpRoutes, type CctpBatch } from "./bridges.ts";
import { chainSourceId, readChainPulse } from "./chains.ts";
import {
  CIRCLE_USDC_REGISTRY_SOURCE_ID,
  CIRCLE_USDC_REGISTRY_URL,
  NATIVE_USDC_DEPLOYMENTS,
  readNativeUsdcSupply,
  type NativeUsdcDeployment,
} from "./stablecoins.ts";
import { listBlockchainChains } from "./registry.ts";
import { createBlockchainRpcClient, type BlockchainRpcClient } from "./rpc.ts";
import type { ChainRegistryEntry, ReferenceBlock, RpcCallOptions } from "./types.ts";
import {
  referenceBlockIsStale,
  type ChainPulse,
  type LendingMarket,
  type LiquidityPool,
  type OnchainBriefing,
  type OnchainSection,
  type OnchainSnapshot,
  type OnchainSource,
  type OnchainThread,
  type OnchainUnavailable,
  type SectionStatus,
  type StablecoinObservation,
} from "./model.ts";
import {
  readUniswapPool,
  UNISWAP_USDC_WETH_POOLS,
  UNISWAP_V3_DEPLOYMENTS_URL,
  UNISWAP_V3_SOURCE_ID,
  type UniswapPoolDefinition,
} from "./uniswap.ts";

export interface OnchainDependencies {
  client: BlockchainRpcClient;
  now: () => Date;
  snapshot_window_ms: number;
  chain: (
    row: ChainRegistryEntry,
    client: BlockchainRpcClient,
    now: Date,
    signal: AbortSignal,
  ) => Promise<ChainPulse>;
  stablecoin: (
    deployment: NativeUsdcDeployment,
    client: BlockchainRpcClient,
    references: ReadonlyMap<string, ReferenceBlock>,
    now: Date,
    signal: AbortSignal,
  ) => Promise<StablecoinObservation>;
  lending: (
    definition: AaveUsdcMarketDefinition,
    client: BlockchainRpcClient,
    references: ReadonlyMap<string, ReferenceBlock>,
    now: Date,
    signal: AbortSignal,
  ) => Promise<LendingMarket>;
  pool: (
    definition: UniswapPoolDefinition,
    client: BlockchainRpcClient,
    references: ReadonlyMap<string, ReferenceBlock>,
    now: Date,
    signal: AbortSignal,
  ) => Promise<LiquidityPool>;
  bridges: (signal: AbortSignal) => Promise<CctpBatch>;
}

export const DEFAULT_ONCHAIN_SNAPSHOT_WINDOW_MS = 25_000;

interface SnapshotWindow {
  signal: AbortSignal;
  run<T>(load: () => Promise<T>): Promise<T>;
  close(): void;
}

function createSnapshotWindow(timeoutMs: number): SnapshotWindow {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) {
    throw new Error("invalid onchain snapshot window");
  }
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error("onchain snapshot deadline exceeded"));
    }, timeoutMs);
  });
  return {
    signal: controller.signal,
    run<T>(load: () => Promise<T>): Promise<T> {
      if (controller.signal.aborted) return Promise.reject(new Error("onchain snapshot deadline exceeded"));
      return Promise.race([Promise.resolve().then(load), expired]);
    },
    close() {
      if (timer !== undefined) clearTimeout(timer);
    },
  };
}

function withSignal(options: RpcCallOptions | undefined, signal: AbortSignal): RpcCallOptions {
  return { ...options, signal };
}

/** Ensure the shared whole-snapshot cancellation reaches every default RPC call. */
function signalBoundClient(client: BlockchainRpcClient, signal: AbortSignal): BlockchainRpcClient {
  return {
    getReferenceBlock: (selector, options) => client.getReferenceBlock(selector, withSignal(options, signal)),
    evmRead: (selector, method, params, options) => client.evmRead(selector, method, params, withSignal(options, signal)),
    evmCallsAtReference: (selector, calls, reference, options) =>
      client.evmCallsAtReference(selector, calls, reference, withSignal(options, signal)),
    bitcoinMempool: (selector, options) => client.bitcoinMempool(selector, withSignal(options, signal)),
    bitcoinFeeEstimate: (selector, options) => client.bitcoinFeeEstimate(selector, withSignal(options, signal)),
    solanaRead: (selector, method, params, options) => client.solanaRead(selector, method, params, withSignal(options, signal)),
    solanaPerformanceSamples: (selector, limit, options) =>
      client.solanaPerformanceSamples(selector, limit, withSignal(options, signal)),
    solanaPrioritizationFees: (selector, accounts, options) =>
      client.solanaPrioritizationFees(selector, accounts, withSignal(options, signal)),
  };
}

function sharedSignalFetch(signal: AbortSignal) {
  return async (input: string | URL | Request, init: RequestInit = {}): Promise<Response> => {
    const upstreamSignal = init.signal;
    if (!upstreamSignal || upstreamSignal === signal) return fetch(input, { ...init, signal });
    const controller = new AbortController();
    const abort = () => controller.abort();
    if (signal.aborted || upstreamSignal.aborted) controller.abort();
    else {
      signal.addEventListener("abort", abort, { once: true });
      upstreamSignal.addEventListener("abort", abort, { once: true });
    }
    try {
      return await fetch(input, { ...init, signal: controller.signal });
    } finally {
      signal.removeEventListener("abort", abort);
      upstreamSignal.removeEventListener("abort", abort);
    }
  };
}

const defaultClient = createBlockchainRpcClient();
const defaults: OnchainDependencies = {
  client: defaultClient,
  now: () => new Date(),
  snapshot_window_ms: DEFAULT_ONCHAIN_SNAPSHOT_WINDOW_MS,
  chain: readChainPulse,
  stablecoin: readNativeUsdcSupply,
  lending: readAaveUsdcMarket,
  pool: readUniswapPool,
  bridges: (signal) => readCctpRoutes({ fetch: sharedSignalFetch(signal) }),
};

function genericFailure(
  id: string,
  section: OnchainSection,
  title: string,
  retryable = true,
): OnchainUnavailable {
  return {
    id,
    section,
    title,
    detail: `${title} did not produce a usable, fully attributed observation in this snapshot. No zero or request-time substitute was inserted.`,
    retryable,
  };
}

function sectionStatus(available: number, expected: number, hasPartial = false): SectionStatus {
  return {
    state: available === 0 ? "unavailable" : available === expected && !hasPartial ? "ready" : "partial",
    available,
    expected,
  };
}

function registrySource(
  id: string,
  name: string,
  title: string,
  url: string,
  status: OnchainSource["status"],
  fetchedAt: string | undefined,
  note: string,
  license: OnchainSource["license"],
  extra: Partial<OnchainSource> = {},
): OnchainSource {
  return {
    id,
    name,
    title,
    url,
    status,
    cadence: "latest-state snapshot",
    license,
    ...(fetchedAt ? { fetched_at: fetchedAt } : {}),
    note,
    ...extra,
  };
}

function sourceState(available: number, expected: number, hasPartial = false): OnchainSource["status"] {
  return available === expected && !hasPartial ? "ok" : available === 0 ? "unavailable" : "partial";
}

function normalizeDependentFreshness<
  T extends StablecoinObservation | LendingMarket | LiquidityPool,
>(row: T, now: Date): T {
  const reference = row.receipt.reference_block;
  const stale = row.stale || (reference ? referenceBlockIsStale(reference, now) : false);
  if (!stale || (row.stale && row.status !== "observed")) return row;
  return {
    ...row,
    stale: true,
    status: row.status === "unavailable" ? "unavailable" : "partial",
  } as T;
}

function noteDependentPartial(
  unavailable: OnchainUnavailable[],
  row: StablecoinObservation | LendingMarket | LiquidityPool,
  section: OnchainSection,
  title: string,
) {
  if (row.status !== "partial") return;
  unavailable.push({
    id: `${row.id}-partial`,
    section,
    title,
    detail: row.stale
      ? `${title} resolved from a reference older than its source-aware freshness allowance.`
      : `${title} resolved only partially; no missing value was replaced with zero or request time.`,
    retryable: true,
  });
}

function makeBriefing(
  chains: ChainPulse[],
  stablecoins: StablecoinObservation[],
  lending: LendingMarket[],
  pools: LiquidityPool[],
  bridgeCount: number,
): OnchainBriefing[] {
  const earliest = (values: Array<string | null | undefined>) => values.filter((value): value is string => Boolean(value)).sort()[0] ?? null;
  return [
    {
      id: "brief-network-references",
      title: "Network pulse is block-bound",
      summary: `${chains.length} of ${listBlockchainChains().length} network references resolved with their actual finality or commitment label. Cross-chain finality is not collapsed into one score.`,
      category: "network",
      status: chains.length === listBlockchainChains().length &&
          chains.every((row) => row.status === "observed" && !row.stale)
        ? "observed"
        : chains.length > 0 ? "derived" : "unavailable",
      observed_at: earliest(chains.map((row) => row.reference_block.block_time?.iso)),
      source_ids: chains.map((row) => row.source_id),
    },
    {
      id: "brief-stable-credit",
      title: "Stable money and credit stay separate",
      summary: `${stablecoins.length} native-USDC supplies and ${lending.length} selected Aave USDC markets resolved. Contract supply is not reserves; gross supplied assets are not TVL.`,
      category: "stable-money",
      status: stablecoins.length > 0 || lending.length > 0 ? "derived" : "unavailable",
      observed_at: earliest([...stablecoins.map((row) => row.receipt.observed_at), ...lending.map((row) => row.receipt.observed_at)]),
      source_ids: [CIRCLE_USDC_REGISTRY_SOURCE_ID, AAVE_ADDRESS_BOOK_SOURCE_ID],
    },
    {
      id: "brief-pool-state",
      title: "Liquidity is shown without invented dollars",
      summary: `${pools.length} curated Uniswap V3 pools resolved at pinned blocks. Token balances and active liquidity units are shown as different facts—not TVL, depth, volume, or APY.`,
      category: "pool",
      status: pools.length === UNISWAP_USDC_WETH_POOLS.length &&
          pools.every((row) => row.status === "observed" && !row.stale)
        ? "observed"
        : pools.length > 0 ? "derived" : "unavailable",
      observed_at: earliest(pools.map((row) => row.receipt.observed_at)),
      source_ids: [UNISWAP_V3_SOURCE_ID],
    },
    {
      id: "brief-bridge-routes",
      title: "A bridge route is a trust boundary",
      summary: `${bridgeCount} CCTP V2 route fee references resolved. They describe burn-and-mint protocol modes—not transfer completion, delivery time, or bridge safety.`,
      category: "bridge",
      status: bridgeCount > 0 ? "reference" : "unavailable",
      observed_at: null,
      source_ids: [CCTP_SOURCE_ID],
    },
  ];
}

function makeThreads(
  chains: ChainPulse[],
  stablecoins: StablecoinObservation[],
  lending: LendingMarket[],
  pools: LiquidityPool[],
): OnchainThread[] {
  const chainNames = new Set(chains.map((row) => row.name));
  return [{
    id: "thread-settlement-fees",
    title: "Settlement demand → execution conditions",
    observed: chains.flatMap((row) => row.metrics.filter((metric) => metric.id.includes("base-fee") || metric.id.includes("gas-use") || metric.id.includes("three-block-fee")).map((metric) => `${row.name}: ${metric.label} ${metric.value.display}`)),
    possible_channels: ["More block demand can affect fee conditions.", "L2 execution fees and L1 data/settlement costs move through different mechanisms."],
    limits: ["One pinned block is context, not a trend or causal estimate.", "Network fee models and finality semantics are not interchangeable."],
    source_ids: chains.map((row) => row.source_id),
  }, {
    id: "thread-stable-credit-pools",
    title: "Native stable money → selected credit and pool state",
    observed: [
      `${stablecoins.length} native USDC supply observations`,
      `${lending.length} selected Aave native-USDC markets`,
      `${pools.length} curated USDC/WETH pools`,
    ],
    possible_channels: ["Issuer-native supply is one input to chain liquidity.", "Borrow demand and pool inventory can redistribute stablecoin availability across protocols."],
    limits: ["Supply does not prove reserves or price stability.", "Selected contracts do not represent all DeFi activity or all liquidity on a chain."],
    source_ids: [CIRCLE_USDC_REGISTRY_SOURCE_ID, AAVE_ADDRESS_BOOK_SOURCE_ID, UNISWAP_V3_SOURCE_ID],
  }, {
    id: "thread-bridge-trust",
    title: "Cross-chain movement → another settlement path",
    observed: Array.from(chainNames).filter((name) => name !== "Bitcoin" && name !== "BNB Smart Chain").map((name) => `${name} participates in the selected native-USDC/CCTP map.`),
    possible_channels: ["CCTP burns on the source domain and mints after attestation and destination execution.", "Standard and fast modes use different finality thresholds and protocol fees."],
    limits: ["A fee reference is not an observed transfer.", "Initiated, attested, received, and minted are separate states; no bridge ranking or safety score is inferred."],
    source_ids: [CCTP_SOURCE_ID, CIRCLE_USDC_REGISTRY_SOURCE_ID],
  }];
}

async function assembleOnchainSnapshot(
  deps: OnchainDependencies,
  window: SnapshotWindow,
): Promise<OnchainSnapshot> {
  const now = deps.now();
  const generatedAt = now.toISOString();
  const chainRows = listBlockchainChains();
  const client = signalBoundClient(deps.client, window.signal);
  const chainSettled = await Promise.allSettled(chainRows.map((row) =>
    window.run(() => deps.chain(row, client, now, window.signal))
  ));
  const chains: ChainPulse[] = [];
  const unavailable: OnchainUnavailable[] = [];
  const chainAvailability = new Map<string, "ok" | "partial" | "unavailable">();
  chainSettled.forEach((result, index) => {
    const row = chainRows[index];
    if (result.status === "fulfilled") {
      chains.push(result.value);
      chainAvailability.set(row.key, result.value.status === "observed" ? "ok" : "partial");
      if (result.value.status === "partial") {
        unavailable.push({
          id: `network-${row.key}-partial`,
          section: "chains",
          title: `${row.label} supplementary network context`,
          detail: result.value.stale
            ? `${row.label}'s reference block is older than the source-aware freshness allowance.`
            : `${row.label}'s reference resolved, but one or more bounded fee or activity reads did not.`,
          retryable: true,
        });
      }
    } else {
      chainAvailability.set(row.key, "unavailable");
      unavailable.push(genericFailure(`network-${row.key}`, "chains", `${row.label} chain state`));
    }
  });
  const references = new Map<string, ReferenceBlock>();
  chains.forEach((row) => {
    references.set(row.reference_block.chain_key, row.reference_block);
    references.set(row.reference_block.chain, row.reference_block);
  });

  const [stableSettled, lendingSettled, poolSettled, bridgeSettled] = await Promise.all([
    Promise.allSettled(NATIVE_USDC_DEPLOYMENTS.map((definition) =>
      window.run(() => deps.stablecoin(definition, client, references, now, window.signal))
    )),
    Promise.allSettled(AAVE_USDC_MARKETS.map((definition) =>
      window.run(() => deps.lending(definition, client, references, now, window.signal))
    )),
    Promise.allSettled(UNISWAP_USDC_WETH_POOLS.map((definition) =>
      window.run(() => deps.pool(definition, client, references, now, window.signal))
    )),
    window.run(() => deps.bridges(window.signal)).then(
      (value): PromiseSettledResult<CctpBatch> => ({ status: "fulfilled", value }),
      (reason): PromiseSettledResult<CctpBatch> => ({ status: "rejected", reason }),
    ),
  ]);

  const stablecoins: StablecoinObservation[] = [];
  stableSettled.forEach((result, index) => {
    const definition = NATIVE_USDC_DEPLOYMENTS[index];
    if (result.status === "fulfilled") {
      const row = normalizeDependentFreshness(result.value, now);
      stablecoins.push(row);
      noteDependentPartial(unavailable, row, "stablecoins", `Native USDC supply on ${definition.chain_key}`);
    } else unavailable.push(genericFailure(`usdc-supply-${definition.chain_key}`, "stablecoins", `Native USDC supply on ${definition.chain_key}`));
  });
  const lendingMarkets: LendingMarket[] = [];
  lendingSettled.forEach((result, index) => {
    const definition = AAVE_USDC_MARKETS[index];
    if (result.status === "fulfilled") {
      const row = normalizeDependentFreshness(result.value, now);
      lendingMarkets.push(row);
      noteDependentPartial(unavailable, row, "lending_markets", `Aave V3 native-USDC market on ${definition.chain_key}`);
    } else unavailable.push(genericFailure(`aave-v3-usdc-${definition.chain_key}`, "lending_markets", `Aave V3 native-USDC market on ${definition.chain_key}`));
  });
  const pools: LiquidityPool[] = [];
  poolSettled.forEach((result, index) => {
    const definition = UNISWAP_USDC_WETH_POOLS[index];
    if (result.status === "fulfilled") {
      const row = normalizeDependentFreshness(result.value, now);
      pools.push(row);
      noteDependentPartial(unavailable, row, "pools", `Uniswap V3 USDC/WETH pool on ${definition.chain_key}`);
    } else unavailable.push(genericFailure(`uniswap-v3-usdc-weth-${definition.chain_key}`, "pools", `Uniswap V3 USDC/WETH pool on ${definition.chain_key}`));
  });
  let bridgeRoutes = [] as CctpBatch["routes"];
  if (bridgeSettled.status === "fulfilled") {
    bridgeRoutes = bridgeSettled.value.routes;
    bridgeSettled.value.failures.forEach((failure) => unavailable.push({
      id: failure.id,
      section: "bridge_routes",
      title: `CCTP V2 route ${failure.id.replace("cctp-v2-", "").replace("-", " → ")}`,
      detail: failure.detail,
      retryable: failure.retryable,
    }));
  } else {
    CCTP_ROUTES.forEach((route) => unavailable.push(genericFailure(
      `cctp-v2-${route.source}-${route.destination}`,
      "bridge_routes",
      `CCTP V2 ${route.source} → ${route.destination} fee reference`,
    )));
  }

  const sections: Record<OnchainSection, SectionStatus> = {
    chains: sectionStatus(chains.length, chainRows.length, chains.some((row) => row.status === "partial")),
    stablecoins: sectionStatus(stablecoins.length, NATIVE_USDC_DEPLOYMENTS.length,
      stablecoins.some((row) => row.status !== "observed")),
    lending_markets: sectionStatus(lendingMarkets.length, AAVE_USDC_MARKETS.length,
      lendingMarkets.some((row) => row.status !== "observed")),
    pools: sectionStatus(pools.length, UNISWAP_USDC_WETH_POOLS.length,
      pools.some((row) => row.status !== "observed")),
    bridge_routes: sectionStatus(bridgeRoutes.length, CCTP_ROUTES.length,
      bridgeRoutes.some((row) => row.status !== "reference")),
  };
  const sources: OnchainSource[] = chainRows.map((row) => registrySource(
    chainSourceId(row.key),
    `${row.label} chain state`,
    `${row.label} read-only chain transport`,
    row.documentation.explorer_url,
    chainAvailability.get(row.key) ?? "unavailable",
    chains.find((chain) => chain.reference_block.chain_key === row.key)?.reference_block.fetched_at,
    `Registry-routed ${row.family === "evm" ? "JSON-RPC" : row.family === "solana" ? "Solana RPC" : "Esplora"} transport. Configured endpoint URLs and credentials are never serialized. Public defaults are rate-limited fallbacks; a dedicated or self-hosted endpoint is recommended for production reliability.`,
    "public-onchain-derived",
    { methodology_url: row.documentation.rpc_documentation_url, retrieval: "live_fetch" },
  ));
  sources.push(
    registrySource(
      CIRCLE_USDC_REGISTRY_SOURCE_ID,
      "Circle native USDC registry",
      "Official USDC contract and mint addresses",
      CIRCLE_USDC_REGISTRY_URL,
      sourceState(stablecoins.length, NATIVE_USDC_DEPLOYMENTS.length,
        stablecoins.some((row) => row.status !== "observed" || row.stale)),
      undefined,
      "The registry identifies issuer-native USDC. CashLoom independently reads each contract or mint supply from chain state.",
      "attribution-required",
      {
        terms_url: CIRCLE_DEVELOPER_TERMS_URL,
        retrieval: "verified_transcription",
        verified_at: "2026-08-20T00:00:00.000Z",
      },
    ),
    registrySource(
      AAVE_ADDRESS_BOOK_SOURCE_ID,
      "Aave V3 Address Book",
      "Official Aave V3 deployments and data-provider interface",
      AAVE_ADDRESS_BOOK_URL,
      sourceState(lendingMarkets.length, AAVE_USDC_MARKETS.length,
        lendingMarkets.some((row) => row.status !== "observed" || row.stale)),
      undefined,
      "MIT-licensed deployment metadata verified 2026-08-20; values are read independently from AaveProtocolDataProvider at pinned blocks.",
      "attribution-required",
      {
        terms_url: "https://github.com/aave-dao/aave-address-book/blob/main/LICENSE",
        retrieval: "verified_transcription",
        verified_at: "2026-08-20T00:00:00.000Z",
      },
    ),
    registrySource(
      UNISWAP_V3_SOURCE_ID,
      "Uniswap V3 contracts",
      "Official V3 factory and pool contracts",
      UNISWAP_V3_DEPLOYMENTS_URL,
      sourceState(pools.length, UNISWAP_USDC_WETH_POOLS.length,
        pools.some((row) => row.status !== "observed" || row.stale)),
      undefined,
      "Factory discovery and pool state are read directly at pinned blocks. CashLoom does not rely on a third-party analytics dashboard or public subgraph.",
      "public-onchain-derived",
      {
        methodology_url: "https://docs.uniswap.org/contracts/v3/reference/core/interfaces/pool/IUniswapV3PoolState",
        retrieval: "verified_transcription",
        verified_at: "2026-08-20T00:00:00.000Z",
      },
    ),
    registrySource(
      CCTP_SOURCE_ID,
      "Circle CCTP V2",
      "Official CCTP route fee references",
      CCTP_FEES_DOCS_URL,
      sourceState(bridgeRoutes.length, CCTP_ROUTES.length,
        bridgeRoutes.some((row) => row.status !== "reference")),
      bridgeRoutes.map((route) => route.fetched_at).sort()[0],
      "Circle Iris supplies current standard/fast protocol fee references. CashLoom does not present them as executed quotes, transfers, or completion records.",
      "contract-required",
      { methodology_url: CCTP_DOMAINS_URL, terms_url: CIRCLE_DEVELOPER_TERMS_URL, retrieval: "live_fetch" },
    ),
  );
  const staleCount = chains.filter((row) => row.stale).length +
    stablecoins.filter((row) => row.stale).length +
    lendingMarkets.filter((row) => row.stale).length +
    pools.filter((row) => row.stale).length;
  const complete = Object.values(sections).every((section) => section.state === "ready") && staleCount === 0;
  const itemCount = chains.length + stablecoins.length + lendingMarkets.length + pools.length + bridgeRoutes.length;
  const state = complete ? "ready" : itemCount === 0 ? "unavailable" : "partial";

  return {
    "@type": "OnchainSnapshot",
    schema: "cashloom.onchain/1",
    generated_at: generatedAt,
    scope: "latest_state",
    status: {
      state,
      complete,
      available_sources: sources.filter((source) => source.status !== "unavailable").length,
      total_sources: sources.length,
      stale_count: staleCount,
      sections,
      unavailable,
    },
    briefing: makeBriefing(chains, stablecoins, lendingMarkets, pools, bridgeRoutes.length),
    chains,
    stablecoins,
    lending_markets: lendingMarkets,
    pools,
    bridge_routes: bridgeRoutes,
    threads: makeThreads(chains, stablecoins, lendingMarkets, pools),
    sources,
  };
}

export async function buildOnchainSnapshot(
  overrides: Partial<OnchainDependencies> = {},
): Promise<OnchainSnapshot> {
  const deps: OnchainDependencies = { ...defaults, ...overrides };
  const window = createSnapshotWindow(deps.snapshot_window_ms);
  try {
    return await assembleOnchainSnapshot(deps, window);
  } finally {
    window.close();
  }
}
