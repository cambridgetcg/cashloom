import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import { mountMoneyworld } from "./router.ts";

describe("ECB FX cache provenance", () => {
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
      const app = new Hono();
      mountMoneyworld(app);
      const [first, concurrent] = await Promise.all([
        (async () => (await app.request("/v1/fx/EUR/USD")).json())(),
        (async () => (await app.request("/v1/fx/EUR/GBP")).json())(),
      ]);
      await new Promise((resolve) => setTimeout(resolve, 5));
      const second = await (await app.request("/v1/fx/EUR/USD")).json();
      expect(calls).toBe(1);
      expect(first.observed_at).toBe("2026-08-20");
      expect(first.sources[0].fetched_at).toBe(concurrent.sources[0].fetched_at);
      expect(first.sources[0].fetched_at).toBe(second.sources[0].fetched_at);
      expect(first.stale_after_s).toBe(7 * 86_400);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
