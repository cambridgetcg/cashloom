import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createCryptoWatchRoutes } from "./crypto-watch.ts";
import { walletConnectSetup } from "./walletconnect-config.ts";

test("missing and invalid project configuration never reflects an input value", () => {
  expect(walletConnectSetup({})).toEqual({ state: "not_configured", project_id: null });
  expect(walletConnectSetup({ CASHLOOM_WALLETCONNECT_PROJECT_ID: "  " }).state).toBe("not_configured");
  for (const value of ["invalid-sensitive-input", "https://example.invalid/project", "a".repeat(31), "a".repeat(33), "z".repeat(32)]) {
    expect(walletConnectSetup({ CASHLOOM_WALLETCONNECT_PROJECT_ID: value })).toEqual({ state: "invalid_configuration", project_id: null });
  }
  expect(walletConnectSetup({ CASHLOOM_WALLETCONNECT_PROJECT_ID: ` ${"a".repeat(32)} ` })).toEqual({ state: "ready", project_id: "a".repeat(32) });
});

test("only the owner can inspect pairing setup, without network or database work", async () => {
  const db = new Database(":memory:");
  let allowed = false, reads = 0, network = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => { network++; throw new Error("Unexpected network"); }) as unknown as typeof fetch;
  try {
    const routes = createCryptoWatchRoutes({ db, canManage: () => allowed, walletConnectSetup: () => { reads++; return { state: "ready", project_id: "a".repeat(32) }; } });
    const denied = await routes.request("/walletconnect");
    expect(denied.status).toBe(403);
    expect(reads).toBe(0);
    expect(await denied.json()).not.toHaveProperty("project_id");
    allowed = true;
    const result = await routes.request("/walletconnect");
    expect(result.status).toBe(200);
    expect(result.headers.get("Cache-Control")).toBe("private, no-store");
    expect(await result.json()).toEqual({ state: "ready", project_id: "a".repeat(32) });
    expect(reads).toBe(1); expect(network).toBe(0);
    expect(db.query("SELECT total_changes() AS n").get()).toEqual({ n: 0 });
    expect((await routes.request("/walletconnect", { method: "POST" })).status).toBe(404);
  } finally { globalThis.fetch = originalFetch; db.close(); }
});
