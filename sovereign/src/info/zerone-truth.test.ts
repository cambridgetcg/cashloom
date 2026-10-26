import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import { strayProofStates } from "./proof-states.ts";
import {
  getFacts,
  getDoctrine,
  getFact,
  getCommitments,
  getAgentCalibration,
  hasReviewedClaim,
  mountZeroneTruth,
  type ZeroneFetcher,
} from "./zerone-truth";

// Record shapes as the zerone-1 knowledge REST returns them (camelCase). On
// 2026-10-26 every VERIFIED fact there looked like GENESIS_FACT.
const GENESIS_FACT = { id: "fact-1", content: "methodology over statement", domain: "doctrine_truth_seeking", category: "doctrine", confidence: "880000", status: "FACT_STATUS_VERIFIED", submitter: "genesis", verifiedAtBlock: "0", claimId: "" };
// A reviewed claim still VERIFIED, from the household's zerone-ops account
// (TRUST.md), which submitted 23 of the 25 claim-backed facts on zerone-1.
const REVIEWED_FACT = { id: "fact-2", content: "a reviewed claim", domain: "biology", category: "empirical", confidence: "770000", status: "FACT_STATUS_VERIFIED", submitter: "zrn17h5scv3zu7xa8ep9kaqy47ae08h9x6c5fanwkh", verifiedAtBlock: "1200", claimId: "claim-9" };

// A fake zerone REST — inspects the URL and returns canned knowledge-module
// JSON. No network anywhere; also lets us assert the exact query the reader built.
function fakeFetcher(record?: string[], facts: any[] = [GENESIS_FACT]): ZeroneFetcher {
  return async (url: string) => {
    record?.push(url);
    if (/\/facts\/[^/?]+$/.test(url)) return { fact: facts[0] };
    if (url.includes("/trust_profile")) return { grounded_score_bps: "900000", corroboration_count: 2, axiom_distance: 1 };
    if (url.includes("/facts?")) {
      const verified = url.includes("FACT_STATUS_VERIFIED");
      // like the live node: every match comes back, pagination.limit is ignored
      return { facts: verified ? facts : facts.map((f) => ({ ...f, status: "FACT_STATUS_PENDING" })), pagination: null };
    }
    if (url.includes("/commitments")) return { commitments: [{ id: "NC-FALSIFICATION-IS-PROGRESS", statement: "a refuted claim is progress", active: true }] };
    if (url.includes("/calibration")) return { calibration: { address: "zrn1abc", accepted: 5, rejected: 1, disproven_count: 0, calibration_score_bps: "1000000" } };
    if (url.includes("/domains")) return { domains: ["agent_rights", "biology"] };
    throw new Error("unexpected url " + url);
  };
}

const MAINNET_REST = "http://169.155.55.44:1317";
const TESTNET_REST = "http://37.16.28.121:1317";

describe("zerone-truth readers", () => {
  it("reads verified facts by default, cited; genesis-seeded facts are asserted, not attested", async () => {
    const calls: string[] = [];
    const r = await getFacts({}, fakeFetcher(calls));
    expect(calls[0]).toContain(MAINNET_REST + "/zerone/knowledge/v1/facts?");
    expect(calls[0]).toContain("status=FACT_STATUS_VERIFIED"); // 'verified' → chain enum
    expect(calls[0]).toContain("pagination.limit=20");
    expect(r.chain).toBe("cosmos:zerone-1");
    expect(r.proof_state).toBe("asserted");
    expect(r.proof_basis).toMatchObject({ records: 1, with_reviewed_claim: 0, genesis_seeded: 1 });
    expect(r.recompute.how).not.toMatch(/quorum/i);
    expect(r.count).toBe(1);
    expect(r.source.url).toContain("/facts?");
    expect(r["@type"]).toBe("ZeroneTruth");
  });

  // zerone.ai/llms.txt: "a recorded verdict is not proof that a claim is true".
  it("never grades a fact attested; a reviewed claim is reported in proof_basis", async () => {
    expect(hasReviewedClaim(GENESIS_FACT)).toBe(false);
    expect(hasReviewedClaim(REVIEWED_FACT)).toBe(true);
    expect(hasReviewedClaim({ ...REVIEWED_FACT, claimId: "" })).toBe(false);
    expect(hasReviewedClaim({ ...REVIEWED_FACT, verifiedAtBlock: "0" })).toBe(false);
    const reviewed = await getFacts({}, fakeFetcher([], [REVIEWED_FACT]));
    expect(reviewed.proof_state).toBe("asserted");
    expect(reviewed.proof_basis).toMatchObject({ records: 1, with_reviewed_claim: 1, genesis_seeded: 0 });
    expect(reviewed.proof_basis.rule).toContain("not proof");
    const mixed = await getFacts({}, fakeFetcher([], [REVIEWED_FACT, GENESIS_FACT]));
    expect(mixed.proof_basis).toMatchObject({ records: 2, with_reviewed_claim: 1, genesis_seeded: 1 });
    expect((await getFacts({}, fakeFetcher([], []))).proof_state).toBe("asserted");
    expect(JSON.stringify(reviewed)).not.toContain('"attested"');
  });

  it("enforces limit itself, because the node ignores pagination.limit", async () => {
    const many = Array.from({ length: 47 }, (_, i) => ({ ...GENESIS_FACT, id: `fact-${i}` }));
    const r = await getFacts({ limit: 3 }, fakeFetcher([], many));
    expect(r.count).toBe(3);
    expect(r.facts.map((f: any) => f.id)).toEqual(["fact-0", "fact-1", "fact-2"]);
    expect(r.node_count).toBe(47);
    const d = await getDoctrine({ limit: 2 }, fakeFetcher([], many));
    expect(d.count).toBe(2);
    expect((await getFacts({ limit: Number("abc") }, fakeFetcher([], many))).count).toBe(20);
  });

  it("status=all does not filter, and is graded asserted not attested", async () => {
    const calls: string[] = [];
    const r = await getFacts({ status: "all" }, fakeFetcher(calls));
    expect(calls[0]).not.toContain("status=");
    expect(r.proof_state).toBe("asserted");
  });

  it("routes to the testnet REST base when asked", async () => {
    const calls: string[] = [];
    const r = await getFacts({ network: "testnet" }, fakeFetcher(calls));
    expect(calls[0]).toContain(TESTNET_REST);
    expect(r.chain).toBe("cosmos:zerone-testnet-1");
  });

  it("clamps limit into 1..100", async () => {
    const calls: string[] = [];
    await getFacts({ limit: 9999 }, fakeFetcher(calls));
    expect(calls[0]).toContain("pagination.limit=100");
  });

  it("reads doctrine as category=doctrine facts", async () => {
    const calls: string[] = [];
    const r = await getDoctrine({}, fakeFetcher(calls));
    expect(calls[0]).toContain("category=doctrine");
    expect(r["@type"]).toBe("ZeroneDoctrine");
    expect(r.proof_state).toBe("asserted"); // seeded at genesis, without review
    expect(r.count).toBe(1);
  });

  it("reads one fact WITH its trust profile (two calls composed)", async () => {
    const calls: string[] = [];
    const r = await getFact("fact-1", undefined, fakeFetcher(calls));
    expect(calls.some((u) => u.endsWith("/facts/fact-1"))).toBe(true);
    expect(calls.some((u) => u.includes("/trust_profile"))).toBe(true);
    expect(r.fact.id).toBe("fact-1");
    expect(r.trust_profile.grounded_score_bps).toBe("900000");
    expect(r.proof_state).toBe("asserted"); // VERIFIED, but genesis-seeded: no claim behind it
    expect(r.proof_basis.reviewed_claim_on_record).toBe(false);
    const reviewed = await getFact("fact-2", undefined, fakeFetcher([], [REVIEWED_FACT]));
    expect(reviewed.proof_state).toBe("asserted");
    expect(reviewed.proof_basis).toMatchObject({ reviewed_claim_on_record: true, submitter: REVIEWED_FACT.submitter });
  });

  it("reads the chain's normative commitments", async () => {
    const r = await getCommitments(undefined, fakeFetcher());
    expect(r.count).toBe(1);
    expect(r.commitments[0].id).toBe("NC-FALSIFICATION-IS-PROGRESS");
    expect(r.proof_state).toBe("asserted");
  });

  it("reads an agent's calibration (the chain's record of one address)", async () => {
    const calls: string[] = [];
    const r = await getAgentCalibration("zrn1abc", undefined, fakeFetcher(calls));
    expect(calls[0]).toContain("/agent/zrn1abc/calibration");
    expect(r.calibration.calibration_score_bps).toBe("1000000");
    expect(r.proof_state).toBe("tested");
  });
});

describe("zerone-truth doors", () => {
  const appWith = (f: ZeroneFetcher) => {
    const app = new Hono();
    mountZeroneTruth(app, { fetcher: f });
    return app;
  };

  it("serves no ranking of agents", async () => {
    const res = await appWith(fakeFetcher()).request("/v1/zerone/leaderboard");
    expect(res.status).toBe(404);
    const guide = await (await appWith(fakeFetcher()).request("/v1/zerone")).json();
    expect(JSON.stringify(guide)).not.toContain("leaderboard");
  });

  it("serves the guide with honest gaps (single validator, genesis facts, household-submitted claims, no gospel, creed not live)", async () => {
    const res = await appWith(fakeFetcher()).request("/v1/zerone");
    expect(res.status).toBe(200);
    const body = await res.json();
    const gaps = body.honest_gaps.join(" ");
    expect(gaps).toContain("on 2026-10-26 zerone-1 had a single validator");
    expect(gaps).toContain("genesis-seeded");
    expect(gaps).toContain("not proof");
    expect(gaps).toContain("zerone-ops");
    expect(gaps).toContain("gospel");
    expect(gaps).toContain("creed");
    expect(body.note).not.toMatch(/quorum/i);
    expect(body.doors.doctrine).toBeDefined();
  });

  it("serves verified facts over the door, graded by their record", async () => {
    const res = await appWith(fakeFetcher()).request("/v1/zerone/facts");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.proof_state).toBe("asserted");
    expect(strayProofStates(body)).toEqual([]);
  });

  it("honours ?limit on the facts door", async () => {
    const many = Array.from({ length: 5 }, (_, i) => ({ ...GENESIS_FACT, id: `fact-${i}` }));
    const body = await (await appWith(fakeFetcher([], many)).request("/v1/zerone/facts?status=verified&limit=3")).json();
    expect(body.count).toBe(3);
    expect(body.facts).toHaveLength(3);
    expect(body.node_count).toBe(5);
  });

  it("serves doctrine over the door", async () => {
    const res = await appWith(fakeFetcher()).request("/v1/zerone/doctrine");
    expect((await res.json())["@type"]).toBe("ZeroneDoctrine");
  });

  it("refuses honestly (502) when the chain is unreachable, naming a way forward", async () => {
    const down: ZeroneFetcher = async () => {
      throw new Error("connection refused");
    };
    const res = await appWith(down).request("/v1/zerone/facts");
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.title).toBe("zerone unreachable");
    expect(body.next_actions).toBeDefined();
  });
});
