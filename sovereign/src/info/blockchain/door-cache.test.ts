import { describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import type { OnchainSnapshot } from "./model.ts";
import {
  ONCHAIN_FAILURE_BACKOFF_MS,
  ONCHAIN_STALE_WINDOW_MS,
  createOnchainSnapshotCache,
  mountOnchainDoor,
} from "./door.ts";

const BASE_TIME = Date.parse("2026-08-21T12:00:00.000Z");

function snapshot(generatedAt: number, marker = "one"): OnchainSnapshot {
  return {
    "@type": "OnchainSnapshot",
    schema: "cashloom.onchain/1",
    generated_at: new Date(generatedAt).toISOString(),
    scope: "latest_state",
    status: {
      state: "ready",
      complete: true,
      available_sources: 0,
      total_sources: 0,
      stale_count: 0,
      sections: {
        chains: { state: "ready", available: 0, expected: 0 },
        stablecoins: { state: "ready", available: 0, expected: 0 },
        lending_markets: { state: "ready", available: 0, expected: 0 },
        pools: { state: "ready", available: 0, expected: 0 },
        bridge_routes: { state: "ready", available: 0, expected: 0 },
      },
      unavailable: [],
    },
    briefing: [],
    chains: [],
    stablecoins: [],
    lending_markets: [],
    pools: [],
    bridge_routes: [],
    threads: [{ id: marker, title: marker, observed: [], possible_channels: [], limits: [], source_ids: [] }],
    sources: [],
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe("onchain snapshot delivery cache", () => {
  it("serves fresh, then stale immediately while deduplicating one background rebuild", async () => {
    let now = BASE_TIME;
    const rebuild = deferred<OnchainSnapshot>();
    const first = snapshot(now, "one");
    const second = snapshot(now + 20_000, "two");
    const builder = vi.fn()
      .mockResolvedValueOnce(first)
      .mockReturnValueOnce(rebuild.promise);
    const cache = createOnchainSnapshotCache(builder, { now: () => now });

    const miss = await cache.read();
    expect(miss).toMatchObject({ cacheState: "miss", snapshot: first });
    expect(await cache.read()).toMatchObject({ cacheState: "fresh", etag: miss.etag });

    now += 20_000;
    const [staleOne, staleTwo] = await Promise.all([cache.read(), cache.read()]);
    expect(staleOne).toMatchObject({ cacheState: "stale", snapshot: first });
    expect(staleTwo).toMatchObject({ cacheState: "stale", snapshot: first });
    await Promise.resolve();
    expect(builder).toHaveBeenCalledTimes(2);

    rebuild.resolve(second);
    await cache.waitForIdle();
    expect(await cache.read()).toMatchObject({ cacheState: "fresh", snapshot: second });
  });

  it("keeps a safe stale snapshot through a failed refresh and backs off retries", async () => {
    let now = BASE_TIME;
    const first = snapshot(now, "one");
    const second = snapshot(now + 50_000, "two");
    const builder = vi.fn()
      .mockResolvedValueOnce(first)
      .mockRejectedValueOnce(new Error("upstream down"))
      .mockResolvedValueOnce(second);
    const cache = createOnchainSnapshotCache(builder, { now: () => now });

    await cache.read();
    now += 20_000;
    expect((await cache.read()).cacheState).toBe("stale");
    await cache.waitForIdle();
    expect(builder).toHaveBeenCalledTimes(2);

    now += ONCHAIN_FAILURE_BACKOFF_MS - 1;
    expect((await cache.read()).cacheState).toBe("stale");
    expect(builder).toHaveBeenCalledTimes(2);

    now += 1;
    expect((await cache.read()).cacheState).toBe("stale");
    await cache.waitForIdle();
    expect(builder).toHaveBeenCalledTimes(3);
    expect(await cache.read()).toMatchObject({ cacheState: "fresh", snapshot: second });
  });

  it("waits for truth at the max-stale boundary instead of serving an expired snapshot", async () => {
    let now = BASE_TIME;
    const rebuild = deferred<OnchainSnapshot>();
    const builder = vi.fn()
      .mockResolvedValueOnce(snapshot(now, "one"))
      .mockReturnValueOnce(rebuild.promise);
    const cache = createOnchainSnapshotCache(builder, { now: () => now });
    await cache.read();

    now += 20_000 + ONCHAIN_STALE_WINDOW_MS;
    let settled = false;
    const pending = cache.read().finally(() => { settled = true; });
    await Promise.resolve();
    expect(builder).toHaveBeenCalledTimes(2);
    expect(settled).toBe(false);

    const next = snapshot(now, "two");
    rebuild.resolve(next);
    await expect(pending).resolves.toMatchObject({ cacheState: "miss", snapshot: next });
  });

  it("backs off a failed cold build without fabricating a first snapshot", async () => {
    let now = BASE_TIME;
    const failure = new Error("cold build failed");
    const builder = vi.fn().mockRejectedValue(failure);
    const cache = createOnchainSnapshotCache(builder, { now: () => now });

    await expect(cache.read()).rejects.toBe(failure);
    await expect(cache.read()).rejects.toBe(failure);
    expect(builder).toHaveBeenCalledTimes(1);

    now += ONCHAIN_FAILURE_BACKOFF_MS;
    await expect(cache.read()).rejects.toBe(failure);
    expect(builder).toHaveBeenCalledTimes(2);
  });

  it("serves exact bytes with a stable ETag and honors conditional GET and HEAD", async () => {
    let now = BASE_TIME;
    const body = snapshot(now);
    const app = new Hono();
    mountOnchainDoor(app, async () => body, { now: () => now });

    const first = await app.request("/v1/onchain");
    const etag = first.headers.get("etag");
    expect(first.status).toBe(200);
    expect(await first.text()).toBe(JSON.stringify(body));
    expect(etag).toMatch(/^W\/"sha256-[A-Za-z0-9_-]+"$/);
    expect(first.headers.get("x-cashloom-cache")).toBe("miss");
    expect(first.headers.get("x-cashloom-snapshot-age")).toBe("0");
    expect(first.headers.get("age")).toBe("0");
    expect(first.headers.get("server-timing")).toContain('desc="miss"');

    const conditional = await app.request("/v1/onchain", {
      headers: { "If-None-Match": `"unrelated", ${etag}` },
    });
    expect(conditional.status).toBe(304);
    expect(await conditional.text()).toBe("");
    expect(conditional.headers.get("etag")).toBe(etag);
    expect(conditional.headers.get("x-cashloom-cache")).toBe("fresh");

    const wildcard = await app.request("/v1/onchain", {
      headers: { "If-None-Match": "*" },
    });
    expect(wildcard.status).toBe(304);

    const head = await app.request("/v1/onchain", { method: "HEAD" });
    expect(head.status).toBe(200);
    expect(await head.text()).toBe("");
    expect(head.headers.get("etag")).toBe(etag);

    now += 20_000;
  });

  it("marks stale delivery in every relevant HTTP receipt without claiming freshness", async () => {
    let now = BASE_TIME;
    const rebuild = deferred<OnchainSnapshot>();
    const body = snapshot(now);
    const builder = vi.fn()
      .mockResolvedValueOnce(body)
      .mockReturnValueOnce(rebuild.promise);
    const app = new Hono();
    mountOnchainDoor(app, builder, { now: () => now });
    await app.request("/v1/onchain");

    now += 20_000;
    const stale = await app.request("/v1/onchain");
    expect(stale.status).toBe(200);
    expect(stale.headers.get("x-cashloom-cache")).toBe("stale");
    expect(stale.headers.get("x-cashloom-snapshot-age")).toBe("20");
    expect(stale.headers.get("age")).toBe("20");
    expect(stale.headers.get("warning")).toContain("110");
    expect(stale.headers.get("cache-control")).toContain("max-age=0");
    expect(stale.headers.get("server-timing")).toContain('desc="stale"');

    rebuild.resolve(snapshot(now, "two"));
  });

  it("never delegates reuse beyond the server's bounded stale window", async () => {
    let now = BASE_TIME;
    const rebuild = deferred<OnchainSnapshot>();
    const body = snapshot(now);
    const builder = vi.fn()
      .mockResolvedValueOnce(body)
      .mockReturnValueOnce(rebuild.promise);
    const app = new Hono();
    mountOnchainDoor(app, builder, { now: () => now });
    await app.request("/v1/onchain");

    // Downstream caches include the response's resident Age when applying
    // max-age + stale-while-revalidate. Even one millisecond before the fresh
    // boundary, the total authorization ends before the server's staleUntil.
    now = BASE_TIME + 20_000 - 1;
    const fresh = await app.request("/v1/onchain");
    const freshControl = fresh.headers.get("cache-control") ?? "";
    const freshAgeSeconds = Number(fresh.headers.get("age"));
    expect(fresh.headers.get("x-cashloom-cache")).toBe("fresh");
    expect(freshControl).toBe("public, max-age=10, stale-while-revalidate=120");
    expect(freshAgeSeconds).toBe(19);
    const downstreamAllowanceSeconds = 10 + 120;
    expect(downstreamAllowanceSeconds).toBeLessThanOrEqual(
      (20_000 + ONCHAIN_STALE_WINDOW_MS) / 1_000,
    );
    const downstreamRemainingSeconds = Math.max(
      0,
      downstreamAllowanceSeconds - freshAgeSeconds,
    );
    const serverStaleUntil = BASE_TIME + 20_000 + ONCHAIN_STALE_WINDOW_MS;
    expect(now + downstreamRemainingSeconds * 1_000).toBeLessThanOrEqual(serverStaleUntil);

    // At the final safe millisecond, Age already exceeds the stale response's
    // entire downstream allowance, so it cannot be replayed beyond the bound.
    now = serverStaleUntil - 1;
    const finalSafeStale = await app.request("/v1/onchain");
    const staleAgeSeconds = Number(finalSafeStale.headers.get("age"));
    const staleAllowanceSeconds = 0 + 120;
    expect(finalSafeStale.headers.get("x-cashloom-cache")).toBe("stale");
    expect(finalSafeStale.headers.get("cache-control")).toBe(
      "public, max-age=0, must-revalidate, stale-while-revalidate=120",
    );
    expect(staleAgeSeconds).toBe(139);
    expect(Math.max(0, staleAllowanceSeconds - staleAgeSeconds)).toBe(0);
    expect(finalSafeStale.headers.get("warning")).toContain("110");

    rebuild.resolve(snapshot(now, "two"));
    await Promise.resolve();
  });
});
