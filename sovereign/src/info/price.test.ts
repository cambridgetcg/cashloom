import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import { readPrice, spotPriceLeg, PRICE_FEEDS, resolveFeed, type OracleFetchers } from "./price";
import { mountPriceDoors } from "./price-door";
import type { getFxRate } from "./fx";

// Every dep faked — no network, no clock beyond `now`. A price test that hit the
// chain would be untestable and flaky; the injectable fetchers are the point.

const nowS = () => Math.floor(Date.now() / 1000);
const DESC_BY_AGG: Record<string, string> = {
  "0x5f4eC3Df9cbd43714FE2740f5E3616155c5b8419": "ETH / USD",
  "0xF4030086522a5bEEa4988F8cA5B36dbC97BeE88c": "BTC / USD",
};

// A deterministic oracle. answer/ageS/decimals/description all overridable so we
// can drive every guard branch. Default answer = $30,000.00 at 8 dp.
function oracle(opts: { answer?: bigint; ageS?: number; decimals?: number; description?: string; throws?: boolean } = {}): OracleFetchers {
  const guard = () => {
    if (opts.throws) throw new Error("rpc down");
  };
  return {
    roundData: async () => {
      guard();
      return { roundId: 4242n, answer: opts.answer ?? 3_000_000_000_000n, updatedAt: BigInt(nowS() - (opts.ageS ?? 30)) };
    },
    decimals: async () => {
      guard();
      return opts.decimals ?? 8;
    },
    description: async (_rpc, agg) => {
      guard();
      return opts.description ?? DESC_BY_AGG[agg] ?? "??";
    },
  };
}

// USD→X ECB cross fixture: GBP=0.80, EUR=0.90 per 1 USD, at 8 dp; ref date older
// than the price round, so a cross fact must stamp the STALER leg's date.
const fakeFx: typeof getFxRate = async (base, quote) => {
  const per: Record<string, string> = { GBP: "80000000", EUR: "90000000" };
  const q = quote.toUpperCase();
  if (!(q in per)) return { error: "unknown currency", available: Object.keys(per) };
  return { base: base.toUpperCase(), quote: q, valueScaled: per[q], decimals: 8, method: "derived", proof_state: "tested", recompute: { how: "test ECB cross" }, refDate: "2026-07-20", sourceUrl: "https://example.test/ecb" };
};

const btc = resolveFeed("BTC")!;

function appWith(fetchers: OracleFetchers, fxRate = fakeFx) {
  const app = new Hono();
  mountPriceDoors(app, { fetchers, fxRate });
  return app;
}

describe("readPrice guards", () => {
  it("returns a cited spot-price fact when fresh and consistent", async () => {
    const r = await readPrice(btc, oracle());
    expect(r.kind).toBe("price");
    if (r.kind !== "price") return;
    expect(r.fact.value).toBe("3000000000000"); // $30,000.00000000 at 8 dp
    expect(r.fact.decimals).toBe(8);
    expect(r.fact.subject).toBe(btc.base); // the ASSET, not the aggregator
    expect(r.fact.unit).toBe("iso4217:USD");
    expect(r.fact.predicate).toBe("spot_price");
    expect(r.fact.method).toBe("observed");
    expect(r.fact.proof_state).toBe("tested");
    expect(r.fact.redistribution).toBe("onchain-rederivable");
    expect(r.fact.recompute?.how).toContain("getRoundData(4242)");
  });

  it("stamps observed_at as the oracle's OWN updatedAt, never now()", async () => {
    const ageS = 47;
    const r = await readPrice(btc, oracle({ ageS }));
    if (r.kind !== "price") throw new Error(r.kind);
    const expected = new Date((nowS() - ageS) * 1000).toISOString();
    // allow a 2s window for test wall-clock drift across the two now() reads
    expect(Math.abs(Date.parse(r.fact.observed_at) - Date.parse(expected))).toBeLessThan(2000);
    expect(r.fact.observed_at).not.toBe(new Date().toISOString());
  });

  it("refuses a non-positive answer as invalid (never a $0 or negative price)", async () => {
    expect((await readPrice(btc, oracle({ answer: 0n }))).kind).toBe("invalid");
    expect((await readPrice(btc, oracle({ answer: -1n }))).kind).toBe("invalid");
  });

  it("refuses a decimals mismatch — a wrong or swapped aggregator", async () => {
    const r = await readPrice(btc, oracle({ decimals: 6 }));
    expect(r.kind).toBe("invalid");
    if (r.kind === "invalid") expect(r.reason).toContain("decimals");
  });

  it("refuses a description mismatch — the second cross-check", async () => {
    const r = await readPrice(btc, oracle({ description: "DOGE / USD" }));
    expect(r.kind).toBe("invalid");
    if (r.kind === "invalid") expect(r.reason).toContain("description");
  });

  it("marks a price older than the heartbeat+grace as stale, not fresh", async () => {
    const r = await readPrice(btc, oracle({ ageS: btc.heartbeat_s + 1000 }));
    expect(r.kind).toBe("stale");
    if (r.kind === "stale") expect(r.age_s).toBeGreaterThan(r.heartbeat_s);
  });

  it("reports an unreachable source rather than throwing", async () => {
    const r = await readPrice(btc, oracle({ throws: true }));
    expect(r.kind).toBe("unreachable");
  });
});

describe("spotPriceLeg", () => {
  it("yields scaled minor units on a fresh price", async () => {
    const leg = await spotPriceLeg(btc, oracle());
    expect("valueScaled" in leg && leg.valueScaled).toBe("3000000000000");
  });
  it("yields a stale signal a caller must refuse on", async () => {
    const leg = await spotPriceLeg(btc, oracle({ ageS: 99999 }));
    expect("stale" in leg && leg.stale).toBe(true);
  });
});

describe("/v1/price door", () => {
  it("serves BTC/USD directly from the oracle", async () => {
    const res = await appWith(oracle()).request("/v1/price/BTC/USD");
    expect(res.status).toBe(200);
    const f = await res.json();
    expect(f.value).toBe("3000000000000");
    expect(f.unit).toBe("iso4217:USD");
    expect(f.method).toBe("observed");
  });

  it("derives BTC/GBP as price × ECB USD→GBP cross, graded derived+tested", async () => {
    const res = await appWith(oracle()).request("/v1/price/BTC/GBP");
    expect(res.status).toBe(200);
    const f = await res.json();
    // 30000 USD × 0.80 GBP/USD = 24000 GBP → 2_400_000_000_000 at 8 dp
    expect(f.value).toBe("2400000000000");
    expect(f.unit).toBe("iso4217:GBP");
    expect(f.method).toBe("derived");
    expect(f.observed_at).toBe("2026-07-20"); // the staler ECB leg's date
    expect(f.sources.length).toBe(2); // oracle + ECB, both named
  });

  it("503s a stale price rather than serving it", async () => {
    const res = await appWith(oracle({ ageS: 99999 })).request("/v1/price/BTC/USD");
    expect(res.status).toBe(503);
    expect((await res.json()).title).toBe("price unavailable");
  });

  it("404s an asset with no feed, naming the ones that exist", async () => {
    const res = await appWith(oracle()).request("/v1/price/DOGE/USD");
    expect(res.status).toBe(404);
    expect((await res.json()).next_actions.join(" ")).toContain("BTC");
  });

  it("422s an unknown quote currency honestly", async () => {
    const res = await appWith(oracle()).request("/v1/price/BTC/ZZZ");
    expect(res.status).toBe(422);
    expect((await res.json()).title).toBe("unknown currency");
  });
});

describe("/v1/prices board", () => {
  it("lists every fresh feed and discloses any withheld", async () => {
    const res = await appWith(oracle()).request("/v1/prices");
    const body = await res.json();
    expect(body.count).toBe(PRICE_FEEDS.length);
    expect(body.facts.every((f: any) => f.predicate === "spot_price")).toBe(true);
    expect(body.unavailable).toBeUndefined();
  });
});

describe("/v1/value door — the honest crypto→fiat report", () => {
  it("values 0.5 BTC in USD exactly (single final rounding)", async () => {
    const res = await appWith(oracle()).request("/v1/value/50000000/BTC/USD");
    expect(res.status).toBe(200);
    const body = await res.json();
    // 0.5 BTC × $30,000 = $15,000.00 → 1_500_000 minor at 2 dp
    expect(body.result.value).toBe("1500000");
    expect(body.result.decimals).toBe(2);
    expect(body.result.unit).toBe("iso4217:USD");
    expect(body["@type"]).toBe("Valuation");
    expect(body.result.recompute.how).toContain("half-even");
  });

  it("values 0.5 BTC in GBP via the ECB cross", async () => {
    const res = await appWith(oracle()).request("/v1/value/50000000/BTC/GBP");
    const body = await res.json();
    // 0.5 BTC × $30,000 × 0.80 = £12,000.00 → 1_200_000 at 2 dp
    expect(body.result.value).toBe("1200000");
    expect(body.result.unit).toBe("iso4217:GBP");
    expect(body.result.method).toBe("derived");
  });

  it("values a whole ETH holding in USD (18 dp base, no precision loss)", async () => {
    // 1 ETH = 10^18 wei; price fixture $30,000.00 → $30,000.00 → 3_000_000 at 2 dp
    const res = await appWith(oracle()).request("/v1/value/1000000000000000000/ETH/USD");
    const body = await res.json();
    expect(body.result.value).toBe("3000000");
  });

  it("refuses to value on a stale price (a valuation on a stale number is a lie)", async () => {
    const res = await appWith(oracle({ ageS: 99999 })).request("/v1/value/50000000/BTC/USD");
    expect(res.status).toBe(503);
  });

  it("teaches on a non-integer amount", async () => {
    const res = await appWith(oracle()).request("/v1/value/0.5/BTC/USD");
    expect(res.status).toBe(422);
    expect((await res.json()).detail).toContain("50000000");
  });
});
