import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fixtureTerms, ids, OWNER, TEST_NOW } from "./fixtures";
import { TradeStore } from "./store";
import { SimulationStore } from "./simulation-store";
import { installTradeSchema, installSimulationSchema, TCG_SIMULATION_TABLES } from "./schema";
import { assertConservation, type SimulationCommand, type SimulationRun } from "./simulation";

function fixture() {
  const real = new Database(":memory:"), sandbox = new Database(":memory:");
  let now = TEST_NOW;
  const trades = new TradeStore(real, { now: () => now, id: ids() });
  const simulations = new SimulationStore(sandbox, { now: () => now, id: ids() });
  const trade = trades.create({ idempotencyKey: "create", expectedVersion: 0, terms: fixtureTerms() }, OWNER);
  const run = simulations.create({ idempotencyKey: "start", expectedVersion: 0, tradeId: trade.id, revision: 1 }, trade.current, OWNER);
  return { real, sandbox, trades, simulations, trade, run, time: (value: string) => { now = value; }, close: () => { real.close(); sandbox.close(); } };
}
function machine(store: SimulationStore, initial: SimulationRun) {
  let run = initial, n = 0;
  return {
    get run() { return run; },
    step(command: SimulationCommand) {
      run = store.command(run.id, { idempotencyKey: `command-${initial.id}-${++n}`, expectedVersion: run.version, command }, OWNER);
      assertConservation(run.state, run.snapshot.totals.total);
      return run;
    },
    fund() {
      this.step({ type: "accept", simulatedRole: "buyer" }); this.step({ type: "accept", simulatedRole: "seller" }); this.step({ type: "fund" });
      return this.step({ type: "advance_operation", operationId: run.state.operation!.id, outcome: "complete" });
    },
    deliver() { this.step({ type: "dispatch" }); return this.step({ type: "deliver" }); },
    complete() { return this.step({ type: "advance_operation", operationId: run.state.operation!.id, outcome: "complete" }); },
  };
}

describe("immutable owner record store", () => {
  test("idempotent schema and exact create replay, conflicting key and stale CAS", () => {
    const f = fixture(); try {
      installTradeSchema(f.real); installTradeSchema(f.real);
      expect(f.trades.create({ terms: fixtureTerms(), expectedVersion: 0, idempotencyKey: "create" }, OWNER)).toEqual(f.trade);
      expect(f.trades.list()).toHaveLength(1);
      expect(() => f.trades.create({ terms: { ...fixtureTerms(), title: "changed" }, expectedVersion: 0, idempotencyKey: "create" }, OWNER)).toThrow("different request");
      expect(() => f.trades.revise(f.trade.id, { terms: fixtureTerms(), expectedVersion: 0, idempotencyKey: "revision" }, OWNER)).toThrow("record changed");
    } finally { f.close(); }
  });
  test("revision edits never rebind old evidence or copied simulation snapshots", () => {
    const f = fixture(); try {
      const accepted = f.trades.recordEvidence(f.trade.id, { idempotencyKey: "accepted", expectedVersion: 1, revision: 1, evidence: { kind: "acceptance", text: "Owner says both agreed", occurredAt: "2026-09-01T12:00:00.000Z" } }, OWNER);
      const revised = f.trades.revise(f.trade.id, { idempotencyKey: "revision", expectedVersion: accepted.version, terms: { ...fixtureTerms(), title: "Second revision" } }, OWNER);
      expect(revised.currentRevision).toBe(2); expect(revised.revisions).toHaveLength(2);
      expect(revised.current.hash).not.toBe(accepted.current.hash);
      expect(revised.evidence[0]).toMatchObject({ revision: 1, agreementHash: f.trade.current.hash, provenance: "owner_reported", actor: OWNER, recordedAt: TEST_NOW, occurredAt: "2026-09-01T12:00:00.000Z" });
      expect(revised.protection).toBe("unavailable");
      expect(f.simulations.get(f.run.id)!.snapshot.hash).toBe(f.trade.current.hash);
      expect(f.simulations.get(f.run.id)!.state.agreement).toEqual({ buyerAccepted: false, sellerAccepted: false });
      const corrected = f.trades.recordEvidence(f.trade.id, { idempotencyKey: "correction", expectedVersion: revised.version, revision: 1, evidence: { kind: "correction", text: "Only the buyer reportedly agreed", correctsEvidenceId: revised.evidence[0]!.id } }, OWNER);
      expect(corrected.evidence).toHaveLength(2); expect(corrected.evidence[0]).toEqual(revised.evidence[0]);
      expect(() => f.trades.recordEvidence(f.trade.id, { idempotencyKey: "wrong-revision-correction", expectedVersion: corrected.version, revision: 2, evidence: { kind: "correction", text: "Wrong revision", correctsEvidenceId: revised.evidence[0]!.id } }, OWNER)).toThrow("request is invalid");
    } finally { f.close(); }
  });
  test("SQL cannot overwrite revisions, evidence, requests or activity; paginated history is stable", () => {
    const f = fixture(); try {
      const evidence = f.trades.recordEvidence(f.trade.id, { idempotencyKey: "note", expectedVersion: 1, revision: 1, evidence: { kind: "note", text: "Reported" } }, OWNER);
      for (const table of ["tcg_revisions", "tcg_evidence", "tcg_events", "tcg_requests"]) {
        expect(() => f.real.exec(`DELETE FROM ${table}`)).toThrow("immutable");
        const column = table === "tcg_requests" ? "response_json" : "json";
        expect(() => f.real.exec(`UPDATE ${table} SET ${column}='{}'`)).toThrow("immutable");
      }
      const first = f.trades.history(evidence.id, { limit: 1 });
      expect(first.events[0]!.sequence).toBe(1); expect(first.nextCursor).toBe(1);
      const second = f.trades.history(evidence.id, { after: first.nextCursor!, limit: 1 });
      expect(second.events[0]!.sequence).toBe(2); expect(second.nextCursor).toBeNull();
      expect(second.events[0]!.mode).toBe("record");
    } finally { f.close(); }
  });
  test("state, event and idempotency persist atomically or roll back together", () => {
    const f = fixture(); try {
      f.real.exec("CREATE TRIGGER synthetic_event_failure BEFORE INSERT ON tcg_events BEGIN SELECT RAISE(ABORT,'synthetic disk error'); END");
      expect(() => f.trades.revise(f.trade.id, { idempotencyKey: "fail", expectedVersion: 1, terms: { ...fixtureTerms(), title: "Not committed" } }, OWNER)).toThrow();
      expect(f.trades.get(f.trade.id)).toEqual(f.trade);
      expect(f.real.query("SELECT 1 FROM tcg_requests WHERE key='fail'").get()).toBeNull();
    } finally { f.close(); }
  });
});

describe("deterministic sandbox journeys", () => {
  test("full release requires dual simulated acceptance, funding, delivery and inspection", () => {
    const f = fixture(); try {
      const m = machine(f.simulations, f.run);
      expect(() => m.step({ type: "fund" })).toThrow();
      m.fund(); m.step({ type: "dispatch" });
      expect(() => m.step({ type: "request_release" })).toThrow();
      f.time("2028-01-01T00:00:00.000Z");
      expect(() => m.step({ type: "request_release" })).toThrow();
      m.step({ type: "deliver" }); expect(() => m.step({ type: "request_release" })).toThrow();
      m.step({ type: "accept_inspection" }); m.step({ type: "request_release" });
      expect(m.run.state.settlement).toBe("release_pending"); expect(m.run.state.balances.held.atomic as string).toBe("360");
      m.complete(); expect(m.run.state.settlement).toBe("released"); expect(m.run.state.balances.released.atomic as string).toBe("360");
      expect(m.run.permittedActions).toEqual([]); expect(() => m.step({ type: "request_refund" })).toThrow();
      expect(f.trades.get(f.trade.id)).toEqual(f.trade);
      expect(f.simulations.history(f.run.id).events.every((e) => e.mode === "simulation" && e.actor.kind === "owner" && e.revision === 1)).toBe(true);
    } finally { f.close(); }
  });
  test("condition dispute freezes release until distinct return receipt and full refund authorization", () => {
    const f = fixture(); try {
      const m = machine(f.simulations, f.run); m.fund(); m.deliver(); m.step({ type: "open_dispute" });
      expect(() => m.step({ type: "request_release" })).toThrow();
      expect(() => m.step({ type: "authorize_refund" })).toThrow();
      m.step({ type: "authorize_return" }); expect(m.run.state.return).toBe("authorized");
      m.step({ type: "dispatch_return" }); expect(() => m.step({ type: "request_refund" })).toThrow();
      m.step({ type: "receive_return" }); expect(m.run.state.settlement).toBe("none");
      m.step({ type: "authorize_refund" }); expect(m.run.state.settlement).toBe("none");
      m.step({ type: "request_refund" }); expect(m.run.state.settlement).toBe("refund_pending");
      m.complete(); expect(m.run.state.settlement).toBe("refunded"); expect(m.run.state.balances.refunded.atomic as string).toBe("360");
      expect(m.run.state.balances.released.atomic as string).toBe("0"); expect(m.run.permittedActions).toEqual([]);
    } finally { f.close(); }
  });
  test("disputed release needs explicit simulated adjudicator resolution bound to the snapshot", () => {
    const f = fixture(); try {
      const m = machine(f.simulations, f.run); m.fund(); m.deliver(); m.step({ type: "open_dispute" }); m.step({ type: "resolve_release" });
      m.step({ type: "request_release" }); m.complete(); expect(m.run.state.settlement).toBe("released");
      const event = f.simulations.history(f.run.id).events.find((e) => e.type === "resolve_release")!;
      expect(event).toMatchObject({ agreementHash: f.trade.current.hash, revision: 1, actor: OWNER, data: { simulatedRole: "adjudicator" } });
    } finally { f.close(); }
  });
  test("unfunded cancellation terminal; funded cancellation requires explicit refund path", () => {
    const f = fixture(); try {
      const m = machine(f.simulations, f.run); m.step({ type: "cancel" }); expect(m.run.permittedActions).toEqual([]);
      const second = f.simulations.create({ idempotencyKey: "another", expectedVersion: 0, tradeId: f.trade.id, revision: 1 }, f.trade.current, OWNER);
      const n = machine(f.simulations, second); n.fund(); n.step({ type: "cancel" });
      expect(n.run.state.cancellation).toBe("refund_required"); expect(n.run.state.balances.held.atomic as string).toBe("360");
      expect(() => n.step({ type: "request_refund" })).toThrow();
      n.step({ type: "authorize_refund" }); n.step({ type: "request_refund" }); n.complete();
      expect(n.run.state.settlement).toBe("refunded");
    } finally { f.close(); }
  });
  test("post-dispatch cancellation cannot bypass physical return", () => {
    const f = fixture(); try {
      const m = machine(f.simulations, f.run); m.fund(); m.step({ type: "dispatch" }); m.step({ type: "cancel" });
      expect(() => m.step({ type: "authorize_refund" })).toThrow();
      m.step({ type: "authorize_return" }); m.step({ type: "dispatch_return" }); m.step({ type: "receive_return" }); m.step({ type: "authorize_refund" }); m.step({ type: "request_refund" }); m.complete();
      expect(m.run.state.settlement).toBe("refunded");
    } finally { f.close(); }
  });
  test("proposal expiry prevents acceptance and funding, including after both roles accepted", () => {
    const f = fixture(); try {
      const m = machine(f.simulations, f.run); m.step({ type: "accept", simulatedRole: "buyer" }); m.step({ type: "accept", simulatedRole: "seller" });
      f.time(f.run.snapshot.terms.expiresAt); expect(() => m.step({ type: "fund" })).toThrow("expired");
      expect(f.simulations.get(f.run.id)!.permittedActions.map((a) => a.command.type)).toEqual(["cancel"]);
    } finally { f.close(); }
  });
  test.each(["funding", "release", "refund"] as const)("%s unknown outcomes block all new/conflicting work until stable-ID reconciliation", (kind) => {
    const f = fixture(); try {
      const m = machine(f.simulations, f.run);
      if (kind === "funding") { m.step({ type: "accept", simulatedRole: "buyer" }); m.step({ type: "accept", simulatedRole: "seller" }); m.step({ type: "fund" }); }
      else { m.fund(); if (kind === "release") { m.deliver(); m.step({ type: "accept_inspection" }); m.step({ type: "request_release" }); } else { m.step({ type: "cancel" }); m.step({ type: "authorize_refund" }); m.step({ type: "request_refund" }); } }
      const operationId = m.run.state.operation!.id;
      m.step({ type: "advance_operation", operationId, outcome: "unknown" });
      expect(m.run.permittedActions.map((a) => a.command)).toEqual([{ type: "reconcile_operation", operationId }]);
      for (const type of ["fund", "cancel", "request_release", "request_refund"] as const) expect(() => m.step({ type })).toThrow("Reconcile");
      expect(() => m.step({ type: "reconcile_operation", operationId: "sim_op_wrong" })).toThrow();
      m.step({ type: "reconcile_operation", operationId }); expect(m.run.state.operation!.status).toBe("completed");
      expect(m.run.state.operation!.id).toBe(operationId);
    } finally { f.close(); }
  });
  test("failed funding does not mint value; failed release permits a fresh attempt, not double consuming", () => {
    const f = fixture(); try {
      const m = machine(f.simulations, f.run); m.step({ type: "accept", simulatedRole: "buyer" }); m.step({ type: "accept", simulatedRole: "seller" }); m.step({ type: "fund" });
      m.step({ type: "advance_operation", operationId: m.run.state.operation!.id, outcome: "fail" });
      expect(m.run.state.balances.funded.atomic as string).toBe("0"); m.step({ type: "fund" }); m.complete(); m.deliver(); m.step({ type: "accept_inspection" }); m.step({ type: "request_release" });
      const failed = m.run.state.operation!.id; m.step({ type: "advance_operation", operationId: failed, outcome: "fail" });
      expect(m.run.state.balances.held.atomic as string).toBe("360"); m.step({ type: "request_release" }); expect(m.run.state.operation!.id).not.toBe(failed); m.complete();
      expect(m.run.state.balances.released.atomic as string).toBe("360");
    } finally { f.close(); }
  });
  test("command replay cannot fund twice; conflicting key and stale settlement commands are refused", () => {
    const f = fixture(); try {
      const m = machine(f.simulations, f.run); m.fund(); m.deliver(); m.step({ type: "accept_inspection" });
      const request = { idempotencyKey: "settle", expectedVersion: m.run.version, command: { type: "request_release" } };
      const result = f.simulations.command(f.run.id, request, OWNER);
      expect(f.simulations.command(f.run.id, request, OWNER)).toEqual(result);
      expect(() => f.simulations.command(f.run.id, { ...request, command: { type: "request_refund" } }, OWNER)).toThrow("different request");
      expect(() => f.simulations.command(f.run.id, { ...request, idempotencyKey: "racing-refund", command: { type: "request_refund" } }, OWNER)).toThrow("record changed");
      expect(f.simulations.get(f.run.id)!.version).toBe(result.version);
    } finally { f.close(); }
  });
  test("failed event append rolls back simulated balances/version and replay reservation", () => {
    const f = fixture(); try {
      f.sandbox.exec("CREATE TRIGGER synthetic_event_failure BEFORE INSERT ON tcg_sim_events BEGIN SELECT RAISE(ABORT,'synthetic failure'); END");
      expect(() => f.simulations.command(f.run.id, { idempotencyKey: "fail", expectedVersion: 1, command: { type: "accept", simulatedRole: "buyer" } }, OWNER)).toThrow();
      expect(f.simulations.get(f.run.id)).toEqual(f.run);
      expect(f.sandbox.query("SELECT 1 FROM tcg_sim_requests WHERE key='fail'").get()).toBeNull();
    } finally { f.close(); }
  });
});

describe("database separation and restart", () => {
  test("sandbox refuses owner/wallet tables before any schema writes, and foreign attachments even later", () => {
    const f = fixture(); try {
      const before = f.real.query("SELECT name FROM sqlite_master ORDER BY name").all();
      expect(() => new SimulationStore(f.real)).toThrow("separate");
      expect(f.real.query("SELECT name FROM sqlite_master ORDER BY name").all()).toEqual(before);
      expect(() => installTradeSchema(f.sandbox)).toThrow("cannot share");
      installSimulationSchema(f.sandbox);
      expect((f.sandbox.query("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as Array<{ name: string }>).map((r) => r.name).sort()).toEqual([...TCG_SIMULATION_TABLES].sort());
      f.sandbox.exec("ATTACH DATABASE ':memory:' AS accidental_wallet");
      expect(() => f.simulations.list()).toThrow("without attachments");
    } finally { f.close(); }
  });
  test("persisted sandbox state rejects malformed discriminants and immutable snapshot writes", () => {
    const f = fixture(); try {
      expect(() => f.sandbox.query("UPDATE tcg_sim_runs SET version=version+1,snapshot_json='{}' WHERE id=?").run(f.run.id)).toThrow("snapshot");
      expect(() => f.sandbox.query("UPDATE tcg_sim_runs SET version=version+1,rowid=rowid+50 WHERE id=?").run(f.run.id)).toThrow("snapshot");
      expect(() => f.real.query("UPDATE tcg_trades SET version=version+1,rowid=rowid+50 WHERE id=?").run(f.trade.id)).toThrow("version transition");
      const forged = { ...f.run.state, funding: "live_funded" };
      f.sandbox.query("UPDATE tcg_sim_runs SET version=version+1,state_json=? WHERE id=?").run(JSON.stringify(forged), f.run.id);
      expect(() => f.simulations.get(f.run.id)).toThrow();
    } finally { f.close(); }
  });
  test("no simulated command changes wallet fixture rows or real trade evidence", () => {
    const f = fixture(); try {
      f.real.exec("CREATE TABLE accounts(id TEXT, balance_minor TEXT); INSERT INTO accounts VALUES ('synthetic','999999999999999999'); CREATE TABLE wallet_journal(id TEXT); CREATE TABLE wallet_payments(id TEXT)");
      const before = f.real.query("SELECT * FROM accounts").all();
      const m = machine(f.simulations, f.run); m.fund(); m.deliver(); m.step({ type: "accept_inspection" }); m.step({ type: "request_release" }); m.complete();
      expect(f.real.query("SELECT * FROM accounts").all()).toEqual(before);
      expect(f.real.query("SELECT * FROM wallet_journal").all()).toEqual([]); expect(f.real.query("SELECT * FROM wallet_payments").all()).toEqual([]);
      expect(f.trades.get(f.trade.id)!.evidence).toEqual([]); expect(f.trades.history(f.trade.id).events).toHaveLength(1);
    } finally { f.close(); }
  });
  test("disk reopen preserves pending/unknown operation, snapshot and creation/command idempotency", () => {
    const dir = mkdtempSync(join(tmpdir(), "cashloom-tcg-restart-"));
    const f = fixture(); let db: Database | null = null;
    try {
      db = new Database(join(dir, "tcg-sandbox.db"));
      let store = new SimulationStore(db, { now: () => TEST_NOW, id: ids() });
      const request = { idempotencyKey: "disk-start", expectedVersion: 0, tradeId: f.trade.id, revision: 1 };
      const original = store.create(request, f.trade.current, OWNER), m = machine(store, original);
      m.fund(); m.deliver(); m.step({ type: "accept_inspection" }); m.step({ type: "request_release" });
      const pending = m.run;
      db.close(); db = new Database(join(dir, "tcg-sandbox.db")); store = new SimulationStore(db, { now: () => TEST_NOW, id: () => `reopen-${crypto.randomUUID()}` });
      expect(store.get(original.id)).toEqual(pending);
      const lost = { idempotencyKey: "lost", expectedVersion: pending.version, command: { type: "advance_operation", operationId: pending.state.operation!.id, outcome: "unknown" } };
      const unknown = store.command(original.id, lost, OWNER);
      db.close(); db = new Database(join(dir, "tcg-sandbox.db")); store = new SimulationStore(db, { now: () => TEST_NOW, id: () => `reconcile-${crypto.randomUUID()}` });
      expect(store.get(original.id)).toEqual(unknown); expect(store.command(original.id, lost, OWNER)).toEqual(unknown);
      expect(store.create(request, f.trade.current, OWNER)).toEqual(original);
      const competingDb = new Database(join(dir, "tcg-sandbox.db"));
      try {
        const competingStore = new SimulationStore(competingDb, { now: () => TEST_NOW, id: () => `competing-${crypto.randomUUID()}` });
        expect(competingStore.get(original.id)!.version).toBe(unknown.version);
        const result = store.command(original.id, { idempotencyKey: "reconcile", expectedVersion: unknown.version, command: { type: "reconcile_operation", operationId: unknown.state.operation!.id } }, OWNER);
        expect(() => competingStore.command(original.id, { idempotencyKey: "racing-refund", expectedVersion: unknown.version, command: { type: "request_refund" } }, OWNER)).toThrow("record changed");
        expect(result.state.balances.released.atomic as string).toBe("360"); expect(result.state.balances.held.atomic as string).toBe("0");
      } finally { competingDb.close(); }
    } finally { db?.close(); f.close(); rmSync(dir, { recursive: true, force: true }); }
  });
});
