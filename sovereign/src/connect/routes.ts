import { Hono, type Context } from "hono";
import type { Database } from "bun:sqlite";
import { z } from "zod";
import { ImportError, prepareActivityImport } from "./import-export";
import { PlaidError } from "./plaid-http";
import {
  applyImportedRows, getReadConnections, getTransferCandidates, getTransferLinks,
  linkInternalTransfer, unlinkInternalTransfer, ReadModelError,
} from "./read-model";

/** The outer local API must authenticate reads and apply its scope map.
 * This router additionally checks owner authority before every mutation. */
export interface ConnectRouteOptions {
  db: Database;
  canManage(context: Context): boolean;
  sessionToken(context: Context): string;
  plaid: {
    status(): unknown;
    createLink(session: string): Promise<unknown>;
    exchange(session: string, body: { attempt_id: string; public_token: string }): Promise<unknown>;
    sync(session: string, id: string): Promise<unknown>;
    disconnect(session: string, id: string): Promise<unknown>;
  };
}

class RouteError extends Error {
  constructor(readonly code: string, message: string, readonly status: 400 | 403 | 404 | 409 | 413 | 422) { super(message); }
}
const uuid = z.string().uuid();
const importSchema = z.object({
  account_id: uuid, csv: z.string().max(1_000_000),
  distinct_rows: z.array(z.object({ row_id: z.string().regex(/^csv:[a-f0-9]{64}:[1-9][0-9]{0,3}$/), reference: z.string().max(120) }).strict()).max(2_000).optional(),
}).strict();
const importCommitSchema = importSchema.extend({ preview_hash: z.string().regex(/^[a-f0-9]{64}$/) }).strict();

async function jsonBody(c: Context, maximum = 32_768): Promise<unknown> {
  if (!/^application\/json(?:\s*;|$)/i.test(c.req.header("content-type") ?? "")) {
    throw new RouteError("invalid_request", "Send a JSON request.", 400);
  }
  const reader = c.req.raw.body?.getReader();
  if (!reader) throw new RouteError("invalid_request", "A request body is required.", 400);
  const chunks: Uint8Array[] = []; let size = 0;
  try {
    for (;;) {
      const part = await reader.read(); if (part.done) break;
      size += part.value.byteLength;
      if (size > maximum) { await reader.cancel(); throw new RouteError("body_too_large", "The request is too large.", 413); }
      chunks.push(part.value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
  catch { throw new RouteError("invalid_request", "The request is not valid JSON.", 400); }
}

export function createConnectRoutes(options: ConnectRouteOptions): Hono {
  const app = new Hono();
  const { db } = options;
  const owner = (c: Context) => {
    if (!options.canManage(c)) throw new RouteError("owner_required", "An owner session with account-management access is required.", 403);
    return options.sessionToken(c);
  };
  const importAccount = (id: string) => {
    const account = db.query("SELECT id,currency,decimals,status,connector_type,read_connection_id FROM accounts WHERE id=?").get(id) as
      { id: string; currency: string; decimals: number; status: string; connector_type: string | null; read_connection_id: string | null } | null;
    if (!account) throw new RouteError("account_not_found", "Choose an existing account.", 404);
    if (account.status !== "ACTIVE") throw new RouteError("account_not_active", "Choose an active account before importing entries.", 409);
    if (account.connector_type || account.read_connection_id) throw new RouteError("import_requires_manual_account", "Choose a manual account. Statement imports cannot be matched safely against connected provider records yet.", 409);
    return account;
  };
  const reviewedImport = (body: z.infer<typeof importSchema>) => {
    const preview = prepareActivityImport(importAccount(body.account_id), body.csv, body.distinct_rows);
    const existing = db.query("SELECT source,title,amount_minor,date FROM transactions WHERE account_id=? AND external_id=?");
    type SavedImport = { source: string; title: string; amount_minor: string; date: string };
    const rows = preview.rows.map((row) => {
      const matched = existing.get(body.account_id, row.row_id) as SavedImport | null;
      const target = row.distinct_reference === null ? matched : existing.get(body.account_id, row.external_id) as SavedImport | null;
      if (matched && matched.source !== "CSV" || target && target.source !== "CSV") {
        throw new RouteError("import_identifier_conflict", "An import identifier conflicts with a non-imported record.", 409);
      }
      if (row.distinct_reference !== null) {
        if (!matched) throw new RouteError("import_match_changed", "A separate entry must match a previously imported entry. Preview the file again.", 409);
        if (target && (target.title !== row.title || target.amount_minor !== row.amount_minor || target.date !== row.date)) {
          throw new RouteError("import_reference_conflict", "This reference already belongs to an entry with a different date, title or amount. Check the statement and use the correct reference.", 409);
        }
      }
      return { ...row, matched_existing: !!matched, already_recorded: !!target };
    });
    // Saved-state annotations do not enter the review hash: a retry after a
    // successful import must still be accepted and report the actual skips.
    return { ...preview, rows, duplicate_count: rows.filter((row) => row.already_recorded).length };
  };
  app.onError((error, c) => {
    c.header("Cache-Control", "private, no-store");
    if (error instanceof RouteError) return c.json({ error: error.code, message: error.message }, error.status);
    if (error instanceof ImportError) return c.json({ error: "invalid_import", message: error.message }, 422);
    if (error instanceof ReadModelError) return c.json({ error: error.code, message: error.message }, error.status as 400);
    if (error instanceof PlaidError) return c.json({ error: error.code, message: error.message }, error.status as 400);
    if (error instanceof z.ZodError) return c.json({ error: "invalid_request", message: "Check the request fields and try again." }, 400);
    return c.json({ error: "connection_operation_failed", message: "The operation could not complete. Reload the saved records before trying again." }, 500);
  });
  app.get("/connections", (c) => c.json({
    schema_version: "cashloom.connections/1", generated_at: new Date().toISOString(),
    can_manage: options.canManage(c), sources: getReadConnections(db), plaid: options.plaid.status(),
  }));
  app.post("/connections/plaid/link", async (c) => {
    owner(c); z.object({}).strict().parse(await jsonBody(c));
    return c.json(await options.plaid.createLink(owner(c)));
  });
  app.post("/connections/plaid/exchange", async (c) => {
    owner(c);
    const body = z.object({ attempt_id: uuid, public_token: z.string().min(1).max(2048) }).strict().parse(await jsonBody(c));
    return c.json(await options.plaid.exchange(owner(c), body));
  });
  app.post("/connections/plaid/:id/sync", async (c) => {
    owner(c); const id = uuid.parse(c.req.param("id"));
    z.object({}).strict().parse(await jsonBody(c));
    return c.json(await options.plaid.sync(owner(c), id));
  });
  app.post("/connections/plaid/:id/disconnect", async (c) => {
    owner(c); const id = uuid.parse(c.req.param("id"));
    z.object({}).strict().parse(await jsonBody(c));
    return c.json(await options.plaid.disconnect(owner(c), id));
  });
  app.get("/transfers", (c) => c.json({
    can_manage: options.canManage(c), candidates: getTransferCandidates(db), links: getTransferLinks(db),
  }));
  app.post("/transfers/link", async (c) => {
    owner(c);
    const body = z.object({ outgoing_id: uuid, incoming_id: uuid }).strict().parse(await jsonBody(c));
    owner(c);
    return c.json({ link: linkInternalTransfer(db, { outgoingId: body.outgoing_id, incomingId: body.incoming_id }) });
  });
  app.post("/transfers/:id/unlink", async (c) => {
    owner(c); const id = uuid.parse(c.req.param("id"));
    z.object({}).strict().parse(await jsonBody(c)); owner(c);
    unlinkInternalTransfer(db, id);
    return c.json({ ok: true });
  });
  app.post("/transactions/import/preview", async (c) => {
    owner(c); const body = importSchema.parse(await jsonBody(c, 2_000_000)); owner(c);
    return c.json(db.transaction(() => reviewedImport(body))());
  });
  app.post("/transactions/import", async (c) => {
    owner(c); const body = importCommitSchema.parse(await jsonBody(c, 2_000_000)); owner(c);
    const result = db.transaction(() => {
      const preview = reviewedImport(body);
      if (preview.preview_hash !== body.preview_hash) throw new RouteError("import_review_changed", "The file, destination or separate-entry references changed. Preview the import again.", 409);
      return applyImportedRows(db, {
        accountId: body.account_id,
        rows: preview.rows.map((row) => ({ externalId: row.external_id, title: row.title, amountMinor: row.amount_minor,
          currency: row.currency, date: new Date(row.date), category: row.category ?? undefined })),
      });
    }).immediate();
    return c.json({ account_id: body.account_id, ...result });
  });
  app.get("/transactions/export", (c) => {
    const selected = c.req.query("accountId");
    const accountId = selected === undefined ? null : uuid.parse(selected);
    // Explicit allowlists exclude provider payloads, account identifiers,
    // credential references, encrypted tokens and vault signing material.
    const accounts = db.query(`SELECT id,display_name,rail,currency,decimals,balance_minor,balance_as_of,
      available_minor,pending_minor,held_minor,balance_kind,account_type,read_environment,status
      FROM accounts WHERE (? IS NULL OR id=?) ORDER BY created_at`).all(accountId, accountId);
    const rows = db.query(`SELECT id,account_id,title,amount_minor,date,category,source,status,
      gross_minor,fee_minor,net_minor,transfer_link_id FROM transactions
      WHERE (? IS NULL OR account_id=?) ORDER BY date,id LIMIT 10001`).all(accountId, accountId);
    if (rows.length > 10_000) throw new RouteError("export_too_large", "This export exceeds 10,000 entries. Select a smaller account; use a local database backup for the full history.", 422);
    return c.json({ schema_version: "cashloom.activity-export/1", generated_at: new Date().toISOString(),
      complete: true, account_id: accountId, accounts, transactions: rows });
  });
  return app;
}
