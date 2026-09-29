import { Hono, type Context } from "hono";
import { z } from "zod";
import { createSimulationSchema, createTradeSchema, ownerActorSchema, PUBLIC_ERRORS, recordEvidenceSchema, reviseTradeSchema, simulationIdSchema, TcgError, tradeIdSchema, type OwnerActor, type TcgErrorCode } from "./domain";
import { simulationMutationSchema, type SimulationRun } from "./simulation";
import type { SimulationStore } from "./simulation-store";
import { pageSchema } from "./sqlite";
import type { TradeStore } from "./store";

export const MAX_TCG_BODY_BYTES = 128 * 1024;
export interface TcgRouteOptions {
  trades: TradeStore;
  // false MUST NOT create a database. Only an explicit, validated creation requests true.
  getSimulationStore: (create: boolean) => SimulationStore | null;
  // Caller validates the current session and exact owner scope; this factory checks owner again.
  getActor: (context: Context) => OwnerActor | null;
}
function errorResponse(c: Context, code: TcgErrorCode) {
  const [status, message] = PUBLIC_ERRORS[code];
  c.header("Cache-Control", "private, no-store");
  return c.json({ error: { code, message } }, status);
}
async function boundedJson(c: Context): Promise<unknown> {
  if (!/^application\/json(?:\s*;|$)/i.test(c.req.header("content-type") ?? "")) throw new TcgError("INVALID_REQUEST");
  const length = c.req.header("content-length");
  if (length && (!/^[0-9]+$/.test(length) || Number(length) > MAX_TCG_BODY_BYTES)) throw new TcgError("BODY_TOO_LARGE");
  const reader = c.req.raw.body?.getReader();
  if (!reader) throw new TcgError("INVALID_REQUEST");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      size += result.value.byteLength;
      if (size > MAX_TCG_BODY_BYTES) { await reader.cancel(); throw new TcgError("BODY_TOO_LARGE"); }
      chunks.push(result.value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
  catch { throw new TcgError("INVALID_REQUEST"); }
}
function page(c: Context) {
  const query = c.req.query();
  if (Object.keys(query).some((key) => key !== "after" && key !== "limit")) throw new TcgError("INVALID_REQUEST");
  for (const value of Object.values(query)) if (!/^(?:0|[1-9][0-9]*)$/.test(value)) throw new TcgError("INVALID_REQUEST");
  return pageSchema.parse({ ...(query.after === undefined ? {} : { after: Number(query.after) }), ...(query.limit === undefined ? {} : { limit: Number(query.limit) }) });
}
export function createTcgRoutes(options: TcgRouteOptions): Hono {
  const app = new Hono();
  const actor = (c: Context) => {
    const candidate = options.getActor(c);
    if (!candidate) throw new TcgError("UNAUTHORIZED");
    const parsed = ownerActorSchema.safeParse(candidate);
    if (!parsed.success) throw new TcgError("FORBIDDEN");
    return parsed.data;
  };
  const present = (run: SimulationRun): SimulationRun => {
    const source = options.trades.get(run.snapshot.tradeId);
    return { ...run, sourceCurrentRevision: source?.currentRevision ?? null, staleRevision: source ? source.currentRevision !== run.snapshot.revision || source.current.hash !== run.snapshot.hash : true };
  };
  const sandbox = () => {
    const store = options.getSimulationStore(false);
    if (!store) throw new TcgError("NOT_FOUND");
    return store;
  };
  app.use("*", async (c, next) => {
    c.header("Cache-Control", "private, no-store");
    actor(c);
    await next();
  });
  app.onError((error, c) => errorResponse(c, error instanceof TcgError ? error.code : error instanceof z.ZodError ? "INVALID_REQUEST" : "INTERNAL_ERROR"));
  app.notFound((c) => errorResponse(c, "NOT_FOUND"));
  app.get("/trades", (c) => c.json(options.trades.listPage(page(c))));
  app.post("/trades", async (c) => {
    const request = createTradeSchema.parse(await boundedJson(c));
    return c.json({ trade: options.trades.create(request, actor(c)) });
  });
  app.get("/trades/:id", (c) => {
    const trade = options.trades.get(tradeIdSchema.parse(c.req.param("id")));
    if (!trade) throw new TcgError("NOT_FOUND");
    return c.json({ trade });
  });
  app.post("/trades/:id/revisions", async (c) => {
    const id = tradeIdSchema.parse(c.req.param("id")), request = reviseTradeSchema.parse(await boundedJson(c));
    return c.json({ trade: options.trades.revise(id, request, actor(c)) });
  });
  app.post("/trades/:id/evidence", async (c) => {
    const id = tradeIdSchema.parse(c.req.param("id")), request = recordEvidenceSchema.parse(await boundedJson(c));
    return c.json({ trade: options.trades.recordEvidence(id, request, actor(c)) });
  });
  app.get("/trades/:id/history", (c) => c.json(options.trades.history(tradeIdSchema.parse(c.req.param("id")), page(c))));
  app.get("/simulations", (c) => {
    const pagination = page(c);
    const result = options.getSimulationStore(false)?.listPage(pagination);
    return c.json({ simulations: result?.simulations.map(present) ?? [], nextCursor: result?.nextCursor ?? null });
  });
  app.post("/simulations", async (c) => {
    const request = createSimulationSchema.parse(await boundedJson(c));
    const authenticated = actor(c);
    const revision = options.trades.revision(request.tradeId, request.revision);
    if (!revision) throw new TcgError("NOT_FOUND");
    const store = options.getSimulationStore(true);
    if (!store) throw new TcgError("INTERNAL_ERROR");
    return c.json({ simulation: present(store.create(request, revision, authenticated)) });
  });
  app.get("/simulations/:id", (c) => {
    const id = simulationIdSchema.parse(c.req.param("id"));
    const run = sandbox().get(id);
    if (!run) throw new TcgError("NOT_FOUND");
    return c.json({ simulation: present(run) });
  });
  app.get("/simulations/:id/history", (c) => c.json(sandbox().history(simulationIdSchema.parse(c.req.param("id")), page(c))));
  app.post("/simulations/:id/commands", async (c) => {
    const id = simulationIdSchema.parse(c.req.param("id")), request = simulationMutationSchema.parse(await boundedJson(c));
    const authenticated = actor(c);
    return c.json({ simulation: present(sandbox().command(id, request, authenticated)) });
  });
  return app;
}
