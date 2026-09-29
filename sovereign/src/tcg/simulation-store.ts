import type { Database } from "bun:sqlite";
import type { z } from "zod";
import { canonicalTimestampSchema } from "../wallet/domain/intent";
import { fingerprint, validateRevision } from "./agreement";
import { agreementSnapshotSchema, createSimulationSchema, localIdSchema, ownerActorSchema, simulationIdSchema, SIMULATION_NOTICE, TcgError, type ActivityEvent, type AgreementRevision, type EventPage, type OwnerActor, type SimulationId, type StoreOptions } from "./domain";
import { assertSandboxDatabase, installSimulationSchema } from "./schema";
import { applySimulationCommand, assertConservation, commandRole, initialSimulationState, permittedActions, simulationMutationSchema, simulationStateSchema, type SimulationRun, type SimulationState } from "./simulation";
import { pageSchema, readHistory, readListKeys, requestReplay, saveReplay } from "./sqlite";

/** An injected, sandbox-only connection. This module never opens files or sees the real trade store. */
export class SimulationStore {
  private readonly now: () => string;
  private readonly id: () => string;
  constructor(private readonly db: Database, options: StoreOptions = {}) {
    installSimulationSchema(db);
    this.now = options.now ?? (() => new Date().toISOString());
    this.id = options.id ?? (() => crypto.randomUUID());
  }
  private timestamp(): string { return canonicalTimestampSchema.parse(this.now()); }
  private newId(prefix: string): string { return localIdSchema.parse(`${prefix}_${this.id()}`); }
  private guard(): void { assertSandboxDatabase(this.db); }
  list(): SimulationRun[] { return this.listPage({ limit: 100 }).simulations; }
  listPage(page: z.input<typeof pageSchema> = {}): { simulations: SimulationRun[]; nextCursor: number | null } {
    this.guard();
    const result = readListKeys(this.db, "tcg_sim_runs", page);
    return { simulations: result.ids.map((id) => this.get(id)!), nextCursor: result.nextCursor };
  }
  get(idInput: string): SimulationRun | null {
    this.guard();
    const id = simulationIdSchema.parse(idInput);
    const row = this.db.query("SELECT * FROM tcg_sim_runs WHERE id=?").get(id) as { id: SimulationId; version: number; snapshot_json: string; state_json: string; actor_json: string; created_at: string; updated_at: string } | null;
    if (!row) return null;
    const snapshot = agreementSnapshotSchema.parse(JSON.parse(row.snapshot_json));
    validateRevision({ ...snapshot, mode: "record", claims: "owner_reported", actor: ownerActorSchema.parse(JSON.parse(row.actor_json)), recordedAt: row.created_at });
    const state = simulationStateSchema.parse(JSON.parse(row.state_json));
    assertConservation(state, snapshot.totals.total);
    return {
      mode: "simulation", id, version: row.version, notice: SIMULATION_NOTICE, protection: "unavailable", snapshot, state,
      permittedActions: permittedActions({ snapshot, state }, this.timestamp()), sourceCurrentRevision: null, staleRevision: false,
      createdAt: row.created_at, updatedAt: row.updated_at, actor: ownerActorSchema.parse(JSON.parse(row.actor_json)),
    };
  }
  history(id: string, page: z.input<typeof pageSchema> = {}): EventPage {
    if (!this.get(id)) throw new TcgError("NOT_FOUND");
    return readHistory(this.db, "tcg_sim_events", id, page);
  }
  private event(run: SimulationRun, type: string, data: Record<string, unknown>, now: string, actor: OwnerActor): void {
    const event: ActivityEvent = { mode: "simulation", id: this.newId("sim_event"), subjectId: run.id, sequence: run.version, revision: run.snapshot.revision, agreementHash: run.snapshot.hash, type, actor, recordedAt: now, data };
    this.db.query("INSERT INTO tcg_sim_events(id,subject_id,sequence,json) VALUES (?,?,?,?)").run(event.id, run.id, run.version, JSON.stringify(event));
  }
  create(input: unknown, revisionInput: AgreementRevision, actorInput: OwnerActor): SimulationRun {
    this.guard();
    const request = createSimulationSchema.parse(input), actor = ownerActorSchema.parse(actorInput), revision = validateRevision(revisionInput);
    if (request.tradeId !== revision.tradeId || request.revision !== revision.revision) throw new TcgError("INVALID_REQUEST");
    const hash = fingerprint("cashloom.tcg.simulation-request/1", { action: "create", request, agreementHash: revision.hash, actor });
    return this.db.transaction(() => {
      const replay = requestReplay<SimulationRun>(this.db, "tcg_sim_requests", request.idempotencyKey, hash);
      if (replay) return replay;
      const id = simulationIdSchema.parse(this.newId("sim")), now = this.timestamp();
      const snapshot: SimulationRun["snapshot"] = { tradeId: revision.tradeId, revision: revision.revision, hash: revision.hash, terms: revision.terms, totals: revision.totals };
      const state = initialSimulationState(revision);
      this.db.query("INSERT INTO tcg_sim_runs(id,version,snapshot_json,state_json,actor_json,created_at,updated_at) VALUES (?,1,?,?,?,?,?)").run(id, JSON.stringify(snapshot), JSON.stringify(state), JSON.stringify(actor), now, now);
      const result = this.get(id)!;
      this.event(result, "simulation_created", { source: "immutable_owner_record_copy" }, now, actor);
      saveReplay(this.db, "tcg_sim_requests", request.idempotencyKey, hash, result);
      return result;
    }).immediate();
  }
  command(idInput: string, input: unknown, actorInput: OwnerActor): SimulationRun {
    this.guard();
    const id = simulationIdSchema.parse(idInput), request = simulationMutationSchema.parse(input), actor = ownerActorSchema.parse(actorInput);
    const hash = fingerprint("cashloom.tcg.simulation-request/1", { action: "command", id, request, actor });
    return this.db.transaction(() => {
      const replay = requestReplay<SimulationRun>(this.db, "tcg_sim_requests", request.idempotencyKey, hash);
      if (replay) return replay;
      const old = this.get(id);
      if (!old) throw new TcgError("NOT_FOUND");
      if (old.version !== request.expectedVersion) throw new TcgError("VERSION_CONFLICT");
      const now = this.timestamp();
      const state = applySimulationCommand(old, request.command, now, () => this.newId("sim_op"));
      const updated = this.db.query("UPDATE tcg_sim_runs SET version=version+1,state_json=?,updated_at=? WHERE id=? AND version=?").run(JSON.stringify(state), now, id, old.version);
      if (updated.changes !== 1) throw new TcgError("VERSION_CONFLICT");
      const result = this.get(id)!;
      this.event(result, request.command.type, { command: request.command, simulatedRole: commandRole(request.command), operation: state.operation }, now, actor);
      saveReplay(this.db, "tcg_sim_requests", request.idempotencyKey, hash, result);
      return result;
    }).immediate();
  }
}
