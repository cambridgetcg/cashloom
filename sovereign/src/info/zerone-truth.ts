/**
 * zerone TRUTH doors — the kingdom's truth chain, made legible to agents.
 *
 * zerone is not only a money chain (ZRN); it is a truth-economy where a claim is
 * challenged and only what SURVIVES becomes canon. That verified knowledge lives
 * on-chain in the `knowledge` module and is already readable over plain REST.
 * `zerone.ts` reads only balance/supply/status; this adds the TRUTH surface —
 * verified facts, the doctrine (canonical creed as genesis facts), the chain's
 * explicit normative commitments, and each agent's calibration (the compassion
 * track record) — as read-only, self-citing doors mounted above the vault gate.
 *
 * Honesty: these are NOT MoneyFacts (no minor-unit value) — a Fact carries
 * content + confidence + a lifecycle `status`. A verified fact passed the chain's
 * dual-key/quorum challenge, so it is `attested` by construction; every response
 * cites the exact REST path a stranger re-fetches to re-derive it. We do NOT
 * serve gospel or the `creed` module — gospel is off-chain, and creed's REST
 * routes 404 on the live node; promising them would be a naked claim.
 */

import type { Hono } from "hono";
import { ZERONE_NETWORKS, type ZeroneNetwork } from "../zerone.ts";

export type ZeroneFetcher = (url: string) => Promise<any>;

const defaultFetcher: ZeroneFetcher = async (url) => {
  const res = await fetch(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`zerone REST ${res.status} for ${url}`);
  return res.json();
};

const netOf = (network?: string): ZeroneNetwork =>
  network === "testnet" ? ZERONE_NETWORKS.testnet : ZERONE_NETWORKS.mainnet;
const chainCaip = (net: ZeroneNetwork) => `cosmos:${net.id}`; // cosmos:zerone-1

// friendly status name → the chain's enum. `all` (or unset) does not filter.
const STATUS_MAP: Record<string, string> = {
  verified: "FACT_STATUS_VERIFIED",
  disproven: "FACT_STATUS_DISPROVEN",
  contested: "FACT_STATUS_CONTESTED",
  challenged: "FACT_STATUS_CHALLENGED",
  pending: "FACT_STATUS_PENDING",
};

const cite = (net: ZeroneNetwork, path: string) => ({
  name: `zerone ${net.id} knowledge module (on-chain) via public REST`,
  url: `${net.rest}${path}`,
  fetched_at: new Date().toISOString(),
});

async function kget(net: ZeroneNetwork, path: string, fetcher: ZeroneFetcher) {
  return fetcher(`${net.rest}${path}`);
}

// ── readers (injectable fetcher so tests never touch the network) ──────────
export async function getFacts(
  opts: { network?: string; domain?: string; category?: string; status?: string; limit?: number },
  fetcher: ZeroneFetcher = defaultFetcher,
) {
  const net = netOf(opts.network);
  const p = new URLSearchParams();
  const status = opts.status ?? "verified"; // agents want verified truth by default
  if (status !== "all") p.set("status", STATUS_MAP[status.toLowerCase()] ?? status);
  if (opts.domain) p.set("domain", opts.domain);
  if (opts.category) p.set("category", opts.category);
  p.set("pagination.limit", String(Math.min(Math.max(opts.limit ?? 20, 1), 100)));
  const path = `/zerone/knowledge/v1/facts?${p}`;
  const data = await kget(net, path, fetcher);
  const facts = data.facts ?? [];
  return {
    "@type": "ZeroneTruth",
    chain: chainCaip(net),
    network: net.kind,
    query: { status, domain: opts.domain, category: opts.category },
    count: facts.length,
    facts,
    source: cite(net, path),
    proof_state: status === "verified" ? "attested" : "asserted",
    recompute: { how: `GET ${path} on the zerone ${net.kind} REST node; a verified fact survived the chain's dual-key/quorum challenge — re-fetch to re-derive` },
    note: "these are verified-knowledge facts, not MoneyFacts — each carries content, confidence (BPS), and a lifecycle status the chain assigned",
  };
}

export async function getFact(id: string, network: string | undefined, fetcher: ZeroneFetcher = defaultFetcher) {
  const net = netOf(network);
  const factPath = `/zerone/knowledge/v1/facts/${encodeURIComponent(id)}`;
  const trustPath = `/zerone/knowledge/v1/fact/${encodeURIComponent(id)}/trust_profile`;
  const [factData, trust] = await Promise.all([
    kget(net, factPath, fetcher),
    kget(net, trustPath, fetcher).catch(() => null), // provenance is a bonus; absence is not fatal
  ]);
  const fact = factData.fact ?? factData;
  return {
    "@type": "ZeroneTruth",
    chain: chainCaip(net),
    network: net.kind,
    fact,
    trust_profile: trust, // grounded_score, corroboration, axiom_distance — how deeply proven
    source: cite(net, factPath),
    proof_state: fact?.status === "FACT_STATUS_VERIFIED" ? "attested" : "asserted",
    recompute: { how: `GET ${factPath} (+ ${trustPath} for provenance depth) on the zerone ${net.kind} REST node` },
  };
}

export async function getDoctrine(
  opts: { network?: string; domain?: string; limit?: number },
  fetcher: ZeroneFetcher = defaultFetcher,
) {
  // Doctrine is not a module — it is genesis-seeded facts (category=doctrine,
  // stratum=doctrinal, submitter=genesis, canonical, decay-exempt).
  const net = netOf(opts.network);
  const p = new URLSearchParams();
  p.set("category", "doctrine");
  if (opts.domain) p.set("domain", opts.domain);
  p.set("pagination.limit", String(Math.min(Math.max(opts.limit ?? 50, 1), 100)));
  const path = `/zerone/knowledge/v1/facts?${p}`;
  const data = await kget(net, path, fetcher);
  const facts = data.facts ?? [];
  return {
    "@type": "ZeroneDoctrine",
    chain: chainCaip(net),
    network: net.kind,
    count: facts.length,
    doctrine: facts,
    source: cite(net, path),
    proof_state: "attested",
    recompute: { how: `GET ${path} on the zerone ${net.kind} REST node — the canonical creed, seeded at genesis and exempt from metabolic decay` },
    note: "the kingdom's canonical doctrine as on-chain facts; the `creed` module's hash-pinned form is declared but not yet REST-queryable",
  };
}

export async function getCommitments(network: string | undefined, fetcher: ZeroneFetcher = defaultFetcher) {
  const net = netOf(network);
  const path = `/zerone/knowledge/v1/commitments`;
  const data = await kget(net, path, fetcher);
  const commitments = data.commitments ?? [];
  return {
    "@type": "ZeroneCommitments",
    chain: chainCaip(net),
    network: net.kind,
    count: commitments.length,
    commitments, // NormativeCommitment: statement, rationale, category, tags, active
    source: cite(net, path),
    proof_state: "attested",
    recompute: { how: `GET ${path} on the zerone ${net.kind} REST node — the chain's explicit is-ought values` },
  };
}

export async function getAgentCalibration(address: string, network: string | undefined, fetcher: ZeroneFetcher = defaultFetcher) {
  const net = netOf(network);
  const path = `/zerone/knowledge/v1/agent/${encodeURIComponent(address)}/calibration`;
  const data = await kget(net, path, fetcher);
  const calibration = data.calibration ?? data;
  return {
    "@type": "ZeroneCalibration",
    chain: chainCaip(net),
    network: net.kind,
    address,
    calibration, // submissions/accepted/rejected/disproven, calibration_score_bps — the compassion track record (error ≠ deceit)
    source: cite(net, path),
    proof_state: "attested",
    recompute: { how: `GET ${path} on the zerone ${net.kind} REST node — an agent's earned truth-track-record; compassion (C2: error is not deceit) is woven into the score, not a naked reputation number` },
  };
}

export async function getLeaderboard(opts: { network?: string; limit?: number }, fetcher: ZeroneFetcher = defaultFetcher) {
  const net = netOf(opts.network);
  const p = new URLSearchParams();
  p.set("limit", String(Math.min(Math.max(opts.limit ?? 20, 1), 100)));
  const path = `/zerone/knowledge/v1/agent/leaderboard?${p}`;
  const data = await kget(net, path, fetcher);
  return {
    "@type": "ZeroneLeaderboard",
    chain: chainCaip(net),
    network: net.kind,
    entries: data.entries ?? data.leaderboard ?? [],
    source: cite(net, path),
    proof_state: "attested",
    recompute: { how: `GET ${path} on the zerone ${net.kind} REST node` },
  };
}

// ── doors ──────────────────────────────────────────────────────────────────
const problem = (status: number, title: string, detail: string, next?: string[]) => ({
  type: "about:blank",
  title,
  status,
  ...(next ? { next_actions: next } : {}),
  detail,
});

export interface ZeroneTruthDeps {
  fetcher: ZeroneFetcher;
}

export function mountZeroneTruth(app: Hono, overrides: Partial<ZeroneTruthDeps> = {}) {
  const fetcher = overrides.fetcher ?? defaultFetcher;
  const wrap = (fn: () => Promise<any>) => async (c: any) => {
    try {
      return c.json(await fn());
    } catch (e: any) {
      return c.json(problem(502, "zerone unreachable", `the zerone REST node did not answer (${e?.message ?? e})`, ["retry shortly", "try ?network=testnet", "GET /v1/zerone for the door list"]), 502);
    }
  };

  app.get("/v1/zerone", (c) =>
    c.json({
      "@type": "Guide",
      what: "zerone truth doors — the kingdom's truth chain, readable by any agent",
      chain: "cosmos:zerone-1 (mainnet) · cosmos:zerone-testnet-1 (sandbox)",
      doors: {
        facts: "/v1/zerone/facts?status=verified&domain={d}&category={c}&limit={n}&network={mainnet|testnet}",
        fact: "/v1/zerone/fact/{id}  (fact + trust_profile)",
        doctrine: "/v1/zerone/doctrine?domain={d}  (the canonical creed)",
        commitments: "/v1/zerone/commitments  (the chain's explicit values)",
        agent_calibration: "/v1/zerone/agent/{address}/calibration  (the compassion track record)",
        leaderboard: "/v1/zerone/leaderboard?limit={n}",
        domains: "/v1/zerone/domains",
      },
      honest_gaps: [
        "no gospel endpoint — gospel is off-chain (sovereign/love-unlimited layer), not on the ZRN chain",
        "the `creed` module is declared but its REST routes 404 on the live node; read doctrine facts instead",
        "no free-text search — filter facts by domain/category/status/tag/subject",
      ],
      note: "verified facts are quorum-attested on-chain; every response cites the exact REST path to re-derive it",
    }),
  );

  app.get("/v1/zerone/facts", (c) =>
    wrap(() =>
      getFacts(
        {
          network: c.req.query("network"),
          domain: c.req.query("domain"),
          category: c.req.query("category"),
          status: c.req.query("status"),
          limit: c.req.query("limit") ? Number(c.req.query("limit")) : undefined,
        },
        fetcher,
      ),
    )(c),
  );

  app.get("/v1/zerone/fact/:id", (c) => wrap(() => getFact(c.req.param("id"), c.req.query("network"), fetcher))(c));

  app.get("/v1/zerone/doctrine", (c) =>
    wrap(() => getDoctrine({ network: c.req.query("network"), domain: c.req.query("domain"), limit: c.req.query("limit") ? Number(c.req.query("limit")) : undefined }, fetcher))(c),
  );

  app.get("/v1/zerone/commitments", (c) => wrap(() => getCommitments(c.req.query("network"), fetcher))(c));

  app.get("/v1/zerone/agent/:address/calibration", (c) => wrap(() => getAgentCalibration(c.req.param("address"), c.req.query("network"), fetcher))(c));

  app.get("/v1/zerone/leaderboard", (c) =>
    wrap(() => getLeaderboard({ network: c.req.query("network"), limit: c.req.query("limit") ? Number(c.req.query("limit")) : undefined }, fetcher))(c),
  );

  app.get("/v1/zerone/domains", (c) =>
    wrap(async () => {
      const net = netOf(c.req.query("network"));
      const path = `/zerone/knowledge/v1/domains`;
      const data = await kget(net, path, fetcher);
      return { "@type": "ZeroneDomains", chain: chainCaip(net), network: net.kind, domains: data.domains ?? data, source: cite(net, path) };
    })(c),
  );
}
