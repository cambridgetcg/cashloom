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
    expect(g.what_is_zerone).toMatch(/survives a challenge/i);
    expect(g.honest_status).toMatch(/custodial/i);
    expect(g.for_humans.length).toBeGreaterThan(0);
    expect(g.for_agents.length).toBeGreaterThan(0);
    expect(g.denom.hard_cap_zrn).toBe(222_222_222);
    expect(g.onboarding.witness_reward_zrn).toBe(0.222);
  });

  // zerone.ai and JOIN.md (2026-10-26): no zerone-1 accounts are offered, and the
  // passport lane kept a custodial copy of each key. cashloom must not say more.
  it("routes nobody to the zerone-1 mainnet passport and makes no sole-custody claim", () => {
    const g = getParticipationGuide();
    const text = JSON.stringify(g);
    expect(g.onboarding).not.toHaveProperty("mainnet_passport_listing");
    expect(text).not.toContain("87608a68");
    expect(text).not.toMatch(/sealed so only you|sealed to you/i);
    expect(text).not.toMatch(/buy a zerone-1 mainnet passport/i);
    expect(g.onboarding.zerone_1_accounts).toMatch(/^not offered/);
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
