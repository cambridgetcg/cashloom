import { afterEach, beforeEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { installConnectSchema } from "../connect/schema";
import { applyReadSync, createReadConnection, getReadSyncState } from "../connect/read-model";
import { installAssistSchema } from "./schema";
import { AssistStore } from "./store";
import type { AssistAccess, AssistProposalInput } from "./contracts";

let db: Database, store: AssistStore, access: AssistAccess, accountId: string, otherId: string, transactionId: string;
const at = "2026-09-29T12:00:00.000Z";
beforeEach(() => {
  db = new Database(":memory:");
  db.exec(`CREATE TABLE accounts(id TEXT PRIMARY KEY,display_name TEXT,rail TEXT,currency TEXT,decimals INTEGER,balance_minor TEXT DEFAULT '0',balance_as_of TEXT,
    connector_type TEXT,external_account_id TEXT,chain_id TEXT,asset_id TEXT,account_ref TEXT,credential_ref TEXT,vault_key_id TEXT,status TEXT DEFAULT 'ACTIVE',created_at TEXT DEFAULT '2026-09-29');
    CREATE TABLE transactions(id TEXT PRIMARY KEY,account_id TEXT,external_id TEXT,title TEXT,amount_minor TEXT,date TEXT,category TEXT,source TEXT DEFAULT 'MANUAL',raw TEXT,created_at TEXT DEFAULT '2026-09-29');
    CREATE UNIQUE INDEX dedupe ON transactions(account_id,external_id) WHERE external_id IS NOT NULL;`);
  installConnectSchema(db); installAssistSchema(db); store = new AssistStore(db);
  accountId = crypto.randomUUID(); otherId = crypto.randomUUID(); transactionId = crypto.randomUUID();
  for (const id of [accountId, otherId]) db.query(`INSERT INTO accounts(id,display_name,rail,currency,decimals,credential_ref,account_ref,external_account_id,vault_key_id) VALUES(?,'Test checking','BANK','USD',2,'PRIVATE_CREDENTIAL','PRIVATE_ADDRESS',?,'PRIVATE_KEY')`).run(id, `private-external-${id}`);
  db.query("INSERT INTO transactions(id,account_id,title,amount_minor,date,raw) VALUES(?,?,'Books','-9007199254740993',?,?)").run(transactionId, accountId, at, '{"private":"PROVIDER_RAW"}');
  db.query("INSERT INTO transactions(id,account_id,title,amount_minor,date) VALUES(?,?,'Other account entry','1',?)").run(crypto.randomUUID(), otherId, at);
  access = { id: crypto.randomUUID(), label: "Budget helper", account_ids: [accountId], permissions: ["read", "propose_categories"], created_at: at, expires_at: "2099-01-01T00:00:00.000Z" };
});
afterEach(() => db.close());
const input = (overrides: Partial<AssistProposalInput> = {}): AssistProposalInput => ({
  request_id: crypto.randomUUID(), transaction_id: transactionId, expected_record_version: store.context(access).transactions.find((row) => row.id === transactionId)!.record_version,
  category: "Books", reason: "The saved description says books.", ...overrides,
});
const propose = (body = input()) => store.propose(body, () => access);
const accept = (proposal: ReturnType<typeof propose>["proposal"]) => store.decide(proposal.id, "accept", proposal.before.record_version, () => undefined);

test("context is bounded, account-scoped and redacted with exact unknown/observed balances", () => {
  const snapshot = store.context(access);
  expect(snapshot.accounts).toHaveLength(1); expect(snapshot.transactions).toHaveLength(1);
  expect(snapshot.transactions[0].amount_minor).toBe("-9007199254740993");
  expect(snapshot.accounts[0].balance_minor).toBeNull();
  expect(snapshot.transactions[0].record_version).toMatch(/^sha256:[a-f0-9]{64}$/);
  for (const hidden of ["PRIVATE_CREDENTIAL", "PRIVATE_ADDRESS", "PRIVATE_KEY", "private-external", "PROVIDER_RAW", "Other account entry", "external_id", "credential_ref", "raw"]) expect(JSON.stringify(snapshot)).not.toContain(hidden);
  expect(() => store.context(access, 30, otherId)).toThrow(/outside/);
  db.query("INSERT INTO transactions(id,account_id,title,amount_minor,date) VALUES(?,?,'Newer','0','2026-09-30')").run(crypto.randomUUID(), accountId);
  expect(store.context(access, 1).activity_window).toEqual({ limit: 1, returned: 1, has_more: true, order: "date_desc_id_desc" });
  db.query("UPDATE accounts SET balance_minor='9007199254740993',balance_as_of=?,available_minor='0' WHERE id=?").run(at, accountId);
  expect(store.context(access).accounts[0]).toMatchObject({ balance_minor: "9007199254740993", available_minor: "0", pending_minor: null });
  db.query("UPDATE accounts SET rail='CRYPTO' WHERE id=?").run(accountId);
  expect(store.context(access).accounts[0].balance_minor).toBeNull();
  db.query("UPDATE accounts SET status='ARCHIVED' WHERE id=?").run(accountId);
  expect(store.context(access).accounts).toHaveLength(0); expect(store.context(access).transactions).toHaveLength(0);
});

test("proposal creation is inert, attributed to the grant and exactly idempotent", () => {
  const before = JSON.stringify(db.query("SELECT * FROM transactions ORDER BY id").all());
  const body = input(); const first = propose(body);
  expect(first.replayed).toBe(false); expect(first.proposal).toMatchObject({ grant_id: access.id, access_label: access.label, status: "pending", review_state: "current" });
  expect(JSON.stringify(db.query("SELECT * FROM transactions ORDER BY id").all())).toBe(before);
  expect(propose(body)).toEqual({ ...first, replayed: true });
  expect(() => propose({ ...body, reason: "Different" })).toThrow(/request ID/);
  expect(() => store.propose(body, () => { throw new Error("revoked"); })).toThrow("revoked");
  expect(store.list(crypto.randomUUID()).proposals).toHaveLength(0);
  const hidden = db.query("SELECT id FROM transactions WHERE account_id=?").get(otherId) as { id: string };
  expect(() => propose({ ...body, request_id: crypto.randomUUID(), transaction_id: hidden.id })).toThrow(/not available/);
});

test("acceptance changes only category, retains its receipt and never reapplies a replay", () => {
  const accounts = JSON.stringify(db.query("SELECT * FROM accounts").all());
  const before = db.query("SELECT * FROM transactions WHERE id=?").get(transactionId) as Record<string, unknown>;
  const proposal = propose().proposal;
  expect(() => store.decide(proposal.id, "accept", `sha256:${"0".repeat(64)}`, () => undefined)).toThrow(/reviewed/);
  expect(accept(proposal).proposal).toMatchObject({ status: "accepted", review_state: "current" });
  expect(db.query("SELECT * FROM transactions WHERE id=?").get(transactionId)).toEqual({ ...before, category: "Books" });
  expect(JSON.stringify(db.query("SELECT * FROM accounts").all())).toBe(accounts);
  db.query("UPDATE transactions SET category='Owner revised' WHERE id=?").run(transactionId);
  expect(accept(proposal).replayed).toBe(true);
  expect(db.query("SELECT category FROM transactions WHERE id=?").get(transactionId)).toEqual({ category: "Owner revised" });
  expect(() => store.decide(proposal.id, "reject", undefined, () => undefined)).toThrow(/different decision/);
});

test("rejection leaves category unchanged and cannot later be accepted", () => {
  const proposal = propose().proposal;
  expect(store.decide(proposal.id, "reject", undefined, () => undefined).proposal.status).toBe("rejected");
  expect(store.decide(proposal.id, "reject", undefined, () => undefined).replayed).toBe(true);
  expect(() => accept(proposal)).toThrow(/different decision/);
  expect(db.query("SELECT category FROM transactions WHERE id=?").get(transactionId)).toEqual({ category: null });
});

test.each([
  "UPDATE transactions SET amount_minor='-1'", "UPDATE transactions SET title='Changed'", "UPDATE transactions SET date='2026-09-28'",
  "UPDATE transactions SET category='Owner category'", "UPDATE transactions SET status='removed'", "UPDATE transactions SET status='pending'",
  "UPDATE accounts SET status='ARCHIVED'", "UPDATE accounts SET currency='EUR'", "UPDATE accounts SET decimals=3",
  "UPDATE accounts SET read_environment='sandbox'", "UPDATE accounts SET account_ref='another-identity'",
  "DELETE FROM transactions",
])("changed records persist a stale decision without applying: %s", (change) => {
  const proposal = propose().proposal; db.exec(change);
  expect(store.list().proposals[0].review_state).not.toBe("current");
  expect(() => accept(proposal)).toThrow(/stale/);
  expect(store.list().proposals[0]).toMatchObject({ status: "stale" });
  expect(db.query("SELECT COUNT(*) AS n FROM transactions WHERE category='Books'").get()).toEqual({ n: 0 });
});

test("competing proposals cannot overwrite the first acceptance and receipt failure rolls back category", () => {
  const first = propose().proposal, second = propose(input({ category: "Office" })).proposal;
  accept(first); expect(() => accept(second)).toThrow(/stale/);
  expect(db.query("SELECT category FROM transactions WHERE id=?").get(transactionId)).toEqual({ category: "Books" });
  const next = propose(input({ category: "Reading" })).proposal;
  db.exec("CREATE TRIGGER fail_decision BEFORE UPDATE ON assist_proposals BEGIN SELECT RAISE(ABORT,'fixture failure'); END;");
  expect(() => accept(next)).toThrow("fixture failure");
  expect(db.query("SELECT category FROM transactions WHERE id=?").get(transactionId)).toEqual({ category: "Books" });
});

test("review snapshots are immutable and submission enforces lifetime/pending bounds", () => {
  const proposal = propose().proposal;
  expect(() => db.query("UPDATE assist_proposals SET reason='replacement' WHERE id=?").run(proposal.id)).toThrow(/immutable/);
  expect(() => db.query("DELETE FROM assist_proposals WHERE id=?").run(proposal.id)).toThrow(/retained/);
  for (let n = 1; n < 100; n++) propose();
  expect(() => propose()).toThrow(/limit/);
  for (let grant = 0; grant < 9; grant++) {
    access = { ...access, id: crypto.randomUUID() };
    for (let n = 0; n < 100; n++) propose();
  }
  access = { ...access, id: crypto.randomUUID() };
  expect(() => propose()).toThrow(/limit/);
  expect(store.list().proposals).toHaveLength(100); expect(store.list().has_more).toBe(true);
});

test("owner-accepted categories survive provider modification through the shared sync store", () => {
  const connection = createReadConnection(db, { provider: "fixture", environment: "sandbox", displayName: "Fixture bank" });
  const batch = () => { const state = getReadSyncState(db, connection.id); return { connectionId: connection.id, expectedRevision: state.revision, expectedCursor: state.cursor, nextCursor: "cursor", observedAt: at,
    accounts: [{ externalAccountId: "checking", displayName: "Checking", rail: "BANK" as const, currency: "USD", decimals: 2, balanceMinor: "12300" }],
    transactions: [{ externalAccountId: "checking", externalId: "entry", title: "Books", amountMinor: "-450", currency: "USD", date: at }] }; };
  const imported = applyReadSync(db, batch());
  accountId = imported.accounts[0].accountId;
  transactionId = (db.query("SELECT id FROM transactions WHERE account_id=?").get(accountId) as { id: string }).id;
  access = { ...access, account_ids: [accountId] };
  accept(propose().proposal);
  const next = batch(); next.transactions[0].title = "Updated bank description";
  applyReadSync(db, next);
  expect(db.query("SELECT category,title FROM transactions WHERE id=?").get(transactionId)).toEqual({ category: "Books", title: "Updated bank description" });
});

test("older pending suggestions stay reachable when more than 100 newer decisions exist", () => {
  const pending = propose().proposal;
  const insert = db.query(`INSERT INTO assist_proposals(id,grant_id,access_label,account_id,transaction_id,request_id,request_hash,before_json,category,reason,status,created_at,decided_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,'rejected','2099-01-01T00:00:00.000Z','2099-01-01T00:00:00.000Z')`);
  for (let n = 0; n < 105; n++) insert.run(crypto.randomUUID(), crypto.randomUUID(), "Previous access", accountId, transactionId, crypto.randomUUID(), "fixture", JSON.stringify(pending.before), "Other", "Previous decision");
  const listed = store.list();
  expect(listed.proposals).toHaveLength(100); expect(listed.has_more).toBe(true);
  expect(listed.proposals[0].id).toBe(pending.id);
  store.decide(pending.id, "reject", undefined, () => undefined);
  expect(store.list().proposals.every((proposal) => proposal.status === "rejected")).toBe(true);
});
