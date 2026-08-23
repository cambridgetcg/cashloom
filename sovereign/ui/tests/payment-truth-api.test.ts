import { expect, test } from "bun:test";
import { api } from "../src/api";

test("payment truth GET is local-only and reconciliation is an explicit POST", async () => {
  const originalFetch = globalThis.fetch;
  const calls: Array<{ path: string; method: string; body: string | null }> = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const path = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const method = init?.method ?? "GET";
    calls.push({ path, method, body: typeof init?.body === "string" ? init.body : null });
    if (method === "POST") {
      return new Response(JSON.stringify({
        truth: {
          schema_version: "cashloom.payment-truth/1",
          intent_id: "payment / one",
          visibility: "not_found",
        },
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    return new Response(JSON.stringify({ payments: [] }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;

  try {
    await api.payments();
    await api.reconcileBasePayment("payment / one");
  } finally {
    globalThis.fetch = originalFetch;
  }

  expect(calls).toEqual([
    { path: "/api/payments", method: "GET", body: null },
    {
      path: "/api/wallet/v2/intents/payment%20%2F%20one/reconcile",
      method: "POST",
      body: "{}",
    },
  ]);
});
