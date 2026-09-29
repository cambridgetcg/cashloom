import { Hono, type Context } from "hono";
import { z } from "zod";
import type { Database } from "bun:sqlite";
import type { AssistAccess, AssistAccessCreated, AssistAccessInput } from "./contracts";
import type { VaultSessionInfo, VaultSessionScope } from "../vault";
import { AssistError } from "./errors";
import { AssistStore } from "./store";
import { accessInputSchema, proposalInputSchema } from "./validation";

interface AssistAuthority {
  isValidSession(token: string | undefined, scope?: VaultSessionScope): boolean;
  getSessionInfo(token: string | undefined): VaultSessionInfo | null;
  createAssistAccess(token: string, input: AssistAccessInput): AssistAccessCreated;
  listAssistAccess(token: string): AssistAccess[];
  revokeAssistAccess(token: string, id: string): boolean;
  getAssistAccess(token: string | undefined, scope?: "assist:read" | "assist:propose"): AssistAccess;
}
const idSchema = z.string().uuid();
async function body(c: Context): Promise<unknown> {
  if (!/^application\/json(?:\s*;|$)/i.test(c.req.header("content-type") ?? "")) throw new AssistError("assist_invalid_request", "Send a JSON request.", 400);
  const reader = c.req.raw.body?.getReader();
  if (!reader) throw new AssistError("assist_invalid_request", "A JSON request body is required.", 400);
  const chunks: Uint8Array[] = []; let size = 0;
  try {
    for (;;) {
      const part = await reader.read(); if (part.done) break;
      size += part.value.byteLength;
      if (size > 16_384) { await reader.cancel(); throw new AssistError("assist_body_too_large", "The request must be no larger than 16 KB.", 413); }
      chunks.push(part.value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
  catch { throw new AssistError("assist_invalid_request", "Send valid UTF-8 JSON.", 400); }
}

export function createAssistRoutes(options: { db: Database; authority: AssistAuthority }): Hono {
  const { authority } = options;
  const store = new AssistStore(options.db);
  const app = new Hono();
  const token = (c: Context) => c.req.header("Authorization")?.replace(/^Bearer\s+/i, "") ?? "";
  const owner = (c: Context, scope: VaultSessionScope) => {
    if (!authority.isValidSession(token(c), scope) || authority.getSessionInfo(token(c))?.principal.kind !== "owner") {
      throw new AssistError("assist_owner_required", "An owner session with the required permission is needed.", 403);
    }
    return token(c);
  };
  app.use("*", async (c, next) => { c.header("Cache-Control", "private, no-store"); await next(); });
  app.onError((error, c) => {
    if (error instanceof AssistError) return c.json({ error: error.code, message: error.message }, error.status);
    if (error instanceof z.ZodError) return c.json({ error: "assist_invalid_request", message: "Check the request fields and try again." }, 400);
    return c.json({ error: "assist_operation_failed", message: "The operation could not complete. Reload saved suggestions before trying again." }, 500);
  });
  app.get("/access", (c) => {
    z.object({}).strict().parse(c.req.query());
    return c.json({ access: authority.listAssistAccess(owner(c, "keys:manage")) });
  });
  app.post("/access", async (c) => {
    owner(c, "keys:manage"); owner(c, "accounts:read");
    const input = accessInputSchema.parse(await body(c));
    owner(c, "accounts:read");
    return c.json(authority.createAssistAccess(owner(c, "keys:manage"), input), 201);
  });
  app.post("/access/:id/revoke", async (c) => {
    owner(c, "keys:manage"); const id = idSchema.parse(c.req.param("id"));
    z.object({}).strict().parse(await body(c));
    return c.json({ ok: true, revoked: authority.revokeAssistAccess(owner(c, "keys:manage"), id) });
  });
  app.get("/context", (c) => {
    const query = z.object({ account_id: idSchema.optional(), limit: z.string().regex(/^[1-9][0-9]{0,2}$/).transform(Number).pipe(z.number().max(100)).optional() }).strict().parse(c.req.query());
    return c.json(store.context(authority.getAssistAccess(token(c)), query.limit, query.account_id));
  });
  app.get("/proposals", (c) => {
    z.object({}).strict().parse(c.req.query());
    return c.json(store.list(authority.getAssistAccess(token(c)).id));
  });
  app.get("/review", (c) => {
    z.object({}).strict().parse(c.req.query());
    owner(c, "accounts:read"); return c.json(store.list());
  });
  app.post("/proposals", async (c) => {
    authority.getAssistAccess(token(c), "assist:propose");
    const input = proposalInputSchema.parse(await body(c));
    return c.json(store.propose(input, () => authority.getAssistAccess(token(c), "assist:propose")), 201);
  });
  app.post("/proposals/:id/accept", async (c) => {
    owner(c, "accounts:write"); const id = idSchema.parse(c.req.param("id"));
    const input = z.object({ expected_record_version: z.string().regex(/^sha256:[a-f0-9]{64}$/) }).strict().parse(await body(c));
    return c.json(store.decide(id, "accept", input.expected_record_version, () => { owner(c, "accounts:write"); }));
  });
  app.post("/proposals/:id/reject", async (c) => {
    owner(c, "accounts:write"); const id = idSchema.parse(c.req.param("id"));
    z.object({}).strict().parse(await body(c));
    return c.json(store.decide(id, "reject", undefined, () => { owner(c, "accounts:write"); }));
  });
  return app;
}
