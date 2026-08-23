/**
 * Chain fee facts — "what does moving money cost right now". Same discipline as
 * the balance door: keyless public reads only, every fact cites its source and
 * carries the recompute recipe. Fetchers are injectable so tests never touch
 * the network.
 *
 * BTC: esplora fee-estimates, 3-block target — value is sat/vB × 100, read as
 * BTC/vB at 10 dp (the unit/decimals contract holds: value × 10^-decimals IS
 * the unit). Base: eth_gasPrice — value is wei, read as ETH/gas at 18 dp.
 */

import { makeFact, type MoneyFact } from "./money-fact.ts";

const BTC_CAIP2 = "bip122:000000000019d6689c085ae165831e93";
const BASE_CAIP2 = "eip155:8453";
const ESPLORA_FEES_URL = "https://blockstream.info/api/fee-estimates";
const BASE_RPC_URL = (): string =>
  process.env.CASHLOOM_BASE_RPC_URL?.trim() || "https://mainnet.base.org";
const BASE_RPC_REFERENCE_URL = "https://docs.base.org/base-chain/reference/public-rpc-endpoints";

export type FeeFetchers = {
  esploraFees: () => Promise<Record<string, number>>;
  baseGasPriceWei: () => Promise<bigint>;
};

const defaultFetchers: FeeFetchers = {
  async esploraFees() {
    const res = await fetch(ESPLORA_FEES_URL, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) throw new Error(`esplora answered ${res.status}`);
    return res.json() as Promise<Record<string, number>>;
  },
  async baseGasPriceWei() {
    const res = await fetch(BASE_RPC_URL(), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_gasPrice", params: [] }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`base rpc answered ${res.status}`);
    const body = (await res.json()) as { result?: string; error?: { message?: string } };
    if (!body.result) throw new Error(`base rpc error: ${body.error?.message ?? "no result"}`);
    return BigInt(body.result);
  },
};

// esplora reports sat/vB as a JSON number with sub-sat precision (e.g. 12.5).
// Rounded to 2 dp by toFixed (IEEE-754 semantics — 1.005 may land on 100, not
// 101; declared in recompute), then ×100 into an integer string. toFixed emits
// decimal notation below 1e21; estimates that large are refused as nonsense.
export function satPerVbTimes100(estimate: number): string {
  if (!Number.isFinite(estimate) || estimate < 0 || estimate >= 1e21) {
    throw new Error(`bad fee estimate ${estimate}`);
  }
  return BigInt(estimate.toFixed(2).replace(".", "")).toString();
}

export interface FeeEntry {
  chain: string; // CAIP-2
  label: string;
  read(f: FeeFetchers): Promise<MoneyFact>;
}

export const FEE_ENTRIES: FeeEntry[] = [
  {
    chain: BTC_CAIP2,
    label: "Bitcoin mainnet",
    async read(f) {
      const estimates = await f.esploraFees();
      const target3 = estimates["3"];
      if (typeof target3 !== "number") throw new Error("esplora: no 3-block estimate");
      return makeFact({
        subject: `${BTC_CAIP2}:mempool`,
        predicate: "fee_per_vbyte_sat",
        value: satPerVbTimes100(target3),
        unit: `${BTC_CAIP2}/slip44:0`,
        decimals: 10, // unit is BTC: value × 10^-10 BTC/vB (sat/vB × 100, 1 sat = 10^-8 BTC)
        plane: "public",
        method: "observed",
        proof_state: "tested",
        redistribution: "onchain-rederivable",
        sources: [
          { name: "esplora (public Bitcoin indexer)", url: ESPLORA_FEES_URL, fetched_at: new Date().toISOString() },
        ],
        observed_at: new Date().toISOString(),
        stale_after_s: 60,
        recompute: { how: `GET /fee-estimates → key "3" (3-block target), rounded to 2 dp (IEEE-754 toFixed), × 100; read as BTC/vB at 10 dp` },
      });
    },
  },
  {
    chain: BASE_CAIP2,
    label: "Base mainnet",
    async read(f) {
      const wei = await f.baseGasPriceWei();
      if (wei < 0n) throw new Error("base rpc: negative gas price");
      return makeFact({
        subject: `${BASE_CAIP2}:gas`,
        predicate: "gas_price_wei",
        value: wei.toString(),
        unit: `${BASE_CAIP2}/slip44:60`,
        decimals: 18, // unit is ETH: value × 10^-18 ETH per gas (the value IS wei)
        plane: "public",
        method: "observed",
        proof_state: "tested",
        redistribution: "onchain-rederivable",
        sources: [
          {
            name: "Base mainnet eth_gasPrice via configured/public RPC",
            // A configured provider URL may contain an API credential. Cite the
            // public method documentation, never echo connection configuration.
            url: BASE_RPC_REFERENCE_URL,
            fetched_at: new Date().toISOString(),
          },
        ],
        observed_at: new Date().toISOString(),
        stale_after_s: 30,
        recompute: { how: "POST eth_gasPrice → result (hex wei)" },
      });
    },
  },
];

const CHAIN_ALIASES: Record<string, string> = {
  btc: BTC_CAIP2, bitcoin: BTC_CAIP2, base: BASE_CAIP2, "base-mainnet": BASE_CAIP2,
};

export function supportedFeeChains(): string[] {
  return FEE_ENTRIES.map((e) => `${e.chain} (${e.label})`);
}

// 20s micro-cache + in-flight dedupe for the default (network) path only —
// honest by the facts' own stale_after_s labels; injected test fetchers bypass.
let feeCache: { at: number; result: Awaited<ReturnType<typeof readAll>> } | null = null;
let feeInflight: Promise<Awaited<ReturnType<typeof readAll>>> | null = null;

async function readAll(fetchers: FeeFetchers) {
  const results = await Promise.allSettled(FEE_ENTRIES.map((e) => e.read(fetchers)));
  const facts: MoneyFact[] = [];
  const failed: { chain: string; label: string }[] = [];
  results.forEach((r, i) => {
    if (r.status === "fulfilled") facts.push(r.value);
    else failed.push({ chain: FEE_ENTRIES[i].chain, label: FEE_ENTRIES[i].label });
  });
  return { facts, failed };
}

export async function readFees(
  chainFilter?: string,
  fetchers: FeeFetchers = defaultFetchers,
): Promise<{ facts: MoneyFact[]; failed: { chain: string; label: string }[]; unknown?: string }> {
  const wanted = chainFilter?.trim()
    ? (() => {
        const needle = chainFilter.trim().toLowerCase();
        const canonical = CHAIN_ALIASES[needle] ?? chainFilter.trim();
        return FEE_ENTRIES.filter((e) => e.chain.toLowerCase() === canonical.toLowerCase());
      })()
    : FEE_ENTRIES;
  if (chainFilter?.trim() && wanted.length === 0) return { facts: [], failed: [], unknown: chainFilter };
  let all;
  if (fetchers === defaultFetchers) {
    if (feeCache && Date.now() - feeCache.at < 20_000) all = feeCache.result;
    else {
      feeInflight ??= readAll(fetchers).then((r) => {
        feeCache = { at: Date.now(), result: r };
        return r;
      }).finally(() => { feeInflight = null; });
      all = await feeInflight;
    }
  } else {
    all = await readAll(fetchers);
  }
  const wantedIds = new Set(wanted.map((e) => e.chain));
  return {
    facts: all.facts.filter((f) => [...wantedIds].some((id) => f.subject.startsWith(id))),
    failed: all.failed.filter((f) => wantedIds.has(f.chain)),
  };
}
