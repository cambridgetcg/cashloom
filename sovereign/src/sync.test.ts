import { describe, it, expect, beforeAll, beforeEach } from "bun:test";
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
let requestedSince: Date | undefined;

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
};

const deferred = <T>(): Deferred<T> => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

const balanceOne = deferred<Awaited<ReturnType<RailConnector["fetchBalance"]>>>();
const balanceTwo = deferred<Awaited<ReturnType<RailConnector["fetchBalance"]>>>();
let concurrentBalanceCall = 0;

const concurrentRail: RailConnector = {
  type: "concurrent-rail",
  fetchBalance() {
    concurrentBalanceCall += 1;
    return concurrentBalanceCall === 1 ? balanceOne.promise : balanceTwo.promise;
  },
  async fetchTransactions() {
    return [];
  },
};

const fakeRail: RailConnector = {
  type: "fake-rail",
  async fetchBalance() {
    return { balanceMinor: "380", currency: "GBP", decimals: 2, asOf: new Date() };
  },
  async fetchTransactions(_ctx, since) {
    requestedSince = since;
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
  registerConnector("concurrent-rail", concurrentRail);
});

beforeEach(() => {
  servedRows = fakeRows;
  requestedSince = undefined;
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
  });

  it("derives its overlap cursor only from connector rows", async () => {
    const id = makeAccount();
    const connectorDate = new Date("2026-06-15T10:00:00.000Z");
    const add = db.query(
      `INSERT INTO transactions
         (id, account_id, external_id, title, amount_minor, date, source)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    add.run(newId(), id, "old-connector", "connector", "1", connectorDate.toISOString(), "CONNECTOR");
    add.run(newId(), id, null, "manual future", "1", "2099-01-01T00:00:00.000Z", "MANUAL");
    add.run(newId(), id, "future-payment", "payment future", "-1", "2098-01-01T00:00:00.000Z", "PAYMENT");
    servedRows = [];

    await syncAccount(id);

    expect(requestedSince?.toISOString()).toBe("2026-06-12T10:00:00.000Z");
  });

  it("rolls back imported rows when the balance update cannot commit", async () => {
    const id = makeAccount();
    const trigger = `sync_atomic_${id.replaceAll("-", "_")}`;
    db.exec(
      `CREATE TRIGGER ${trigger}
       BEFORE UPDATE OF balance_minor ON accounts
       WHEN OLD.id = '${id}'
       BEGIN
         SELECT RAISE(ABORT, 'forced balance failure');
       END`,
    );

    try {
      await expect(syncAccount(id)).rejects.toThrow(/forced balance failure/);
    } finally {
      db.exec(`DROP TRIGGER IF EXISTS ${trigger}`);
    }

    const count = db
      .query("SELECT COUNT(*) AS n FROM transactions WHERE account_id = ?")
      .get(id) as { n: number };
    const account = db
      .query("SELECT balance_minor FROM accounts WHERE id = ?")
      .get(id) as { balance_minor: string };
    expect(count.n).toBe(0);
    expect(account.balance_minor).toBe("0");
  });

  it("never lets a slower stale observation overwrite a newer balance", async () => {
    const id = makeAccount({ connector_type: "concurrent-rail" });
    const slowerOld = syncAccount(id);
    const fasterNew = syncAccount(id);

    balanceTwo.resolve({
      balanceMinor: "200",
      currency: "GBP",
      decimals: 2,
      asOf: new Date("2026-07-02T00:00:00.000Z"),
    });
    const newerResult = await fasterNew;
    balanceOne.resolve({
      balanceMinor: "100",
      currency: "GBP",
      decimals: 2,
      asOf: new Date("2026-07-01T00:00:00.000Z"),
    });
    const olderResult = await slowerOld;

    const account = db
      .query("SELECT balance_minor, balance_as_of FROM accounts WHERE id = ?")
      .get(id) as { balance_minor: string; balance_as_of: string };
    expect(newerResult.balanceMinor).toBe("200");
    expect(olderResult.balanceMinor).toBe("200");
    expect(account).toEqual({
      balance_minor: "200",
      balance_as_of: "2026-07-02T00:00:00.000Z",
    });
  });

  it("rejects malformed atomic connector values before any local write", async () => {
    const malformedType = `malformed-${newId()}`;
    const malformedRail: RailConnector = {
      type: malformedType,
      async fetchBalance() {
        return {
          balanceMinor: "100",
          currency: "GBP",
          decimals: 2,
          asOf: new Date("2026-07-01T00:00:00.000Z"),
        };
      },
      async fetchTransactions() {
        return [{
          externalId: "malformed-row",
          title: "not atomic",
          amountMinor: "1.2",
          currency: "GBP",
          date: new Date("2026-07-01T00:00:00.000Z"),
        }];
      },
    };
    registerConnector(malformedType, malformedRail);
    const id = makeAccount({ connector_type: malformedType });

    await expect(syncAccount(id)).rejects.toThrow(/signed decimal integer string/);

    const count = db
      .query("SELECT COUNT(*) AS n FROM transactions WHERE account_id = ?")
      .get(id) as { n: number };
    const account = db
      .query("SELECT balance_minor, balance_as_of FROM accounts WHERE id = ?")
      .get(id) as { balance_minor: string; balance_as_of: string | null };
    expect(count.n).toBe(0);
    expect(account).toEqual({ balance_minor: "0", balance_as_of: null });
  });

  it("rejects a malformed connector balance before importing otherwise valid rows", async () => {
    const malformedType = `malformed-balance-${newId()}`;
    registerConnector(malformedType, {
      type: malformedType,
      async fetchBalance() {
        return {
          balanceMinor: "1.2",
          currency: "GBP",
          decimals: 2,
          asOf: new Date("2026-07-01T00:00:00.000Z"),
        };
      },
      async fetchTransactions() {
        return fakeRows;
      },
    });
    const id = makeAccount({ connector_type: malformedType });

    await expect(syncAccount(id)).rejects.toThrow(/signed decimal integer string/);

    const count = db
      .query("SELECT COUNT(*) AS n FROM transactions WHERE account_id = ?")
      .get(id) as { n: number };
    const account = db
      .query("SELECT balance_minor, balance_as_of FROM accounts WHERE id = ?")
      .get(id) as { balance_minor: string; balance_as_of: string | null };
    expect(count.n).toBe(0);
    expect(account).toEqual({ balance_minor: "0", balance_as_of: null });
  });

  it("refuses to sync an account with no connector", async () => {
    const id = makeAccount({ connector_type: null as unknown as string });
    db.query("UPDATE accounts SET connector_type = NULL WHERE id = ?").run(id);
    await expect(syncAccount(id)).rejects.toThrow(/no connector/);
  });
});
