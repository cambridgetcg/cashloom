/**
 * Fixed mainnet registry for the Blockchain door.
 *
 * RPC endpoints are deliberately not properties of serializable registry rows.
 * A URL can only come from a server-side environment variable or the fixed
 * fallback table below, and `InternalRpcTarget#toJSON` emits the safe receipt.
 */

import type {
  Caip2Id,
  ChainKey,
  ChainRegistryEntry,
  EvmChainKey,
  RpcSourceReceipt,
} from "./types.ts";

export const BITCOIN_MAINNET_GENESIS =
  "000000000019d6689c085ae165831e934ff763ae46a2a6c172b3f1b60a8ce26f";
export const SOLANA_MAINNET_GENESIS =
  "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d";

const BTC_CAIP2 = `bip122:${BITCOIN_MAINNET_GENESIS.slice(0, 32)}` as Caip2Id;
const SOLANA_CAIP2 = `solana:${SOLANA_MAINNET_GENESIS.slice(0, 32)}` as Caip2Id;

const rows = [
  {
    key: "bitcoin",
    caip2: BTC_CAIP2,
    family: "bitcoin",
    label: "Bitcoin",
    aliases: ["btc", "bitcoin-mainnet"],
    native_asset: {
      symbol: "BTC",
      name: "Bitcoin",
      decimals: 8,
      caip19: `${BTC_CAIP2}/slip44:0`,
    },
    documentation: {
      official_url: "https://bitcoin.org/",
      explorer_url: "https://blockstream.info/",
      rpc_documentation_url: "https://github.com/Blockstream/esplora/blob/master/API.md",
    },
    rpc_env: "CASHLOOM_BITCOIN_HTTP_URL",
    genesis_hash: BITCOIN_MAINNET_GENESIS,
    reference_cache_ms: 15_000,
  },
  {
    key: "ethereum",
    caip2: "eip155:1",
    family: "evm",
    label: "Ethereum",
    aliases: ["eth", "ethereum-mainnet"],
    native_asset: {
      symbol: "ETH",
      name: "Ether",
      decimals: 18,
      caip19: "eip155:1/slip44:60",
    },
    documentation: {
      official_url: "https://ethereum.org/",
      explorer_url: "https://etherscan.io/",
      rpc_documentation_url: "https://ethereum.org/developers/docs/apis/json-rpc/",
    },
    rpc_env: "CASHLOOM_ETHEREUM_RPC_URL",
    evm_chain_id: "1",
    reference_tags: ["finalized", "safe", "latest"],
    reference_cache_ms: 12_000,
  },
  {
    key: "base",
    caip2: "eip155:8453",
    family: "evm",
    label: "Base",
    aliases: ["base-mainnet"],
    native_asset: {
      symbol: "ETH",
      name: "Ether",
      decimals: 18,
      caip19: "eip155:8453/slip44:60",
    },
    documentation: {
      official_url: "https://base.org/",
      explorer_url: "https://basescan.org/",
      rpc_documentation_url: "https://docs.base.org/base-chain/api-reference/rpc-overview",
    },
    rpc_env: "CASHLOOM_BASE_RPC_URL",
    evm_chain_id: "8453",
    reference_tags: ["finalized", "safe", "latest"],
    reference_cache_ms: 8_000,
  },
  {
    key: "arbitrum",
    caip2: "eip155:42161",
    family: "evm",
    label: "Arbitrum One",
    aliases: ["arb", "arbitrum-one"],
    native_asset: {
      symbol: "ETH",
      name: "Ether",
      decimals: 18,
      caip19: "eip155:42161/slip44:60",
    },
    documentation: {
      official_url: "https://arbitrum.io/",
      explorer_url: "https://arbiscan.io/",
      rpc_documentation_url: "https://docs.arbitrum.io/run-arbitrum-node/run-full-node",
    },
    rpc_env: "CASHLOOM_ARBITRUM_RPC_URL",
    evm_chain_id: "42161",
    reference_tags: ["finalized", "safe", "latest"],
    reference_cache_ms: 8_000,
  },
  {
    key: "optimism",
    caip2: "eip155:10",
    family: "evm",
    label: "OP Mainnet",
    aliases: ["op", "op-mainnet", "optimism-mainnet"],
    native_asset: {
      symbol: "ETH",
      name: "Ether",
      decimals: 18,
      caip19: "eip155:10/slip44:60",
    },
    documentation: {
      official_url: "https://www.optimism.io/",
      explorer_url: "https://explorer.optimism.io/",
      rpc_documentation_url: "https://docs.optimism.io/op-mainnet/network-information/connecting-to-op",
    },
    rpc_env: "CASHLOOM_OPTIMISM_RPC_URL",
    evm_chain_id: "10",
    reference_tags: ["finalized", "safe", "latest"],
    reference_cache_ms: 8_000,
  },
  {
    key: "polygon",
    caip2: "eip155:137",
    family: "evm",
    label: "Polygon PoS",
    aliases: ["matic", "polygon-pos"],
    native_asset: {
      symbol: "POL",
      name: "POL",
      decimals: 18,
      caip19: "eip155:137/slip44:966",
    },
    documentation: {
      official_url: "https://polygon.technology/",
      explorer_url: "https://polygonscan.com/",
      rpc_documentation_url: "https://docs.polygon.technology/pos/reference/rpc-endpoints/",
    },
    rpc_env: "CASHLOOM_POLYGON_RPC_URL",
    evm_chain_id: "137",
    reference_tags: ["finalized", "safe", "latest"],
    reference_cache_ms: 8_000,
  },
  {
    key: "bsc",
    caip2: "eip155:56",
    family: "evm",
    label: "BNB Smart Chain",
    aliases: ["bnb", "bnb-chain", "binance-smart-chain"],
    native_asset: {
      symbol: "BNB",
      name: "BNB",
      decimals: 18,
      caip19: "eip155:56/slip44:714",
    },
    documentation: {
      official_url: "https://www.bnbchain.org/",
      explorer_url: "https://bscscan.com/",
      rpc_documentation_url: "https://docs.bnbchain.org/bnb-smart-chain/developers/json_rpc/json-rpc-endpoint/",
    },
    rpc_env: "CASHLOOM_BSC_RPC_URL",
    evm_chain_id: "56",
    reference_tags: ["finalized", "safe", "latest"],
    reference_cache_ms: 8_000,
  },
  {
    key: "solana",
    caip2: SOLANA_CAIP2,
    family: "solana",
    label: "Solana",
    aliases: ["sol", "solana-mainnet"],
    native_asset: {
      symbol: "SOL",
      name: "Solana",
      decimals: 9,
      caip19: `${SOLANA_CAIP2}/slip44:501`,
    },
    documentation: {
      official_url: "https://solana.com/",
      explorer_url: "https://explorer.solana.com/",
      rpc_documentation_url: "https://solana.com/docs/rpc/http",
    },
    rpc_env: "CASHLOOM_SOLANA_RPC_URL",
    genesis_hash: SOLANA_MAINNET_GENESIS,
    reference_cache_ms: 4_000,
  },
] as const satisfies readonly ChainRegistryEntry[];

type InternalDefaults = {
  provider: string;
  transport: RpcSourceReceipt["transport"];
};

const defaults: Record<ChainKey, InternalDefaults> = {
  bitcoin: {
    provider: "Blockstream public Esplora",
    transport: "esplora-http",
  },
  ethereum: {
    provider: "PublicNode community RPC",
    transport: "json-rpc",
  },
  base: {
    provider: "PublicNode community RPC",
    transport: "json-rpc",
  },
  arbitrum: {
    provider: "Arbitrum public RPC",
    transport: "json-rpc",
  },
  optimism: {
    provider: "PublicNode community RPC",
    transport: "json-rpc",
  },
  polygon: {
    provider: "Polygon-listed dRPC endpoint",
    transport: "json-rpc",
  },
  bsc: {
    provider: "BNB Chain public RPC",
    transport: "json-rpc",
  },
  solana: {
    provider: "Solana Labs public RPC",
    transport: "json-rpc",
  },
};

// The public registry is fixed at runtime as well as readonly in TypeScript.
for (const row of rows) {
  const registryRow: ChainRegistryEntry = row;
  Object.freeze(row.aliases);
  Object.freeze(row.native_asset);
  Object.freeze(row.documentation);
  if (registryRow.reference_tags) Object.freeze(registryRow.reference_tags);
  Object.freeze(row);
}
Object.freeze(rows);
for (const value of Object.values(defaults)) Object.freeze(value);
Object.freeze(defaults);

const bySelector = new Map<string, ChainRegistryEntry>();
for (const row of rows) {
  for (const selector of [row.key, row.caip2, ...row.aliases]) {
    const normalized = selector.toLowerCase();
    if (bySelector.has(normalized)) throw new Error(`duplicate blockchain registry selector: ${normalized}`);
    bySelector.set(normalized, row);
  }
}

export function listBlockchainChains(): readonly ChainRegistryEntry[] {
  return rows;
}

export function resolveBlockchainChain(selector: string): ChainRegistryEntry | undefined {
  const normalized = selector.trim().toLowerCase();
  if (!normalized) return undefined;
  return bySelector.get(normalized);
}

export function requireBlockchainChain(selector: string): ChainRegistryEntry {
  const row = resolveBlockchainChain(selector);
  if (!row) throw new Error("CHAIN_NOT_FOUND");
  return row;
}

export function isEvmChain(row: ChainRegistryEntry): row is ChainRegistryEntry & {
  key: EvmChainKey;
  family: "evm";
  evm_chain_id: `${bigint}`;
  reference_tags: readonly ("finalized" | "safe" | "latest")[];
} {
  return row.family === "evm";
}

function assertConfiguredEndpoint(raw: string): void {
  if (!raw || raw.length > 4096) throw new Error("RPC_CONFIGURATION_INVALID");
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("RPC_CONFIGURATION_INVALID");
  }
  const localHttp =
    url.protocol === "http:" &&
    (url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]");
  if (url.protocol !== "https:" && !localHttp) throw new Error("RPC_CONFIGURATION_INVALID");
  if (url.username || url.password || url.hash) throw new Error("RPC_CONFIGURATION_INVALID");
}

export function blockchainRpcReceipt(
  selector: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
): RpcSourceReceipt {
  const entry = requireBlockchainChain(selector);
  const configured = env[entry.rpc_env]?.trim();
  if (configured) assertConfiguredEndpoint(configured);
  const fallback = defaults[entry.key];
  return Object.freeze({
    chain: entry.caip2,
    provider: configured ? "Configured RPC provider" : fallback.provider,
    transport: fallback.transport,
    configuration: configured ? "environment" : "public-default",
    rpc_documentation_url: entry.documentation.rpc_documentation_url,
    explorer_url: entry.documentation.explorer_url,
    endpoint_disclosed: false,
  });
}
