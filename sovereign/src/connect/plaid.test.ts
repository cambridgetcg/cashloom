import { afterEach, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { createPlaidSandboxService, installPlaidSchema, plaidAccounts, plaidUsdMinor } from "./plaid.ts";
import { createPlaidHttp, PlaidError } from "./plaid-http.ts";
import { installConnectSchema } from "./schema.ts";
import { getReadSyncState, setReadConnectionStatus } from "./read-model.ts";

// Every provider reply and credential below is synthetic. No live network, vault,
// provider account or user database is opened by this suite.
const TIME = "2026-09-29T12:00:00.000Z";
const dbs: Database[] = [];
afterEach(() => { for (const db of dbs.splice(0)) db.close(); });
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const account = (patch: Record<string, unknown> = {}) => ({ account_id: "account_test", name: "Synthetic Checking", type: "depository", subtype: "checking", mask: "1234", balances: { current: 123.45, available: null, iso_currency_code: "USD", unofficial_currency_code: null }, ...patch });
const transaction = (id: string, patch: Record<string, unknown> = {}) => ({ transaction_id: id, account_id: "account_test", name: "Synthetic shop", amount: 12.34, date: "2026-09-27", pending: false, pending_transaction_id: null, iso_currency_code: "USD", ...patch });
const delta = (patch: Record<string, unknown> = {}) => ({ added: [], modified: [], removed: [], next_cursor: "cursor_one", has_more: false, ...patch });

async function fixture() {
  const db = new Database(":memory:"); dbs.push(db); db.exec("PRAGMA foreign_keys=ON");
  db.exec(`
    CREATE TABLE accounts(id TEXT PRIMARY KEY,rail TEXT NOT NULL,connector_type TEXT,display_name TEXT NOT NULL,currency TEXT NOT NULL,decimals INTEGER NOT NULL,balance_minor TEXT NOT NULL DEFAULT '0',balance_as_of TEXT,external_account_id TEXT,credential_ref TEXT,vault_key_id TEXT,status TEXT NOT NULL DEFAULT 'ACTIVE',created_at TEXT DEFAULT '2026-09-29');
    CREATE TABLE transactions(id TEXT PRIMARY KEY,account_id TEXT NOT NULL REFERENCES accounts(id),external_id TEXT,title TEXT NOT NULL,amount_minor TEXT NOT NULL,category TEXT,date TEXT NOT NULL,source TEXT NOT NULL DEFAULT 'MANUAL',raw TEXT,created_at TEXT DEFAULT '2026-09-29');
    CREATE UNIQUE INDEX idx_tx_dedupe ON transactions(account_id,external_id) WHERE external_id IS NOT NULL;
  `);
  installConnectSchema(db); installPlaidSchema(db);
  const calls: Array<{ path: string; options: RequestInit; body: Record<string, unknown> }> = [];
  let live = true; let clock = new Date(TIME);
  let handler: (path: string, body: Record<string, unknown>) => Response | Promise<Response> = path => {
    if (path === "/link/token/create") return response({ link_token: "link-sandbox-synthetic", expiration: "2026-09-29T15:00:00.000Z" });
    if (path === "/item/public_token/exchange") return response({ access_token: "access-sandbox-synthetic", item_id: "item_synthetic" });
    if (path === "/accounts/get") return response({ item: { item_id: "item_synthetic" }, accounts: [account()] });
    if (path === "/transactions/sync") return response(delta());
    if (path === "/item/remove") return response({ request_id: "synthetic" });
    throw new Error("Unexpected synthetic request");
  };
  const key = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
  const service = createPlaidSandboxService({ db, now: () => clock, env: { PLAID_CLIENT_ID: "synthetic-client", PLAID_SANDBOX_SECRET: "synthetic-only" },
    assertOwner: session => { if (!live || !["owner-one", "owner-two"].includes(session)) throw new Error("Not owner"); },
    fetch: (async (input: string | URL | Request, options?: RequestInit) => {
      const url = new URL(String(input)); expect(url.origin).toBe("https://sandbox.plaid.com");
      const body = JSON.parse(String(options!.body)); calls.push({ path: url.pathname, options: options!, body });
      return handler(url.pathname, body);
    }) as typeof fetch,
    sealToken: async (binding, token) => {
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const encrypted = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: new TextEncoder().encode(JSON.stringify(binding)) }, key, new TextEncoder().encode(token)));
      return new Uint8Array([...iv, ...encrypted]);
    },
    unsealToken: async (binding, blob) => new TextDecoder().decode(await crypto.subtle.decrypt({ name: "AES-GCM", iv: blob.slice(0, 12), additionalData: new TextEncoder().encode(JSON.stringify(binding)) }, key, blob.slice(12))),
  });
  const connect = async () => { const link = await service.createLink("owner-one"); const result = await service.exchange("owner-one", { attempt_id: link.attempt_id, public_token: "public-sandbox-synthetic" }); return { ...result, link }; };
  return { db, service, calls, connect, handle: (next: typeof handler) => { handler = next; }, lock: () => { live = false; }, advance: () => { clock = new Date(clock.getTime() + 16 * 60_000); } };
}

describe("Plaid sandbox boundaries", () => {
  it("keeps status networkless and excludes token/provider references", async () => {
    const f = await fixture(); expect(f.service.status()).toEqual({ environment: "sandbox", configured: true, items: [] }); expect(f.calls).toHaveLength(0);
    await f.connect();
    const status = JSON.stringify(f.service.status());
    expect(status).not.toContain("access-sandbox"); expect(status).not.toContain("item_synthetic"); expect(status).not.toContain("enc_blob");
    const count = f.calls.length; f.service.status(); expect(f.calls).toHaveLength(count);
    const stored = f.db.query("SELECT enc_blob FROM connect_provider_tokens").get() as { enc_blob: Uint8Array };
    expect(new TextDecoder().decode(stored.enc_blob)).not.toContain("access-sandbox");
  });
  it("uses fixed sandbox endpoints, refuses redirects and asks only for Transactions", async () => {
    const f = await fixture(); const link = await f.service.createLink("owner-one");
    expect(link.environment).toBe("sandbox"); expect(link.expires_at).toBe("2026-09-29T12:15:00.000Z");
    expect(f.calls[0]!.options.redirect).toBe("error"); expect(f.calls[0]!.body.products).toEqual(["transactions"]); expect(f.calls[0]!.body.country_codes).toEqual(["US"]);
    await expect(f.service.exchange("owner-one", { attempt_id: link.attempt_id, public_token: "public-production-synthetic" })).rejects.toMatchObject({ code: "PLAID_INVALID_REQUEST" });
    expect(f.calls).toHaveLength(1);
  });
  it("requires owner authority before network and binds exchange to the creating session", async () => {
    const f = await fixture(); await expect(f.service.createLink("agent")).rejects.toMatchObject({ code: "PLAID_OWNER_REQUIRED" }); expect(f.calls).toHaveLength(0);
    const link = await f.service.createLink("owner-one");
    await expect(f.service.exchange("owner-two", { attempt_id: link.attempt_id, public_token: "public-sandbox-synthetic" })).rejects.toMatchObject({ code: "PLAID_LINK_CONFLICT" }); expect(f.calls).toHaveLength(1);
  });
  it("expires Link attempts and never exchanges their tokens", async () => {
    const f = await fixture(); const link = await f.service.createLink("owner-one"); f.advance();
    await expect(f.service.exchange("owner-one", { attempt_id: link.attempt_id, public_token: "public-sandbox-synthetic" })).rejects.toMatchObject({ code: "PLAID_LINK_EXPIRED" }); expect(f.calls).toHaveLength(1);
  });
  it("replays completed exchange locally and refuses a different public token", async () => {
    const f = await fixture(); const result = await f.connect(); const count = f.calls.length;
    expect(await f.service.exchange("owner-one", { attempt_id: result.link.attempt_id, public_token: "public-sandbox-synthetic" })).toMatchObject({ item_id: result.item_id, replayed: true }); expect(f.calls).toHaveLength(count);
    await expect(f.service.exchange("owner-one", { attempt_id: result.link.attempt_id, public_token: "public-sandbox-other" })).rejects.toMatchObject({ code: "PLAID_LINK_CONFLICT" });
  });
  it("rejects token reuse through a different Link attempt before provider exchange", async () => {
    const f = await fixture(); await f.connect(); const link = await f.service.createLink("owner-one"); const count = f.calls.length;
    await expect(f.service.exchange("owner-one", { attempt_id: link.attempt_id, public_token: "public-sandbox-synthetic" })).rejects.toMatchObject({ code: "PLAID_LINK_CONFLICT" });
    expect(f.calls).toHaveLength(count);
  });
  it("imports server-trusted USD accounts and preserves unknown available balance", async () => {
    const f = await fixture(); await f.connect();
    const saved = f.db.query("SELECT display_name,balance_minor,available_minor,account_type FROM accounts").get();
    expect(saved).toEqual({ display_name: "Synthetic Checking", balance_minor: "12345", available_minor: null, account_type: "checking" });
    expect(plaidAccounts([account({ balances: { current: 1, available: 1, iso_currency_code: "EUR" } })]).accounts).toHaveLength(0);
    expect(plaidAccounts([account({ type: "credit", subtype: "credit card" })]).accounts[0]!.accountType).toBe("credit");
  });
  it("rejects malformed amounts and never truncates sub-cent USD", () => {
    expect(plaidUsdMinor(0.29)).toBe("29"); expect(plaidUsdMinor(-12.34)).toBe("-1234"); expect(plaidUsdMinor(-0)).toBe("0");
    for (const value of [0.001, 1e20, NaN, Infinity, "1.20"]) expect(() => plaidUsdMinor(value)).toThrow(PlaidError);
  });
  it("stores a token before a failed account import and retries without another exchange", async () => {
    const f = await fixture(); let reads = 0;
    f.handle(path => path === "/link/token/create" ? response({ link_token: "link-sandbox-synthetic", expiration: "2026-09-29T15:00:00.000Z" }) : path === "/item/public_token/exchange" ? response({ access_token: "access-sandbox-synthetic", item_id: "item_synthetic" }) : ++reads === 1 ? response({ error_code: "TEMPORARY" }, 500) : response({ item: { item_id: "item_synthetic" }, accounts: [account()] }));
    const link = await f.service.createLink("owner-one");
    await expect(f.service.exchange("owner-one", { attempt_id: link.attempt_id, public_token: "public-sandbox-synthetic" })).rejects.toMatchObject({ code: "PLAID_PROVIDER_UNAVAILABLE" });
    expect(f.service.status().items[0]!.state).toBe("setup_pending");
    expect(await f.service.exchange("owner-one", { attempt_id: link.attempt_id, public_token: "public-sandbox-synthetic" })).toMatchObject({ state: "connected", replayed: true });
    expect(f.calls.filter(call => call.path === "/item/public_token/exchange")).toHaveLength(1);
  });
  it("does not retry an uncertain one-use exchange", async () => {
    const f = await fixture(); const link = await f.service.createLink("owner-one"); f.handle(() => { throw new Error("synthetic secret-bearing network error"); });
    await expect(f.service.exchange("owner-one", { attempt_id: link.attempt_id, public_token: "public-sandbox-synthetic" })).rejects.toMatchObject({ code: "PLAID_PROVIDER_UNAVAILABLE" });
    const count = f.calls.length;
    await expect(f.service.exchange("owner-one", { attempt_id: link.attempt_id, public_token: "public-sandbox-synthetic" })).rejects.toMatchObject({ code: "PLAID_EXCHANGE_UNCERTAIN" }); expect(f.calls).toHaveLength(count);
  });
  it("refuses an exchange response after the owner locks", async () => {
    const f = await fixture(); const link = await f.service.createLink("owner-one"); f.handle(() => { f.lock(); return response({ access_token: "access-sandbox-synthetic", item_id: "item_synthetic" }); });
    await expect(f.service.exchange("owner-one", { attempt_id: link.attempt_id, public_token: "public-sandbox-synthetic" })).rejects.toMatchObject({ code: "PLAID_OWNER_REQUIRED" });
    expect(f.service.status().items).toHaveLength(0); expect(f.db.query("SELECT count(*) n FROM connect_provider_tokens").get()).toEqual({ n: 0 });
  });
});

describe("Plaid atomic sync", () => {
  it("commits all pages together, applies modifications/removals, and replaces pending records", async () => {
    const f = await fixture(); const { item_id } = await f.connect(); let page = 0;
    f.handle(path => {
      if (path === "/accounts/get") return response({ item: { item_id: "item_synthetic" }, accounts: [account()] });
      if (++page === 1) return response(delta({ added: [transaction("pending", { pending: true }), transaction("old")], has_more: true, next_cursor: "page_two" }));
      expect(f.db.query("SELECT count(*) n FROM transactions").get()).toEqual({ n: 0 });
      return response(delta({ added: [transaction("posted", { pending_transaction_id: "pending" })], modified: [transaction("old", { amount: 5 })], removed: [{ transaction_id: "pending" }] }));
    });
    await f.service.sync("owner-one", item_id);
    expect(getReadSyncState(f.db, item_id).cursor).toBe("cursor_one");
    expect(f.db.query("SELECT external_id,amount_minor,status,pending_external_id FROM transactions ORDER BY external_id").all()).toEqual([
      { external_id: "old", amount_minor: "-500", status: "posted", pending_external_id: null },
      { external_id: "posted", amount_minor: "-1234", status: "posted", pending_external_id: "pending" },
    ]);
    expect(f.service.status().items[0]!.last_synced_at).toBe(TIME);
  });
  it("preserves the previous cursor and records when a later page fails", async () => {
    const f = await fixture(); const { item_id } = await f.connect(); const before = getReadSyncState(f.db, item_id); let page = 0;
    f.handle(path => path === "/accounts/get" ? response({ item: { item_id: "item_synthetic" }, accounts: [account()] }) : ++page === 1 ? response(delta({ added: [transaction("first")], next_cursor: "page_two", has_more: true })) : response({ error_code: "TEMPORARY" }, 500));
    await expect(f.service.sync("owner-one", item_id)).rejects.toMatchObject({ code: "PLAID_PROVIDER_UNAVAILABLE" });
    expect(getReadSyncState(f.db, item_id)).toEqual(before); expect(f.db.query("SELECT count(*) n FROM transactions").get()).toEqual({ n: 0 });
  });
  it("restarts a mutation error from the original cursor and discards its partial batch", async () => {
    const f = await fixture(); const { item_id } = await f.connect(); let page = 0;
    f.handle((path, body) => {
      if (path === "/accounts/get") return response({ item: { item_id: "item_synthetic" }, accounts: [account()] });
      page++;
      if (page === 1) return response(delta({ added: [transaction("discarded")], has_more: true, next_cursor: "partial" }));
      if (page === 2) return response({ error_code: "TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION" }, 400);
      expect(body.cursor).toBeUndefined(); return response(delta({ added: [transaction("retained")] }));
    });
    await f.service.sync("owner-one", item_id);
    expect(f.db.query("SELECT external_id FROM transactions").all()).toEqual([{ external_id: "retained" }]);
  });
  it("keeps an initial not-ready empty cursor unknown", async () => {
    const f = await fixture(); const { item_id } = await f.connect();
    f.handle(path => path === "/accounts/get" ? response({ item: { item_id: "item_synthetic" }, accounts: [account()] }) : response(delta({ next_cursor: "" })));
    await f.service.sync("owner-one", item_id); expect(getReadSyncState(f.db, item_id).cursor).toBeNull();
  });
  it("does not commit a fetched batch after lock or local disconnection", async () => {
    const f = await fixture(); const { item_id } = await f.connect();
    f.handle(path => {
      if (path === "/accounts/get") return response({ item: { item_id: "item_synthetic" }, accounts: [account()] });
      f.lock(); return response(delta({ added: [transaction("late")] }));
    });
    await expect(f.service.sync("owner-one", item_id)).rejects.toMatchObject({ code: "PLAID_OWNER_REQUIRED" });
    expect(getReadSyncState(f.db, item_id).cursor).toBeNull(); expect(f.db.query("SELECT count(*) n FROM transactions").get()).toEqual({ n: 0 });
  });
  it("rejects a stale revision even when the provider finishes successfully", async () => {
    const f = await fixture(); const { item_id } = await f.connect();
    f.handle(path => {
      if (path === "/accounts/get") return response({ item: { item_id: "item_synthetic" }, accounts: [account()] });
      setReadConnectionStatus(f.db, item_id, "disconnected"); return response(delta({ added: [transaction("late")] }));
    });
    await expect(f.service.sync("owner-one", item_id)).rejects.toMatchObject({ code: "PLAID_SYNC_CHANGED" });
    expect(getReadSyncState(f.db, item_id).cursor).toBeNull(); expect(f.db.query("SELECT count(*) n FROM transactions").get()).toEqual({ n: 0 });
  });
  it("retains reconnect-required state and stops subsequent reads", async () => {
    const f = await fixture(); const { item_id } = await f.connect(); f.handle(() => response({ error_code: "ITEM_LOGIN_REQUIRED" }, 400));
    await expect(f.service.sync("owner-one", item_id)).rejects.toMatchObject({ code: "PLAID_RECONNECT_REQUIRED" }); const count = f.calls.length;
    await expect(f.service.sync("owner-one", item_id)).rejects.toMatchObject({ code: "PLAID_RECONNECT_REQUIRED" }); expect(f.calls).toHaveLength(count);
  });
  it("does not advance past a lost account permission or changed currency", async () => {
    const f = await fixture(); const { item_id } = await f.connect();
    f.handle(() => response({ item: { item_id: "item_synthetic" }, accounts: [account({ balances: { current: 1, available: 1, iso_currency_code: "EUR" } })] }));
    await expect(f.service.sync("owner-one", item_id)).rejects.toMatchObject({ code: "PLAID_RECONNECT_REQUIRED" });
    expect(getReadSyncState(f.db, item_id).cursor).toBeNull();
    expect(f.db.query("SELECT balance_minor FROM accounts").get()).toEqual({ balance_minor: "12345" });
  });
});

describe("Plaid disconnect and safe transport", () => {
  it("disables locally before remote removal, retains records, and reports unsuccessful revocation", async () => {
    const f = await fixture(); const { item_id } = await f.connect();
    f.handle(path => { expect(path).toBe("/item/remove"); expect(getReadSyncState(f.db, item_id).status).toBe("disconnected"); return response({ error_message: "synthetic confidential text" }, 500); });
    expect(await f.service.disconnect("owner-one", item_id)).toMatchObject({ local_disabled: true, provider_revoked: false, state: "disconnect_pending" });
    expect(f.db.query("SELECT count(*) n FROM accounts").get()).toEqual({ n: 1 });
    const count = f.calls.length; await expect(f.service.sync("owner-one", item_id)).rejects.toMatchObject({ code: "PLAID_ITEM_DISABLED" }); expect(f.calls).toHaveLength(count);
    f.handle(() => response({ request_id: "synthetic" }));
    expect(await f.service.disconnect("owner-one", item_id)).toMatchObject({ provider_revoked: true, state: "disconnected" });
    expect(f.db.query("SELECT count(*) n FROM connect_provider_tokens").get()).toEqual({ n: 0 });
    const done = f.calls.length; await f.service.disconnect("owner-one", item_id); expect(f.calls).toHaveLength(done);
  });
  it("disconnecting during sync prevents the in-flight batch from restoring access or changing records", async () => {
    const f = await fixture(); const { item_id } = await f.connect();
    let begin!: () => void; const begun = new Promise<void>(resolve => { begin = resolve; });
    let finish!: (value: Response) => void; const deferred = new Promise<Response>(resolve => { finish = resolve; });
    f.handle(path => {
      if (path === "/accounts/get") return response({ item: { item_id: "item_synthetic" }, accounts: [account()] });
      if (path === "/item/remove") return response({ request_id: "synthetic" });
      begin(); return deferred;
    });
    const pending = f.service.sync("owner-one", item_id).then(value => value, error => error);
    await begun; await f.service.disconnect("owner-one", item_id); finish(response(delta({ added: [transaction("late")] })));
    expect(await pending).toMatchObject({ code: "PLAID_ITEM_DISABLED" });
    expect(getReadSyncState(f.db, item_id)).toMatchObject({ status: "disconnected", cursor: null });
    expect(f.service.status().items[0]!.state).toBe("disconnected");
    expect(f.db.query("SELECT count(*) n FROM transactions").get()).toEqual({ n: 0 });
  });
  it("never includes upstream errors in exceptions and rejects missing configuration", async () => {
    let calls = 0;
    const http = createPlaidHttp({ env: {}, fetch: (async () => { calls++; return response({}); }) as unknown as typeof fetch });
    await expect(http.post("/accounts/get", {})).rejects.toMatchObject({ code: "PLAID_NOT_CONFIGURED" }); expect(calls).toBe(0);
    const errorHttp = createPlaidHttp({ env: { PLAID_CLIENT_ID: "synthetic-client", PLAID_SANDBOX_SECRET: "synthetic-only" }, fetch: (async () => response({ error_message: "private-provider-content" }, 400)) as unknown as typeof fetch });
    try { await errorHttp.post("/accounts/get", {}); throw new Error("Expected refusal"); } catch (error) { expect(error).toBeInstanceOf(PlaidError); expect(String(error)).not.toContain("private-provider-content"); }
  });
  it("enforces a bounded deadline even if an injected transport ignores abort", async () => {
    const http = createPlaidHttp({ timeoutMs: 10, env: { PLAID_CLIENT_ID: "synthetic-client", PLAID_SANDBOX_SECRET: "synthetic-only" }, fetch: (() => new Promise(() => {})) as unknown as typeof fetch });
    await expect(http.post("/accounts/get", {})).rejects.toMatchObject({ code: "PLAID_PROVIDER_UNAVAILABLE" });
  });
});
