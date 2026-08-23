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
function oracle(opts: { answer?: bigint; ageS?: number; decimals?: number; description?: string; throws?: boolean | string } = {}): OracleFetchers {
  const guard = () => {
    if (opts.throws) throw new Error(typeof opts.throws === "string" ? opts.throws : "rpc down");
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

// ECB cross fixture over a tiny per-USD table (USD=1, GBP=0.80, EUR=0.90). Any
// pair derives as perUsd[quote]/perUsd[base] at 8 dp — same semantics as the real
// getFxRate. Ref date older than the price round, so a cross fact must stamp the
// STALER leg's date.
const PER_USD: Record<string, number> = { USD: 1, GBP: 0.8, EUR: 0.9 };
const fakeFx: typeof getFxRate = async (base, quote) => {
  const b = base.toUpperCase(), q = quote.toUpperCase();
  if (!(b in PER_USD) || !(q in PER_USD)) return { error: "unknown currency", available: Object.keys(PER_USD) };
  const scaled = String(Math.round((PER_USD[q] / PER_USD[b]) * 1e8));
  return { base: b, quote: q, valueScaled: scaled, decimals: 8, method: b === "USD" ? "observed" : "derived", proof_state: b === "USD" ? "asserted" : "tested", recompute: { how: "test ECB cross" }, refDate: "2026-07-20", fetchedAt: "2026-07-21T12:00:00.000Z", sourceUrl: "https://example.test/ecb" };
};

const btc = resolveFeed("BTC")!;

function appWith(
  fetchers: OracleFetchers,
  fxRate = fakeFx,
  now: () => Date = () => new Date("2026-07-21T12:00:00.000Z"),
) {
  const app = new Hono();
  mountPriceDoors(app, { fetchers, fxRate, now });
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
    if (r.kind === "unreachable") expect(r.code).toBe("price_upstream_unavailable");
  });

  it("never publishes credential-bearing upstream exception text", async () => {
    const sentinel = "https://rpc.example/v2/DO-NOT-LEAK-PRICE-TOKEN";
    const result = await readPrice(btc, oracle({ throws: sentinel }));
    expect(result).toMatchObject({
      kind: "unreachable",
      code: "price_upstream_unavailable",
      detail: "The on-chain price source did not answer with a usable observation.",
    });
    expect(JSON.stringify(result)).not.toContain(sentinel);
  });

  it("never publishes a configured RPC credential in a source receipt", async () => {
    const previous = process.env.CASHLOOM_ETH_RPC_URL;
    process.env.CASHLOOM_ETH_RPC_URL = "https://provider.example/v2/SUPER-SECRET-KEY";
    try {
      const result = await readPrice(btc, oracle());
      expect(result.kind).toBe("price");
      expect(JSON.stringify(result)).not.toContain("SUPER-SECRET-KEY");
      if (result.kind === "price") expect(result.fact.sources[0].url).toContain("etherscan.io/address/");
    } finally {
      if (previous === undefined) delete process.env.CASHLOOM_ETH_RPC_URL;
      else process.env.CASHLOOM_ETH_RPC_URL = previous;
    }
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
    expect(f.redistribution).toBe("attribution-required");
    expect(f.observed_at).toBe("2026-07-20"); // the staler ECB leg's date
    expect(f.stale_after_s).toBe(7 * 86_400); // date-only FX clock, not the oracle's 1h heartbeat from midnight
    expect(f.sources.length).toBe(2); // oracle + ECB, both named
  });

  it("refuses an old ECB leg across price, value, and portfolio surfaces", async () => {
    const oldFx: typeof getFxRate = async (base, quote) => {
      const result = await fakeFx(base, quote);
      return "error" in result ? result : { ...result, refDate: "2026-07-01", fetchedAt: "2026-07-02T12:00:00.000Z" };
    };
    const app = appWith(oracle(), oldFx, () => new Date("2026-08-20T12:00:00.000Z"));
    expect((await app.request("/v1/price/BTC/GBP")).status).toBe(503);
    expect((await app.request("/v1/value/50000000/BTC/GBP")).status).toBe(503);
    const portfolio = await (await app.request("/v1/portfolio?quote=GBP&hold=BTC:50000000,EUR:10000")).json();
    expect(portfolio.complete).toBe(false);
    expect(portfolio.withheld).toHaveLength(2);
    expect(portfolio.withheld.every((item: { reason: string }) => item.reason.toLowerCase().includes("old") || item.reason.toLowerCase().includes("expired"))).toBe(true);
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

  it("sanitizes upstream exception text on both price surfaces", async () => {
    const sentinel = "Bearer DO-NOT-LEAK-PRICE-BOARD-TOKEN";
    const app = appWith(oracle({ throws: sentinel }));
    const one = await app.request("/v1/price/BTC/USD");
    const board = await app.request("/v1/prices");
    const oneBody = await one.json();
    const boardBody = await board.json();

    expect(one.status).toBe(503);
    expect(oneBody).toMatchObject({
      code: "price_upstream_unavailable",
      detail: "The on-chain price source did not answer with a usable observation.",
    });
    expect(boardBody.unavailable).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "price_upstream_unavailable" }),
    ]));
    expect(JSON.stringify({ oneBody, boardBody })).not.toContain(sentinel);
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
    expect(body.result.redistribution).toBe("attribution-required");
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

describe("/v1/portfolio door — a mixed basket, honestly totalled", () => {
  // oracle fixture prices BOTH BTC and ETH at $30,000.00.
  it("sums a mixed crypto+fiat basket into one quote", async () => {
    // 0.5 BTC=$15,000 + 1 ETH=$30,000 + £1,000→$1,250 + $1,000 identity = $47,250.00
    const res = await appWith(oracle()).request(
      "/v1/portfolio?quote=USD&hold=BTC:50000000,ETH:1000000000000000000,GBP:100000,USD:100000",
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.complete).toBe(true);
    expect(body.total.value).toBe("4725000"); // $47,250.00 at 2 dp
    expect(body.total.predicate).toBe("total_value");
    expect(body.total.redistribution).toBe("attribution-required"); // GBP leg brings ECB conditions
    expect(body.holdings).toHaveLength(4);
    expect(body.withheld).toBeUndefined();
  });

  it("grades a pure-fiat basket attribution-required (no crypto leg)", async () => {
    const res = await appWith(oracle()).request("/v1/portfolio?quote=USD&hold=USD:100000,GBP:100000");
    const body = await res.json();
    expect(body.total.value).toBe("225000"); // $1,000 + $1,250
    expect(body.total.redistribution).toBe("attribution-required");
  });

  it("keeps a USD-only crypto basket on-chain rederivable", async () => {
    const res = await appWith(oracle()).request("/v1/portfolio?quote=USD&hold=BTC:50000000,USD:100000");
    const body = await res.json();
    expect(body.total.redistribution).toBe("onchain-rederivable");
  });

  it("serves a PARTIAL total when a leg is stale — withheld, not zeroed", async () => {
    const res = await appWith(oracle({ ageS: 99999 })).request("/v1/portfolio?quote=USD&hold=BTC:50000000,USD:100000");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.complete).toBe(false);
    expect(body.total.predicate).toBe("partial_value");
    expect(body.total.value).toBe("100000"); // only the $1,000 USD leg
    expect(body.withheld).toHaveLength(1);
    expect(body.withheld[0].input).toBe("BTC");
    expect(body.note).toContain("PARTIAL");
  });

  it("withholds an unknown asset rather than guessing", async () => {
    const res = await appWith(oracle()).request("/v1/portfolio?quote=USD&hold=DOGE:100,USD:100000");
    const body = await res.json();
    expect(body.complete).toBe(false);
    expect(body.withheld[0].reason).toContain("unknown asset");
    expect(body.total.value).toBe("100000");
  });

  it("422s a malformed leg instead of coercing it", async () => {
    for (const bad of ["BTC", "BTC:1.5", "BTC:", ":100"]) {
      const res = await appWith(oracle()).request(`/v1/portfolio?quote=USD&hold=${encodeURIComponent(bad)}`);
      expect(res.status).toBe(422);
    }
  });

  it("400s with an example when hold is missing", async () => {
    const res = await appWith(oracle()).request("/v1/portfolio?quote=USD");
    expect(res.status).toBe(400);
    expect((await res.json()).next_actions[0]).toContain("hold=");
  });
});
