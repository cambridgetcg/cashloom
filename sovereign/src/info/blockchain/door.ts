import type { Context, Hono } from "hono";
import { createHash } from "node:crypto";
import {
  ONCHAIN_MEDIA_TYPE,
  ONCHAIN_SECTION_MEDIA_TYPE,
  type OnchainSnapshot,
} from "./model.ts";
import { buildOnchainSnapshot } from "./snapshot.ts";
import { AAVE_ADDRESS_BOOK_SOURCE_ID, AAVE_USDC_MARKETS } from "./aave.ts";
import { CCTP_SOURCE_ID } from "./bridges.ts";
import { chainSourceId } from "./chains.ts";
import { listBlockchainChains } from "./registry.ts";
import { CIRCLE_USDC_REGISTRY_SOURCE_ID, NATIVE_USDC_DEPLOYMENTS } from "./stablecoins.ts";
import { UNISWAP_USDC_WETH_POOLS, UNISWAP_V3_SOURCE_ID } from "./uniswap.ts";

export type OnchainBuilder = () => Promise<OnchainSnapshot>;

export type OnchainCacheState = "miss" | "fresh" | "stale";

interface CachedSnapshot {
  snapshot: OnchainSnapshot;
  serialized: string;
  etag: string;
  storedAt: number;
  freshUntil: number;
  staleUntil: number;
}

export interface OnchainSnapshotDelivery extends CachedSnapshot {
  cacheState: OnchainCacheState;
  buildDurationMs: number;
  deliveredAt: number;
}

export interface OnchainCacheOptions {
  now?: () => number;
  /** How long a previously truthful snapshot may be served after its fresh TTL. */
  staleWindowMs?: number;
  /** Suppress repeated upstream rebuild attempts after one has failed. */
  failureBackoffMs?: number;
}

export interface OnchainSnapshotCache {
  read(): Promise<OnchainSnapshotDelivery>;
  /** Await the current rebuild, if any. Primarily useful for orderly shutdown and tests. */
  waitForIdle(): Promise<void>;
}

export const ONCHAIN_STALE_WINDOW_MS = 120_000;
export const ONCHAIN_FAILURE_BACKOFF_MS = 30_000;

function snapshotEtag(serialized: string): string {
  const digest = createHash("sha256").update(serialized).digest("base64url");
  // Semantic validator: transfer compression may change representation bytes.
  return `W/"sha256-${digest}"`;
}

/**
 * Keep the last complete snapshot available while exactly one refresh runs.
 * Once the bounded stale window closes, callers wait for a new truthful build
 * (or receive an error); an old snapshot is never relabelled as fresh.
 */
export function createOnchainSnapshotCache(
  builder: OnchainBuilder,
  options: OnchainCacheOptions = {},
): OnchainSnapshotCache {
  const now = options.now ?? Date.now;
  const staleWindowMs = options.staleWindowMs ?? ONCHAIN_STALE_WINDOW_MS;
  const failureBackoffMs = options.failureBackoffMs ?? ONCHAIN_FAILURE_BACKOFF_MS;
  let cached: CachedSnapshot | null = null;
  let inflight: Promise<CachedSnapshot> | null = null;
  let retryAt = 0;
  let lastFailure: unknown;

  const beginBuild = (): Promise<CachedSnapshot> => {
    if (inflight) return inflight;
    const build = Promise.resolve()
      .then(builder)
      .then((snapshot) => {
        const storedAt = now();
        const serialized = JSON.stringify(snapshot);
        const freshUntil = storedAt + onchainSnapshotCacheTtl(snapshot.status.state);
        const next: CachedSnapshot = {
          snapshot,
          serialized,
          etag: snapshotEtag(serialized),
          storedAt,
          freshUntil,
          staleUntil: freshUntil + staleWindowMs,
        };
        cached = next;
        retryAt = 0;
        lastFailure = undefined;
        return next;
      })
      .catch((error: unknown) => {
        retryAt = now() + failureBackoffMs;
        lastFailure = error;
        throw error;
      });
    inflight = build;
    void build.then(
      () => { if (inflight === build) inflight = null; },
      () => { if (inflight === build) inflight = null; },
    );
    return build;
  };

  const delivery = (
    entry: CachedSnapshot,
    cacheState: OnchainCacheState,
    buildDurationMs = 0,
  ): OnchainSnapshotDelivery => ({
    ...entry,
    cacheState,
    buildDurationMs,
    deliveredAt: now(),
  });

  return {
    async read() {
      const requestedAt = now();
      if (cached && requestedAt < cached.freshUntil) {
        return delivery(cached, "fresh");
      }
      if (cached && requestedAt < cached.staleUntil) {
        if (!inflight && requestedAt >= retryAt) {
          // Stale-while-revalidate: the response does not wait for the fan-out.
          void beginBuild().catch(() => undefined);
        }
        return delivery(cached, "stale");
      }

      // There is no snapshot inside the honest serve window. Dedupe callers
      // onto a live build, but retain failure backoff to avoid an outage storm.
      if (!inflight && requestedAt < retryAt) {
        throw lastFailure instanceof Error
          ? lastFailure
          : new Error("onchain snapshot refresh is backing off after an upstream failure");
      }
      const next = await beginBuild();
      return delivery(next, "miss", Math.max(0, now() - requestedAt));
    },
    async waitForIdle() {
      const active = inflight;
      if (active) await active.then(() => undefined, () => undefined);
    },
  };
}

export function onchainSnapshotCacheTtl(state: OnchainSnapshot["status"]["state"]): number {
  return state === "ready" ? 20_000 : 30_000;
}

const sharedSnapshotCache = createOnchainSnapshotCache(buildOnchainSnapshot);

function problem(detail: string) {
  return {
    type: "about:blank",
    title: "onchain snapshot unavailable",
    status: 503,
    detail,
    next_actions: ["retry shortly", "GET /v1/onchain for the composite latest-state surface", "GET /v1/guide for every public door"],
  };
}

function ifNoneMatch(requestValue: string | undefined, etag: string): boolean {
  if (!requestValue) return false;
  const normalizedEtag = etag.replace(/^W\//, "");
  return requestValue.split(",").some((candidate) => {
    const normalized = candidate.trim().replace(/^W\//, "");
    return normalized === "*" || normalized === normalizedEtag;
  });
}

function snapshotAgeSeconds(snapshot: OnchainSnapshot, now: number): number {
  const generatedAt = Date.parse(snapshot.generated_at);
  if (!Number.isFinite(generatedAt)) return 0;
  return Math.max(0, Math.floor((now - generatedAt) / 1_000));
}

function jsonSnapshot(
  c: Context,
  body: unknown,
  delivery: OnchainSnapshotDelivery,
  mediaType = ONCHAIN_MEDIA_TYPE,
  serialized = JSON.stringify(body),
  etag = snapshotEtag(serialized),
) {
  const respondedAt = delivery.deliveredAt;
  const residentAge = Math.max(0, Math.floor((respondedAt - delivery.storedAt) / 1_000));
  c.header("Content-Type", mediaType);
  c.header(
    "Cache-Control",
    delivery.cacheState === "stale"
      ? "public, max-age=0, must-revalidate, stale-while-revalidate=120"
      : "public, max-age=10, stale-while-revalidate=120",
  );
  c.header("Vary", "Accept");
  c.header("ETag", etag);
  c.header("Age", String(residentAge));
  c.header("X-CashLoom-Cache", delivery.cacheState);
  c.header("X-CashLoom-Snapshot-Age", String(snapshotAgeSeconds(delivery.snapshot, respondedAt)));
  c.header(
    "Server-Timing",
    `onchain;dur=${delivery.buildDurationMs.toFixed(1)};desc="${delivery.cacheState}"`,
  );
  c.header("Content-Length", String(new TextEncoder().encode(serialized).byteLength));
  if (delivery.cacheState === "stale") {
    c.header("Warning", '110 cashloom.io "Response is stale"');
  }
  if (ifNoneMatch(c.req.header("If-None-Match"), etag)) return c.body(null, 304);
  if (c.req.method === "HEAD") return c.body(null, 200);
  return c.body(serialized);
}

const SECTIONS = {
  chains: "chains",
  stablecoins: "stablecoins",
  "lending-markets": "lending_markets",
  pools: "pools",
  bridges: "bridge_routes",
} as const;

type SectionKey = (typeof SECTIONS)[keyof typeof SECTIONS];

const chainSources = (keys: readonly string[]) => keys.map(chainSourceId);
const SECTION_SOURCE_IDS: Record<SectionKey, ReadonlySet<string>> = {
  chains: new Set(chainSources(listBlockchainChains().map((row) => row.key))),
  stablecoins: new Set([
    CIRCLE_USDC_REGISTRY_SOURCE_ID,
    ...chainSources(NATIVE_USDC_DEPLOYMENTS.map((row) => row.chain_key)),
  ]),
  lending_markets: new Set([
    AAVE_ADDRESS_BOOK_SOURCE_ID,
    ...chainSources(AAVE_USDC_MARKETS.map((row) => row.chain_key)),
  ]),
  pools: new Set([
    UNISWAP_V3_SOURCE_ID,
    ...chainSources(UNISWAP_USDC_WETH_POOLS.map((row) => row.chain_key)),
  ]),
  bridge_routes: new Set([CCTP_SOURCE_ID]),
};

export function mountOnchainDoor(
  app: Hono,
  builder?: OnchainBuilder,
  cacheOptions?: OnchainCacheOptions,
) {
  const snapshotCache = builder
    ? createOnchainSnapshotCache(builder, cacheOptions)
    : sharedSnapshotCache;
  const composite = async (c: Context) => {
    try {
      const result = await snapshotCache.read();
      return jsonSnapshot(
        c,
        result.snapshot,
        result,
        ONCHAIN_MEDIA_TYPE,
        result.serialized,
        result.etag,
      );
    } catch {
      return c.json(problem("Snapshot assembly failed before a complete or honestly degraded response could be produced inside the server-enforced whole-snapshot deadline. Unfinished reads were cancelled or omitted; no fabricated replacement was served."), 503);
    }
  };

  app.get("/v1/onchain", composite);
  // Search-language alias. `/v1/onchain` remains the canonical product door.
  app.get("/v1/blockchain", async (c) => {
    c.header("Link", '</v1/onchain>; rel="canonical"');
    return composite(c);
  });

  app.get("/v1/onchain/:section", async (c) => {
    const selector = c.req.param("section") as keyof typeof SECTIONS;
    const key = SECTIONS[selector];
    if (!key) {
      return c.json({
        type: "about:blank",
        title: "unknown onchain section",
        status: 404,
        detail: `No onchain section is registered for '${c.req.param("section")}'.`,
        next_actions: Object.keys(SECTIONS).map((section) => `GET /v1/onchain/${section}`),
      }, 404);
    }
    try {
      const result = await snapshotCache.read();
      const snapshot = result.snapshot;
      const relevantSources = SECTION_SOURCE_IDS[key];
      return jsonSnapshot(c, {
        "@type": "OnchainSection",
        schema: "cashloom.onchain-section/1",
        generated_at: snapshot.generated_at,
        scope: snapshot.scope,
        section: selector,
        status: snapshot.status.sections[key],
        unavailable: snapshot.status.unavailable.filter((item) => item.section === key),
        items: snapshot[key],
        sources: snapshot.sources.filter((source) => relevantSources.has(source.id)),
      }, result, ONCHAIN_SECTION_MEDIA_TYPE);
    } catch {
      return c.json(problem(`The ${selector} section could not be assembled inside the server-enforced whole-snapshot deadline.`), 503);
    }
  });
}
