/**
 * The CAIP-2 chain registry — "which chain" is a TABLE ROW, not code and not a
 * type. Ethereum is not privileged and not special-cased here; it would be one
 * more entry (eip155:1 → an alchemy reader). Adding a chain is adding a row; the
 * route, the MoneyFact format, and the Xenia door never change.
 *
 * Today: the two SECRETLESS sources — BTC (a fixed public Esplora read) and zerone (public
 * cosmos REST). Zero secrets across the whole surface = non-custodial by
 * CONSTRUCTION, demonstrated, not asserted. Every read is a public chain read,
 * so every fact is proof_state:tested (a stranger re-derives it) and
 * redistribution:onchain-rederivable (public data — no license firewall).
 */

import { getAddressBalance, isZrnAddress, ZERONE_NETWORKS, ZRN } from "../zerone.ts";
import type { Method, ProofState, Redistribution, Source } from "./money-fact.ts";

export interface ChainRead {
  valueMinor: string;
  decimals: number;
  unit: string;
  symbol: string;
  sources: Source[];
  method: Method;
  proof_state: ProofState;
  redistribution: Redistribution;
  stale_after_s: number;
  recompute?: { how: string };
}

export interface ChainEntry {
  caip2: string;
  label: string;
  native: { symbol: string; assetRef: string };
  aliases: string[];
  validate(addr: string): boolean;
  read(address: string): Promise<ChainRead>;
}

const BTC_GENESIS = "000000000019d6689c085ae165831e93";
const BTC_CAIP2 = `bip122:${BTC_GENESIS}`;
const BTC_ASSET = `${BTC_CAIP2}/slip44:0`;
const PUBLIC_ESPLORA_BASE = "https://blockstream.info/api";
const PUBLIC_ESPLORA_TIMEOUT_MS = 10_000;
const PUBLIC_ESPLORA_MAX_BYTES = 64 * 1024;
const PUBLIC_ESPLORA_FAILURE = "Bitcoin public balance evidence is temporarily unavailable.";

export type PublicEsploraFetch = (
  input: string,
  init: RequestInit,
) => Promise<Response>;

/**
 * INFO owns this deliberately tiny public reader instead of importing the
 * local account connector. That keeps Axios, credential/config plumbing,
 * transaction sync, and every custody-adjacent connector out of the hosted
 * bundle. The origin is fixed and keyless; no configured URL can smuggle a
 * token into a request, receipt, or error.
 */
export async function readPublicBitcoinBalance(
  address: string,
  options: {
    readonly fetch?: PublicEsploraFetch;
    readonly now?: () => Date;
    readonly timeoutMs?: number;
  } = {},
): Promise<ChainRead> {
  const fetcher = options.fetch ?? ((input, init) => fetch(input, init));
  const timeoutMs = options.timeoutMs ?? PUBLIC_ESPLORA_TIMEOUT_MS;
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error(PUBLIC_ESPLORA_FAILURE));
    }, timeoutMs);
  });

  try {
    const url = `${PUBLIC_ESPLORA_BASE}/address/${encodeURIComponent(address)}`;
    const response = await Promise.race([
      fetcher(url, {
        method: "GET",
        headers: { Accept: "application/json" },
        redirect: "error",
        signal: controller.signal,
      }),
      deadline,
    ]);
    const declaredLength = Number(response.headers.get("content-length"));
    if (
      !response.ok ||
      (Number.isFinite(declaredLength) && declaredLength > PUBLIC_ESPLORA_MAX_BYTES)
    ) {
      throw new Error(PUBLIC_ESPLORA_FAILURE);
    }
    if (!response.body) throw new Error(PUBLIC_ESPLORA_FAILURE);
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let receivedBytes = 0;
    try {
      for (;;) {
        const chunk = await Promise.race([reader.read(), deadline]);
        if (chunk.done) break;
        receivedBytes += chunk.value.byteLength;
        if (receivedBytes > PUBLIC_ESPLORA_MAX_BYTES) {
          controller.abort();
          void reader.cancel().catch(() => undefined);
          throw new Error(PUBLIC_ESPLORA_FAILURE);
        }
        chunks.push(chunk.value);
      }
      reader.releaseLock();
    } catch (error) {
      controller.abort();
      void reader.cancel().catch(() => undefined);
      throw error;
    }
    const bytes = new Uint8Array(receivedBytes);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    const body = JSON.parse(text) as {
      chain_stats?: { funded_txo_sum?: unknown; spent_txo_sum?: unknown };
    };
    const funded = body?.chain_stats?.funded_txo_sum;
    const spent = body?.chain_stats?.spent_txo_sum;
    if (
      typeof funded !== "number" || !Number.isSafeInteger(funded) || funded < 0 ||
      typeof spent !== "number" || !Number.isSafeInteger(spent) || spent < 0 ||
      spent > funded
    ) {
      throw new Error(PUBLIC_ESPLORA_FAILURE);
    }
    const fetchedAt = (options.now ?? (() => new Date()))().toISOString();
    return {
      valueMinor: (BigInt(funded) - BigInt(spent)).toString(),
      decimals: 8,
      unit: BTC_ASSET,
      symbol: "BTC",
      sources: [{
        name: "esplora (public Bitcoin indexer)",
        url,
        fetched_at: fetchedAt,
      }],
      method: "observed",
      proof_state: "tested",
      redistribution: "onchain-rederivable",
      stale_after_s: 60,
      recompute: { how: "GET /address/{addr} → chain_stats.funded_txo_sum − spent_txo_sum" },
    };
  } catch {
    throw new Error(PUBLIC_ESPLORA_FAILURE);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

const BTC: ChainEntry = {
  caip2: BTC_CAIP2,
  label: "Bitcoin mainnet",
  native: { symbol: "BTC", assetRef: BTC_ASSET },
  aliases: ["btc", "bitcoin"],
  validate: (a) => /^(bc1[a-z0-9]{20,90}|[13][a-km-zA-HJ-NP-Z1-9]{25,39})$/.test(a),
  read: readPublicBitcoinBalance,
};

const ZERONE: ChainEntry = {
  caip2: "cosmos:zerone-1",
  label: "Zerone mainnet (the truth chain)",
  native: { symbol: ZRN.symbol, assetRef: "cosmos:zerone-1/denom:uzrn" },
  aliases: ["zrn", "zerone"],
  validate: (a) => isZrnAddress(a),
  async read(address) {
    const r = await getAddressBalance(address, ZERONE_NETWORKS.mainnet);
    const rest = ZERONE_NETWORKS.mainnet.rest;
    return {
      valueMinor: String(r.balance_uzrn),
      decimals: 6, // 1 ZRN = 1,000,000 uzrn
      unit: "cosmos:zerone-1/denom:uzrn",
      symbol: ZRN.symbol,
      sources: [
        {
          name: "zerone-1 cosmos REST",
          url: `${rest}/cosmos/bank/v1beta1/balances/${address}/by_denom?denom=uzrn`,
          fetched_at: new Date().toISOString(),
        },
      ],
      method: "observed",
      proof_state: "tested",
      redistribution: "onchain-rederivable",
      stale_after_s: 30,
      recompute: { how: "GET cosmos/bank/v1beta1/balances/{addr}/by_denom?denom=uzrn" },
    };
  },
};

const ENTRIES: ChainEntry[] = [BTC, ZERONE];

const byKey = new Map<string, ChainEntry>();
for (const e of ENTRIES) {
  byKey.set(e.caip2, e);
  byKey.set(e.caip2.toLowerCase(), e);
  for (const a of e.aliases) byKey.set(a.toLowerCase(), e);
}

export function resolveChain(caip2OrAlias: string): ChainEntry | undefined {
  const raw = caip2OrAlias; // Hono has already percent-decoded — a second decode crashes on raw '%'
  return byKey.get(raw) ?? byKey.get(raw.toLowerCase());
}

export function listChains() {
  return ENTRIES.map((e) => ({
    caip2: e.caip2,
    label: e.label,
    native: e.native,
    aliases: e.aliases,
    balance_door: `/v1/chain/${e.caip2}/{address}`,
  }));
}
