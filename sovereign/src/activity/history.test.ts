import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { ActivityQueryError, readActivityPage } from "./history.ts";
import { installActivityHistoryIndexes } from "./schema.ts";

let db: Database;
const account = "10000000-0000-4000-8000-000000000001";
const other = "10000000-0000-4000-8000-000000000002";
const day = "2026-09-29T12:00:00.000Z";
const id = (value: number) => `20000000-0000-4000-8000-${String(value).padStart(12, "0")}`;
function insert(value: number, options: { accountId?: string; date?: string; title?: string; category?: string; status?: string } = {}) {
  db.query(`INSERT INTO transactions(id,account_id,title,amount_minor,date,category,status,raw,provider_category)
    VALUES(?,?,?,'-123456789012345678901',?,?,?,'private synthetic provider payload','provider-only classification')`)
    .run(id(value), options.accountId ?? account, options.title ?? `Entry ${value}`, options.date ?? day, options.category ?? null, options.status ?? "posted");
}
const page = (input: Parameters<typeof readActivityPage>[1] = {}) => readActivityPage(db, { accountId: account, ...input });
beforeEach(() => {
  db = new Database(":memory:");
  db.exec(`CREATE TABLE accounts(id TEXT PRIMARY KEY, status TEXT NOT NULL, balance_minor TEXT NOT NULL);
    CREATE TABLE transactions(id TEXT PRIMARY KEY,account_id TEXT NOT NULL,external_id TEXT,title TEXT NOT NULL,
      amount_minor TEXT NOT NULL,category TEXT,date TEXT NOT NULL,source TEXT NOT NULL DEFAULT 'MANUAL',raw TEXT,
      created_at TEXT NOT NULL DEFAULT '2026-09-29T00:00:00.000Z',status TEXT NOT NULL DEFAULT 'posted',gross_minor TEXT,
      fee_minor TEXT,net_minor TEXT,transfer_link_id TEXT,provider_category TEXT);
    CREATE INDEX idx_tx_account_date ON transactions(account_id,date);`);
  db.query("INSERT INTO accounts VALUES(?,'ACTIVE','123456789012345678901')").run(account);
  db.query("INSERT INTO accounts VALUES(?,'ARCHIVED','0')").run(other);
  installActivityHistoryIndexes(db);
});
afterEach(() => db.close());

describe("saved Activity history", () => {
  test("pages beyond 200 with exact equal-date ordering and no missing or repeated entries", () => {
    for (let value = 1; value <= 235; value++) insert(value);
    const first = page({ limit: "200" });
    expect(first.transactions).toHaveLength(200);
    expect(first.has_more).toBe(true);
    expect(first.next_cursor).toBeString();
    const second = page({ limit: "200", cursor: first.next_cursor! });
    expect(second.transactions).toHaveLength(35);
    expect(second.has_more).toBe(false);
    expect(second.next_cursor).toBeNull();
    expect([...first.transactions, ...second.transactions].map(row => row.id)).toEqual(Array.from({ length: 235 }, (_, index) => id(235 - index)));
    expect(first.transactions[0].amount_minor).toBe("-123456789012345678901");
  });

  test("search reaches old titles and saved categories while staying inside the selected account", () => {
    for (let value = 1; value <= 230; value++) insert(value);
    insert(231, { date: "2020-01-01T00:00:00Z", title: "Needle in older history" });
    insert(232, { date: "2020-01-02T00:00:00Z", category: "NEEDLE category" });
    insert(233, { accountId: other, title: "Needle in another account" });
    expect(page({ q: "  needle  " }).transactions.map(row => row.id)).toEqual([id(232), id(231)]);
    expect(page({ q: "provider-only" }).transactions).toEqual([]);
    expect(page({ q: "private synthetic" }).transactions).toEqual([]);
    expect(page({ q: "not found" })).toEqual({ transactions: [], has_more: false, next_cursor: null });
  });

  test("percent, underscore, quotes and SQL-shaped text are literal search characters", () => {
    const titles = ["100% saved", "under_score", "O'Brien", "needle' OR 1=1 --", "ordinary entry"];
    titles.forEach((title, index) => insert(index + 1, { title }));
    for (const [q, matches] of [["%", [1]], ["_", [2]], ["'", [4, 3]], ["needle' OR 1=1 --", [4]]] as const) {
      expect(page({ q }).transactions.map(row => row.id)).toEqual(matches.map(id));
    }
    expect(db.query("SELECT COUNT(*) AS n FROM transactions").get()).toEqual({ n: 5 });
  });

  test("cursors bind normalized account/search but allow a different page size", () => {
    for (let value = 1; value <= 5; value++) insert(value, { title: "needle" });
    const first = page({ q: " needle ", limit: "1" });
    const cursor = first.next_cursor!;
    expect(page({ q: "needle", limit: "3", cursor }).transactions.map(row => row.id)).toEqual([id(4), id(3), id(2)]);
    for (const input of [{ accountId: other, q: "needle" }, { accountId: undefined, q: "needle" }, { q: "different" }, { q: "" }]) {
      expect(() => page({ ...input, cursor })).toThrow(ActivityQueryError);
    }
    const all = page({ accountId: undefined, q: "needle", limit: "1" });
    expect(() => page({ q: "needle", cursor: all.next_cursor! })).toThrow(ActivityQueryError);
    const blank = page({ q: "  ", limit: "1" });
    expect(page({ cursor: blank.next_cursor! }).transactions).toHaveLength(4);
  });

  test("rejects malformed, oversized and unsupported cursors without reflecting their values", () => {
    insert(1); insert(2);
    const cursor = page({ limit: "1" }).next_cursor!;
    const decoded = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    const encoded = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
    for (const value of ["", "not a cursor", "a".repeat(1025), `${cursor}=`, encoded({ ...decoded, v: 2 }), encoded({ ...decoded, filter: "0".repeat(64) }), encoded({ ...decoded, date: "" }), encoded({ ...decoded, id: "\u0000" }), encoded({ ...decoded, surprise: "private marker" })]) {
      try { page({ cursor: value }); throw new Error("Expected refusal"); }
      catch (error) {
        expect(error).toBeInstanceOf(ActivityQueryError);
        expect((error as ActivityQueryError).code).toBe("activity_cursor_invalid");
        expect((error as Error).message).not.toContain("private marker");
      }
    }
  });

  test("a newly inserted newer row does not shift the next page or duplicate an older row", () => {
    for (let value = 1; value <= 5; value++) insert(value);
    const first = page({ limit: "2" });
    insert(6, { date: "2026-09-30T00:00:00.000Z" });
    const remaining = page({ cursor: first.next_cursor! });
    expect([...first.transactions, ...remaining.transactions].map(row => row.id)).toEqual([5, 4, 3, 2, 1].map(id));
    expect(page({ limit: "1" }).transactions[0].id).toBe(id(6));
  });

  test("keeps archived and removed history visible, excludes raw data, and performs no writes", () => {
    insert(1, { accountId: other, status: "removed" });
    const before = db.query("SELECT total_changes() AS n").get();
    const result = readActivityPage(db, {});
    expect(result.transactions).toHaveLength(1);
    expect(result.transactions[0]).toMatchObject({ account_id: other, status: "removed", amount_minor: "-123456789012345678901", provider_category: "provider-only classification" });
    expect(result.transactions[0]).not.toHaveProperty("raw");
    expect(JSON.stringify(result)).not.toContain("private synthetic provider payload");
    expect(db.query("SELECT total_changes() AS n").get()).toEqual(before);
    expect(db.query("SELECT balance_minor FROM accounts WHERE id=?").get(account)).toEqual({ balance_minor: "123456789012345678901" });
  });

  test("validates bounds and preserves the existing default of 100", () => {
    for (let value = 1; value <= 101; value++) insert(value);
    expect(page().transactions).toHaveLength(100);
    expect(page({ limit: "500" }).transactions).toHaveLength(101);
    expect(page({ q: "a".repeat(120) }).transactions).toHaveLength(0);
    for (const input of [{ limit: "0" }, { limit: "501" }, { limit: "1.5" }, { limit: "bad" }, { limit: "" }, { accountId: "not-an-id" }, { q: "a".repeat(121) }, { q: "inside\u0000text" }]) {
      expect(() => page(input)).toThrow(ActivityQueryError);
    }
  });

  test("upgrades indices idempotently and both ordering paths avoid a temporary sort", () => {
    installActivityHistoryIndexes(db);
    const indices = db.query("PRAGMA index_list(transactions)").all() as { name: string }[];
    expect(indices.map(row => row.name).filter(name => name.startsWith("idx_tx_"))).toEqual(expect.arrayContaining(["idx_tx_account_date_id", "idx_tx_date_id"]));
    expect(indices.map(row => row.name)).not.toContain("idx_tx_account_date");
    for (const sql of ["SELECT id FROM transactions ORDER BY date DESC,id DESC LIMIT 10", `SELECT id FROM transactions WHERE account_id='${account}' AND (date,id)<('2026','z') ORDER BY date DESC,id DESC LIMIT 10`]) {
      const plan = db.query(`EXPLAIN QUERY PLAN ${sql}`).all() as { detail: string }[];
      expect(plan.map(row => row.detail).join(" ")).not.toContain("TEMP B-TREE");
      expect(plan.map(row => row.detail).join(" ")).toContain(sql.includes("account_id") ? "idx_tx_account_date_id" : "idx_tx_date_id");
    }
  });
});
