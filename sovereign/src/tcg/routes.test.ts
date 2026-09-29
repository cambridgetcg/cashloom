import { Database } from "bun:sqlite";
import { describe, expect, spyOn, test } from "bun:test";
import { Hono } from "hono";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { createTcgRoutes, MAX_TCG_BODY_BYTES } from "./routes";
import { TradeStore } from "./store";
import { SimulationStore } from "./simulation-store";
import { fixtureTerms, ids, OWNER, TEST_NOW } from "./fixtures";
import type { OwnerActor, TradeRecord } from "./domain";
import type { SimulationRun } from "./simulation";

function fixture(actor: () => OwnerActor | null = () => OWNER) {
  const db = new Database(":memory:");
  const trades = new TradeStore(db, { now: () => TEST_NOW, id: ids() });
  let sandboxDb: Database | null = null, simulationStore: SimulationStore | null = null;
  const calls: boolean[] = [];
  const app = new Hono().route("/tcg", createTcgRoutes({ trades, getActor: actor, getSimulationStore: (create) => {
    calls.push(create);
    if (!simulationStore && create) { sandboxDb = new Database(":memory:"); simulationStore = new SimulationStore(sandboxDb, { now: () => TEST_NOW, id: ids() }); }
    return simulationStore;
  } }));
  return { app, db, trades, calls, close: () => { db.close(); sandboxDb?.close(); } };
}
const post = (app: Hono, path: string, body: unknown) => app.request(`/tcg${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
async function createTrade(app: Hono): Promise<TradeRecord> {
  const response = await post(app, "/trades", { idempotencyKey: "create", expectedVersion: 0, terms: fixtureTerms() });
  expect(response.status).toBe(200); return (await response.json() as { trade: TradeRecord }).trade;
}

describe("owner-only private bounded TCG routes", () => {
  test("missing or invalid principals fail closed before creating sandbox state", async () => {
    for (const actor of [null, { kind: "agent", ref: "local-owner" }, { kind: "owner", ref: "forged" }]) {
      const f = fixture(() => actor as OwnerActor | null); try {
        const response = await post(f.app, "/simulations", { idempotencyKey: "x", expectedVersion: 0, tradeId: "trade_fake", revision: 1 });
        expect(response.status).toBe(actor ? 403 : 401); expect(response.headers.get("cache-control")).toBe("private, no-store");
        expect(f.calls).toEqual([]);
        expect((await response.json() as any).error.code).toBe(actor ? "FORBIDDEN" : "UNAUTHORIZED");
      } finally { f.close(); }
    }
  });
  test("owner authorization is checked again after body parsing", async () => {
    let calls = 0;
    const f = fixture(() => ++calls === 1 ? OWNER : null); try {
      const response = await post(f.app, "/trades", { idempotencyKey: "x", expectedVersion: 0, terms: fixtureTerms() });
      expect(response.status).toBe(401); expect(f.trades.list()).toEqual([]);
    } finally { f.close(); }
  });
  test("GET list and missing detail/history never create the sandbox", async () => {
    const f = fixture(); try {
      expect(await (await f.app.request("/tcg/simulations")).json()).toEqual({ simulations: [], nextCursor: null });
      expect((await f.app.request("/tcg/simulations/sim_missing")).status).toBe(404);
      expect((await f.app.request("/tcg/simulations/sim_missing/history")).status).toBe(404);
      expect(f.calls).toEqual([false, false, false]);
      const invalid = await post(f.app, "/simulations", { idempotencyKey: "missing-source", expectedVersion: 0, tradeId: "trade_missing", revision: 1 });
      expect(invalid.status).toBe(404); expect(f.calls).toEqual([false, false, false]);
    } finally { f.close(); }
  });
  test("create, revise, evidence and bounded paginated history use server actor/time and fixed conflict errors", async () => {
    const f = fixture(); try {
      const trade = await createTrade(f.app);
      const response = await post(f.app, `/trades/${trade.id}/evidence`, { expectedVersion: trade.version, idempotencyKey: "evidence", revision: 1, evidence: { kind: "payment", text: "Externally reported payment", references: ["https://example.invalid/receipt"] } });
      expect(response.status).toBe(200);
      const saved = (await response.json() as { trade: TradeRecord }).trade;
      expect(saved.evidence[0]).toMatchObject({ actor: OWNER, recordedAt: TEST_NOW, provenance: "owner_reported", mode: "record" });
      expect(saved.protection).toBe("unavailable");
      const stale = await post(f.app, `/trades/${trade.id}/revisions`, { expectedVersion: trade.version, idempotencyKey: "stale", terms: fixtureTerms() });
      expect(stale.status).toBe(409); expect(await stale.json()).toEqual({ error: { code: "VERSION_CONFLICT", message: "The record changed. Refresh before making another change." } });
      const page = await f.app.request(`/tcg/trades/${trade.id}/history?after=0&limit=1`);
      expect((await page.json() as any).nextCursor).toBe(1);
      for (const query of ["limit=101", "limit=0", "after=-1", "after=1.5", "surprise=true"]) expect((await f.app.request(`/tcg/trades/${trade.id}/history?${query}`)).status).toBe(400);
    } finally { f.close(); }
  });
  test("strict bodies reject forged actors/modes/provenance/status and malformed inputs", async () => {
    const f = fixture(); try {
      for (const extra of [{ actor: OWNER }, { mode: "simulation" }, { protection: "escrow" }, { recordedAt: TEST_NOW }]) expect((await post(f.app, "/trades", { idempotencyKey: "forged", expectedVersion: 0, terms: fixtureTerms(), ...extra })).status).toBe(400);
      for (const invalid of [{ terms: fixtureTerms() }, { terms: fixtureTerms(), idempotencyKey: "x", expectedVersion: 1 }, { terms: fixtureTerms(), idempotencyKey: "x".repeat(129), expectedVersion: 0 }]) expect((await post(f.app, "/trades", invalid)).status).toBe(400);
      const trade = await createTrade(f.app);
      expect((await post(f.app, `/trades/${trade.id}/evidence`, { idempotencyKey: "x", expectedVersion: 1, revision: 1, evidence: { kind: "payment", text: "Forged", provenance: "verified" } })).status).toBe(400);
      expect((await post(f.app, `/simulations/sim_fake/commands`, { idempotencyKey: "x", expectedVersion: 1, command: { type: "set_status", settlement: "released" } })).status).toBe(400);
      expect((await f.app.request("/tcg/trades", { method: "POST", headers: { "content-type": "application/json" }, body: "{broken" })).status).toBe(400);
      expect((await f.app.request("/tcg/trades", { method: "POST", headers: { "content-type": "text/plain" }, body: "{}" })).status).toBe(400);
      expect(f.calls).toEqual([]);
    } finally { f.close(); }
  });
  test("body limits cover claimed length and streamed actual bytes without invoking stores", async () => {
    const f = fixture(); try {
      const response = await f.app.request("/tcg/trades", { method: "POST", headers: { "content-type": "application/json", "content-length": String(MAX_TCG_BODY_BYTES + 1) }, body: "{}" });
      expect(response.status).toBe(413);
      const oversized = await post(f.app, "/trades", { note: "x".repeat(MAX_TCG_BODY_BYTES + 1) });
      expect(oversized.status).toBe(413); expect((await oversized.json() as any).error.code).toBe("BODY_TOO_LARGE");
      expect(f.trades.list()).toEqual([]);
    } finally { f.close(); }
  });
  test("immutable source snapshot displays stale revisions and sandbox history stays separate", async () => {
    const f = fixture(); try {
      const trade = await createTrade(f.app);
      const response = await post(f.app, "/simulations", { idempotencyKey: "start", expectedVersion: 0, tradeId: trade.id, revision: 1 });
      expect(response.status).toBe(200); const run = (await response.json() as { simulation: SimulationRun }).simulation;
      expect(run).toMatchObject({ mode: "simulation", sourceCurrentRevision: 1, staleRevision: false }); expect(f.calls).toEqual([true]);
      await post(f.app, `/trades/${trade.id}/revisions`, { idempotencyKey: "revise", expectedVersion: trade.version, terms: { ...fixtureTerms(), title: "New terms" } });
      const current = (await (await f.app.request(`/tcg/simulations/${run.id}`)).json() as { simulation: SimulationRun }).simulation;
      expect(current.staleRevision).toBe(true); expect(current.sourceCurrentRevision).toBe(2); expect(current.snapshot.hash).toBe(trade.current.hash);
      const history = await f.app.request(`/tcg/simulations/${run.id}/history`);
      expect((await history.json() as any).events[0]).toMatchObject({ mode: "simulation", actor: OWNER, agreementHash: trade.current.hash });
      expect(f.trades.get(trade.id)!.evidence).toEqual([]);
    } finally { f.close(); }
  });
  test("returned permitted commands execute, unknown state exposes reconciliation only, and network is never used", async () => {
    const f = fixture(); let networkCalls = 0;
    const forbidNetwork = () => { networkCalls++; throw new Error("network forbidden"); };
    const fetchMock = spyOn(globalThis, "fetch").mockImplementation(Object.assign(forbidNetwork, { preconnect: forbidNetwork }));
    try {
      const trade = await createTrade(f.app);
      let run = (await (await post(f.app, "/simulations", { idempotencyKey: "start", expectedVersion: 0, tradeId: trade.id, revision: 1 })).json() as { simulation: SimulationRun }).simulation;
      let n = 0;
      const step = async (type: string, outcome?: string) => {
        const command = run.permittedActions.find((a) => a.command.type === type && (!outcome || (a.command as any).outcome === outcome))!.command;
        const response = await post(f.app, `/simulations/${run.id}/commands`, { idempotencyKey: `step-${++n}`, expectedVersion: run.version, command });
        expect(response.status).toBe(200); run = (await response.json() as { simulation: SimulationRun }).simulation;
      };
      await step("accept"); await step("accept"); await step("fund"); await step("advance_operation", "unknown");
      expect(run.permittedActions.map((a) => a.command.type)).toEqual(["reconcile_operation"]);
      const blocked = await post(f.app, `/simulations/${run.id}/commands`, { idempotencyKey: "blocked", expectedVersion: run.version, command: { type: "request_release" } });
      expect(blocked.status).toBe(409); expect((await blocked.json() as any).error.code).toBe("RECONCILIATION_REQUIRED");
      await step("reconcile_operation"); expect(run.state.funding).toBe("funded"); expect(networkCalls).toBe(0);
    } finally { fetchMock.mockRestore(); f.close(); }
  });
  test("101 trades and simulations remain discoverable across stable list cursors", async () => {
    const f = fixture(); try {
      let oldest: TradeRecord | undefined;
      for (let i = 0; i < 101; i++) {
        const trade = (await (await post(f.app, "/trades", { idempotencyKey: `many-${i}`, expectedVersion: 0, terms: { ...fixtureTerms(), title: `Synthetic ${i}` } })).json() as { trade: TradeRecord }).trade;
        oldest ??= trade;
        expect((await post(f.app, "/simulations", { idempotencyKey: `many-${i}`, expectedVersion: 0, tradeId: trade.id, revision: 1 })).status).toBe(200);
      }
      for (const kind of ["trades", "simulations"] as const) {
        const first = await (await f.app.request(`/tcg/${kind}?after=0&limit=50`)).json() as Record<string, any>;
        expect(first[kind]).toHaveLength(50); expect(first.nextCursor).not.toBeNull();
        if (kind === "trades") {
          // New insertion and an edit of an old row cannot shift an in-progress cursor.
          await post(f.app, "/trades", { idempotencyKey: "newer-during-list", expectedVersion: 0, terms: fixtureTerms() });
          await post(f.app, `/trades/${oldest!.id}/revisions`, { idempotencyKey: "edit-during-list", expectedVersion: 1, terms: { ...fixtureTerms(), title: "Oldest edited" } });
        }
        const second = await (await f.app.request(`/tcg/${kind}?after=${first.nextCursor}&limit=50`)).json() as Record<string, any>;
        const third = await (await f.app.request(`/tcg/${kind}?after=${second.nextCursor}&limit=50`)).json() as Record<string, any>;
        expect(second[kind]).toHaveLength(50); expect(third[kind]).toHaveLength(1); expect(third.nextCursor).toBeNull();
        const ids = [...first[kind], ...second[kind], ...third[kind]].map((row: { id: string }) => row.id);
        expect(new Set(ids).size).toBe(101);
        if (kind === "trades") expect(ids).toContain(oldest!.id);
        for (const invalid of ["limit=101", "after=-1", "limit=0", "after=1.1", "unknown=yes"]) expect((await f.app.request(`/tcg/${kind}?${invalid}`)).status).toBe(400);
      }
    } finally { f.close(); }
  });
  test("database errors return no SQL paths or raw exception messages", async () => {
    const f = fixture(); try {
      f.db.exec("DROP TRIGGER tcg_trades_no_delete; CREATE TRIGGER synthetic_failure BEFORE INSERT ON tcg_trades BEGIN SELECT RAISE(ABORT,'sensitive SQL path /private/account-secret'); END");
      const response = await post(f.app, "/trades", { idempotencyKey: "x", expectedVersion: 0, terms: fixtureTerms() });
      expect(response.status).toBe(500); expect(await response.json()).toEqual({ error: { code: "INTERNAL_ERROR", message: "The request could not be completed." } });
      expect(response.headers.get("cache-control")).toBe("private, no-store");
    } finally { f.close(); }
  });
});

test("transitive simulation import closure contains only isolated persistence and pure domain modules", () => {
  const root = dirname(new URL(import.meta.url).pathname), visited = new Set<string>();
  function visit(path: string) {
    if (visited.has(path)) return; visited.add(path);
    const source = readFileSync(path, "utf8");
    expect(source.includes(String.fromCharCode(0))).toBe(false);
    expect(source).not.toMatch(/\b(?:fetch|Bun\.serve|Bun\.connect|attachDatabase)\s*\(/);
    for (const match of source.matchAll(/(?:from\s+|import\s*\()["']([^"']+)["']/g)) {
      const specifier = match[1]!;
      if (!specifier.startsWith(".")) { expect(["bun:sqlite", "zod", "@noble/hashes/sha2.js", "@noble/hashes/utils.js"]).toContain(specifier); continue; }
      const next = resolve(dirname(path), specifier.endsWith(".ts") ? specifier : `${specifier}.ts`);
      expect(next).not.toMatch(/\/(?:vault|db|send|senders|connectors|adapters|pay)\b/);
      expect(next).not.toBe(resolve(root, "store.ts"));
      visit(next);
    }
  }
  visit(resolve(root, "simulation-store.ts"));
  expect(visited.has(resolve(root, "../wallet/domain/money.ts"))).toBe(true);
  expect(visited.has(resolve(root, "../wallet/domain/intent.ts"))).toBe(true);
});
