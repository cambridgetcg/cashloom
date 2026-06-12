import { describe, it, expect } from "vitest";
import accountRoutes from "./account.route";

// The sync endpoints drive QUOTA-LIMITED and PAID upstream calls (GoCardless
// ~4 calls/account/day, metered Stripe usage), so they must sit behind a
// per-endpoint limiter — the global 300/15min cap alone lets one looping
// client torch every linked account's daily quota. This pins the limiter in
// place structurally: an express-rate-limit middleware is identifiable by the
// resetKey/getKey functions it carries.

interface RouteHandlerLayer {
  name: string;
  handle: { resetKey?: unknown; getKey?: unknown };
}

interface RouterLayer {
  route?: {
    path: string;
    methods: Record<string, boolean>;
    stack: RouteHandlerLayer[];
  };
}

const findRoute = (path: string, method: string) =>
  (accountRoutes as unknown as { stack: RouterLayer[] }).stack.find(
    (layer) => layer.route?.path === path && layer.route.methods[method]
  )?.route;

const isRateLimiter = (layer: RouteHandlerLayer): boolean =>
  typeof layer.handle.resetKey === "function" &&
  typeof layer.handle.getKey === "function";

describe("sync endpoint throttles", () => {
  it.each(["/sync/:id", "/sync-all"])(
    "POST %s runs a per-endpoint rate limiter ahead of the controller",
    (path) => {
      const route = findRoute(path, "post");
      expect(route).toBeTruthy();
      // Limiter first, controller after.
      expect(route!.stack.length).toBeGreaterThanOrEqual(2);
      expect(isRateLimiter(route!.stack[0])).toBe(true);
      expect(isRateLimiter(route!.stack[route!.stack.length - 1])).toBe(false);
    }
  );

  it("non-sync account routes are not throttled beyond the global limiter", () => {
    const route = findRoute("/all", "get");
    expect(route).toBeTruthy();
    expect(route!.stack.some(isRateLimiter)).toBe(false);
  });
});
