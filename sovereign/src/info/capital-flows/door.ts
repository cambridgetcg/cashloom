import type { Context, Hono } from "hono";
import { CAPITAL_FLOWS_MEDIA_TYPE, type CapitalFlowAdapter } from "./model.ts";
import { capitalFlowAdapters } from "./registry.ts";
import { createCapitalFlowsCache, type CapitalFlowsCache, type CapitalFlowsCacheOptions } from "./snapshot.ts";

export interface CapitalFlowsDoorOverrides extends CapitalFlowsCacheOptions {
  adapters?: readonly CapitalFlowAdapter[];
  cache?: CapitalFlowsCache;
}
let sharedCache: CapitalFlowsCache | undefined;
function matches(header: string | undefined, etag: string): boolean {
  const value = etag.replace(/^W\//, "");
  return !!header?.split(",").some(candidate => candidate.trim() === "*" || candidate.trim().replace(/^W\//, "") === value);
}
/** Independent, public read-only door. Returned cache supports orderly shutdown/test disposal. */
export function mountCapitalFlowsDoor(app: Hono, overrides?: CapitalFlowsDoorOverrides): CapitalFlowsCache {
  const cache = overrides?.cache ?? (overrides
    ? createCapitalFlowsCache(overrides.adapters ?? capitalFlowAdapters, overrides)
    : sharedCache ??= createCapitalFlowsCache(capitalFlowAdapters));
  const handle = async (c: Context) => {
    try {
      // Query strings never affect resources, cache keys, budgets or refresh eligibility.
      const result = await cache.read();
      c.header("Content-Type", CAPITAL_FLOWS_MEDIA_TYPE);
      // Every request must revalidate rights. No shared/browser stale-while-revalidate window.
      c.header("Cache-Control", "public, max-age=0, must-revalidate");
      c.header("Vary", "Accept");
      c.header("ETag", result.etag);
      c.header("Age", String(Math.max(0, Math.floor((result.deliveredAt - result.storedAt) / 1_000))));
      c.header("X-CashLoom-Cache", result.cacheState);
      c.header("Content-Length", String(new TextEncoder().encode(result.serialized).byteLength));
      if (matches(c.req.header("If-None-Match"), result.etag)) return c.body(null, 304);
      if (c.req.method === "HEAD") return c.body(null, 200);
      return c.body(result.serialized, 200);
    } catch {
      c.header("Cache-Control", "no-store");
      c.header("Content-Type", "application/problem+json");
      if (c.req.method === "HEAD") return c.body(null, 503);
      return c.body(JSON.stringify({ type: "about:blank", title: "Capital-flow snapshot unavailable", status: 503,
        detail: "The bounded snapshot could not be served. No fabricated values or unvalidated fallback were returned." }), 503);
    }
  };
  app.on(["GET", "HEAD"], "/v1/capital-flows", handle);
  return cache;
}
