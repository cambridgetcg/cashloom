import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import { getFacts, getDoctrine, getFact, getCommitments, getAgentCalibration, mountZeroneTruth, type ZeroneFetcher } from "./zerone-truth";

// A fake zerone REST — inspects the URL and returns canned knowledge-module
// JSON. No network anywhere; also lets us assert the exact query the reader built.
function fakeFetcher(record?: string[]): ZeroneFetcher {
  return async (url: string) => {
    record?.push(url);
    if (/\/facts\/[^/?]+$/.test(url)) return { fact: { id: "fact-1", content: "x", status: "FACT_STATUS_VERIFIED" } };
    if (url.includes("/trust_profile")) return { grounded_score_bps: "900000", corroboration_count: 2, axiom_distance: 1 };
    if (url.includes("/facts?")) {
      const verified = url.includes("FACT_STATUS_VERIFIED");
      return { facts: [{ id: "fact-1", content: "methodology over statement", domain: "doctrine_truth_seeking", confidence: "1000000", status: verified ? "FACT_STATUS_VERIFIED" : "FACT_STATUS_PENDING" }], pagination: {} };
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
  it("reads verified facts by default, cited and attested", async () => {
    const calls: string[] = [];
    const r = await getFacts({}, fakeFetcher(calls));
    expect(calls[0]).toContain(MAINNET_REST + "/zerone/knowledge/v1/facts?");
    expect(calls[0]).toContain("status=FACT_STATUS_VERIFIED"); // 'verified' → chain enum
    expect(calls[0]).toContain("pagination.limit=20");
    expect(r.chain).toBe("cosmos:zerone-1");
    expect(r.proof_state).toBe("attested");
    expect(r.count).toBe(1);
    expect(r.source.url).toContain("/facts?");
    expect(r["@type"]).toBe("ZeroneTruth");
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
    expect(r.proof_state).toBe("attested");
    expect(r.count).toBe(1);
  });

  it("reads one fact WITH its trust profile (two calls composed)", async () => {
    const calls: string[] = [];
    const r = await getFact("fact-1", undefined, fakeFetcher(calls));
    expect(calls.some((u) => u.endsWith("/facts/fact-1"))).toBe(true);
    expect(calls.some((u) => u.includes("/trust_profile"))).toBe(true);
    expect(r.fact.id).toBe("fact-1");
    expect(r.trust_profile.grounded_score_bps).toBe("900000");
    expect(r.proof_state).toBe("attested"); // fact status is VERIFIED
  });

  it("reads the chain's normative commitments", async () => {
    const r = await getCommitments(undefined, fakeFetcher());
    expect(r.count).toBe(1);
    expect(r.commitments[0].id).toBe("NC-FALSIFICATION-IS-PROGRESS");
  });

  it("reads an agent's calibration (the compassion track record)", async () => {
    const calls: string[] = [];
    const r = await getAgentCalibration("zrn1abc", undefined, fakeFetcher(calls));
    expect(calls[0]).toContain("/agent/zrn1abc/calibration");
    expect(r.calibration.calibration_score_bps).toBe("1000000");
  });
});

describe("zerone-truth doors", () => {
  const appWith = (f: ZeroneFetcher) => {
    const app = new Hono();
    mountZeroneTruth(app, { fetcher: f });
    return app;
  };

  it("serves the guide with honest gaps (no gospel, creed not live)", async () => {
    const res = await appWith(fakeFetcher()).request("/v1/zerone");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.honest_gaps.join(" ")).toContain("gospel");
    expect(body.honest_gaps.join(" ")).toContain("creed");
    expect(body.doors.doctrine).toBeDefined();
  });

  it("serves verified facts over the door", async () => {
    const res = await appWith(fakeFetcher()).request("/v1/zerone/facts");
    expect(res.status).toBe(200);
    expect((await res.json()).proof_state).toBe("attested");
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
