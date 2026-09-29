import { afterEach, beforeEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { installConnectSchema } from "../connect/schema";
import { BASE_CHAIN_ID, BASE_ETH_ASSET_ID, BASE_USDC_ASSET_ID, ensureBaseAccountProjection } from "../wallet/base-account-projection";
import { WalletKernelStore } from "../wallet/infrastructure/sqlite/store";
import { AssistStore } from "./store";
import type { AssistAccess } from "./contracts";

const at = "2026-09-29T12:00:00.000Z";
const blockTime = "2026-09-29T11:59:00.000Z";
const address = `0x${"1".repeat(40)}`;
const otherAddress = `0x${"2".repeat(40)}`;
const big = "900719925474099312345678";
let db: Database, store: AssistStore, kernel: WalletKernelStore, access: AssistAccess;
let a: string, alias: string, outside: string;
const originalFetch = globalThis.fetch;
let fetches: number;
beforeEach(() => {
  db = new Database(":memory:");
  db.exec(`CREATE TABLE accounts(id TEXT PRIMARY KEY,display_name TEXT,rail TEXT,currency TEXT,decimals INTEGER,balance_minor TEXT DEFAULT '777',balance_as_of TEXT,
    connector_type TEXT,external_account_id TEXT,chain_id TEXT,asset_id TEXT,account_ref TEXT,credential_ref TEXT,vault_key_id TEXT,status TEXT DEFAULT 'ACTIVE',created_at TEXT DEFAULT '2026-09-29');
    CREATE TABLE transactions(id TEXT PRIMARY KEY,account_id TEXT,external_id TEXT,title TEXT,amount_minor TEXT,date TEXT,category TEXT,source TEXT DEFAULT 'MANUAL',raw TEXT,created_at TEXT DEFAULT '2026-09-29');
    CREATE TABLE vault_keys(id TEXT PRIMARY KEY,kind TEXT,address TEXT,enc_blob BLOB);`);
  installConnectSchema(db);
  kernel = new WalletKernelStore(db, { now: () => new Date(at) });
  store = new AssistStore(db);
  a = crypto.randomUUID(); alias = crypto.randomUUID(); outside = crypto.randomUUID();
  for (const [id, ref] of [[a, address], [alias, address], [outside, otherAddress]]) {
    db.query("INSERT INTO accounts(id,display_name,rail,currency,decimals,chain_id,asset_id,account_ref,balance_as_of) VALUES(?,'Synthetic Base','CRYPTO','ETH',18,?,?,?,?)").run(id!, BASE_CHAIN_ID, BASE_ETH_ASSET_ID, `${BASE_CHAIN_ID}:${ref}`, at);
  }
  access = { id: crypto.randomUUID(), label: "Base review", account_ids: [a], permissions: ["read"], created_at: at, expires_at: "2099-01-01T00:00:00.000Z" };
  fetches = 0;
  globalThis.fetch = (async () => { fetches++; throw new Error("No network permitted in saved projection"); }) as unknown as typeof fetch;
});
afterEach(() => { globalThis.fetch = originalFetch; db.close(); });

function save(id: string, options: { block?: string; hash?: string; eth?: string; observedAt?: string } = {}) {
  ensureBaseAccountProjection({ db, store: kernel }, id);
  const fact = {
    accountId: id, blockNumber: options.block ?? "9007199254740993", blockHash: `0x${(options.hash ?? "a").repeat(64)}` as `0x${string}`,
    blockTime, evidenceHash: `sha256:${"e".repeat(64)}` as `sha256:${string}`,
    items: [{ assetId: BASE_ETH_ASSET_ID, observedAtomic: options.eth ?? big }, { assetId: BASE_USDC_ASSET_ID, observedAtomic: "0" }],
  };
  const sightingIds = ["b", "c"].map((byte, index) => kernel.appendBasePositionSighting({
    ...fact, providerId: `synthetic-${index}`, providerTrustDomain: `sha256:${byte.repeat(64)}`, body: { private_evidence: "DO_NOT_SHARE" },
    observedAt: options.observedAt ?? at, fetchedAt: options.observedAt ?? at,
  }).sighting.id);
  return kernel.applyBasePositionSnapshot({ ...fact, providerIds: ["synthetic-0", "synthetic-1"], sightingIds, quorum: 2, decidedAt: options.observedAt ?? at });
}
const read = (ids = [a], filter?: string) => store.context({ ...access, account_ids: ids }, 30, filter);
const check = (id: string, outcome: "partial" | "rejected" | "cancelled" | "stale" | "replayed", attemptedAt = "2026-09-29T12:02:00.000Z") => kernel.appendBasePositionRefreshAttempt({
  accountId: id, outcome, attemptedAt, reasonCode: "synthetic_check", providerCount: 2, availableProviderCount: 1, agreeingProviderCount: 0,
});

test("saved Base reads preserve exact complete holdings and dates without RPC, writes or legacy scalar balances", () => {
  save(a); save(outside);
  const before = db.serialize();
  db.exec("PRAGMA query_only=ON");
  const context = read();
  expect(context.accounts[0]).toMatchObject({ balance_minor: null, balance_as_of: null, available_minor: null });
  expect(context.base_holdings).toEqual([{
    account_ids: [a], chain_id: BASE_CHAIN_ID, network: "Base mainnet", authority: "observation_only", status: "saved_finalized",
    finality: "finalized", as_of: blockTime, observed_at: at, block_number: "9007199254740993", last_check: null,
    holdings: [{ asset: "ETH", decimals: 18, observed_atomic: big }, { asset: "USDC", decimals: 6, observed_atomic: "0" }],
  }]);
  const encoded = JSON.stringify(context);
  for (const secret of [address, otherAddress, outside, alias, "DO_NOT_SHARE", "synthetic-0", "provider", "evidence_hash", "snapshot_id", "account_ref"]) expect(encoded).not.toContain(secret);
  expect(db.serialize()).toEqual(before);
  expect(fetches).toBe(0);
});

test("new watch rows and a missing kernel remain unknown and do not install tables", () => {
  expect(read().base_holdings[0]).toMatchObject({ status: "not_checked", holdings: [], as_of: null, observed_at: null });
  // Simulate a legacy node without any kernel tables by using its core schema alone.
  const legacy = new Database(":memory:");
  try {
    for (const row of db.query("SELECT sql FROM sqlite_master WHERE type='table' AND name IN ('accounts','transactions','read_connections')").all() as { sql: string }[]) legacy.exec(row.sql);
    legacy.query("INSERT INTO accounts(id,display_name,rail,currency,decimals,chain_id,asset_id,account_ref) VALUES(?,'Watch','CRYPTO','ETH',18,?,?,?)").run(a, BASE_CHAIN_ID, BASE_ETH_ASSET_ID, `${BASE_CHAIN_ID}:${address}`);
    legacy.exec("PRAGMA query_only=ON");
    expect(new AssistStore(legacy).context(access).base_holdings[0]).toMatchObject({ status: "not_checked", holdings: [] });
    expect(legacy.query("SELECT name FROM sqlite_master WHERE name LIKE 'wk_%'").all()).toEqual([]);
  } finally { legacy.close(); }
  expect(fetches).toBe(0);
});

test("later failed or stale checks retain dated observations, while unknown remains unknown", () => {
  save(a);
  for (const [index, outcome] of (["partial", "rejected", "cancelled", "stale"] as const).entries()) {
    const time = `2026-09-29T12:0${index + 2}:00.000Z`;
    check(a, outcome, time);
    expect(read().base_holdings[0]).toMatchObject({ status: "retained_after_check", as_of: blockTime, observed_at: at,
      holdings: [{ asset: "ETH", observed_atomic: big }, { asset: "USDC", observed_atomic: "0" }], last_check: { attempted_at: time, outcome } });
  }
  ensureBaseAccountProjection({ db, store: kernel }, outside); check(outside, "partial");
  expect(read([outside]).base_holdings[0]).toMatchObject({ status: "not_checked", holdings: [], last_check: { outcome: "partial" } });
});

test("deduplication uses selected aliases only, respects the optional filter and never uses an ungranted newer balance", () => {
  save(a); save(alias, { block: "9007199254740994", eth: "42", observedAt: "2026-09-29T12:01:00.000Z" });
  expect(read().base_holdings[0]!.holdings[0]!.observed_atomic).toBe(big);
  const group = read([a, alias]).base_holdings;
  expect(group).toHaveLength(1); expect(group[0]).toMatchObject({ account_ids: [a, alias], block_number: "9007199254740994", holdings: [{ observed_atomic: "42" }, { observed_atomic: "0" }] });
  expect(read([a, alias], a).base_holdings[0]).toMatchObject({ account_ids: [a], holdings: [{ observed_atomic: big }, { observed_atomic: "0" }] });
  db.query("UPDATE accounts SET status='ARCHIVED' WHERE id=?").run(alias);
  expect(read([a, alias]).base_holdings[0]!.account_ids).toEqual([a]);
  expect(() => read([a], outside)).toThrow(/outside/);
});

test("same-height selected alias contradictions suppress holdings without leaking outside-grant conflicts", () => {
  save(a); save(alias, { eth: "42" });
  expect(read([a, alias]).base_holdings[0]).toMatchObject({ status: "conflicted", holdings: [], finality: null });
  expect(read([a]).base_holdings[0]!.status).toBe("saved_finalized");
  expect(read([a, alias], a).base_holdings[0]!.status).toBe("saved_finalized");
});

test("frozen heads suppress retained amounts", () => {
  save(a); save(a, { hash: "b", eth: "42" });
  expect(read().base_holdings[0]).toMatchObject({ status: "conflicted", holdings: [], as_of: null, observed_at: null, finality: null });
});

test("invalid core identity and mismatched kernel identity cannot reuse saved balances", () => {
  save(a);
  db.query("UPDATE accounts SET account_ref=? WHERE id=?").run(`${BASE_CHAIN_ID}:${otherAddress}`, a);
  expect(read().base_holdings[0]).toMatchObject({ status: "identity_invalid", holdings: [] });
  db.query("UPDATE accounts SET account_ref='invalid' WHERE id=?").run(a);
  expect(read().base_holdings[0]).toMatchObject({ status: "identity_invalid", holdings: [] });
});

test("malformed saved evidence fails closed without mutating or exposing the raw error", () => {
  save(a);
  db.exec("DROP TRIGGER wk_base_position_snapshots_no_update; PRAGMA ignore_check_constraints=ON;");
  db.query("UPDATE wk_base_position_snapshots SET usdc_atomic='not-a-number',provider_ids_json='malformed-private-value' WHERE account_id=?").run(a);
  const before = db.serialize(); db.exec("PRAGMA query_only=ON");
  const result = read();
  expect(result.base_holdings[0]).toMatchObject({ status: "evidence_invalid", holdings: [], last_check: null });
  expect(JSON.stringify(result)).not.toContain("malformed-private-value");
  expect(db.serialize()).toEqual(before); expect(fetches).toBe(0);
});
