import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import AccountModel, { AccountStatusEnum, RailEnum } from "./account.model";
import {
  getAccountByIdService,
  getAllAccountsService,
} from "../services/account.service";

// Real-DB proof of the Account foundation: the string-minor-unit balance must
// survive 18-decimal crypto without float loss, the partial-unique index must
// stop a rail account being onboarded twice, and the read services must be
// scoped to the owner (no IDOR — a guessed id can't read someone else's money).
let mongod: MongoMemoryServer;

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());
  // Build indexes so the partial-unique constraint is actually enforced below.
  await AccountModel.init();
}, 120000); // first run downloads a mongod binary

afterAll(async () => {
  await mongoose.disconnect();
  if (mongod) await mongod.stop();
});

beforeEach(async () => {
  await AccountModel.deleteMany({});
});

describe("Account model defaults", () => {
  it("defaults balance to '0', status ACTIVE, and uppercases currency", async () => {
    const userId = new mongoose.Types.ObjectId();
    const acc = await AccountModel.create({
      userId,
      rail: RailEnum.CRYPTO,
      displayName: "Hot ETH",
      currency: "eth",
      decimals: 18,
    });

    expect(acc.balanceMinor).toBe("0");
    expect(acc.status).toBe(AccountStatusEnum.ACTIVE);
    expect(acc.currency).toBe("ETH");
  });

  it("holds an 18-decimal (wei-scale) balance exactly as a string", async () => {
    const userId = new mongoose.Types.ObjectId();
    // 1.234567890123456789 ETH in wei — far past Number.MAX_SAFE_INTEGER, so a
    // float would mangle it. The string must round-trip byte-for-byte.
    const wei = "1234567890123456789";
    await AccountModel.create({
      userId,
      rail: RailEnum.CRYPTO,
      displayName: "ETH",
      currency: "ETH",
      decimals: 18,
      balanceMinor: wei,
    });

    // Raw driver read (bypasses Mongoose) proves the exact string is on disk.
    const raw = await AccountModel.collection.findOne({ userId });
    expect(raw?.balanceMinor).toBe(wei);
  });
});

describe("Account uniqueness", () => {
  it("rejects a duplicate (user, rail, externalAccountId) but allows many manual accounts", async () => {
    const userId = new mongoose.Types.ObjectId();

    await AccountModel.create({
      userId,
      rail: RailEnum.STRIPE,
      displayName: "Stripe",
      currency: "GBP",
      externalAccountId: "acct_1",
    });

    await expect(
      AccountModel.create({
        userId,
        rail: RailEnum.STRIPE,
        displayName: "Stripe dup",
        currency: "GBP",
        externalAccountId: "acct_1",
      })
    ).rejects.toThrow();

    // Manual accounts carry no externalAccountId, so the partial index exempts
    // them — you can hold several cash floats.
    await AccountModel.create({
      userId,
      rail: RailEnum.CASH,
      displayName: "Wallet",
      currency: "GBP",
    });
    await AccountModel.create({
      userId,
      rail: RailEnum.CASH,
      displayName: "Petty cash",
      currency: "GBP",
    });

    expect(await AccountModel.countDocuments({ userId })).toBe(3);
  });
});

describe("Account read services are owner-scoped (no IDOR)", () => {
  it("getAllAccountsService returns only the caller's accounts", async () => {
    const me = new mongoose.Types.ObjectId();
    const other = new mongoose.Types.ObjectId();
    await AccountModel.create({
      userId: me,
      rail: RailEnum.CASH,
      displayName: "Mine",
      currency: "GBP",
    });
    await AccountModel.create({
      userId: other,
      rail: RailEnum.CASH,
      displayName: "Theirs",
      currency: "GBP",
    });

    const { accounts } = await getAllAccountsService(String(me));
    expect(accounts).toHaveLength(1);
    expect(accounts[0].displayName).toBe("Mine");
  });

  it("getAccountByIdService refuses another owner's account", async () => {
    const me = new mongoose.Types.ObjectId();
    const other = new mongoose.Types.ObjectId();
    const theirs = await AccountModel.create({
      userId: other,
      rail: RailEnum.CASH,
      displayName: "Theirs",
      currency: "GBP",
    });

    await expect(
      getAccountByIdService(String(me), String(theirs._id))
    ).rejects.toThrow();
  });
});
