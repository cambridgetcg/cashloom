import { describe, expect, it, vi } from "vitest";
import { readPublicBitcoinBalance } from "./chains.ts";

const ADDRESS = "bc1qcashloompublicreader000000000000000000000";

describe("hosted INFO Bitcoin balance reader", () => {
  it("derives an exact confirmed balance from the fixed public Esplora origin", async () => {
    const fetcher = vi.fn(async (url: string, init: RequestInit) => {
      expect(url).toBe(`https://blockstream.info/api/address/${ADDRESS}`);
      expect(init).toMatchObject({ method: "GET", redirect: "error" });
      return new Response(JSON.stringify({
        chain_stats: { funded_txo_sum: 9_007_199_254_000, spent_txo_sum: 8_000_000_000_001 },
        mempool_stats: { funded_txo_sum: 999_999_999_999_999, spent_txo_sum: 0 },
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    });

    const result = await readPublicBitcoinBalance(ADDRESS, {
      fetch: fetcher,
      now: () => new Date("2026-08-24T12:00:00.000Z"),
    });

    expect(result.valueMinor).toBe("1007199253999");
    expect(result.symbol).toBe("BTC");
    expect(result.decimals).toBe(8);
    expect(result.sources).toEqual([{
      name: "esplora (public Bitcoin indexer)",
      url: `https://blockstream.info/api/address/${ADDRESS}`,
      fetched_at: "2026-08-24T12:00:00.000Z",
    }]);
  });

  it.each([
    { chain_stats: null },
    { chain_stats: { funded_txo_sum: 1.5, spent_txo_sum: 0 } },
    { chain_stats: { funded_txo_sum: 1, spent_txo_sum: 2 } },
    { chain_stats: { funded_txo_sum: Number.MAX_SAFE_INTEGER + 1, spent_txo_sum: 0 } },
  ])("refuses malformed or inconsistent upstream evidence", async (body) => {
    await expect(readPublicBitcoinBalance(ADDRESS, {
      fetch: async () => new Response(JSON.stringify(body), { status: 200 }),
    })).rejects.toThrow("Bitcoin public balance evidence is temporarily unavailable.");
  });

  it("settles at its own deadline when fetch ignores abort and never leaks upstream text", async () => {
    const canary = "https://provider.invalid/token/CASHLOOM_SECRET_CANARY";
    const started = performance.now();
    await expect(readPublicBitcoinBalance(ADDRESS, {
      fetch: async () => new Promise<Response>(() => {}),
      timeoutMs: 20,
    })).rejects.not.toThrow(canary);
    expect(performance.now() - started).toBeLessThan(500);
  });

  it("bounds an undeclared response body", async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(40 * 1024));
        controller.enqueue(new Uint8Array(40 * 1024));
      },
      cancel() {
        cancelled = true;
      },
    });
    await expect(readPublicBitcoinBalance(ADDRESS, {
      fetch: async () => new Response(body, { status: 200 }),
    })).rejects.toThrow("Bitcoin public balance evidence is temporarily unavailable.");
    expect(cancelled).toBe(true);
  });
});
