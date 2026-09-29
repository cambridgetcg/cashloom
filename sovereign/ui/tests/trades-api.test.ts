import { expect, test } from "bun:test";
import { api, ApiError, hasToken, onSessionLost, setToken } from "../src/api";

function response(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
}

test("Trades reads and commands use private local namespace, exact CAS and retry key", async () => {
  const original = globalThis.fetch;
  const calls: Array<{ path: string; method: string; body: unknown; authorization: string | undefined }> = [];
  setToken("synthetic-owner-token");
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ path: String(input), method: init?.method ?? "GET", body: init?.body ? JSON.parse(String(init.body)) : null, authorization: (init?.headers as Record<string, string>)?.Authorization });
    return response({ trades: [], simulations: [], simulation: { mode: "simulation" }, events: [], nextCursor: null });
  }) as typeof fetch;
  try {
    await api.trades(); await api.trade("trade / 1"); await api.tradeHistory("trade / 1", 50);
    await api.tradeSimulations(); await api.tradeSimulation("sim / 1"); await api.tradeSimulationHistory("sim / 1", 100);
    await api.createTradeSimulation({ tradeId: "trade_1", revision: 2, expectedVersion: 0, idempotencyKey: "same-key" });
    const body = { expectedVersion: 7, idempotencyKey: "same-command-key", command: { type: "reconcile_operation" as const, operationId: "op_1" } };
    await api.tradeSimulationCommand("sim / 1", body); await api.tradeSimulationCommand("sim / 1", body);
    expect(calls.every((call) => call.path.startsWith("/api/tcg/") && call.authorization === "Bearer synthetic-owner-token")).toBe(true);
    expect(calls.slice(0, 6).every((call) => call.method === "GET" && call.body === null)).toBe(true);
    expect(calls[0].path).toBe("/api/tcg/trades?after=0&limit=50");
    expect(calls[3].path).toBe("/api/tcg/simulations?after=0&limit=50");
    expect(calls[1].path).toBe("/api/tcg/trades/trade%20%2F%201");
    expect(calls[2].path).toBe("/api/tcg/trades/trade%20%2F%201/history?after=50&limit=50");
    expect(calls[5].path).toBe("/api/tcg/simulations/sim%20%2F%201/history?after=100&limit=50");
    expect(calls[6].body).toEqual({ tradeId: "trade_1", revision: 2, expectedVersion: 0, idempotencyKey: "same-key" });
    expect(calls[7]).toEqual(calls[8]);
    expect(calls[7].body).toEqual(body);
  } finally { globalThis.fetch = original; setToken(null); }
});

test("nested trade version conflicts expose typed status without retry or silent rewrite", async () => {
  const original = globalThis.fetch; let calls = 0;
  globalThis.fetch = (async () => { calls++; return response({ error: { code: "VERSION_CONFLICT", message: "Refresh before another change." } }, 409); }) as typeof fetch;
  try {
    let caught: unknown;
    try { await api.tradeEvidence("trade_1", { expectedVersion: 4, idempotencyKey: "conflict-key", revision: 2, evidence: { kind: "note", text: "synthetic" } }); } catch (e) { caught = e; }
    expect(caught).toBeInstanceOf(ApiError);
    expect((caught as ApiError).code).toBe("VERSION_CONFLICT");
    expect((caught as ApiError).status).toBe(409);
    expect((caught as ApiError).message).toBe("Refresh before another change.");
    expect(calls).toBe(1);
  } finally { globalThis.fetch = original; }
});

test("session loss clears the shared token and invokes private view unmount handler", async () => {
  const original = globalThis.fetch; let lost = false;
  setToken("synthetic-owner-token"); onSessionLost(() => { lost = true; });
  globalThis.fetch = (async () => response({ error: { code: "UNAUTHORIZED", message: "Owner session expired." } }, 401)) as typeof fetch;
  try {
    await expect(api.trades()).rejects.toThrow("Owner session expired.");
    expect(hasToken()).toBe(false); expect(lost).toBe(true);
  } finally { globalThis.fetch = original; setToken(null); onSessionLost(() => undefined); }
});

test("unreadable successful mutation result remains an error, not a false completion", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = (async () => new Response("not JSON", { status: 200 })) as typeof fetch;
  try {
    await expect(api.createTradeSimulation({ tradeId: "trade_1", revision: 1, expectedVersion: 0, idempotencyKey: "synthetic-key" })).rejects.toThrow("Retry the exact request");
  } finally { globalThis.fetch = original; }
});
