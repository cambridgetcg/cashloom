import type { Database } from "bun:sqlite";
import { z } from "zod";
import { TcgError, type ActivityEvent, type EventPage } from "./domain";

// Shared SQL mechanics only. No connection, filesystem, wallet or sandbox is opened here.
export const pageSchema = z.object({ after: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).default(0), limit: z.number().int().min(1).max(100).default(50) }).strict();
export function requestReplay<T>(db: Database, table: "tcg_requests" | "tcg_sim_requests", key: string, hash: string): T | undefined {
  const row = db.query(`SELECT fingerprint,response_json FROM ${table} WHERE key=?`).get(key) as { fingerprint: string; response_json: string } | null;
  if (!row) return undefined;
  if (row.fingerprint !== hash) throw new TcgError("IDEMPOTENCY_CONFLICT");
  return JSON.parse(row.response_json) as T;
}
export function saveReplay(db: Database, table: "tcg_requests" | "tcg_sim_requests", key: string, hash: string, result: unknown): void {
  db.query(`INSERT INTO ${table}(key,fingerprint,response_json) VALUES (?,?,?)`).run(key, hash, JSON.stringify(result));
}
// List cursors are immutable insertion rowids, newest first. Zero starts a fresh listing.
export function readListKeys(db: Database, table: "tcg_trades" | "tcg_sim_runs", input: z.input<typeof pageSchema> = {}): { ids: string[]; nextCursor: number | null } {
  const page = pageSchema.parse(input);
  const rows = db.query(`SELECT id,rowid AS cursor FROM ${table} WHERE (?=0 OR rowid<?) ORDER BY rowid DESC LIMIT ?`).all(page.after, page.after, page.limit + 1) as Array<{ id: string; cursor: number }>;
  const visible = rows.slice(0, page.limit);
  return { ids: visible.map((row) => row.id), nextCursor: rows.length > page.limit ? visible.at(-1)!.cursor : null };
}
export function readHistory(db: Database, table: "tcg_events" | "tcg_sim_events", subjectId: string, input: z.input<typeof pageSchema> = {}): EventPage {
  const page = pageSchema.parse(input);
  const rows = db.query(`SELECT json FROM ${table} WHERE subject_id=? AND sequence>? ORDER BY sequence LIMIT ?`).all(subjectId, page.after, page.limit + 1) as Array<{ json: string }>;
  const events = rows.slice(0, page.limit).map((r) => JSON.parse(r.json) as ActivityEvent);
  return { events, nextCursor: rows.length > page.limit ? events.at(-1)!.sequence : null };
}
