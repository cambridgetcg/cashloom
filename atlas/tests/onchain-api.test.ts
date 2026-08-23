import { describe, expect, it, vi } from "vitest";
import {
  ONCHAIN_CACHE_RETENTION_MS,
  ONCHAIN_STORAGE_KEY,
  fetchOnchain,
  loadPersistedOnchainSnapshot,
  persistOnchainSnapshot,
} from "../src/onchain/api.ts";
import type { OnchainSnapshot } from "../src/onchain/types.ts";

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

function snapshot(generatedAt: number): OnchainSnapshot {
  return {
    "@type": "OnchainSnapshot",
    schema: "cashloom.onchain/1",
    generated_at: new Date(generatedAt).toISOString(),
    scope: "latest_state",
    status: { state: "ready" },
    briefing: [],
    chains: [],
    stablecoins: [],
    lending_markets: [],
    pools: [],
    bridge_routes: [],
    threads: [],
    sources: [],
  };
}

describe("persisted public onchain snapshot", () => {
  it("round-trips the versioned body, validator, and received timestamp", () => {
    const storage = new MemoryStorage();
    const now = Date.parse("2026-08-21T12:00:00.000Z");
    const body = snapshot(now - 10_000);
    const etag = 'W/"sha256-fixture"';

    persistOnchainSnapshot(body, etag, now, storage);
    expect(loadPersistedOnchainSnapshot(now, storage)).toEqual({
      snapshot: body,
      receivedAt: now,
      etag,
    });
    expect(JSON.parse(storage.getItem(ONCHAIN_STORAGE_KEY)!)).toMatchObject({
      schema: "cashloom.onchain-cache/1",
      received_at: new Date(now).toISOString(),
    });
  });

  it.each([
    ["corrupt JSON", "{"],
    ["wrong schema", JSON.stringify({ schema: "elsewhere" })],
    ["expired", (now: number) => JSON.stringify({
      schema: "cashloom.onchain-cache/1",
      received_at: new Date(now - ONCHAIN_CACHE_RETENTION_MS - 1).toISOString(),
      snapshot: snapshot(now - ONCHAIN_CACHE_RETENTION_MS - 1),
    })],
  ])("deletes %s instead of trusting it", (_label, value) => {
    const storage = new MemoryStorage();
    const now = Date.parse("2026-08-21T12:00:00.000Z");
    storage.setItem(ONCHAIN_STORAGE_KEY, typeof value === "function" ? value(now) : value);

    expect(loadPersistedOnchainSnapshot(now, storage)).toBeUndefined();
    expect(storage.removed).toEqual([ONCHAIN_STORAGE_KEY]);
  });
});

describe("conditional onchain fetch", () => {
  it("sends the persisted validator and reuses the body on 304", async () => {
    const etag = 'W/"sha256-fixture"';
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
      expect(new Headers(init?.headers).get("if-none-match")).toBe(etag);
      return new Response(null, {
        status: 304,
        headers: {
          ETag: etag,
          "X-CashLoom-Cache": "fresh",
          "X-CashLoom-Snapshot-Age": "12",
        },
      });
    });

    try {
      await expect(fetchOnchain({ etag })).resolves.toMatchObject({
        kind: "not-modified",
        etag,
        serverCacheState: "fresh",
        serverSnapshotAgeSeconds: 12,
      });
    } finally {
      fetchMock.mockRestore();
    }
  });

  it("never assigns an old request validator to a modified body", async () => {
    const oldEtag = 'W/"sha256-old"';
    const body = snapshot(Date.now());
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
      expect(new Headers(init?.headers).get("if-none-match")).toBe(oldEtag);
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });

    try {
      const result = await fetchOnchain({ etag: oldEtag });
      expect(result).toMatchObject({ kind: "modified", snapshot: body });
      expect(result).not.toHaveProperty("etag");
    } finally {
      fetchMock.mockRestore();
    }
  });
});
