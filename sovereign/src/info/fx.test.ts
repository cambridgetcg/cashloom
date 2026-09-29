import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";

describe("ECB FX cache provenance", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-08-20T16:00:00.000Z"));
  });
  afterEach(() => vi.useRealTimers());

  it("keeps the true retrieval timestamp stable across cache-hit responses", async () => {
    const originalFetch = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      return new Response(
        "<Envelope><Cube><Cube time='2026-08-20'><Cube currency='USD' rate='1.1700'/><Cube currency='GBP' rate='0.8600'/></Cube></Cube></Envelope>",
        { status: 200, headers: { "Content-Type": "application/xml" } },
      );
    }) as unknown as typeof fetch;
    try {
      const { mountMoneyworld } = await import("./router.ts");
      const app = new Hono();
      mountMoneyworld(app);
      const [first, concurrent] = await Promise.all([
        (async () => (await app.request("/v1/fx/EUR/USD")).json())(),
        (async () => (await app.request("/v1/fx/EUR/GBP")).json())(),
      ]);
      vi.setSystemTime(new Date("2026-08-20T16:05:00.000Z"));
      const second = await (await app.request("/v1/fx/EUR/USD")).json();
      expect(calls).toBe(1);
      expect(first.observed_at).toBe("2026-08-20");
      expect(first.sources[0].fetched_at).toBe("2026-08-20T16:00:00.000Z");
      expect(first.sources[0].fetched_at).toBe(concurrent.sources[0].fetched_at);
      expect(first.sources[0].fetched_at).toBe(second.sources[0].fetched_at);
      expect(first.stale_after_s).toBe(7 * 86_400);

      // Re-fetching the same dated publisher observation must not renew it.
      vi.setSystemTime(new Date("2026-08-26T16:00:00.000Z"));
      const stale = await app.request("/v1/fx/EUR/USD");
      expect(calls).toBe(2);
      expect(stale.status).toBe(503);
      expect(await stale.json()).toMatchObject({ title: "fx reference unavailable" });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("keeps the three-business-day freshness boundary independent of the wall clock", async () => {
    const { fxReferenceBusinessDayAge, fxReferenceIsStale } = await import("./fx.ts");
    expect(fxReferenceBusinessDayAge("2026-08-20", new Date("2026-08-23T16:00:00Z"))).toBe(1);
    expect(fxReferenceIsStale("2026-08-20", new Date("2026-08-25T16:00:00Z"))).toBe(false);
    expect(fxReferenceIsStale("2026-08-20", new Date("2026-08-26T16:00:00Z"))).toBe(true);
  });
});
