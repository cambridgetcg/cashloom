import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { installConnectSchema } from "./schema.ts";
import { applyImportedRows, applyReadSync, createReadConnection, getReadConnections, getReadSyncState, getTransferCandidates, getTransferLinks, linkInternalTransfer, markReadSyncFailure, ReadSyncConflict, setReadConnectionStatus, unlinkInternalTransfer } from "./read-model.ts";
import type { ReadAccountInput, ReadSyncBatch, ReadTransactionInput } from "./contracts.ts";

let db: Database;
const T0 = "2026-09-01T12:00:00.000Z";
const T1 = "2026-09-02T12:00:00.000Z";
const account = (externalAccountId = "checking"): ReadAccountInput => ({ externalAccountId, displayName: externalAccountId, rail: "BANK", currency: "USD", decimals: 2, balanceMinor: "12000", availableMinor: "10000", balanceKind: "current", observedAt: T0 });
const tx = (externalId = "one", amountMinor = "-1000", externalAccountId = "checking"): ReadTransactionInput => ({ externalId, externalAccountId, amountMinor, title: externalId, currency: "USD", date: T0 });
function batch(overrides: Partial<ReadSyncBatch> = {}): ReadSyncBatch {
  const state = getReadSyncState(db, "connection");
  return { connectionId: state.id, expectedRevision: state.revision, expectedCursor: state.cursor, nextCursor: "next", observedAt: T0, accounts: [account()], transactions: [tx()], ...overrides };
}
function records() { return db.query("SELECT * FROM transactions ORDER BY external_id").all() as Array<Record<string, any>>; }
function idFor(externalId: string): string { return (db.query("SELECT id FROM transactions WHERE external_id=?").get(externalId) as { id: string }).id; }
function connection(name: string, environment: "sandbox" | "live" | "local" = "sandbox") { return createReadConnection(db, { id: name, provider: "fixture", environment, displayName: "Read connection" }); }
beforeEach(() => {
  db = new Database(":memory:");
  db.exec(`PRAGMA foreign_keys=ON;
    CREATE TABLE accounts(id TEXT PRIMARY KEY,rail TEXT NOT NULL,connector_type TEXT,display_name TEXT NOT NULL,currency TEXT NOT NULL,decimals INTEGER NOT NULL,balance_minor TEXT NOT NULL DEFAULT '0',balance_as_of TEXT,external_account_id TEXT,chain_id TEXT,asset_id TEXT,account_ref TEXT,credential_ref TEXT,status TEXT NOT NULL DEFAULT 'ACTIVE',created_at TEXT NOT NULL DEFAULT '2026-01-01');
    CREATE TABLE transactions(id TEXT PRIMARY KEY,account_id TEXT NOT NULL REFERENCES accounts(id),external_id TEXT,title TEXT NOT NULL,amount_minor TEXT NOT NULL,category TEXT,date TEXT NOT NULL,source TEXT NOT NULL DEFAULT 'MANUAL',raw TEXT,created_at TEXT NOT NULL DEFAULT '2026-01-01');
    CREATE UNIQUE INDEX dedupe ON transactions(account_id,external_id) WHERE external_id IS NOT NULL;`);
  installConnectSchema(db);
  connection("connection");
});
afterEach(() => db.close());

describe("atomic normalized observations", () => {
  it("installs additively and keeps available, pending, held and freshness distinct", () => {
    installConnectSchema(db);
    applyReadSync(db, batch({ accounts: [{ ...account(), pendingMinor: "2000", heldMinor: "500" }] }));
    const source = getReadConnections(db)[0];
    expect(source.accounts[0]).toMatchObject({ balance_minor: "12000", available_minor: "10000", pending_minor: "2000", held_minor: "500", read_environment: "sandbox", read_observed_at: T0 });
    expect(source.capabilities.payments).toBe(false);
    expect(JSON.stringify(source)).not.toContain("cursor");
    expect(JSON.stringify(source)).not.toContain("external_account_id");
  });

  it("represents an unknown current balance without inventing a fresh zero", () => {
    applyReadSync(db, batch());
    applyReadSync(db, batch({ observedAt: T1, accounts: [{ ...account(), observedAt: T1, balanceMinor: null, availableMinor: null }], transactions: [] }));
    expect(getReadConnections(db)[0].accounts[0]).toMatchObject({ balance_minor: "12000", balance_as_of: null, read_observed_at: T1, available_minor: null, pending_minor: null });
  });

  it("commits revisions, records and cursor together and rejects stale batches", () => {
    const stale = batch({ transactions: [tx("stale", "-99")] });
    applyReadSync(db, batch());
    expect(() => applyReadSync(db, stale)).toThrow(ReadSyncConflict);
    expect(records().map((row) => row.external_id)).toEqual(["one"]);
    expect(getReadSyncState(db, "connection")).toMatchObject({ cursor: "next", revision: 1 });
    db.exec("CREATE TRIGGER fail_cursor BEFORE UPDATE OF cursor ON read_connections BEGIN SELECT RAISE(ABORT,'forced failure'); END");
    expect(() => applyReadSync(db, batch({ nextCursor: "bad", transactions: [tx("must-rollback")] }))).toThrow("forced failure");
    expect(records().map((row) => row.external_id)).toEqual(["one"]);
    expect(getReadSyncState(db, "connection").revision).toBe(1);
  });

  it("does not commit accounts or records when one record has the wrong currency", () => {
    expect(() => applyReadSync(db, batch({ transactions: [{ ...tx(), currency: "GBP" }] }))).toThrow(/currency/);
    expect(db.query("SELECT id FROM accounts").all()).toHaveLength(0);
    expect(getReadSyncState(db, "connection").cursor).toBeNull();
  });

  it("updates provider facts without overwriting user categorization", () => {
    applyReadSync(db, batch());
    db.query("UPDATE transactions SET category='food'").run();
    const result = applyReadSync(db, batch({ transactions: [{ ...tx(), title: "Corrected", amountMinor: "-950", providerCategory: "dining" }] }));
    expect(result.updated).toBe(1);
    expect(records()[0]).toMatchObject({ title: "Corrected", amount_minor: "-950", category: "food", provider_category: "dining" });
    expect(applyReadSync(db, batch({ transactions: [{ ...tx(), title: "Corrected", amountMinor: "-950", providerCategory: "dining" }] })).skipped).toBe(1);
  });

  it("replaces a pending entry with the posted entry and carries its category", () => {
    applyReadSync(db, batch({ transactions: [{ ...tx("pending"), status: "pending" }] }));
    db.query("UPDATE transactions SET category='groceries'").run();
    // A removed notification may arrive in a different page or prior refresh.
    applyReadSync(db, batch({ transactions: [], removed: [{ externalId: "pending" }] }));
    applyReadSync(db, batch({ transactions: [{ ...tx("posted", "-1200"), pendingExternalId: "pending" }] }));
    expect(records()).toMatchObject([{ external_id: "pending", status: "removed", category: "groceries" }, { external_id: "posted", status: "posted", category: "groceries", amount_minor: "-1200" }]);
  });

  it("scopes removals to a connection and blocks commits after disconnect", () => {
    applyReadSync(db, batch());
    const prepared = batch({ removed: [{ externalId: "one" }] });
    setReadConnectionStatus(db, "connection", "disconnected");
    expect(() => applyReadSync(db, prepared)).toThrow(ReadSyncConflict);
    expect(records()[0].status).toBe("posted");
  });

  it("keeps failure status behind a newer success or disconnect while allowing a concurrent success", () => {
    const before = getReadSyncState(db, "connection");
    markReadSyncFailure(db, before);
    expect(getReadConnections(db)[0]).toMatchObject({ status: "error", last_error_code: "READ_FAILED" });
    applyReadSync(db, batch());
    markReadSyncFailure(db, before);
    expect(getReadConnections(db)[0]).toMatchObject({ status: "active", last_error_code: null });
    const active = getReadSyncState(db, "connection");
    setReadConnectionStatus(db, "connection", "disconnected");
    markReadSyncFailure(db, active);
    expect(getReadSyncState(db, "connection").status).toBe("disconnected");
  });

  it("validates exact fee math, raw payload bounds and dates before writing", () => {
    expect(() => applyReadSync(db, batch({ transactions: [{ ...tx("charge", "9700"), grossMinor: "10000", feeMinor: "300", netMinor: "9900" }] }))).toThrow(/Gross, fee and net/);
    expect(() => applyReadSync(db, batch({ transactions: [{ ...tx(), amountMinor: "1.2" }] }))).toThrow(/integer/);
    expect(() => applyReadSync(db, batch({ transactions: [{ ...tx(), date: "2026-02-30" }] }))).toThrow(/dates/);
    expect(() => applyReadSync(db, batch({ transactions: [{ ...tx(), raw: { data: "x".repeat(70_000) } }] }))).toThrow(/too large/);
    expect(records()).toHaveLength(0);
    applyReadSync(db, batch({ transactions: [{ ...tx(), raw: { merchant: "Shop", access_token: "fixture-secret", nested: { clientSecret: "fixture-secret" } } }] }));
    expect(records()[0].raw).not.toContain("fixture-secret");
  });

  it("preserves exact amounts beyond JavaScript's safe integer range", () => {
    const amount = "123456789012345678901234567890";
    applyReadSync(db, batch({ transactions: [tx("exact", amount)] }));
    expect(records()[0].amount_minor).toBe(amount);
  });
});

describe("reviewed transfers and statement imports", () => {
  function payout() {
    applyReadSync(db, batch({ accounts: [account("stripe"), account("checking")], transactions: [
      { ...tx("charge", "9700", "stripe"), grossMinor: "10000", feeMinor: "300", netMinor: "9700" },
      tx("payout", "-9700", "stripe"), tx("deposit", "9700", "checking"),
    ] }));
  }
  it("only excludes a payout/deposit after the owner confirms the pair, and can undo it", () => {
    payout();
    expect(getTransferCandidates(db)).toHaveLength(1);
    expect(getTransferLinks(db)).toHaveLength(0);
    const link = linkInternalTransfer(db, { outgoingId: idFor("payout"), incomingId: idFor("deposit") });
    expect(getTransferCandidates(db)).toHaveLength(0);
    const remaining = records().filter((row) => row.status === "posted" && row.transfer_link_id === null);
    expect(remaining).toMatchObject([{ external_id: "charge", amount_minor: "9700", gross_minor: "10000", fee_minor: "300" }]);
    unlinkInternalTransfer(db, link.id);
    expect(getTransferCandidates(db)).toHaveLength(1);
  });

  it("keeps a confirmed historical transfer when an account is archived, then unlinks changed provider facts", () => {
    payout();
    linkInternalTransfer(db, { outgoingId: idFor("payout"), incomingId: idFor("deposit") });
    db.query("UPDATE accounts SET status='ARCHIVED' WHERE external_account_id='stripe'").run();
    applyReadSync(db, batch({ accounts: [account()], transactions: [] }));
    expect(getTransferLinks(db)).toHaveLength(1);
    applyReadSync(db, batch({ accounts: [account()], transactions: [tx("deposit", "9600")] }));
    expect(getTransferLinks(db)).toHaveLength(0);
    expect(records().every((row) => row.transfer_link_id === null)).toBe(true);
  });

  it("refuses sandbox/live, pending, same-account and different-chain pairings", () => {
    payout();
    db.query("UPDATE accounts SET read_environment='live' WHERE external_account_id='stripe'").run();
    expect(getTransferCandidates(db)).toHaveLength(0);
    expect(() => linkInternalTransfer(db, { outgoingId: idFor("payout"), incomingId: idFor("deposit") })).toThrow(/environment/);
    db.query("UPDATE accounts SET read_environment='sandbox',rail='CRYPTO',chain_id='eip155:1',asset_id='eip155:1/slip44:60'").run();
    db.query("UPDATE accounts SET chain_id='eip155:8453',asset_id='eip155:8453/slip44:60' WHERE external_account_id='stripe'").run();
    expect(getTransferCandidates(db)).toHaveLength(0);
    expect(() => linkInternalTransfer(db, { outgoingId: idFor("payout"), incomingId: idFor("charge") })).toThrow(/different owned accounts/);
    db.query("UPDATE accounts SET chain_id='eip155:1',asset_id='eip155:1/slip44:60'").run();
    db.query("UPDATE transactions SET status='pending' WHERE external_id='deposit'").run();
    expect(getTransferCandidates(db)).toHaveLength(0);
  });

  it("allows a live payout to a manual statement but never hides a recorded fee", () => {
    payout();
    db.query("UPDATE accounts SET read_environment='local'").run();
    db.query("UPDATE accounts SET read_environment='live' WHERE external_account_id='stripe'").run();
    expect(getTransferCandidates(db)).toHaveLength(1);
    db.query("UPDATE transactions SET gross_minor='-9600',fee_minor='100',net_minor='-9700' WHERE external_id='payout'").run();
    expect(getTransferCandidates(db)).toHaveLength(0);
    expect(() => linkInternalTransfer(db, { outgoingId: idFor("payout"), incomingId: idFor("deposit") })).toThrow(/no recorded fees/);
  });

  it("imports exact reviewed records idempotently without pretending to observe a balance", () => {
    const accountId = "manual-account";
    db.query("INSERT INTO accounts(id,rail,display_name,currency,decimals) VALUES(?,'BANK','Statement','USD',2)").run(accountId);
    const rows = [{ externalId: "csv:fixture", title: "Statement entry", amountMinor: "-1050", currency: "USD", date: new Date(T0), category: "travel" }];
    expect(applyImportedRows(db, { accountId, rows })).toEqual({ imported: 1, skipped: 0 });
    expect(applyImportedRows(db, { accountId, rows })).toEqual({ imported: 0, skipped: 1 });
    expect(db.query("SELECT balance_minor,balance_as_of FROM accounts WHERE id=?").get(accountId)).toEqual({ balance_minor: "0", balance_as_of: null });
    expect(records()[0]).toMatchObject({ source: "CSV", status: "posted", category: "travel" });
    expect(() => applyImportedRows(db, { accountId, rows: [{ ...rows[0], externalId: "csv:bad", currency: "GBP" }] })).toThrow(/currency/);
    expect(records()).toHaveLength(1);
    applyReadSync(db, batch({ transactions: [] }));
    const connectedId = getReadConnections(db)[0].accounts[0].id;
    expect(() => applyImportedRows(db, { accountId: connectedId, rows })).toThrow(/manual account/);
  });
});
