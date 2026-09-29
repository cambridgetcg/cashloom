import type { Database } from "bun:sqlite";
import { z } from "zod";
import { canonicalTimestampSchema } from "../wallet/domain/intent";
import { fingerprint, makeRevision, validateRevision } from "./agreement";
import { createTradeSchema, localIdSchema, ownerActorSchema, recordEvidenceSchema, RECORD_NOTICE, reviseTradeSchema, TcgError, tradeIdSchema, tradeRecordSchema, type ActivityEvent, type AgreementRevision, type EventPage, type OwnerActor, type StoreOptions, type TradeEvidence, type TradeId, type TradeRecord } from "./domain";
import { installTradeSchema } from "./schema";

import { pageSchema, readHistory, readListKeys, requestReplay, saveReplay } from "./sqlite";

export class TradeStore {
  private readonly now: () => string;
  private readonly id: () => string;
  constructor(private readonly db: Database, options: StoreOptions = {}) {
    installTradeSchema(db);
    this.now = options.now ?? (() => new Date().toISOString());
    this.id = options.id ?? (() => crypto.randomUUID());
  }
  private newId(prefix: string): string { return localIdSchema.parse(`${prefix}_${this.id()}`); }
  private timestamp(): string { return canonicalTimestampSchema.parse(this.now()); }
  list(): TradeRecord[] { return this.listPage({ limit: 100 }).trades; }
  listPage(page: z.input<typeof pageSchema> = {}): { trades: TradeRecord[]; nextCursor: number | null } {
    const result = readListKeys(this.db, "tcg_trades", page);
    return { trades: result.ids.map((id) => this.get(id)!), nextCursor: result.nextCursor };
  }
  get(input: string): TradeRecord | null {
    const id = tradeIdSchema.parse(input);
    const row = this.db.query("SELECT * FROM tcg_trades WHERE id=?").get(id) as { id: TradeId; version: number; current_revision: number; created_at: string; updated_at: string } | null;
    if (!row) return null;
    const revisions = (this.db.query("SELECT json FROM tcg_revisions WHERE trade_id=? ORDER BY revision").all(id) as Array<{ json: string }>).map((r) => validateRevision(JSON.parse(r.json) as AgreementRevision));
    const evidence = (this.db.query("SELECT json FROM tcg_evidence WHERE trade_id=? ORDER BY rowid").all(id) as Array<{ json: string }>).map((r) => JSON.parse(r.json) as TradeEvidence);
    return tradeRecordSchema.parse({ mode: "record", id: row.id, version: row.version, currentRevision: row.current_revision, protection: "unavailable", notice: RECORD_NOTICE, current: revisions.find((r) => r.revision === row.current_revision)!, revisions, evidence, createdAt: row.created_at, updatedAt: row.updated_at });
  }
  revision(id: string, revision: number): AgreementRevision | null {
    const trade = this.get(id);
    return trade?.revisions.find((r) => r.revision === revision) ?? null;
  }
  history(id: string, page: z.input<typeof pageSchema> = {}): EventPage {
    if (!this.get(id)) throw new TcgError("NOT_FOUND");
    return readHistory(this.db, "tcg_events", id, page);
  }
  private event(tradeId: TradeId, revision: AgreementRevision, sequence: number, type: string, data: Record<string, unknown>, now: string, actor: OwnerActor): void {
    const event: ActivityEvent = { mode: "record", id: this.newId("event"), subjectId: tradeId, sequence, revision: revision.revision, agreementHash: revision.hash, type, data, recordedAt: now, actor };
    this.db.query("INSERT INTO tcg_events(id,subject_id,sequence,json) VALUES (?,?,?,?)").run(event.id, tradeId, sequence, JSON.stringify(event));
  }
  create(input: unknown, actorInput: OwnerActor): TradeRecord {
    const request = createTradeSchema.parse(input), actor = ownerActorSchema.parse(actorInput);
    const hash = fingerprint("cashloom.tcg.record-request/1", { action: "create", request, actor });
    return this.db.transaction(() => {
      const replay = requestReplay<TradeRecord>(this.db, "tcg_requests", request.idempotencyKey, hash);
      if (replay) return replay;
      const id = tradeIdSchema.parse(this.newId("trade")), now = this.timestamp();
      const revision = makeRevision(id, 1, request.terms, now, actor);
      this.db.query("INSERT INTO tcg_trades(id,version,current_revision,created_at,updated_at) VALUES (?,1,1,?,?)").run(id, now, now);
      this.db.query("INSERT INTO tcg_revisions(trade_id,revision,hash,json) VALUES (?,1,?,?)").run(id, revision.hash, JSON.stringify(revision));
      this.event(id, revision, 1, "trade_created", {}, now, actor);
      const result = this.get(id)!;
      saveReplay(this.db, "tcg_requests", request.idempotencyKey, hash, result);
      return result;
    }).immediate();
  }
  revise(idInput: string, input: unknown, actorInput: OwnerActor): TradeRecord {
    const id = tradeIdSchema.parse(idInput), request = reviseTradeSchema.parse(input), actor = ownerActorSchema.parse(actorInput);
    const hash = fingerprint("cashloom.tcg.record-request/1", { action: "revise", id, request, actor });
    return this.db.transaction(() => {
      const replay = requestReplay<TradeRecord>(this.db, "tcg_requests", request.idempotencyKey, hash);
      if (replay) return replay;
      const old = this.get(id);
      if (!old) throw new TcgError("NOT_FOUND");
      if (old.version !== request.expectedVersion) throw new TcgError("VERSION_CONFLICT");
      const now = this.timestamp(), revision = makeRevision(id, old.currentRevision + 1, request.terms, now, actor);
      this.bump(id, old.version, revision.revision, now);
      this.db.query("INSERT INTO tcg_revisions(trade_id,revision,hash,json) VALUES (?,?,?,?)").run(id, revision.revision, revision.hash, JSON.stringify(revision));
      this.event(id, revision, old.version + 1, "revision_created", { previousRevision: old.currentRevision }, now, actor);
      const result = this.get(id)!;
      saveReplay(this.db, "tcg_requests", request.idempotencyKey, hash, result);
      return result;
    }).immediate();
  }
  recordEvidence(idInput: string, input: unknown, actorInput: OwnerActor): TradeRecord {
    const id = tradeIdSchema.parse(idInput), request = recordEvidenceSchema.parse(input), actor = ownerActorSchema.parse(actorInput);
    const hash = fingerprint("cashloom.tcg.record-request/1", { action: "evidence", id, request, actor });
    return this.db.transaction(() => {
      const replay = requestReplay<TradeRecord>(this.db, "tcg_requests", request.idempotencyKey, hash);
      if (replay) return replay;
      const old = this.get(id);
      if (!old) throw new TcgError("NOT_FOUND");
      if (old.version !== request.expectedVersion) throw new TcgError("VERSION_CONFLICT");
      const revision = old.revisions.find((r) => r.revision === request.revision);
      if (!revision) throw new TcgError("NOT_FOUND");
      if (request.evidence.correctsEvidenceId && !old.evidence.some((e) => e.id === request.evidence.correctsEvidenceId && e.revision === revision.revision)) throw new TcgError("INVALID_REQUEST");
      const now = this.timestamp();
      const evidence: TradeEvidence = { ...request.evidence, mode: "record", id: this.newId("evidence"), tradeId: id, revision: revision.revision, agreementHash: revision.hash, provenance: "owner_reported", recordedAt: now, actor };
      this.bump(id, old.version, old.currentRevision, now);
      this.db.query("INSERT INTO tcg_evidence(id,trade_id,revision,json) VALUES (?,?,?,?)").run(evidence.id, id, revision.revision, JSON.stringify(evidence));
      this.event(id, revision, old.version + 1, "evidence_recorded", { evidenceId: evidence.id, kind: evidence.kind, provenance: "owner_reported" }, now, actor);
      const result = this.get(id)!;
      saveReplay(this.db, "tcg_requests", request.idempotencyKey, hash, result);
      return result;
    }).immediate();
  }
  private bump(id: string, version: number, revision: number, now: string): void {
    const updated = this.db.query("UPDATE tcg_trades SET version=version+1,current_revision=?,updated_at=? WHERE id=? AND version=?").run(revision, now, id, version);
    if (updated.changes !== 1) throw new TcgError("VERSION_CONFLICT");
  }
}
