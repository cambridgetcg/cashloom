import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import { mountInfoDoors } from "./doors";
import { satPerVbTimes100, readFees, type FeeFetchers } from "./fees";
import { resolveAsset, searchAssets } from "./assets";
import type { getFxRate } from "./fx";

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
  sourceUrl: "https://example.test/ecb",
});

const goodFetchers: FeeFetchers = {
  esploraFees: async () => ({ "1": 20.1, "3": 12.5, "6": 8 }),
  baseGasPriceWei: async () => 12345678n,
};

function appWith(deps: Parameters<typeof mountInfoDoors>[1]) {
  const app = new Hono();
  mountInfoDoors(app, deps);
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
    expect(btc.decimals).toBe(2);
    const base = r.facts.find((f) => f.predicate === "gas_price_wei")!;
    expect(base.value).toBe("12345678");
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

  it("404s an unknown chain with a way forward", async () => {
    const app = appWith({ fees: (chain) => readFees(chain, goodFetchers) });
    const res = await app.request("/v1/fees?chain=eip155:1");
    expect(res.status).toBe(404);
    expect((await res.json()).next_actions).toContain("GET /v1/chains");
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
});
