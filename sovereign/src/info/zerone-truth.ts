/**
 * zerone TRUTH doors — the kingdom's truth chain, made legible to agents.
 *
 * zerone keeps a record of claims, the reviews and challenges that follow, and
 * the verdicts reviewers recorded. That record lives on-chain in the
 * `knowledge` module and is already readable over plain REST.
 * `zerone.ts` reads only balance/supply/status; this adds the TRUTH surface —
 * verified facts, the doctrine (canonical creed as genesis facts), the chain's
 * explicit normative commitments, and each agent's calibration (the compassion
 * track record) — as read-only, self-citing doors mounted above the vault gate.
 *
 * Honesty: these are NOT MoneyFacts (no minor-unit value) — a Fact carries
 * content + confidence + a lifecycle `status`. zerone says "a recorded verdict
 * is not proof that a claim is true" (zerone.ai/llms.txt, 2026-10-26), so every
 * fact is graded `asserted`: what its submitter claimed. Whether a reviewed
 * claim stands behind it (verifiedAtBlock > 0 and a claimId) is reported in
 * proof_basis, not in the grade. On zerone-1 (2026-10-26) all 47 VERIFIED facts
 * were seeded at genesis, and 23 of the 25 facts that came from reviewed claims
 * were submitted by zerone-ops, the household's operations account (TRUST.md),
 * on a one-validator chain.
 * Every response cites the exact REST path a stranger re-fetches.
 * We do NOT serve gospel or the `creed` module — gospel is off-chain, and
 * creed's REST routes 404 on the live node; promising them would be a naked claim.
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

// The node ignores pagination.limit (limit=3 returned all 47 VERIFIED facts on
// 2026-10-26), so the door trims to the documented limit itself.
const clampLimit = (n: number | undefined, fallback: number) =>
  n !== undefined && Number.isFinite(n) ? Math.min(Math.max(Math.trunc(n), 1), 100) : fallback;

// MONEYWORLD.md reserves `attested` for a zerone Proof-of-Truth fact, and
// zerone does not call a reviewed claim proof (see the header), so no fact read
// here is graded above `asserted`. A reviewed claim on record means
// verifiedAtBlock > 0 and a claimId; a genesis-seeded fact has neither.
export const FACT_PROOF_RULE =
  "asserted: zerone says a recorded verdict is not proof that a claim is true (zerone.ai/llms.txt), so a reviewed claim on record (verifiedAtBlock > 0 and a claimId) is reported here, not graded higher";

export function hasReviewedClaim(fact: any): boolean {
  const verifiedAt = Number(fact?.verifiedAtBlock ?? fact?.verified_at_block ?? 0);
  const claimId = fact?.claimId ?? fact?.claim_id;
  return verifiedAt > 0 && typeof claimId === "string" && claimId.length > 0;
}

function listProof(facts: any[]) {
  return {
    proof_state: "asserted" as const,
    proof_basis: {
      rule: FACT_PROOF_RULE,
      records: facts.length,
      with_reviewed_claim: facts.filter(hasReviewedClaim).length,
      genesis_seeded: facts.filter((f) => f?.submitter === "genesis").length,
    },
  };
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
  const limit = clampLimit(opts.limit, 20);
  p.set("pagination.limit", String(limit));
  const path = `/zerone/knowledge/v1/facts?${p}`;
  const data = await kget(net, path, fetcher);
  const all: any[] = data.facts ?? [];
  const facts = all.slice(0, limit);
  return {
    "@type": "ZeroneTruth",
    chain: chainCaip(net),
    network: net.kind,
    query: { status, domain: opts.domain, category: opts.category, limit },
    count: facts.length,
    node_count: all.length,
    facts,
    source: cite(net, path),
    ...listProof(facts),
    recompute: { how: `GET ${path} on the zerone ${net.kind} REST node and keep the first ${limit} (the node ignores pagination.limit); a fact's verifiedAtBlock and claimId show whether a reviewed claim stands behind it, and its submitter who made it` },
    note: "these are knowledge-module facts, not MoneyFacts — each carries content, confidence (BPS), and a lifecycle status the chain assigned; VERIFIED genesis-seeded facts were written in when the chain began, without review",
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
    trust_profile: trust, // the chain's recorded grounded score, corroboration count and axiom distance
    source: cite(net, factPath),
    proof_state: "asserted" as const,
    proof_basis: { rule: FACT_PROOF_RULE, reviewed_claim_on_record: hasReviewedClaim(fact), submitter: fact?.submitter ?? null },
    recompute: { how: `GET ${factPath} (+ ${trustPath} for the recorded trust profile) on the zerone ${net.kind} REST node; verifiedAtBlock > 0 and a claimId show a reviewed claim on record` },
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
  const limit = clampLimit(opts.limit, 50);
  p.set("pagination.limit", String(limit));
  const path = `/zerone/knowledge/v1/facts?${p}`;
  const data = await kget(net, path, fetcher);
  const all: any[] = data.facts ?? [];
  const facts = all.slice(0, limit);
  return {
    "@type": "ZeroneDoctrine",
    chain: chainCaip(net),
    network: net.kind,
    count: facts.length,
    node_count: all.length,
    doctrine: facts,
    source: cite(net, path),
    ...listProof(facts),
    recompute: { how: `GET ${path} on the zerone ${net.kind} REST node and keep the first ${limit} (the node ignores pagination.limit) — the canonical creed, seeded at genesis and exempt from metabolic decay` },
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
    commitments, // NormativeCommitment: statement, rationale, category, tags, active, ratifiedAtBlock
    source: cite(net, path),
    proof_state: "asserted", // value statements written by the chain's authors; ratifiedAtBlock "0" means seeded at genesis
    recompute: { how: `GET ${path} on the zerone ${net.kind} REST node — the chain's explicit is-ought values; ratifiedAtBlock "0" means seeded at genesis` },
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
    calibration, // submissions/accepted/rejected/disproven, calibration_score_bps — the chain's record of this address (C2: error ≠ deceit)
    source: cite(net, path),
    proof_state: "tested", // an on-chain read, as /v1/chain grades a zerone balance; the score is the chain's own computation
    recompute: { how: `GET ${path} on the zerone ${net.kind} REST node — the chain's record of this address's submissions, acceptances and disprovals; calibration_score_bps is the chain's own computation` },
  };
}

export async function getLeaderboard(opts: { network?: string; limit?: number }, fetcher: ZeroneFetcher = defaultFetcher) {
  const net = netOf(opts.network);
  const p = new URLSearchParams();
  const limit = clampLimit(opts.limit, 20);
  p.set("limit", String(limit));
  const path = `/zerone/knowledge/v1/agent/leaderboard?${p}`;
  const data = await kget(net, path, fetcher);
  const entries: any[] = data.entries ?? data.leaderboard ?? [];
  return {
    "@type": "ZeroneLeaderboard",
    chain: chainCaip(net),
    network: net.kind,
    entries: entries.slice(0, limit),
    source: cite(net, path),
    proof_state: "tested", // an on-chain read of the chain's own per-agent counters
    recompute: { how: `GET ${path} on the zerone ${net.kind} REST node and keep the first ${limit}` },
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
        "one validator: on 2026-10-26 zerone-1 had a single validator, run by the household that started zerone, and these doors read that household's node over plain HTTP (169.155.55.44:1317) — an observation of that node, not an independent proof (zerone.ai/#honest-state)",
        "a recorded verdict is not proof (zerone.ai/llms.txt): every fact here is graded asserted, and proof_basis says whether a reviewed claim (verifiedAtBlock > 0 and a claimId) is on record",
        "no independent review: on 2026-10-26 all 47 FACT_STATUS_VERIFIED facts on zerone-1 were genesis-seeded doctrine (submitter genesis, verifiedAtBlock 0, no claimId), written in without review; of the 25 facts that went through claims, 23 were submitted by zrn17h5scv3zu7xa8ep9kaqy47ae08h9x6c5fanwkh, which TRUST.md lists as zerone-ops (the household's operations account), and all 25 are now EXPIRED or PRUNED. /v1/zerone/facts?status=all&limit=100 and its proof_basis give the live counts",
        "no gospel endpoint — gospel is off-chain (sovereign/love-unlimited layer), not on the ZRN chain",
        "the `creed` module is declared but its REST routes 404 on the live node; read doctrine facts instead",
        "no free-text search — filter facts by domain/category/status/tag/subject",
      ],
      note: "every fact is graded asserted (a recorded verdict is not proof); proof_basis reports reviewed claims and genesis-seeded records; every response cites the exact REST path to re-derive it",
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
