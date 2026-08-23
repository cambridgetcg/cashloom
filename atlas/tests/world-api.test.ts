import { describe, expect, it, vi } from "vitest";
import {
  WORLD_CACHE_RETENTION_MS,
  fetchWorld,
  loadPersistedWorldSnapshot,
  persistWorldSnapshot,
  worldStorageKey,
} from "../src/world/api.ts";
import type { WorldResponse } from "../src/world/types.ts";

class MemoryStorage {
  readonly values = new Map<string, string>();
  removed: string[] = [];

  getItem(key: string) { return this.values.get(key) ?? null; }
  setItem(key: string, value: string) { this.values.set(key, value); }
  removeItem(key: string) {
    this.removed.push(key);
    this.values.delete(key);
  }
}

function snapshot(baseCurrency: string, generatedAt: number): WorldResponse {
  return {
    "@type": "WorldSnapshot",
    schema: "cashloom.world/1",
    generated_at: new Date(generatedAt).toISOString(),
    base_currency: baseCurrency,
    status: { state: "ready" },
    briefing: [],
    policy: [],
    sovereigns: [],
    fx: [],
    crypto: [],
    fees: [],
    energy: [],
    calendar: [],
    threads: [],
    sources: [],
  };
}

describe("persisted public World snapshots", () => {
  it("round-trips an exact versioned body, validator, and receipt per base", () => {
    const storage = new MemoryStorage();
    const now = Date.parse("2026-08-21T12:00:00.000Z");
    const usd = snapshot("USD", now - 10_000);
    const eur = snapshot("EUR", now - 20_000);
    const usdEtag = 'W/"sha256-usd"';
    const eurEtag = 'W/"sha256-eur"';

    persistWorldSnapshot(usd, usdEtag, now, storage);
    persistWorldSnapshot(eur, eurEtag, now - 1_000, storage);

    expect(loadPersistedWorldSnapshot("USD", now, storage)).toEqual({
      snapshot: usd,
      receivedAt: now,
      etag: usdEtag,
    });
    expect(loadPersistedWorldSnapshot("EUR", now, storage)).toEqual({
      snapshot: eur,
      receivedAt: now - 1_000,
      etag: eurEtag,
    });
    expect(worldStorageKey("usd")).not.toBe(worldStorageKey("EUR"));
    expect(JSON.parse(storage.getItem(worldStorageKey("USD"))!)).toMatchObject({
      schema: "cashloom.world-cache/1",
      base_currency: "USD",
      received_at: new Date(now).toISOString(),
    });
  });

  it.each([
    ["corrupt JSON", "{"],
    ["wrong base", (now: number) => JSON.stringify({
      schema: "cashloom.world-cache/1",
      base_currency: "USD",
      received_at: new Date(now).toISOString(),
      snapshot: snapshot("USD", now),
    })],
    ["expired", (now: number) => JSON.stringify({
      schema: "cashloom.world-cache/1",
      base_currency: "EUR",
      received_at: new Date(now - WORLD_CACHE_RETENTION_MS - 1).toISOString(),
      snapshot: snapshot("EUR", now - WORLD_CACHE_RETENTION_MS - 1),
    })],
    ["future-generated snapshot", (now: number) => JSON.stringify({
      schema: "cashloom.world-cache/1",
      base_currency: "EUR",
      received_at: new Date(now).toISOString(),
      snapshot: snapshot("EUR", now + 10 * 60_000),
    })],
  ])("deletes %s from the requested base slot instead of trusting it", (_label, value) => {
    const storage = new MemoryStorage();
    const now = Date.parse("2026-08-21T12:00:00.000Z");
    const key = worldStorageKey("EUR");
    storage.setItem(key, typeof value === "function" ? value(now) : value);

    expect(loadPersistedWorldSnapshot("EUR", now, storage)).toBeUndefined();
    expect(storage.removed).toEqual([key]);
  });
});

describe("conditional World fetch", () => {
  it("sends the exact base validator and returns a 304 reuse receipt", async () => {
    const etag = 'W/"sha256-world"';
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      expect(String(input)).toContain("/v1/world?base=EUR");
      expect(new Headers(init?.headers).get("if-none-match")).toBe(etag);
      expect(init?.cache).toBe("no-cache");
      return new Response(null, {
        status: 304,
        headers: {
          ETag: etag,
          "X-CashLoom-Cache": "stale",
          "X-CashLoom-Snapshot-Age": "42",
        },
      });
    });

    try {
      await expect(fetchWorld("eur", { etag })).resolves.toMatchObject({
        kind: "not-modified",
        etag,
        serverCacheState: "stale",
        serverSnapshotAgeSeconds: 42,
      });
    } finally {
      fetchMock.mockRestore();
    }
  });

  it("never assigns an old request validator to a modified body", async () => {
    const oldEtag = 'W/"sha256-old"';
    const body = snapshot("USD", Date.parse("2026-08-21T12:00:00.000Z"));
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
      expect(new Headers(init?.headers).get("if-none-match")).toBe(oldEtag);
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "Content-Type": "application/vnd.cashloom.world.v1+json" },
      });
    });

    try {
      const result = await fetchWorld("USD", { etag: oldEtag });
      expect(result).toMatchObject({ kind: "modified", snapshot: body });
      expect(result).not.toHaveProperty("etag");
    } finally {
      fetchMock.mockRestore();
    }
  });
});
