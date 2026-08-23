/**
 * Crypto spot prices — a spot price is FX with a crypto base. Same MoneyFact
 * envelope, same makeFact(), served the honest way: an ON-CHAIN oracle answer
 * read via a public RPC. That answer is public and re-derivable by anyone, so
 * it is proof_state:tested + redistribution:onchain-rederivable — never a
 * relayed third-party number. We read Chainlink aggregators (latestRoundData);
 * adding a price is adding a registry row, the door never changes.
 *
 * Honesty guards, all LOUD (a bad or stale price refuses, never a silent number):
 *   - answer must be > 0 (int256 decoded, refuse ≤ 0);
 *   - the aggregator's own decimals() must match the row (refuse a wrong feed);
 *   - its description() must match the row (a second refusing cross-check);
 *   - observed_at is the oracle's OWN updatedAt, never new Date();
 *   - if age > the feed heartbeat, the fact is STALE and the door refuses (503).
 *
 * Fetchers are injectable so tests never touch the network (fees.ts template).
 */

import { decodeAbiParameters } from "viem";
import { makeFact, type MoneyFact, type Source } from "./money-fact.ts";

const ETH_RPC = (): string => process.env.CASHLOOM_ETH_RPC_URL?.trim() || "https://ethereum-rpc.publicnode.com";

// function selectors
const SEL_LATEST_ROUND = "0xfeaf968c"; // latestRoundData()
const SEL_DECIMALS = "0x313ce567"; // decimals()
const SEL_DESCRIPTION = "0x7284e416"; // description()

export interface PriceFeed {
  base: string; // CAIP-19 of the BASE asset priced (NOT the aggregator)
  quote: string; // CAIP-19 of the quote, e.g. "iso4217:USD"
  symbol: string; // "ETH"
  description: string; // the aggregator's own description(), cross-checked
  caip2: string; // chain the aggregator lives on
  aggregator: `0x${string}`;
  decimals: number; // EXPECTED oracle decimals, cross-checked on-chain
  base_decimals: number; // the BASE asset's own minor-unit scale (sats=8, wei=18) — how to read an input amount
  heartbeat_s: number; // publish cadence → stale_after_s
  aliases: string[];
}

// First slice: L1 mainnet feeds (no L2 sequencer dependency to reason about).
// Addresses per docs.chain.link — treated as load-bearing constants.
export const PRICE_FEEDS: PriceFeed[] = [
  {
    base: "eip155:1/slip44:60",
    quote: "iso4217:USD",
    symbol: "ETH",
    description: "ETH / USD",
    caip2: "eip155:1",
    aggregator: "0x5f4eC3Df9cbd43714FE2740f5E3616155c5b8419",
    decimals: 8,
    base_decimals: 18, // wei
    heartbeat_s: 3600,
    aliases: ["eth", "ether", "eip155:1/slip44:60"],
  },
  {
    base: "bip122:000000000019d6689c085ae165831e93/slip44:0",
    quote: "iso4217:USD",
    symbol: "BTC",
    description: "BTC / USD",
    caip2: "eip155:1",
    aggregator: "0xF4030086522a5bEEa4988F8cA5B36dbC97BeE88c",
    decimals: 8,
    base_decimals: 8, // satoshi
    heartbeat_s: 3600,
    aliases: ["btc", "bitcoin", "bip122:000000000019d6689c085ae165831e93/slip44:0"],
  },
];

const byKey = new Map<string, PriceFeed>();
for (const f of PRICE_FEEDS) {
  byKey.set(f.symbol.toLowerCase(), f);
  byKey.set(f.base.toLowerCase(), f);
  for (const a of f.aliases) byKey.set(a.toLowerCase(), f);
}
/** Resolve a feed by symbol, CAIP-19 base, or alias (quote defaults to USD). */
export function resolveFeed(baseIdOrAlias: string): PriceFeed | undefined {
  const raw = decodeURIComponent(baseIdOrAlias);
  return byKey.get(raw.toLowerCase());
}
export function listFeeds() {
  return PRICE_FEEDS.map((f) => ({ base: f.base, quote: f.quote, symbol: f.symbol, aliases: f.aliases, chain: f.caip2, price_door: `/v1/price/${f.symbol}/USD`, heartbeat_s: f.heartbeat_s }));
}

// ── the reader ───────────────────────────────────────────────────────────
export interface RawRound {
  roundId: bigint;
  answer: bigint;
  updatedAt: bigint; // seconds
}
export type OracleFetchers = {
  roundData(rpc: string, aggregator: string): Promise<RawRound>;
  decimals(rpc: string, aggregator: string): Promise<number>;
  description(rpc: string, aggregator: string): Promise<string>;
};

async function ethCall(rpc: string, to: string, data: string): Promise<`0x${string}`> {
  const res = await fetch(rpc, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_call", params: [{ to, data }, "latest"] }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error("PRICE_RPC_HTTP_ERROR");
  const body = (await res.json()) as { result?: string; error?: { message?: string } };
  // Provider error bodies can echo request URLs, headers, or account metadata.
  // Keep the diagnostic private to the adapter and expose only the fixed public
  // failure contract below.
  if (!body.result) throw new Error("PRICE_RPC_RESULT_MISSING");
  return body.result as `0x${string}`;
}

// decimals()/description() are immutable — cache forever per aggregator.
const immutableCache = new Map<string, { decimals: number; description: string }>();
// roundData — 30s micro-cache on the default path (injected fetchers bypass).
const roundCache = new Map<string, { at: number; round: RawRound }>();

export const defaultFetchers: OracleFetchers = {
  async roundData(rpc, aggregator) {
    const hit = roundCache.get(aggregator);
    if (hit && Date.now() - hit.at < 30_000) return hit.round;
    const raw = await ethCall(rpc, aggregator, SEL_LATEST_ROUND);
    const [roundId, answer, , updatedAt] = decodeAbiParameters(
      [{ type: "uint80" }, { type: "int256" }, { type: "uint256" }, { type: "uint256" }, { type: "uint80" }],
      raw,
    ) as unknown as [bigint, bigint, bigint, bigint, bigint];
    const round: RawRound = { roundId, answer, updatedAt };
    roundCache.set(aggregator, { at: Date.now(), round });
    return round;
  },
  async decimals(rpc, aggregator) {
    const raw = await ethCall(rpc, aggregator, SEL_DECIMALS);
    return Number((decodeAbiParameters([{ type: "uint8" }], raw) as unknown as [bigint | number])[0]);
  },
  async description(rpc, aggregator) {
    const raw = await ethCall(rpc, aggregator, SEL_DESCRIPTION);
    return (decodeAbiParameters([{ type: "string" }], raw) as unknown as [string])[0];
  },
};

export const PRICE_FAILURE = Object.freeze({
  stale: {
    code: "price_oracle_stale",
    message: "The on-chain price observation is older than its configured heartbeat.",
  },
  answer: {
    code: "price_oracle_answer_invalid",
    message: "The on-chain price source returned a non-positive answer.",
  },
  decimals: {
    code: "price_oracle_decimals_mismatch",
    message: "The on-chain price source decimals did not match the configured feed.",
  },
  description: {
    code: "price_oracle_description_mismatch",
    message: "The on-chain price source description did not match the configured feed.",
  },
  upstream: {
    code: "price_upstream_unavailable",
    message: "The on-chain price source did not answer with a usable observation.",
  },
} as const);

export type PriceFailureCode = (typeof PRICE_FAILURE)[keyof typeof PRICE_FAILURE]["code"];

export type OracleResult =
  | { kind: "price"; fact: MoneyFact; age_s: number; heartbeat_s: number }
  | { kind: "stale"; pair: string; code: typeof PRICE_FAILURE.stale.code; age_s: number; heartbeat_s: number; updated_at: string }
  | { kind: "invalid"; pair: string; code: PriceFailureCode; reason: string }
  | { kind: "unreachable"; pair: string; code: typeof PRICE_FAILURE.upstream.code; detail: string };

function sourcesFor(feed: PriceFeed, roundId: bigint): Source[] {
  return [{
    name: `Chainlink ${feed.description} aggregator (on-chain; round ${roundId.toString()})`,
    // Never publish the configured RPC URL: hosted provider endpoints commonly
    // contain credentials. The public contract is the durable verification URL.
    url: `https://etherscan.io/address/${feed.aggregator}#readContract`,
    fetched_at: new Date().toISOString(),
  }];
}

/** Read a feed's on-chain price with all guards. Never returns a stale or
 *  unusable number as a price — those are their own kinds the door refuses. */
export async function readPrice(feed: PriceFeed, fetchers: OracleFetchers = defaultFetchers): Promise<OracleResult> {
  const pair = `${feed.symbol}/USD`;
  const rpc = ETH_RPC();
  let round: RawRound, onchainDecimals: number, onchainDesc: string;
  // The immutable-meta cache optimises the REAL network reader only; injected
  // fetchers (tests, alt readers) are always honoured fresh, never shadowed.
  const useCache = fetchers === defaultFetchers;
  try {
    const meta = useCache ? immutableCache.get(feed.aggregator) : undefined;
    [round, onchainDecimals, onchainDesc] = await Promise.all([
      fetchers.roundData(rpc, feed.aggregator),
      meta ? Promise.resolve(meta.decimals) : fetchers.decimals(rpc, feed.aggregator),
      meta ? Promise.resolve(meta.description) : fetchers.description(rpc, feed.aggregator),
    ]);
    if (useCache && !meta) immutableCache.set(feed.aggregator, { decimals: onchainDecimals, description: onchainDesc });
  } catch {
    return {
      kind: "unreachable",
      pair,
      code: PRICE_FAILURE.upstream.code,
      detail: PRICE_FAILURE.upstream.message,
    };
  }

  // guard: the answer must be a positive number
  if (round.answer <= 0n) {
    return { kind: "invalid", pair, code: PRICE_FAILURE.answer.code, reason: PRICE_FAILURE.answer.message };
  }
  // guard: the aggregator must be the one we think it is
  if (onchainDecimals !== feed.decimals) {
    return { kind: "invalid", pair, code: PRICE_FAILURE.decimals.code, reason: PRICE_FAILURE.decimals.message };
  }
  if (onchainDesc.trim() !== feed.description) {
    return { kind: "invalid", pair, code: PRICE_FAILURE.description.code, reason: PRICE_FAILURE.description.message };
  }

  // guard: staleness, measured against the ORACLE's own clock
  const updatedMs = Number(round.updatedAt) * 1000;
  const observed_at = new Date(updatedMs).toISOString();
  const age_s = Math.max(0, Math.round((Date.now() - updatedMs) / 1000));
  if (age_s > feed.heartbeat_s) {
    return { kind: "stale", pair, code: PRICE_FAILURE.stale.code, age_s, heartbeat_s: feed.heartbeat_s, updated_at: observed_at };
  }

  const fact = makeFact({
    subject: feed.base,
    predicate: "spot_price",
    value: round.answer.toString(),
    unit: feed.quote,
    decimals: onchainDecimals,
    plane: "public",
    method: "observed",
    proof_state: "tested",
    redistribution: "onchain-rederivable",
    sources: sourcesFor(feed, round.roundId),
    observed_at, // the oracle's round clock, NEVER new Date()
    stale_after_s: feed.heartbeat_s,
    recompute: {
      how: `eth_call getRoundData(${round.roundId.toString()}) @ ${feed.aggregator} on ${feed.caip2} via {CASHLOOM_ETH_RPC_URL|public RPC}; word[1]=answer; USD per 1 ${feed.symbol} = answer × 10^-${onchainDecimals}; observed_at = word[3] updatedAt. decimals()=${onchainDecimals} and description()='${feed.description}' cross-checked. Pinning the roundId re-derives these exact bytes forever.`,
    },
  });
  return { kind: "price", fact, age_s, heartbeat_s: feed.heartbeat_s };
}

/** The value-door / crypto-convert seam: a price leg as scaled minor units, or
 *  a stale/unreachable signal the caller must refuse on. */
export async function spotPriceLeg(
  feed: PriceFeed,
  fetchers?: OracleFetchers,
): Promise<{ valueScaled: string; scale: number; observed_at: string; sources: Source[]; recompute: { how: string } } | { stale: true; code: PriceFailureCode; detail: string }> {
  const r = await readPrice(feed, fetchers);
  if (r.kind === "price") {
    return {
      valueScaled: r.fact.value,
      scale: r.fact.decimals,
      observed_at: r.fact.observed_at,
      sources: r.fact.sources,
      recompute: r.fact.recompute!,
    };
  }
  if (r.kind === "stale") return { stale: true, code: r.code, detail: PRICE_FAILURE.stale.message };
  if (r.kind === "invalid") return { stale: true, code: r.code, detail: r.reason };
  return { stale: true, code: r.code, detail: r.detail };
}
