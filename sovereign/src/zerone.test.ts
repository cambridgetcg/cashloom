import { describe, it, expect, afterEach, spyOn } from "bun:test";
import {
  getParticipationGuide,
  getNetworkStatus,
  getAddressBalance,
  isZrnAddress,
  ZERONE_NETWORKS,
  ZRN,
} from "./zerone.ts";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("zerone participation guide", () => {
  it("is honest and covers both audiences + the hard cap", () => {
    const g = getParticipationGuide();
    expect(g.what_is_zerone).toContain("a recorded verdict is not proof that a claim is true");
    expect(g.what_is_zerone).not.toMatch(/proof-of-quality|three pathways|nothing else can mint/i);
    expect(g.what_is_zerone).toContain("governance-configurable issuance");
    expect(g.honest_status).toMatch(/custodial/i);
    expect(g.for_humans.length).toBeGreaterThan(0);
    expect(g.for_agents.length).toBeGreaterThan(0);
    expect(g.denom.hard_cap_zrn).toBe(222_222_222);
    expect(g.onboarding.witness_reward_zrn).toBe(0.222);
  });

  // zerone.ai and JOIN.md (2026-10-26): no zerone-1 accounts are offered, and the
  // passport lane kept a custodial copy of each key. cashloom must not say more.
  // The free guide listing (96f679d7) points buyers at the mainnet passport, and
  // the testnet passport (64cbc078) says "sealed so only you can open it" while
  // its seller keeps a custodial copy, so the guide names no listing at all.
  it("routes nobody to an agenttool passport or listing and makes no sole-custody claim", () => {
    const g = getParticipationGuide();
    const text = JSON.stringify(g);
    expect(g.onboarding).not.toHaveProperty("mainnet_passport_listing");
    for (const key of ["marketplace", "testnet_passport_listing", "free_guide_listing"]) expect(g.onboarding).not.toHaveProperty(key);
    for (const id of ["87608a68", "64cbc078", "96f679d7", "api.agenttool.dev"]) expect(text).not.toContain(id);
    expect(text).not.toMatch(/sealed so only you|sealed to you/i);
    expect(text).not.toMatch(/buy a zerone-1 mainnet passport|prove your integration/i);
    expect(text).not.toMatch(/accounts are not offered/i);
    expect(g.onboarding.zerone_1_accounts).toMatch(/^zerone offers none \(zerone\.ai/);
    expect(g.onboarding.zerone_testnet_1_accounts).toContain("buy or request credentials");
    expect(g.networks.testnet.what).toContain("not a validator or full-node join guide");
    expect(g.for_humans.join(" ")).toContain("none are offered");
    expect(g.honest_status).toMatch(/shared custody/);
    expect(g.zerone_public.whatYouCanDoToday).toBe("https://zerone.ai/#onboarding");
  });

  it("states the exit as it is: IBC client expired, Osmosis side testnet", () => {
    const g = getParticipationGuide();
    expect(g.exit).toContain("07-tendermint-0");
    expect(g.exit).toContain("Expired");
    expect(g.exit).toContain("osmo-test-5");
    expect(g.exit).not.toMatch(/permissionless|near-free/i);
  });

  it("gives the challenge window in blocks and at the measured block time", () => {
    const g = getParticipationGuide();
    expect(g.onboarding.challenge_window_blocks).toBe(200);
    expect(g.onboarding.challenge_window_basis).toContain("abci_query");
    expect(g.for_agents.join(" ")).toContain("200 blocks");
    expect(g.for_agents.join(" ")).toContain("about 100 minutes at the 30 s block time");
    expect(JSON.stringify(g)).not.toMatch(/8-9 min|8–9 min/);
  });

  it("says the zerone-core links need repository access", () => {
    const g = getParticipationGuide();
    expect(Object.values(g.links).every((u) => u.startsWith("https://github.com/cambridgetcg/zerone-core"))).toBe(true);
    expect(g.links_access).toMatch(/private repository/);
  });

  // The UI turns each links key into its label: JOIN.md is titled "Observe zerone-1".
  it("names the links for what the pages are", () => {
    const g = getParticipationGuide();
    expect(Object.keys(g.links)).toEqual(expect.arrayContaining(["observeMainnet", "testnetNodeStatus"]));
    expect(g.links).not.toHaveProperty("joinMainnet");
    expect(g.links).not.toHaveProperty("runANode");
  });

  it("attributes sealing to the operator and leads with zerone.ai's unflattering facts", () => {
    const g = getParticipationGuide();
    expect(g.networks.mainnet.what).toContain("no date is promised");
    expect(g.networks.mainnet.what).not.toMatch(/then it seals/);
    expect(g.honest_status).toContain("at least 95% of ZRN");
    expect(g.honest_status).toContain("the people who ran that sign-up kept a copy of their keys");
  });
});

describe("live status (mocked)", () => {
  it("reports height, supply and % of the cap when the node answers", async () => {
    globalThis.fetch = (async (url: string | URL | Request) => {
      const u = String(url);
      const body = u.includes("/status")
        ? { result: { sync_info: { latest_block_height: "58549", catching_up: false } } }
        : { amount: { denom: "uzrn", amount: "13566857546" } };
      return new Response(JSON.stringify(body), { status: 200 });
    }) as unknown as typeof fetch;
    const s = await getNetworkStatus(ZERONE_NETWORKS.mainnet);
    expect(s.reachable).toBe(true);
    expect(s.height).toBe("58549");
    expect(s.supply_zrn).toBeCloseTo(13566.857546, 3);
    expect(s.minted_pct_of_cap).toBeGreaterThan(0);
    expect(s.minted_pct_of_cap).toBeLessThan(0.01);
  });

  it("says supply is unknown, never zero, when the node answers without an amount", async () => {
    globalThis.fetch = (async (url: string | URL | Request) => {
      const body = String(url).includes("/status")
        ? { result: { sync_info: { latest_block_height: "58549", catching_up: false } } }
        : {};
      return new Response(JSON.stringify(body), { status: 200 });
    }) as unknown as typeof fetch;
    const s = await getNetworkStatus(ZERONE_NETWORKS.mainnet);
    expect(s.reachable).toBe(true);
    expect(s.supply_uzrn).toBeNull();
    expect(s.supply_zrn).toBeNull();
    expect(s.minted_pct_of_cap).toBeNull();
    expect(s.supply_issue).toContain("Supply unknown");
  });

  it("degrades honestly to reachable:false instead of throwing", async () => {
    globalThis.fetch = (async () => {
      throw new Error("node down");
    }) as unknown as typeof fetch;
    const s = await getNetworkStatus(ZERONE_NETWORKS.testnet);
    expect(s.reachable).toBe(false);
    expect(s.supply_zrn).toBeNull();
  });
});

describe("address balance (mocked)", () => {
  it("reads a zrn address ZRN balance in uzrn and ZRN", async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ balance: { denom: "uzrn", amount: "2222000" } }), {
        status: 200,
      })) as unknown as typeof fetch;
    const b = await getAddressBalance("zrn1la2g8yzqtpj546x2x9rq42erc6zpj4jqktkhaz");
    expect(b.balance_uzrn).toBe("2222000");
    expect(b.balance_zrn).toBeCloseTo(2.222, 6);
    expect(b.network).toBe(ZERONE_NETWORKS.mainnet.id);
  });

  it("serves a zero only when the chain reports one", async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ balance: { denom: "uzrn", amount: "0" } }), { status: 200 })) as unknown as typeof fetch;
    expect((await getAddressBalance("zrn1la2g8yzqtpj546x2x9rq42erc6zpj4jqktkhaz")).balance_uzrn).toBe("0");
  });

  it("refuses instead of inventing a zero when the node is down or the answer has no uzrn amount", async () => {
    const address = "zrn1la2g8yzqtpj546x2x9rq42erc6zpj4jqktkhaz";
    globalThis.fetch = (async () => {
      throw new Error("node down");
    }) as unknown as typeof fetch;
    await expect(getAddressBalance(address)).rejects.toThrow();
    for (const body of [{ balances: [] }, { balance: { denom: "uatom", amount: "5" } }, { balance: { denom: "uzrn", amount: "1.5" } }]) {
      globalThis.fetch = (async () => new Response(JSON.stringify(body), { status: 200 })) as unknown as typeof fetch;
      await expect(getAddressBalance(address)).rejects.toThrow("no uzrn balance");
    }
  });
});

describe("address validation + config", () => {
  it("accepts zrn1 addresses and rejects others", () => {
    expect(isZrnAddress("zrn1la2g8yzqtpj546x2x9rq42erc6zpj4jqktkhaz")).toBe(true);
    expect(isZrnAddress("cosmos1abc")).toBe(false);
    expect(isZrnAddress("0xdeadbeef")).toBe(false);
  });
  it("has the canonical denom and micro factor", () => {
    expect(ZRN.denom).toBe("uzrn");
    expect(ZRN.micro).toBe(1_000_000);
  });
});
