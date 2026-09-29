import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { Hono } from "hono";
import { getAddress } from "viem";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createCryptoWatchAccount, createCryptoWatchRoutes, CryptoWatchError } from "./crypto-watch.ts";
import { installConnectSchema } from "./schema.ts";
import { BASE_CHAIN_ID, BASE_ETH_ASSET_ID, BASE_USDC_ASSET_ID } from "../wallet/base-account-projection.ts";

let db: Database;
const address = "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd";
const checksummed = getAddress(address);
const payload = (overrides: Record<string, unknown> = {}) => ({ network: "base", address, display_name: "Watched wallet", ...overrides });
const create = (input: unknown = payload()) => createCryptoWatchAccount(db, input, () => undefined);
const count = () => (db.query("SELECT COUNT(*) AS n FROM accounts").get() as { n: number }).n;
function router(database = db, allowed: () => boolean = () => true) {
  const app = new Hono();
  app.route("/api/connections/crypto", createCryptoWatchRoutes({ db: database, canManage: allowed }));
  return app;
}
const request = (app: Hono, input: unknown = payload()) => app.request("/api/connections/crypto/watch", {
  method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input),
});
beforeEach(() => {
  db = new Database(":memory:");
  db.exec(`PRAGMA foreign_keys=ON;
    CREATE TABLE accounts(id TEXT PRIMARY KEY,rail TEXT NOT NULL,connector_type TEXT,display_name TEXT NOT NULL,
      currency TEXT NOT NULL,decimals INTEGER NOT NULL,balance_minor TEXT NOT NULL DEFAULT '0',balance_as_of TEXT,
      external_account_id TEXT,chain_id TEXT,asset_id TEXT,account_ref TEXT,credential_ref TEXT,vault_key_id TEXT,
      status TEXT NOT NULL DEFAULT 'ACTIVE',created_at TEXT NOT NULL DEFAULT '2026-09-29T00:00:00.000Z');
    CREATE TABLE vault_keys(id TEXT PRIMARY KEY,kind TEXT,address TEXT,enc_blob BLOB);
    CREATE TABLE transactions(id TEXT PRIMARY KEY,account_id TEXT,external_id TEXT,title TEXT,amount_minor TEXT,date TEXT,
      category TEXT,source TEXT,raw TEXT,created_at TEXT);
    CREATE TABLE payments(id TEXT PRIMARY KEY);`);
  installConnectSchema(db);
});
afterEach(() => db.close());

describe("Base watch onboarding", () => {
  test("derives one keyless Base ETH identity with an unknown balance and no other records or network calls", () => {
    const originalFetch = globalThis.fetch;
    let networkCalls = 0;
    globalThis.fetch = (async () => { networkCalls++; throw new Error("Unexpected network"); }) as unknown as typeof fetch;
    const tablesBefore = db.query("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all();
    try {
      const result = create(payload({ address: ` ${checksummed} `, display_name: "  Personal Base watch  " }));
      expect(result.created).toBe(true);
      expect(result.account).toMatchObject({ rail: "CRYPTO", display_name: "Personal Base watch", currency: "ETH", decimals: 18,
        chain_id: BASE_CHAIN_ID, asset_id: BASE_ETH_ASSET_ID, account_ref: `${BASE_CHAIN_ID}:${address}`,
        balance_minor: "0", balance_as_of: null, connector_type: null, credential_ref: null, vault_key_id: null,
        external_account_id: null, read_connection_id: null, read_environment: "live", read_observed_at: null,
        read_connection_status: null, status: "ACTIVE" });
      expect(result.account).not.toHaveProperty("enc_blob");
      expect(result.account).not.toHaveProperty("snapshot");
      expect(count()).toBe(1);
      for (const table of ["vault_keys", "transactions", "payments", "read_connections"]) {
        expect(db.query(`SELECT COUNT(*) AS n FROM ${table}`).get()).toEqual({ n: 0 });
      }
      expect(db.query("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all()).toEqual(tablesBefore);
      expect(networkCalls).toBe(0);
    } finally { globalThis.fetch = originalFetch; }
  });

  test("lost-response retries and valid address casing reuse the original account and label without any write", () => {
    const first = create();
    const before = db.query("SELECT total_changes() AS n").get();
    for (const variant of [address, checksummed, `0x${address.slice(2).toUpperCase()}`]) {
      const replay = create(payload({ address: variant, display_name: "Do not rename existing record" }));
      expect(replay).toEqual({ created: false, account: first.account });
    }
    expect(count()).toBe(1);
    expect(db.query("SELECT total_changes() AS n").get()).toEqual(before);
  });

  test("accepts zero and contract-shaped public addresses without claiming ownership", () => {
    expect(create(payload({ address: `0x${"0".repeat(40)}` })).created).toBe(true);
    expect(create(payload({ address: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913" })).created).toBe(true);
    expect(db.query("SELECT vault_key_id FROM accounts").all()).toEqual([{ vault_key_id: null }, { vault_key_id: null }]);
  });

  test("rejects a wrong mixed-case checksum rather than correcting it silently", () => {
    const badChecksum = checksummed.replace(/[a-fA-F]/, letter => letter === letter.toLowerCase() ? letter.toUpperCase() : letter.toLowerCase());
    expect(badChecksum).not.toBe(checksummed);
    expect(() => create(payload({ address: badChecksum }))).toThrow(CryptoWatchError);
    expect(() => create(payload({ address: `0x${"z".repeat(40)}` }))).toThrow(CryptoWatchError);
    expect(count()).toBe(0);
  });

  test("reuses an existing native-USDC account and local key without rewriting custody, name or saved values", () => {
    const first = create();
    db.query("INSERT INTO vault_keys(id,kind,address,enc_blob) VALUES('synthetic-key','evm',?,?)").run(checksummed, new Uint8Array([1, 2, 3]));
    db.query("UPDATE accounts SET asset_id=?,currency='USDC',decimals=6,vault_key_id='synthetic-key',account_ref=?,balance_minor='987654',display_name='Existing custody account' WHERE id=?")
      .run(BASE_USDC_ASSET_ID, `${BASE_CHAIN_ID}:${checksummed}`, first.account.id);
    const before = db.query("SELECT * FROM accounts WHERE id=?").get(first.account.id);
    const result = create();
    expect(result.created).toBe(false);
    expect(result.account).toMatchObject({ id: first.account.id, vault_key_id: "synthetic-key", currency: "USDC", decimals: 6,
      account_ref: `${BASE_CHAIN_ID}:${checksummed}`, display_name: "Existing custody account", balance_minor: "987654" });
    expect(db.query("SELECT * FROM accounts WHERE id=?").get(first.account.id)).toEqual(before);
    expect(result.account).not.toHaveProperty("enc_blob");
    expect(count()).toBe(1);
  });

  test("same addresses on other networks remain distinct and do not block Base onboarding", () => {
    const ethereum = create();
    db.query("UPDATE accounts SET chain_id='eip155:1',asset_id='eip155:1/slip44:60',account_ref=? WHERE id=?")
      .run(`eip155:1:${address}`, ethereum.account.id);
    const base = create();
    expect(base.created).toBe(true);
    expect(base.account.id).not.toBe(ethereum.account.id);
    expect(base.account.chain_id).toBe(BASE_CHAIN_ID);
    expect(count()).toBe(2);
  });

  test("archived records stay archived while a new active watch account may be created", () => {
    const archived = create();
    db.query("UPDATE accounts SET status='ARCHIVED' WHERE id=?").run(archived.account.id);
    const next = create();
    expect(next.created).toBe(true);
    expect(next.account.id).not.toBe(archived.account.id);
    expect(create().account.id).toBe(next.account.id);
    expect(db.query("SELECT status FROM accounts WHERE id=?").get(archived.account.id)).toEqual({ status: "ARCHIVED" });
    expect(count()).toBe(2);
  });

  test.each([
    "UPDATE accounts SET decimals=6",
    "UPDATE accounts SET asset_id='eip155:8453/erc20:0x1111111111111111111111111111111111111111'",
    "UPDATE accounts SET vault_key_id='missing-key'",
    "UPDATE accounts SET rail='BANK'",
    "UPDATE accounts SET balance_minor='unknown'",
    `UPDATE accounts SET account_ref='${address}'`,
    `UPDATE accounts SET account_ref=NULL,external_account_id='${address}'`,
  ])("refuses an incompatible active Base identity rather than adding a duplicate: %s", (sql) => {
    create(); db.exec(sql);
    const before = db.query("SELECT * FROM accounts").all();
    try { create(); throw new Error("Expected refusal"); }
    catch (error) {
      expect(error).toBeInstanceOf(CryptoWatchError);
      expect((error as CryptoWatchError).code).toBe("crypto_watch_identity_conflict");
      expect((error as Error).message).not.toContain(address);
    }
    expect(db.query("SELECT * FROM accounts").all()).toEqual(before);
  });

  test("rejects unsupported networks, unbounded names and caller-controlled routing or key fields", () => {
    for (const input of [payload({ network: "ethereum" }), payload({ network: "base-sepolia" }), payload({ display_name: " " }),
      payload({ display_name: "x".repeat(121) }), payload({ display_name: "a\u0000b" }), payload({ address: 123 }),
      payload({ chain_id: "eip155:1" }), payload({ vault_key_id: "untrusted" }), payload({ connector_type: "alchemy" }),
      payload({ credential_ref: "UNTRUSTED_NAME" }), payload({ balance_minor: "1000" }), payload({ asset_id: BASE_USDC_ASSET_ID })]) {
      expect(() => create(input)).toThrow(CryptoWatchError);
    }
    expect(count()).toBe(0);
  });

  test("returns created201 and reused200 through the strict bounded JSON route", async () => {
    const app = router();
    const first = await request(app);
    expect(first.status).toBe(201);
    expect(first.headers.get("cache-control")).toBe("private, no-store");
    const created = await first.json();
    const retry = await request(app, payload({ address: checksummed }));
    expect(retry.status).toBe(200);
    expect(await retry.json()).toEqual({ created: false, account: created.account });
    for (const [init, status] of [
      [{ body: "{}", headers: { "Content-Type": "text/plain" } }, 400],
      [{ body: "{bad JSON", headers: { "Content-Type": "application/json" } }, 400],
      [{ body: "x".repeat(4097), headers: { "Content-Type": "application/json", "Content-Length": "2" } }, 413],
    ] as const) {
      expect((await app.request("/api/connections/crypto/watch", { method: "POST", ...init })).status).toBe(status);
    }
    expect(count()).toBe(1);
  });

  test("revalidates owner authority after reading a body and inside the transaction", async () => {
    for (const allowedChecks of [0, 1, 2, 3]) {
      let checks = 0;
      const response = await request(router(db, () => checks++ < allowedChecks));
      expect(response.status).toBe(403);
      expect((await response.json()).error).toBe("crypto_watch_owner_required");
      expect(count()).toBe(0);
    }
  });

  test("racing retries through separate SQLite connections create one active account", async () => {
    const directory = mkdtempSync(join(tmpdir(), "cashloom-watch-race-"));
    const path = join(directory, "synthetic.db");
    writeFileSync(path, db.serialize());
    const firstDb = new Database(path), secondDb = new Database(path);
    firstDb.exec("PRAGMA busy_timeout=5000"); secondDb.exec("PRAGMA busy_timeout=5000");
    try {
      const [first, second] = await Promise.all([request(router(firstDb)), request(router(secondDb), payload({ address: checksummed, display_name: "Racing label" }))]);
      expect([first.status, second.status].sort()).toEqual([200, 201]);
      const [a, b] = await Promise.all([first.json(), second.json()]);
      expect(a.account.id).toBe(b.account.id);
      expect(a.account.display_name).toBe(b.account.display_name);
      expect(firstDb.query("SELECT COUNT(*) AS n FROM accounts").get()).toEqual({ n: 1 });
    } finally { firstDb.close(); secondDb.close(); rmSync(directory, { recursive: true, force: true }); }
  });

  test("unexpected storage errors remain fixed, redacted and transactionally rolled back", async () => {
    db.exec("CREATE TRIGGER synthetic_failure AFTER INSERT ON accounts BEGIN SELECT RAISE(ABORT,'synthetic private storage marker'); END");
    const response = await request(router());
    expect(response.status).toBe(500);
    const result = await response.json();
    expect(result.error).toBe("crypto_watch_failed");
    expect(JSON.stringify(result)).not.toContain("synthetic private storage marker");
    expect(count()).toBe(0);
  });
});
