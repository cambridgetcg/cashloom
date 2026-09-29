import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { Hono } from "hono";
import { createConnectRoutes } from "./routes";
import { installConnectSchema } from "./schema";

let db: Database;
let app: Hono;
let providerCalls = 0;
let ownerChecksRemaining: number | null = null;
const accountId = "11111111-1111-4111-8111-111111111111";
const secondId = "22222222-2222-4222-8222-222222222222";
const csv = 'date,title,amount,currency,category\n2026-09-29,"Books, paper",-4.50,USD,office';
const request = (path: string, body: unknown, owner = true) => app.request(path, {
  method: "POST", headers: { "Content-Type": "application/json", "X-Test-Owner": owner ? "yes" : "no" }, body: JSON.stringify(body),
});

beforeEach(() => {
  db = new Database(":memory:");
  db.exec(`PRAGMA foreign_keys=ON;
    CREATE TABLE accounts(id TEXT PRIMARY KEY,display_name TEXT,rail TEXT,currency TEXT,decimals INTEGER,
      balance_minor TEXT DEFAULT '0',balance_as_of TEXT,external_account_id TEXT,connector_type TEXT,
      credential_ref TEXT,vault_key_id TEXT,chain_id TEXT,asset_id TEXT,account_ref TEXT,
      status TEXT DEFAULT 'ACTIVE',created_at TEXT DEFAULT '2026-09-29');
    CREATE TABLE transactions(id TEXT PRIMARY KEY,account_id TEXT REFERENCES accounts(id),external_id TEXT,
      title TEXT,amount_minor TEXT,category TEXT,date TEXT,source TEXT,raw TEXT,created_at TEXT DEFAULT '2026-09-29');
    CREATE UNIQUE INDEX dedupe ON transactions(account_id,external_id) WHERE external_id IS NOT NULL;`);
  installConnectSchema(db);
  for (const id of [accountId, secondId]) db.query("INSERT INTO accounts(id,display_name,rail,currency,decimals,balance_minor) VALUES(?,'Test account','BANK','USD',2,'900')").run(id);
  providerCalls = 0;
  ownerChecksRemaining = null;
  const called = async () => { providerCalls += 1; return { ok: true }; };
  app = new Hono();
  app.route("/api", createConnectRoutes({ db,
    canManage: (c) => c.req.header("X-Test-Owner") === "yes" && (ownerChecksRemaining === null || ownerChecksRemaining-- > 0), sessionToken: () => "test-session",
    plaid: { status: () => ({ configured: false, environment: "sandbox", items: [] }), createLink: called, exchange: called, sync: called, disconnect: called },
  }));
});
afterEach(() => db.close());

describe("private connection routes", () => {
  it("reads saved connection status without provider calls and advertises actual management permission", async () => {
    const response = await app.request("/api/connections");
    const result = await response.json();
    expect(result.can_manage).toBe(false);
    expect(result.plaid).toEqual({ configured: false, environment: "sandbox", items: [] });
    expect(providerCalls).toBe(0);
  });
  it("refuses non-owner Link, import, and transfer mutations before any effect", async () => {
    for (const path of ["/api/connections/plaid/link", "/api/connections/plaid/exchange", "/api/transactions/import/preview", "/api/transactions/import", "/api/transfers/link"]) {
      expect((await request(path, {}, false)).status).toBe(403);
    }
    expect(providerCalls).toBe(0);
    expect(db.query("SELECT COUNT(*) AS n FROM transactions").get()).toEqual({ n: 0 });
  });
  it("previews without writes, binds confirmation, deduplicates replay, and preserves the balance", async () => {
    const body = { account_id: accountId, csv };
    const preview = await (await request("/api/transactions/import/preview", body)).json();
    expect(preview.row_count).toBe(1); expect(preview.duplicate_count).toBe(0);
    expect(db.query("SELECT COUNT(*) AS n FROM transactions").get()).toEqual({ n: 0 });
    expect((await request("/api/transactions/import", { ...body, csv: csv.replace("4.50", "5.50"), preview_hash: preview.preview_hash })).status).toBe(409);
    expect((await request("/api/transactions/import", { ...body, account_id: secondId, preview_hash: preview.preview_hash })).status).toBe(409);
    const confirmed = { ...body, preview_hash: preview.preview_hash };
    expect(await (await request("/api/transactions/import", confirmed)).json()).toEqual({ account_id: accountId, imported: 1, skipped: 0 });
    expect(await (await request("/api/transactions/import", confirmed)).json()).toEqual({ account_id: accountId, imported: 0, skipped: 1 });
    expect((await (await request("/api/transactions/import/preview", body)).json()).duplicate_count).toBe(1);
    expect(db.query("SELECT balance_minor FROM accounts WHERE id=?").get(accountId)).toEqual({ balance_minor: "900" });
  });
  it("refuses archived destinations, malformed rows and oversized request bodies", async () => {
    db.query("UPDATE accounts SET status='ARCHIVED' WHERE id=?").run(accountId);
    expect((await request("/api/transactions/import/preview", { account_id: accountId, csv })).status).toBe(409);
    expect((await request("/api/transactions/import/preview", { account_id: secondId, csv: csv.replace("4.50", "4.501") })).status).toBe(422);
    expect((await request("/api/transactions/import/preview", { account_id: secondId, csv: "x".repeat(2_000_001) })).status).toBe(413);
    expect(db.query("SELECT COUNT(*) AS n FROM transactions").get()).toEqual({ n: 0 });
  });
  it("keeps a reviewed matching entry separately and skips the same reference on replay", async () => {
    const body = { account_id: accountId, csv };
    const initial = await (await request("/api/transactions/import/preview", body)).json();
    await request("/api/transactions/import", { ...body, preview_hash: initial.preview_hash });
    const matched = await (await request("/api/transactions/import/preview", body)).json();
    expect(matched.rows[0]).toMatchObject({ matched_existing: true, already_recorded: true, distinct_reference: null });
    const distinct_rows = [{ row_id: matched.rows[0].row_id, reference: "September statement, line 18" }];
    const separate = { ...body, distinct_rows };
    const preview = await (await request("/api/transactions/import/preview", separate)).json();
    expect(preview.duplicate_count).toBe(0);
    expect(preview.rows[0]).toMatchObject({ matched_existing: true, already_recorded: false, distinct_reference: distinct_rows[0].reference });
    expect(preview.preview_hash).not.toBe(matched.preview_hash);
    // References and the destination are part of the review, never a force flag.
    expect((await request("/api/transactions/import", { ...separate, preview_hash: matched.preview_hash })).status).toBe(409);
    expect((await request("/api/transactions/import", { ...separate, distinct_rows: [{ ...distinct_rows[0], reference: "line 19" }], preview_hash: preview.preview_hash })).status).toBe(409);
    expect((await request("/api/transactions/import", { ...separate, account_id: secondId, preview_hash: preview.preview_hash })).status).toBe(409);
    expect(db.query("SELECT COUNT(*) AS n FROM transactions").get()).toEqual({ n: 1 });
    const commit = { ...separate, preview_hash: preview.preview_hash };
    expect(await (await request("/api/transactions/import", commit)).json()).toEqual({ account_id: accountId, imported: 1, skipped: 0 });
    expect(await (await request("/api/transactions/import", commit)).json()).toEqual({ account_id: accountId, imported: 0, skipped: 1 });
    const replay = await (await request("/api/transactions/import/preview", separate)).json();
    expect(replay.duplicate_count).toBe(1);
    expect(replay.preview_hash).toBe(preview.preview_hash);
    expect(replay.rows[0].already_recorded).toBe(true);
    expect(db.query("SELECT COUNT(*) AS n FROM transactions").get()).toEqual({ n: 2 });
    expect(db.query("SELECT balance_minor FROM accounts WHERE id=?").get(accountId)).toEqual({ balance_minor: "900" });
  });
  it("refuses separate-entry references for rows that have no saved match", async () => {
    const body = { account_id: accountId, csv };
    const preview = await (await request("/api/transactions/import/preview", body)).json();
    const distinct_rows = [{ row_id: preview.rows[0].row_id, reference: "line 18" }];
    const result = await request("/api/transactions/import/preview", { ...body, distinct_rows });
    expect(result.status).toBe(409); expect((await result.json()).error).toBe("import_match_changed");
    expect((await request("/api/transactions/import/preview", { ...body, force: true })).status).toBe(400);
    expect(db.query("SELECT COUNT(*) AS n FROM transactions").get()).toEqual({ n: 0 });
  });
  it.each([csv.replace("4.50", "5.50"), csv.replace("09-29", "09-28"), csv.replace("Books, paper", "Other books")])("refuses conflicting reuse of a separate-entry reference: %s", async (changedCsv) => {
    const importNormally = async (text: string) => {
      const body = { account_id: accountId, csv: text };
      const preview = await (await request("/api/transactions/import/preview", body)).json();
      expect((await request("/api/transactions/import", { ...body, preview_hash: preview.preview_hash })).status).toBe(200);
      return preview;
    };
    const original = await importNormally(csv);
    const separate = { account_id: accountId, csv, distinct_rows: [{ row_id: original.rows[0].row_id, reference: "statement-entry-18" }] };
    const reviewed = await (await request("/api/transactions/import/preview", separate)).json();
    await request("/api/transactions/import", { ...separate, preview_hash: reviewed.preview_hash });
    const changed = await importNormally(changedCsv);
    const response = await request("/api/transactions/import/preview", { account_id: accountId, csv: changedCsv, distinct_rows: [{ row_id: changed.rows[0].row_id, reference: "statement-entry-18" }] });
    expect(response.status).toBe(409); expect((await response.json()).error).toBe("import_reference_conflict");
    expect(db.query("SELECT COUNT(*) AS n FROM transactions").get()).toEqual({ n: 3 });
  });
  it("rechecks reference conflicts at confirmation without importing other rows", async () => {
    const body = { account_id: accountId, csv };
    const initial = await (await request("/api/transactions/import/preview", body)).json();
    await request("/api/transactions/import", { ...body, preview_hash: initial.preview_hash });
    const separate = { ...body, csv: csv + '\n2026-09-29,New entry,1.00,USD,', distinct_rows: [{ row_id: initial.rows[0].row_id, reference: "statement-entry-18" }] };
    const reviewed = await (await request("/api/transactions/import/preview", separate)).json();
    db.query("INSERT INTO transactions(id,account_id,external_id,title,amount_minor,date,source) VALUES(?,?,?,'Conflicting entry','-450',?,'CSV')")
      .run(crypto.randomUUID(), accountId, reviewed.rows[0].external_id, reviewed.rows[0].date);
    const response = await request("/api/transactions/import", { ...separate, preview_hash: reviewed.preview_hash });
    expect(response.status).toBe(409); expect((await response.json()).error).toBe("import_reference_conflict");
    expect(db.query("SELECT COUNT(*) AS n FROM transactions").get()).toEqual({ n: 2 });
  });
  it("rechecks owner authority after asynchronous body reads for preview and import", async () => {
    const body = { account_id: accountId, csv };
    const preview = await (await request("/api/transactions/import/preview", body)).json();
    for (const path of ["/api/transactions/import/preview", "/api/transactions/import"]) {
      ownerChecksRemaining = 1;
      expect((await request(path, path.endsWith("preview") ? body : { ...body, preview_hash: preview.preview_hash })).status).toBe(403);
      expect(db.query("SELECT COUNT(*) AS n FROM transactions").get()).toEqual({ n: 0 });
    }
  });
  it("refuses connected imports, including a destination connected after preview", async () => {
    const body = { account_id: accountId, csv };
    const preview = await (await request("/api/transactions/import/preview", body)).json();
    db.query("UPDATE accounts SET connector_type='stripe' WHERE id=?").run(accountId);
    for (const [path, payload] of [
      ["/api/transactions/import/preview", body],
      ["/api/transactions/import", { ...body, preview_hash: preview.preview_hash }],
    ] as const) {
      const response = await request(path, payload);
      expect(response.status).toBe(409);
      expect((await response.json()).error).toBe("import_requires_manual_account");
    }
    db.query("INSERT INTO read_connections(id,provider,environment,display_name) VALUES('source','plaid','sandbox','Test bank')").run();
    db.query("UPDATE accounts SET read_connection_id='source' WHERE id=?").run(secondId);
    expect((await request("/api/transactions/import/preview", { account_id: secondId, csv })).status).toBe(409);
    expect(db.query("SELECT COUNT(*) AS n FROM transactions").get()).toEqual({ n: 0 });
  });
  it("exports records without raw provider fields, credential references or external identifiers", async () => {
    db.query("UPDATE accounts SET credential_ref='TEST_PRIVATE_REF',external_account_id='private-provider-id' WHERE id=?").run(accountId);
    db.query("INSERT INTO transactions(id,account_id,title,amount_minor,date,source,raw) VALUES(? ,?,'Saved entry','12','2026-09-29','MANUAL',?)")
      .run(crypto.randomUUID(), accountId, JSON.stringify({ private_field: "private-provider-payload" }));
    const response = await app.request(`/api/transactions/export?accountId=${accountId}`);
    const body = await response.json();
    expect(body.complete).toBe(true); expect(body.transactions).toHaveLength(1);
    const output = JSON.stringify(body);
    for (const forbidden of ["TEST_PRIVATE_REF", "private-provider-id", "private-provider-payload", '"raw"']) expect(output).not.toContain(forbidden);
  });
  it("links only a reviewed pair and supports undo without deleting either entry", async () => {
    const outgoing = crypto.randomUUID(), incoming = crypto.randomUUID();
    const add = db.query("INSERT INTO transactions(id,account_id,title,amount_minor,date,source) VALUES(?,?,'Transfer',?,'2026-09-29','MANUAL')");
    add.run(outgoing, accountId, "-9700"); add.run(incoming, secondId, "9700");
    const suggestions = await (await app.request("/api/transfers")).json();
    expect(suggestions.candidates).toHaveLength(1); expect(suggestions.links).toHaveLength(0);
    const linked = await (await request("/api/transfers/link", { outgoing_id: outgoing, incoming_id: incoming })).json();
    expect(linked.link.outgoing_id).toBe(outgoing);
    expect((await (await app.request("/api/transfers")).json()).candidates).toHaveLength(0);
    expect((await request(`/api/transfers/${linked.link.id}/unlink`, {})).status).toBe(200);
    expect(db.query("SELECT COUNT(*) AS n FROM transactions").get()).toEqual({ n: 2 });
    expect((await (await app.request("/api/transfers")).json()).candidates).toHaveLength(1);
  });
});
