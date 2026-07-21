/**
 * The CAIP-2 chain registry — "which chain" is a TABLE ROW, not code and not a
 * type. Ethereum is not privileged and not special-cased here; it would be one
 * more entry (eip155:1 → an alchemy reader). Adding a chain is adding a row; the
 * route, the MoneyFact format, and the Xenia door never change.
 *
 * Today: the two SECRETLESS sources — BTC (esplora, keyless) and zerone (public
 * cosmos REST). Zero secrets across the whole surface = non-custodial by
 * CONSTRUCTION, demonstrated, not asserted. Every read is a public chain read,
 * so every fact is proof_state:tested (a stranger re-derives it) and
 * redistribution:onchain-rederivable (public data — no license firewall).
 */

import { esploraConnector } from "../connectors/esplora.connector.ts";
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

const BTC: ChainEntry = {
  caip2: BTC_CAIP2,
  label: "Bitcoin mainnet",
  native: { symbol: "BTC", assetRef: BTC_ASSET },
  aliases: ["btc", "bitcoin"],
  validate: (a) => /^(bc1[a-z0-9]{20,90}|[13][a-km-zA-HJ-NP-Z1-9]{25,39})$/.test(a),
  async read(address) {
    const b = await esploraConnector.fetchBalance({ externalAccountId: address, credentialRef: null });
    return {
      valueMinor: b.balanceMinor,
      decimals: b.decimals,
      unit: BTC_ASSET,
      symbol: b.currency,
      sources: [
        {
          name: "esplora (public Bitcoin indexer)",
          url: `https://blockstream.info/api/address/${address}`,
          fetched_at: b.asOf.toISOString(),
        },
      ],
      method: "observed",
      proof_state: "tested",
      redistribution: "onchain-rederivable",
      stale_after_s: 60,
      recompute: { how: "GET /address/{addr} → chain_stats.funded_txo_sum − spent_txo_sum" },
    };
  },
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
  const raw = decodeURIComponent(caip2OrAlias);
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
