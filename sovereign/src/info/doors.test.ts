import { readFileSync } from "node:fs";
import { describe, it, expect, vi } from "vitest";
import { Hono } from "hono";
import { mountInfoDoors } from "./doors";
import { satPerVbTimes100, readFees, type FeeFetchers } from "./fees";
import { resolveAsset, searchAssets } from "./assets";
import type { getFxRate } from "./fx";
import { mountWorldDoor } from "./world-door.ts";
import { mountCapitalFlowsDoor } from "./capital-flows/door.ts";
import { CAPITAL_FLOWS_MEDIA_TYPE, CAPITAL_FLOWS_SCHEMA, HISTORY_LIMIT } from "./capital-flows/model.ts";

// All deps faked — no network anywhere in this file.

const fakeFx: typeof getFxRate = async (base, quote) => ({
  base: base.toUpperCase(),
  quote: quote.toUpperCase(),
  valueScaled: "128000000", // 1.28 @ 8
  decimals: 8,
  method: "derived",
  proof_state: "tested",
  recompute: { how: "test fixture" },
  refDate: "2026-07-21",
  fetchedAt: "2026-07-21T16:00:00.000Z",
  sourceUrl: "https://example.test/ecb",
});

const goodFetchers: FeeFetchers = {
  esploraFees: async () => ({ "1": 20.1, "3": 12.5, "6": 8 }),
  baseGasPriceWei: async () => 12345678n,
};

function appWith(deps: Parameters<typeof mountInfoDoors>[1]) {
  const app = new Hono();
  mountInfoDoors(app, { now: () => new Date("2026-07-22T12:00:00.000Z"), ...deps });
  return app;
}

describe("satPerVbTimes100", () => {
  it("scales estimates to 2 dp integer strings", () => {
    expect(satPerVbTimes100(12.5)).toBe("1250");
    expect(satPerVbTimes100(1)).toBe("100");
    expect(satPerVbTimes100(0.1)).toBe("10");
    expect(satPerVbTimes100(0)).toBe("0");
  });
  it("survives float exponent notation", () => {
    expect(satPerVbTimes100(1e-7)).toBe("0");
  });
  it("refuses negatives and non-finite", () => {
    expect(() => satPerVbTimes100(-1)).toThrow();
    expect(() => satPerVbTimes100(Number.NaN)).toThrow();
  });
});

describe("readFees", () => {
  it("serves all sources when all answer", async () => {
    const r = await readFees(undefined, goodFetchers);
    expect(r.facts).toHaveLength(2);
    expect(r.failed).toHaveLength(0);
    const btc = r.facts.find((f) => f.predicate === "fee_per_vbyte_sat")!;
    expect(btc.value).toBe("1250");
    expect(btc.decimals).toBe(10); // unit/decimals contract: value × 10^-10 = BTC/vB
    const base = r.facts.find((f) => f.predicate === "gas_price_wei")!;
    expect(base.value).toBe("12345678");
    expect(base.decimals).toBe(18); // wei read as ETH/gas
  });

  it("names a failed source instead of hiding it", async () => {
    const r = await readFees(undefined, {
      ...goodFetchers,
      esploraFees: async () => {
        throw new Error("down");
      },
    });
    expect(r.facts).toHaveLength(1);
    expect(r.failed).toHaveLength(1);
    expect(r.failed[0].label).toContain("Bitcoin");
  });

  it("echoes an unknown chain filter", async () => {
    const r = await readFees("eip155:1", goodFetchers);
    expect(r.unknown).toBe("eip155:1");
  });

  it("accepts chain aliases case-insensitively", async () => {
    const r = await readFees("btc", goodFetchers);
    expect(r.unknown).toBeUndefined();
    expect(r.facts).toHaveLength(1);
    expect(r.facts[0].predicate).toBe("fee_per_vbyte_sat");
  });

  it("treats an empty filter as all chains", async () => {
    const r = await readFees("", goodFetchers);
    expect(r.facts).toHaveLength(2);
  });

  it("never publishes a configured Base RPC credential in a source receipt", async () => {
    const previous = process.env.CASHLOOM_BASE_RPC_URL;
    process.env.CASHLOOM_BASE_RPC_URL = "https://provider.example/v2/SUPER-SECRET-BASE-KEY";
    try {
      const result = await readFees("base", goodFetchers);
      expect(JSON.stringify(result)).not.toContain("SUPER-SECRET-BASE-KEY");
      expect(result.facts[0].sources[0].url).toContain("docs.base.org");
    } finally {
      if (previous === undefined) delete process.env.CASHLOOM_BASE_RPC_URL;
      else process.env.CASHLOOM_BASE_RPC_URL = previous;
    }
  });
});

describe("asset registry", () => {
  it("resolves aliases to canonical rows", () => {
    expect(resolveAsset("usdc")?.id).toContain("erc20:0x8335");
    expect(resolveAsset("iso4217:GBP")?.symbol).toBe("GBP");
    expect(resolveAsset("zrn")?.decimals).toBe(6);
    expect(resolveAsset("nope")).toBeUndefined();
  });
  it("searches across names and aliases", () => {
    const hits = searchAssets("usd");
    expect(hits.length).toBeGreaterThanOrEqual(2); // USD fiat + USDC at least
  });
});

describe("/v1/convert", () => {
  const app = appWith({ fxRate: fakeFx });

  it("converts fiat→fiat exactly and shows its work", async () => {
    const res = await app.request("/v1/convert?amount_minor=10000&from=GBP&to=USD");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.result.value).toBe("12800"); // 100.00 GBP @ 1.28 = 128.00 USD
    expect(body.result.decimals).toBe(2);
    expect(body.rounding).toBe("half_even");
    expect(body.rate.value_scaled).toBe("128000000");
    expect(body.result.recompute.how).toContain("half-even");
  });

  it("teaches on a malformed amount", async () => {
    const res = await app.request("/v1/convert?amount_minor=100.50&from=GBP&to=USD");
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.detail).toContain("amount_minor=10050");
  });

  it("refuses crypto conversion honestly", async () => {
    const res = await app.request("/v1/convert?amount_minor=100&from=BTC&to=USD");
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.title).toBe("conversion not yet served");
    expect(body.next_actions).toBeDefined();
  });

  it("names the fiat registry and sends a crypto leg to the value and price doors", async () => {
    const body = await (await app.request("/v1/convert?amount_minor=100000000&from=BTC&to=EUR")).json();
    expect(body.detail).toContain("GBP, USD, EUR");
    expect(body.detail).toContain("/v1/value/{amount_minor}/{asset}/{quote}");
    expect(body.detail).toContain("/v1/price/{asset}/{quote}");
    expect(body.detail).not.toMatch(/no honest source/);
    expect(body.next_actions).toContain("GET /v1/value/100000000/BTC/EUR for this amount's value");
    expect(body.next_actions).toContain("GET /v1/price/BTC/EUR for the unit price");

    const toCrypto = await (await app.request("/v1/convert?amount_minor=10000&from=GBP&to=eth-base")).json();
    expect(toCrypto.next_actions).toContain("GET /v1/price/ETH/GBP for the unit price");
    expect(toCrypto.next_actions.join(" ")).not.toContain("/v1/value/");
    // the Base ETH row is priced by the Ethereum mainnet feed, and the detail says so
    expect(toCrypto.detail).toContain("eip155:8453/slip44:60 (Ether (Base)) has no feed of its own");
    expect(toCrypto.detail).toContain("ETH/USD feed for eip155:1/slip44:60");
    expect(body.detail).not.toContain("has no feed of its own");

    // bare "ETH" is not a registry alias (the row is Base ETH), but it is priced
    const bare = await (await app.request("/v1/convert?amount_minor=1&from=ETH&to=USD")).json();
    expect(bare.title).toBe("unknown asset");
    expect(bare.next_actions[0]).toBe("GET /v1/price/ETH/USD");
  });

  // Hono has already decoded the query; decoding again threw URIError (500).
  it("refuses an unknown asset holding a raw '%' with 422, not a crash", async () => {
    for (const q of ["amount_minor=1&from=%25&to=USD", "amount_minor=1&from=GBP&to=%25zz"]) {
      const res = await app.request(`/v1/convert?${q}`);
      expect(res.status).toBe(422);
      expect((await res.json()).title).toBe("unknown asset");
    }
  });

  it("says when a crypto leg has no price source at all", async () => {
    const body = await (await app.request("/v1/convert?amount_minor=1000000&from=ZRN&to=USD")).json();
    expect(body.status).toBe(422);
    expect(body.detail).toContain("ZRN has no price source here");
    expect(body.next_actions.join(" ")).not.toContain("/v1/value/1000000/ZRN");
    expect(body.next_actions).toContain("GET /v1/prices for every priced asset");
  });

  it("applies half-even at the conversion's final digit", async () => {
    // 0.25 GBP @ 0.5: 25 × 50000000 × 10^-8 = 12.5 → 12 (even)
    const tieFx: typeof fakeFx = async (b, q) => ({
      ...(await fakeFx(b, q)),
      valueScaled: "50000000",
    });
    const tieApp = appWith({ fxRate: tieFx });
    const res = await tieApp.request("/v1/convert?amount_minor=25&from=GBP&to=USD");
    expect((await res.json()).result.value).toBe("12");
  });

  it("stamps the ECB fixing date, never a fabricated now", async () => {
    const res = await app.request("/v1/convert?amount_minor=10000&from=GBP&to=USD");
    const body = await res.json();
    expect(body.ref_date).toBe("2026-07-21");
    expect(body.result.observed_at).toBe("2026-07-21");
    expect(body.result.stale_after_s).toBe(7 * 86_400);
  });

  it("refuses conversion when the ECB reference leg is too old", async () => {
    const stale = appWith({
      fxRate: fakeFx,
      now: () => new Date("2026-08-20T12:00:00.000Z"),
    });
    const response = await stale.request("/v1/convert?amount_minor=10000&from=GBP&to=USD");
    expect(response.status).toBe(503);
    expect((await response.json()).title).toContain("fx reference");
  });

  it("names the supported rounding when refused", async () => {
    const res = await app.request("/v1/convert?amount_minor=100&from=GBP&to=USD&rounding=floor");
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.detail).toContain("half_even");
  });

  it("asks for missing parameters with an example", async () => {
    const res = await app.request("/v1/convert");
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.next_actions[0]).toContain("amount_minor=");
  });
});

describe("/v1/fees door", () => {
  it("serves partial results with the failure named", async () => {
    const app = appWith({
      fees: (chain) =>
        readFees(chain, {
          ...goodFetchers,
          baseGasPriceWei: async () => {
            throw new Error("down");
          },
        }),
    });
    const res = await app.request("/v1/fees");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.count).toBe(1);
    expect(body.failed).toHaveLength(1);
  });

  it("404s an unknown chain naming the actual supported set", async () => {
    const app = appWith({ fees: (chain) => readFees(chain, goodFetchers) });
    const res = await app.request("/v1/fees?chain=eip155:1");
    expect(res.status).toBe(404);
    const next = (await res.json()).next_actions as string[];
    expect(next.join(" ")).toContain("bip122:");
    expect(next.join(" ")).toContain("eip155:8453");
  });
});

describe("/v1/assets doors", () => {
  const app = appWith({});
  it("serves the registry and resolves one asset", async () => {
    const all = await app.request("/v1/assets");
    expect((await all.json()).count).toBeGreaterThanOrEqual(7);
    const one = await app.request("/v1/assets/usdc");
    expect((await one.json()).symbol).toBe("USDC");
  });
  it("404s the unknown with search guidance", async () => {
    const res = await app.request("/v1/assets/wat");
    expect(res.status).toBe(404);
    expect((await res.json()).next_actions[0]).toContain("?q=");
  });

  it("reaches slash-bearing canonical ids raw", async () => {
    const res = await app.request(
      "/v1/assets/eip155:8453/erc20:0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    );
    expect(res.status).toBe(200);
    expect((await res.json()).symbol).toBe("USDC");
  });

  it("refuses a raw percent without crashing", async () => {
    const res = await app.request("/v1/assets/%25");
    expect(res.status).toBe(404);
    expect((await res.json()).title).toBe("unknown asset");
  });

  it("resolves the sibling door's fiat:iso4217 unit strings", async () => {
    const res = await app.request("/v1/assets/fiat:iso4217%2FUSD");
    expect(res.status).toBe(200);
    expect((await res.json()).symbol).toBe("USD");
  });
});

describe("/v1/guide", () => {
  it("serves the hospitality guide with promises and honest gaps", async () => {
    const app = appWith({});
    const res = await app.request("/v1/guide");
    const body = await res.json();
    expect(body.promises_not_to.length).toBeGreaterThanOrEqual(4);
    expect(body.not_covered.join(" ")).toContain("prices");
    expect(body.rights.baseline).toBe("xenia.rights/0.1");
  });

  it("describes scoped publisher histories, exact units and source-specific reuse evidence", async () => {
    const body = await (await appWith({}).request("/v1/guide")).json();
    expect(body.doors.capital_flows).toBe("/v1/capital-flows");
    expect(body.capital_flows).toMatchObject({
      api: "/v1/capital-flows",
      media_type: CAPITAL_FLOWS_MEDIA_TYPE,
      schema: CAPITAL_FLOWS_SCHEMA,
      history: { policy: "latestRevisedPublisherHistoryNotVintageArchive", maximum_observations_per_series: HISTORY_LIMIT },
    });
    expect(body.capital_flows.human_route).toContain("INFO process serves JSON");
    expect(body.capital_flows.scope.join(" ")).toContain("Grand Total 99996");
    expect(body.capital_flows.scope.join(" ")).toContain("quarterly EUR millions");
    expect(body.capital_flows.scope.join(" ")).toContain("Foreign purchases use _sale, foreign sales use _pur");
    expect(body.capital_flows.scope.join(" ")).toContain("not pure secondary turnover");
    expect(body.capital_flows.read_values).toContain("unitMultiplier");
    expect(body.capital_flows.periods_and_receipts).toContain("nullable receipt.publicationAt");
    expect(body.capital_flows.refresh).toContain("no capital fetch enters World's critical path");
    expect(body.capital_flows.boundaries).toContain("No accounts, execution, alerts, continuous collector or archived vintages");
    expect(body.capital_flows.boundaries).toContain("not a declared XENIA Surface resource");
    const ecb = body.sources_ledger.find((source: any) => source.name === "ECB securities issuance and investment-fund statistics");
    expect(ecb.license).toContain("available free of charge from the ECB");
    expect(ecb.evidence_url).toBe("https://www.ecb.europa.eu/services/disclaimer/html/index.en.html");
    const fiscal = body.sources_ledger.find((source: any) => source.name === "US Treasury Daily Treasury Statement cash debt totals");
    expect(fiscal.evidence_url).toBe("https://fiscaldata.treasury.gov/api-documentation/");
    const tic = body.sources_ledger.find((source: any) => source.name === "US Treasury TIC SLT aggregate securities transactions");
    expect(tic.evidence_url).toBe("https://www.copyright.gov/title17/92chap1.html#105");
    expect(tic.provenance_url).toBe("https://home.treasury.gov/data/treasury-international-capital-tic-system-home-page/tic-forms-instructions/tic-slt-form-and-instructions");
    expect(tic.license).toContain("not blanket permission");
  });
});

// Exercise only injected Hono reads: importing either real entrypoint would start
// the INFO listener or initialize the local wallet database, outside this test.
describe("capital-flow public route integration", () => {
  it("mounts once in each entrypoint, before the local vault session gate", () => {
    for (const file of ["../info-server.ts", "../index.ts"]) {
      const source = readFileSync(new URL(file, import.meta.url), "utf-8");
      expect(source.match(/mountCapitalFlowsDoor\(app\)/g)).toHaveLength(1);
      expect(source).toContain('from "./info/capital-flows/door.ts"');
      expect(source.indexOf("mountCapitalFlowsDoor(app)")).toBeGreaterThan(source.indexOf("mountWorldDoor(app)"));
      if (file === "../index.ts") {
        expect(source.indexOf("mountCapitalFlowsDoor(app)")).toBeLessThan(source.indexOf("session-gated API"));
      }
    }
  });

  it("serves World while a capital read is blocked, then after its sanitized failure", async () => {
    const app = new Hono();
    let failCapital!: (reason: Error) => void;
    let started!: () => void;
    const capitalStarted = new Promise<void>((resolve) => { started = resolve; });
    const blocked = new Promise<never>((_, reject) => { failCapital = reject; });
    const capitalRead = vi.fn(() => { started(); return blocked; });
    const cache = mountCapitalFlowsDoor(app, { cache: {
      read: capitalRead,
      waitForIdle: async () => {},
      dispose: () => { failCapital(new Error("injected capital failure")); },
    } });
    const unavailable = async (): Promise<never> => { throw new Error("fixture unavailable"); };
    mountWorldDoor(app, {
      macro: unavailable, announcements: unavailable, cash: unavailable, price: unavailable,
      fxRate: fakeFx, fees: async () => ({ facts: [], failed: [] }),
      now: () => new Date("2026-07-22T12:00:00.000Z"),
    });
    let capitalSettled = false;
    const capital = Promise.resolve(app.request("/v1/capital-flows")).then((response) => {
      capitalSettled = true;
      return response;
    });
    try {
      await capitalStarted;
      const world = await app.request("/v1/world");
      expect(world.status).toBe(200);
      expect((await world.json()).schema).toBe("cashloom.world/1");
      expect(capitalSettled).toBe(false);
      expect(capitalRead).toHaveBeenCalledOnce();
      failCapital(new Error("injected capital failure"));
      const failure = await capital;
      expect(failure.status).toBe(503);
      expect(await failure.text()).not.toContain("injected capital failure");
      const unchanged = await app.request("/v1/world", { headers: { "If-None-Match": world.headers.get("ETag")! } });
      expect(unchanged.status).toBe(304);
      expect(capitalRead).toHaveBeenCalledOnce();
    } finally {
      cache.dispose();
      await capital;
    }
  }, 1_000);
});
