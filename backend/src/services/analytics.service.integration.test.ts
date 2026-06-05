import { describe, it, expect, beforeAll, afterAll } from "vitest";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import TransactionModel, {
  TransactionTypeEnum,
  PaymentMethodEnum,
} from "../models/transaction.model";
import { chartAnalyticsService } from "./analytics.service";

// Proves the daily chart buckets transactions by the viewer's local day, not
// the UTC day — a 9pm purchase shouldn't jump to the next day on the chart.
let mongod: MongoMemoryServer;

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());
}, 120000);

afterAll(async () => {
  await mongoose.disconnect();
  if (mongod) await mongod.stop();
});

describe("chartAnalyticsService day-bucketing by timezone (real DB)", () => {
  it("buckets a late-night transaction on the local day, not the UTC day", async () => {
    const userId = new mongoose.Types.ObjectId();
    // 2026-05-02T02:00:00Z is still 2026-05-01 (21:00) in America/Chicago.
    await TransactionModel.insertMany([
      {
        userId,
        title: "Late night snack",
        amount: 10,
        type: TransactionTypeEnum.EXPENSE,
        category: "food",
        date: new Date("2026-05-02T02:00:00Z"),
        paymentMethod: PaymentMethodEnum.CARD,
      },
    ]);

    const from = new Date("2026-04-25T00:00:00Z");
    const to = new Date("2026-05-05T00:00:00Z");

    // No timezone -> UTC day.
    const utc = await chartAnalyticsService(userId.toString(), undefined, from, to);
    expect(utc.chartData[0].date).toBe("2026-05-02");

    // Chicago -> the local day.
    const chicago = await chartAnalyticsService(
      userId.toString(),
      undefined,
      from,
      to,
      "America/Chicago"
    );
    expect(chicago.chartData[0].date).toBe("2026-05-01");
  });
});
