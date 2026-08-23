import { expect, test } from "bun:test";
import { api } from "../src/api";

test("saved Base positions are a local GET and network refresh is an explicit POST", async () => {
  const originalFetch = globalThis.fetch;
  const calls: Array<{ path: string; method: string; body: string | null }> = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const path = typeof input === "string"
      ? input
      : input instanceof URL
        ? input.toString()
        : input.url;
    const method = init?.method ?? "GET";
    calls.push({ path, method, body: typeof init?.body === "string" ? init.body : null });
    const body = method === "POST"
      ? {
          schema_version: "cashloom.base-position-refresh/1",
          outcome: "partial",
          observation: {
            state: "partial",
            reason: "provider_unavailable",
            observed_at: "2026-08-23T20:00:00.000Z",
            available_providers: "1",
            unavailable_providers: "1",
          },
          account: {
            account_id: "account / one",
            label: "Base wallet",
            chain_id: "eip155:8453",
            account_ref: `eip155:8453:0x${"a".repeat(40)}`,
            address: `0x${"a".repeat(40)}`,
            custody_mode: "watch_only",
            status: "not_checked",
            snapshot: null,
            positions: [],
            actions: { refresh: true },
          },
        }
      : {
          schema_version: "cashloom.wallet-kernel-positions/3",
          generated_at: "2026-08-23T20:00:00.000Z",
          positions: [],
          base_accounts: [],
        };
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;

  try {
    await api.walletPositions();
    await api.refreshBasePositions("account / one");
  } finally {
    globalThis.fetch = originalFetch;
  }

  expect(calls).toEqual([
    { path: "/api/wallet/v3/positions", method: "GET", body: null },
    {
      path: "/api/wallet/v2/accounts/account%20%2F%20one/base-positions/refresh",
      method: "POST",
      body: "{}",
    },
  ]);
});
