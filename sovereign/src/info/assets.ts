/**
 * The asset registry — "tzdata for money". An asset is a TABLE ROW: canonical
 * id (CAIP-19 for chain assets, iso4217: for fiat — fiat is a peer, no chain
 * privileged), symbol, decimals, aliases. This is the fix for stringly
 * identity: "USDC" is many assets; the registry is where ambiguity goes to be
 * named. Adding an asset is adding a row; the doors never change.
 */

export interface AssetRow {
  id: string; // canonical: caip19 or iso4217:XXX
  symbol: string;
  name: string;
  decimals: number;
  chain?: { caip2: string; label: string };
  aliases: string[];
  notes?: string;
}

const BTC_CAIP2 = "bip122:000000000019d6689c085ae165831e93";

export const ASSETS: AssetRow[] = [
  {
    id: "iso4217:GBP", symbol: "GBP", name: "Pound sterling", decimals: 2,
    aliases: ["gbp", "pound", "sterling", "£", "fiat:iso4217/gbp"],
  },
  {
    id: "iso4217:USD", symbol: "USD", name: "United States dollar", decimals: 2,
    aliases: ["usd", "dollar", "$", "fiat:iso4217/usd"],
  },
  {
    id: "iso4217:EUR", symbol: "EUR", name: "Euro", decimals: 2,
    aliases: ["eur", "euro", "€", "fiat:iso4217/eur"],
  },
  {
    id: `${BTC_CAIP2}/slip44:0`, symbol: "BTC", name: "Bitcoin", decimals: 8,
    chain: { caip2: BTC_CAIP2, label: "Bitcoin mainnet" },
    aliases: ["btc", "bitcoin", "xbt"],
    notes: "minor unit: satoshi",
  },
  {
    id: "cosmos:zerone-1/denom:uzrn", symbol: "ZRN", name: "Zerone", decimals: 6,
    chain: { caip2: "cosmos:zerone-1", label: "Zerone mainnet (the truth chain)" },
    aliases: ["zrn", "zerone", "uzrn"],
    notes: "minor unit: uzrn; supply hard-capped at 222,222,222 ZRN, zero premine",
  },
  {
    id: "eip155:8453/erc20:0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    symbol: "USDC", name: "USD Coin (native, Base)", decimals: 6,
    chain: { caip2: "eip155:8453", label: "Base mainnet" },
    aliases: ["usdc", "usdc-base", "usdc on base"],
    notes: "Circle-issued native USDC on Base — one of MANY assets called 'USDC'; the id is the truth",
  },
  {
    id: "eip155:8453/slip44:60", symbol: "ETH", name: "Ether (Base)", decimals: 18,
    chain: { caip2: "eip155:8453", label: "Base mainnet" },
    aliases: ["eth-base", "ether-base", "base-eth"],
    notes: "minor unit: wei; gas asset of Base",
  },
];

const byKey = new Map<string, AssetRow>();
for (const a of ASSETS) {
  byKey.set(a.id.toLowerCase(), a);
  for (const al of a.aliases) byKey.set(al.toLowerCase(), a);
}

export function resolveAsset(idOrAlias: string): AssetRow | undefined {
  // Hono has already percent-decoded the param — decoding again crashes on a raw '%'.
  return byKey.get(idOrAlias.trim().toLowerCase());
}

// Substring search across id / symbol / name / aliases — the disambiguation
// door. "usdc" returns every asset that answers to the name, ids first.
export function searchAssets(q: string): AssetRow[] {
  const needle = q.trim().toLowerCase();
  if (!needle) return [];
  return ASSETS.filter(
    (a) =>
      a.id.toLowerCase().includes(needle) ||
      a.symbol.toLowerCase().includes(needle) ||
      a.name.toLowerCase().includes(needle) ||
      a.aliases.some((al) => al.includes(needle)),
  );
}
