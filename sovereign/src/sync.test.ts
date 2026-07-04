import { describe, it, expect, beforeAll } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.CASHLOOM_DATA_DIR = mkdtempSync(join(tmpdir(), "cashloom-sync-test-"));

const { db, newId } = await import("./db.ts");
const { registerConnector } = await import("./connectors/index.ts");
const { syncAccount } = await import("./sync.ts");
import type { RailConnector, NormalizedTransaction } from "./connectors/types.ts";

const T0 = new Date("2026-07-01T12:00:00Z");

const fakeRows: NormalizedTransaction[] = [
  { externalId: "row-1", title: "fund · birth", amountMinor: "500", currency: "GBP", date: T0 },
  { externalId: "row-2", title: "spend · index", amountMinor: "-120", currency: "GBP", date: T0 },
];

let servedRows = fakeRows;

const fakeRail: RailConnector = {
  type: "fake-rail",
  async fetchBalance() {
    return { balanceMinor: "380", currency: "GBP", decimals: 2, asOf: new Date() };
  },
  async fetchTransactions() {
    return servedRows;
  },
};

const makeAccount = (overrides: Record<string, unknown> = {}): string => {
  const id = newId();
  const row = {
    rail: "PLATFORM_CREDIT",
    display_name: "test",
    currency: "GBP",
    decimals: 2,
    connector_type: "fake-rail",
    external_account_id: "ext-1",
    ...overrides,
  };
  db.query(
    `INSERT INTO accounts (id, rail, display_name, currency, decimals, connector_type, external_account_id)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(id, row.rail as string, row.display_name as string, row.currency as string, row.decimals as number, row.connector_type as string, row.external_account_id as string);
  return id;
};

beforeAll(() => {
  registerConnector("fake-rail", fakeRail);
});

describe("sync — the ledger never doubles and never mixes", () => {
  it("imports rows once and dedupes on re-sync", async () => {
    const id = makeAccount();
    const first = await syncAccount(id);
    expect(first.imported).toBe(2);
    expect(first.balanceMinor).toBe("380");

    const second = await syncAccount(id);
    expect(second.imported).toBe(0);
    expect(second.skipped).toBe(2);

    const count = db
      .query("SELECT COUNT(*) AS n FROM transactions WHERE account_id = ?")
      .get(id) as { n: number };
    expect(count.n).toBe(2);
  });

  it("refuses a currency mismatch outright", async () => {
    const id = makeAccount({ currency: "EUR" });
    await expect(syncAccount(id)).rejects.toThrow(/refusing to mix currencies/);
  });

  it("refuses a decimals mismatch outright", async () => {
    const id = makeAccount({ decimals: 0 });
    await expect(syncAccount(id)).rejects.toThrow(/refusing to mis-scale/);
  });

  it("skips foreign-currency rows instead of importing them wrong", async () => {
    const id = makeAccount();
    servedRows = [
      ...fakeRows,
      { externalId: "row-usd", title: "alien", amountMinor: "999", currency: "USD", date: T0 },
    ];
    const result = await syncAccount(id);
    expect(result.imported).toBe(2);
    expect(result.skipped).toBe(1);
    servedRows = fakeRows;
  });

  it("refuses to sync an account with no connector", async () => {
    const id = makeAccount({ connector_type: null as unknown as string });
    db.query("UPDATE accounts SET connector_type = NULL WHERE id = ?").run(id);
    await expect(syncAccount(id)).rejects.toThrow(/no connector/);
  });
});
