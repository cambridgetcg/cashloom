/**
 * Chain fee facts — "what does moving money cost right now". Same discipline as
 * the balance door: keyless public reads only, every fact cites its source and
 * carries the recompute recipe. Fetchers are injectable so tests never touch
 * the network.
 *
 * BTC: esplora fee-estimates, 3-block target, served as sat/vB × 100 (2 dp).
 * Base: eth_gasPrice via the public RPC, served in wei (0 dp — wei IS minor).
 */

import { makeFact, type MoneyFact } from "./money-fact.ts";

const BTC_CAIP2 = "bip122:000000000019d6689c085ae165831e93";
const BASE_CAIP2 = "eip155:8453";
const ESPLORA_FEES_URL = "https://blockstream.info/api/fee-estimates";
const BASE_RPC_URL = (): string =>
  process.env.CASHLOOM_BASE_RPC_URL?.trim() || "https://mainnet.base.org";

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
// ×100 into an integer string via toFixed(2) — decimal notation is guaranteed
// (no exponent form), the rounding is toFixed's and is declared in recompute.
export function satPerVbTimes100(estimate: number): string {
  if (!Number.isFinite(estimate) || estimate < 0) throw new Error(`bad fee estimate ${estimate}`);
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
        decimals: 2, // value × 10^-2 = sat/vB
        plane: "public",
        method: "observed",
        proof_state: "tested",
        redistribution: "onchain-rederivable",
        sources: [
          { name: "esplora (public Bitcoin indexer)", url: ESPLORA_FEES_URL, fetched_at: new Date().toISOString() },
        ],
        observed_at: new Date().toISOString(),
        stale_after_s: 60,
        recompute: { how: `GET /fee-estimates → key "3" (3-block target), × 100 rounded to 2 dp` },
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
        decimals: 0, // wei is already the minor unit
        plane: "public",
        method: "observed",
        proof_state: "tested",
        redistribution: "onchain-rederivable",
        sources: [
          { name: "Base public RPC", url: BASE_RPC_URL(), fetched_at: new Date().toISOString() },
        ],
        observed_at: new Date().toISOString(),
        stale_after_s: 30,
        recompute: { how: "POST eth_gasPrice → result (hex wei)" },
      });
    },
  },
];

export async function readFees(
  chainFilter?: string,
  fetchers: FeeFetchers = defaultFetchers,
): Promise<{ facts: MoneyFact[]; failed: { chain: string; label: string }[]; unknown?: string }> {
  const wanted = chainFilter
    ? FEE_ENTRIES.filter(
        (e) => e.chain === chainFilter || e.chain.toLowerCase() === chainFilter.toLowerCase(),
      )
    : FEE_ENTRIES;
  if (chainFilter && wanted.length === 0) return { facts: [], failed: [], unknown: chainFilter };
  const results = await Promise.allSettled(wanted.map((e) => e.read(fetchers)));
  const facts: MoneyFact[] = [];
  const failed: { chain: string; label: string }[] = [];
  results.forEach((r, i) => {
    if (r.status === "fulfilled") facts.push(r.value);
    else failed.push({ chain: wanted[i].chain, label: wanted[i].label });
  });
  return { facts, failed };
}
