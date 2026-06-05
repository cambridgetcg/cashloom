import { describe, it, expect, beforeAll, afterAll } from "vitest";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import {
  TransactionTypeEnum,
  PaymentMethodEnum,
} from "../models/transaction.model";

// bulkTransactionService pulls in env-validated config, so set dummy env first
// and import it dynamically. (Reusable pattern for service-level DB tests.)
let mongod: MongoMemoryServer;
let bulkTransactionService: (
  userId: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  txs: any[]
) => Promise<{ insertedCount: number; skippedCount: number; success: boolean }>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let TransactionModel: any;

beforeAll(async () => {
  process.env.MONGO_URI ||= "mongodb://test";
  process.env.GEMINI_API_KEY ||= "test";
  process.env.CLOUDINARY_CLOUD_NAME ||= "test";
  process.env.CLOUDINARY_API_KEY ||= "test";
  process.env.CLOUDINARY_API_SECRET ||= "test";
  process.env.RESEND_API_KEY ||= "test";

  ({ bulkTransactionService } = await import("./transaction.service"));
  ({ default: TransactionModel } = await import("../models/transaction.model"));

  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());
}, 120000);

afterAll(async () => {
  await mongoose.disconnect();
  if (mongod) await mongod.stop();
});

const row = (title: string, amount: number, day: string) => ({
  title,
  amount,
  type: TransactionTypeEnum.EXPENSE,
  category: "food",
  date: new Date(day),
  paymentMethod: PaymentMethodEnum.CARD,
  isRecurring: false,
});

describe("bulkTransactionService dedup (real DB)", () => {
  it("inserts a fresh batch, then skips re-imported overlaps", async () => {
    const userId = new mongoose.Types.ObjectId().toString();

    const first = await bulkTransactionService(userId, [
      row("Tesco", 42.1, "2026-05-01"),
      row("Salary", 2200, "2026-05-02"),
    ]);
    expect(first.insertedCount).toBe(2);
    expect(first.skippedCount).toBe(0);

    // Re-import: one duplicate (same title+day+amount) + one new.
    const second = await bulkTransactionService(userId, [
      row("Tesco", 42.1, "2026-05-01"),
      row("Coffee", 3.5, "2026-05-03"),
    ]);
    expect(second.insertedCount).toBe(1);
    expect(second.skippedCount).toBe(1);

    const total = await TransactionModel.countDocuments({
      userId: new mongoose.Types.ObjectId(userId),
    });
    expect(total).toBe(3); // Tesco, Salary, Coffee — not 4
  });
});
