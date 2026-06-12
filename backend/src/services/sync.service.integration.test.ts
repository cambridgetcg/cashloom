import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import AccountModel, { RailEnum } from "../models/account.model";
import TransactionModel, {
  PaymentMethodEnum,
  TransactionSourceEnum,
  TransactionStatusEnum,
  TransactionTypeEnum,
} from "../models/transaction.model";
import { registerConnector } from "../connectors";
import {
  ConnectorContext,
  NormalizedBalance,
  NormalizedTransaction,
  RailConnector,
} from "../connectors/types";
import {
  syncAccountService,
  syncAllAccountsService,
} from "./sync.service";

// Real-DB proof of the sync pipeline: idempotent imports (pre-filter + the
// {userId, accountId, externalId} unique index as backstop), the 3-day
// overlap window, the never-mix-currencies rule, owner scoping, and — the
// corruption class this repo has been burned by — the one precision boundary
// where integer minor units become the model's major-unit/cents amount.
// All connector traffic is a registered FAKE; nothing touches the network.

let mongod: MongoMemoryServer;

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());
  // Build indexes so the unique backstops are actually enforced below.
  await AccountModel.init();
  await TransactionModel.init();
}, 120000); // first run downloads a mongod binary

afterAll(async () => {
  await mongoose.disconnect();
  if (mongod) await mongod.stop();
});

beforeEach(async () => {
  await AccountModel.deleteMany({});
  await TransactionModel.deleteMany({});
  fakeBalance = balance("123456", "GBP");
  fakeRows = [];
  lastSince = null;
});

/* ------------------------------ fake connector ----------------------------- */

let fakeBalance: NormalizedBalance;
let fakeRows: NormalizedTransaction[];
let lastSince: Date | null;

// Honours `since` the way a real rail does, so the overlap-window test proves
// the service computes the window — not that the fake ignores it.
const fakeConnector: RailConnector = {
  type: "fake",
  async fetchBalance(_ctx: ConnectorContext) {
    return fakeBalance;
  },
  async fetchTransactions(_ctx: ConnectorContext, since: Date) {
    lastSince = since;
    return fakeRows.filter((r) => r.date.getTime() >= since.getTime());
  },
};
registerConnector("fake", fakeConnector);

registerConnector("exploding", {
  type: "exploding",
  async fetchBalance() {
    // An obviously-fake key in the message proves the sync-all scrubber works
    // even if a connector misbehaves. NOT a real credential.
    throw new Error("boom: credential rk_test_FAKEFAKEFAKE rejected");
  },
  async fetchTransactions() {
    return [];
  },
});

/* --------------------------------- helpers -------------------------------- */

const daysAgo = (n: number): Date => new Date(Date.now() - n * 24 * 60 * 60 * 1000);

const balance = (
  balanceMinor: string,
  currency: string,
  decimals = 2
): NormalizedBalance => ({
  balanceMinor,
  currency,
  decimals,
  asOf: daysAgo(0),
});

const row = (
  externalId: string,
  amountMinor: string,
  date: Date,
  currency = "GBP"
): NormalizedTransaction => ({
  externalId,
  title: `tx ${externalId}`,
  amountMinor,
  currency,
  date,
});

const makeAccount = (
  userId: mongoose.Types.ObjectId,
  overrides: Record<string, unknown> = {}
) =>
  AccountModel.create({
    userId,
    rail: RailEnum.BANK,
    connectorType: "fake",
    displayName: "Test bank",
    currency: "GBP",
    decimals: 2,
    externalAccountId: "ext-1",
    ...overrides,
  });

/* ---------------------------------- tests ---------------------------------- */

describe("syncAccountService (real DB, fake connector)", () => {
  it("(a) first sync inserts N transactions and writes the balance verbatim", async () => {
    const userId = new mongoose.Types.ObjectId();
    const account = await makeAccount(userId);

    fakeBalance = balance("123456", "GBP");
    fakeRows = [
      row("t1", "-1500", daysAgo(10)), // money out → EXPENSE £15.00
      row("t2", "250000", daysAgo(7)), // money in → INCOME £2500.00
      row("t3", "-999", daysAgo(5)),
    ];

    const result = await syncAccountService(String(userId), String(account._id));

    expect(result.imported).toBe(3);
    expect(result.skipped).toBe(0);
    expect(result.balanceMinor).toBe("123456");
    expect(result.warnings).toBeUndefined();

    const saved = await AccountModel.findById(account._id);
    expect(saved?.balanceMinor).toBe("123456");
    expect(saved?.balanceAsOf).toBeTruthy();

    const txs = await TransactionModel.find({ accountId: account._id }).sort({
      date: 1,
    });
    expect(txs).toHaveLength(3);
    expect(txs[0].type).toBe(TransactionTypeEnum.EXPENSE);
    expect(txs[0].amount).toBe(15); // getter: 1500 cents → 15.00 major
    expect(txs[1].type).toBe(TransactionTypeEnum.INCOME);
    expect(txs[1].amount).toBe(2500);
    expect(txs[0].source).toBe(TransactionSourceEnum.CONNECTOR);
    expect(txs[0].status).toBe(TransactionStatusEnum.COMPLETED);
    expect(txs[0].externalId).toBe("t1");
    // "fake" is not a mapped rail → OTHER (stripe→CARD, gocardless→BANK_TRANSFER).
    expect(txs[0].paymentMethod).toBe(PaymentMethodEnum.OTHER);

    // First-ever sync used the 90-day initial lookback.
    expect(lastSince).not.toBeNull();
    expect(Math.abs(lastSince!.getTime() - daysAgo(90).getTime())).toBeLessThan(
      10_000
    );
  });

  it("(b) an identical re-sync imports 0 and skips N", async () => {
    const userId = new mongoose.Types.ObjectId();
    const account = await makeAccount(userId);
    // All within 3 days of the newest row, so the overlap window (newest − 3d)
    // re-fetches the WHOLE batch — every row must come back as a skip.
    fakeRows = [
      row("t1", "-1500", daysAgo(5)),
      row("t2", "250000", daysAgo(4)),
      row("t3", "-999", daysAgo(3)),
    ];

    const first = await syncAccountService(String(userId), String(account._id));
    expect(first.imported).toBe(3);

    const second = await syncAccountService(String(userId), String(account._id));
    expect(second.imported).toBe(0);
    expect(second.skipped).toBe(3);

    expect(await TransactionModel.countDocuments({ accountId: account._id })).toBe(3);
  });

  it("(c) the 3-day overlap window re-fetches old rows but imports only the new one", async () => {
    const userId = new mongoose.Types.ObjectId();
    const account = await makeAccount(userId);
    fakeRows = [
      row("old1", "-1000", daysAgo(7)),
      row("old2", "-2000", daysAgo(5)),
    ];
    await syncAccountService(String(userId), String(account._id));

    // The rail now also has one new row. since = newest known (5 days ago)
    // minus 3 days = 8 days ago, so both old rows fall inside the window and
    // are re-fetched — and must be skipped, not doubled.
    fakeRows = [...fakeRows, row("new1", "-3000", daysAgo(2))];

    const result = await syncAccountService(String(userId), String(account._id));

    expect(lastSince).not.toBeNull();
    expect(Math.abs(lastSince!.getTime() - daysAgo(8).getTime())).toBeLessThan(
      10_000
    );
    expect(result.imported).toBe(1);
    expect(result.skipped).toBe(2);
    expect(await TransactionModel.countDocuments({ accountId: account._id })).toBe(3);
  });

  it("(d) currency-mismatch rows are skipped and a mismatched balance warns without writing", async () => {
    const userId = new mongoose.Types.ObjectId();
    // balanceAsOf set → an ESTABLISHED account, so the first-sync currency
    // correction must NOT kick in.
    const account = await makeAccount(userId, {
      balanceMinor: "999",
      balanceAsOf: daysAgo(1),
    });

    fakeBalance = balance("777777", "EUR");
    fakeRows = [
      row("gbp1", "-1500", daysAgo(4), "GBP"),
      row("eur1", "-1500", daysAgo(3), "EUR"),
      row("eur2", "2500", daysAgo(2), "EUR"),
    ];

    const result = await syncAccountService(String(userId), String(account._id));

    expect(result.imported).toBe(1);
    expect(result.skipped).toBe(2);
    expect(result.warnings?.join(" ")).toMatch(/balance not written/i);
    expect(result.balanceMinor).toBe("999"); // untouched

    const saved = await AccountModel.findById(account._id);
    expect(saved?.balanceMinor).toBe("999");
    expect(saved?.currency).toBe("GBP");
  });

  it("adopts the connector-reported decimals on the FIRST sync (Stripe-JPY shape: defaulted decimals 2, rail reports 0)", async () => {
    const userId = new mongoose.Types.ObjectId();
    // Created via POST /account/create with currency JPY and no explicit
    // decimals — the schema default of 2 misreads whole-yen minor units 100x.
    const account = await makeAccount(userId, { currency: "JPY" });

    fakeBalance = balance("500", "JPY", 0); // ¥500, whole yen
    fakeRows = [row("y1", "500", daysAgo(3), "JPY")];

    const result = await syncAccountService(String(userId), String(account._id));

    expect(result.warnings?.join(" ")).toMatch(/decimals corrected from 2 to 0/i);
    expect(result.balanceMinor).toBe("500");
    expect(result.imported).toBe(1);

    const saved = await AccountModel.findById(account._id);
    expect(saved?.currency).toBe("JPY");
    expect(saved?.decimals).toBe(0); // formatMinor("500", 0) renders ¥500, not ¥5.00

    // The transaction imported as ¥500, not ¥5 (the 100x corruption class).
    const doc = await TransactionModel.findOne({ accountId: account._id });
    expect(doc?.amount).toBe(500);
    const raw = await TransactionModel.collection.findOne({
      accountId: account._id,
    });
    expect(raw?.amount).toBe(50000); // 500 major → 50000 model-cents, exact
  });

  it("an ESTABLISHED account with mismatched decimals refuses both the balance write and the import, loudly", async () => {
    const userId = new mongoose.Types.ObjectId();
    const account = await makeAccount(userId, {
      currency: "JPY",
      balanceMinor: "999",
      balanceAsOf: daysAgo(1), // established → no silent correction
    });

    fakeBalance = balance("500", "JPY", 0); // rail scale 0 vs account scale 2
    fakeRows = [row("y1", "500", daysAgo(2), "JPY")];

    const result = await syncAccountService(String(userId), String(account._id));

    expect(result.imported).toBe(0);
    expect(result.skipped).toBe(0);
    expect(result.balanceMinor).toBe("999"); // untouched
    expect(result.warnings?.join(" ")).toMatch(/balance not written/i);
    expect(result.warnings?.join(" ")).toMatch(/transactions not imported/i);
    // The rail was never even asked for transactions — nothing it returned
    // could have been stored at the wrong scale.
    expect(lastSince).toBeNull();

    const saved = await AccountModel.findById(account._id);
    expect(saved?.decimals).toBe(2);
    expect(saved?.balanceMinor).toBe("999");
    expect(await TransactionModel.countDocuments({ accountId: account._id })).toBe(0);
  });

  it("corrects the onboarding-default currency on the FIRST sync of a fresh account", async () => {
    const userId = new mongoose.Types.ObjectId();
    // Fresh GoCardless-style import: GBP guessed, never synced, no rows.
    const account = await makeAccount(userId);

    fakeBalance = balance("5000", "EUR");
    fakeRows = [row("eur1", "-250", daysAgo(3), "EUR")];

    const result = await syncAccountService(String(userId), String(account._id));

    expect(result.warnings?.join(" ")).toMatch(/corrected from GBP to EUR/i);
    expect(result.balanceMinor).toBe("5000");
    expect(result.imported).toBe(1); // EUR rows now match the corrected currency

    const saved = await AccountModel.findById(account._id);
    expect(saved?.currency).toBe("EUR");
    expect(saved?.balanceMinor).toBe("5000");
  });

  it("(e) a manual account refuses to sync with a 400-class error", async () => {
    const userId = new mongoose.Types.ObjectId();
    const manual = await AccountModel.create({
      userId,
      rail: RailEnum.CASH,
      displayName: "Wallet",
      currency: "GBP",
    });

    await expect(
      syncAccountService(String(userId), String(manual._id))
    ).rejects.toMatchObject({
      statusCode: 400,
      message: "manual accounts do not sync",
    });
  });

  it("(f) another user's accountId looks like NotFound (no IDOR)", async () => {
    const owner = new mongoose.Types.ObjectId();
    const stranger = new mongoose.Types.ObjectId();
    const account = await makeAccount(owner);

    await expect(
      syncAccountService(String(stranger), String(account._id))
    ).rejects.toMatchObject({ statusCode: 404 });
  });

  it("folds unique-index (E11000) duplicates into skipped instead of failing", async () => {
    const userId = new mongoose.Types.ObjectId();
    const account = await makeAccount(userId);

    // Two rows share an externalId — the DB pre-filter can't see an
    // intra-batch duplicate, so this exercises the index backstop +
    // insertMany({ordered:false}) E11000 handling.
    fakeRows = [
      row("dup", "-1000", daysAgo(5)),
      { ...row("dup", "-2000", daysAgo(4)), title: "tx dup again" },
      row("fresh", "-3000", daysAgo(3)),
    ];

    const result = await syncAccountService(String(userId), String(account._id));

    expect(result.imported).toBe(2);
    expect(result.skipped).toBe(1);
    expect(await TransactionModel.countDocuments({ accountId: account._id })).toBe(2);
  });

  it("skips a row whose minor amount cannot survive the float path, with a warning", async () => {
    const userId = new mongoose.Types.ObjectId();
    const account = await makeAccount(userId);

    // Wei-scale magnitude: minorToMajor would throw, so the row must be
    // dropped loudly rather than imported rounded.
    fakeRows = [
      row("huge", "123456789012345678901", daysAgo(3)),
      row("ok", "-500", daysAgo(2)),
    ];

    const result = await syncAccountService(String(userId), String(account._id));

    expect(result.imported).toBe(1);
    expect(result.skipped).toBe(1);
    expect(result.warnings?.join(" ")).toMatch(/huge/);
  });
});

describe("the one precision boundary: minor units → model cents", () => {
  it("a 1234 minor-unit GBP row round-trips to £12.34 through the cents setter", async () => {
    const userId = new mongoose.Types.ObjectId();
    const account = await makeAccount(userId);
    fakeRows = [row("p1", "1234", daysAgo(3), "GBP")];

    const result = await syncAccountService(String(userId), String(account._id));
    expect(result.imported).toBe(1);

    // Raw driver read: the setter must have stored EXACTLY 1234 cents — the
    // 100x/off-by-rounding corruption class this repo has been burned by.
    const raw = await TransactionModel.collection.findOne({
      accountId: account._id,
    });
    expect(raw?.amount).toBe(1234);

    // Mongoose getter: cents back out as £12.34, type INCOME (positive).
    const doc = await TransactionModel.findOne({ accountId: account._id });
    expect(doc?.amount).toBe(12.34);
    expect(doc?.type).toBe(TransactionTypeEnum.INCOME);
  });

  it("3-decimal currency (KWD-style): sub-cent rows skip loudly, cent-exact rows import exactly", async () => {
    const userId = new mongoose.Types.ObjectId();
    const account = await makeAccount(userId, { currency: "KWD", decimals: 3 });
    fakeBalance = balance("123456", "KWD", 3);
    fakeRows = [
      // 12.345 KWD passes the minor→major float check but cannot survive the
      // model's 2-decimal cents setter — it must SKIP, never store 12.35.
      row("fils", "12345", daysAgo(3), "KWD"),
      // 12.340 KWD is exact at 2 decimals → imports.
      row("clean", "12340", daysAgo(2), "KWD"),
    ];

    const result = await syncAccountService(String(userId), String(account._id));

    expect(result.imported).toBe(1);
    expect(result.skipped).toBe(1);
    expect(result.warnings?.join(" ")).toMatch(/fils/);
    expect(result.warnings?.join(" ")).toMatch(/cannot be stored exactly/i);

    const raws = await TransactionModel.collection
      .find({ accountId: account._id })
      .toArray();
    expect(raws).toHaveLength(1);
    expect(raws[0].externalId).toBe("clean");
    expect(raws[0].amount).toBe(1234); // 12.34 → 1234 cents, exact
  });

  it("8-decimal currency (BTC-style): a satoshi-scale row never imports as 0", async () => {
    const userId = new mongoose.Types.ObjectId();
    const account = await makeAccount(userId, { currency: "BTC", decimals: 8 });
    fakeBalance = balance("100000000", "BTC", 8);
    fakeRows = [
      // 0.00054321 BTC is double-safe, but the cents setter would store 0 —
      // it must SKIP with a warning, never import a 0-amount row.
      row("sat", "54321", daysAgo(3), "BTC"),
      // 0.25 BTC is exact at 2 decimals → imports.
      row("quarter", "25000000", daysAgo(2), "BTC"),
    ];

    const result = await syncAccountService(String(userId), String(account._id));

    expect(result.imported).toBe(1);
    expect(result.skipped).toBe(1);
    expect(result.warnings?.join(" ")).toMatch(/sat /);

    const raws = await TransactionModel.collection
      .find({ accountId: account._id })
      .toArray();
    expect(raws).toHaveLength(1);
    expect(raws[0].externalId).toBe("quarter");
    expect(raws[0].amount).toBe(25); // 0.25 → 25 cents, exact
  });
});

describe("syncAllAccountsService", () => {
  it("syncs sequentially, isolates failures, and scrubs anything key-shaped", async () => {
    const userId = new mongoose.Types.ObjectId();
    const good = await makeAccount(userId, {
      displayName: "Good bank",
      externalAccountId: "ext-good",
    });
    const bad = await makeAccount(userId, {
      displayName: "Bad rail",
      connectorType: "exploding",
      externalAccountId: "ext-bad",
    });
    // Not swept: manual (no connectorType) and archived accounts.
    await AccountModel.create({
      userId,
      rail: RailEnum.CASH,
      displayName: "Wallet",
      currency: "GBP",
    });
    await makeAccount(userId, {
      displayName: "Old bank",
      externalAccountId: "ext-archived",
      status: "ARCHIVED",
    });

    fakeRows = [row("t1", "-1500", daysAgo(3))];

    const results = await syncAllAccountsService(String(userId));

    expect(results).toHaveLength(2);

    const goodResult = results.find((r) => r.accountId === String(good._id));
    expect(goodResult).toMatchObject({
      displayName: "Good bank",
      ok: true,
      imported: 1,
      skipped: 0,
    });

    const badResult = results.find((r) => r.accountId === String(bad._id));
    expect(badResult?.ok).toBe(false);
    expect(badResult?.error).toBeTruthy();
    // The key-shaped token must be gone; the rest of the message survives.
    expect(badResult?.error).not.toMatch(/rk_test/i);
    expect(badResult?.error).toContain("[redacted]");

    // One account failing did not stop the good one from importing.
    expect(await TransactionModel.countDocuments({ accountId: good._id })).toBe(1);
  });

  it("propagates per-account warnings so a refused balance write is visible in the sweep", async () => {
    const userId = new mongoose.Types.ObjectId();
    // Established GBP account; the rail reports EUR → balance withheld with a
    // warning. That warning must survive into the sync-all entry — otherwise
    // a sweep that refused to write a balance toasts identically to a clean one.
    await makeAccount(userId, {
      balanceMinor: "999",
      balanceAsOf: daysAgo(1),
    });
    fakeBalance = balance("777777", "EUR");
    fakeRows = [];

    const results = await syncAllAccountsService(String(userId));

    expect(results).toHaveLength(1);
    expect(results[0].ok).toBe(true);
    expect(results[0].warnings?.join(" ")).toMatch(/balance not written/i);
  });
});
