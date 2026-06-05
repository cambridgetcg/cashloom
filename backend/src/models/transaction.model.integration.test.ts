import { describe, it, expect, beforeAll, afterAll } from "vitest";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import TransactionModel, {
  TransactionTypeEnum,
  PaymentMethodEnum,
} from "./transaction.model";

// End-to-end proof of the money round-trip against a real MongoDB: the bug the
// whole product depends on not having. insertMany (the CSV/AI bulk path) must
// run the schema setter so dollars are stored as integer cents, and the getter
// must read them back as dollars. The old bulkWrite/insertOne bypassed the
// setter and stored raw dollars where cents belong — every amount 100x wrong.
let mongod: MongoMemoryServer;

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());
}, 120000); // first run downloads a mongod binary

afterAll(async () => {
  await mongoose.disconnect();
  if (mongod) await mongod.stop();
});

const txInput = (userId: mongoose.Types.ObjectId, amount: number) => ({
  userId,
  title: "Test",
  amount,
  type: TransactionTypeEnum.EXPENSE,
  category: "food",
  date: new Date("2026-05-01"),
  paymentMethod: PaymentMethodEnum.CARD,
});

describe("Transaction amount cents round-trip (real DB)", () => {
  it("stores integer cents, reads back dollars ($10.00 -> $10.00)", async () => {
    const userId = new mongoose.Types.ObjectId();
    await TransactionModel.insertMany([txInput(userId, 10)]);

    // Mongoose getter converts cents -> dollars on read.
    const tx = await TransactionModel.findOne({ userId });
    expect(tx?.amount).toBe(10);

    // Raw driver read (bypasses the getter) proves cents are what's stored.
    const raw = await TransactionModel.collection.findOne({ userId });
    expect(raw?.amount).toBe(1000);
  });

  it("survives float imprecision (19.99 -> 1999 cents -> 19.99)", async () => {
    const userId = new mongoose.Types.ObjectId();
    await TransactionModel.insertMany([txInput(userId, 19.99)]);

    const raw = await TransactionModel.collection.findOne({ userId });
    expect(raw?.amount).toBe(1999);

    const tx = await TransactionModel.findOne({ userId });
    expect(tx?.amount).toBe(19.99);
  });
});
