import { describe, it, expect } from "vitest";
import { convertToCents, convertToDollarUnit } from "./format-currency";

// The money primitive every balance, chart, and AI report trusts.
// Amounts are stored as integer cents (schema setter on Transaction.amount)
// and read back as dollars (getter). This locks the round-trip so a future
// refactor can't silently reintroduce drift.
describe("currency cents round-trip", () => {
  it("converts dollars to integer cents", () => {
    expect(convertToCents(10)).toBe(1000);
    expect(convertToCents(10.99)).toBe(1099);
    expect(convertToCents(0.1)).toBe(10);
  });

  it("round-trips dollars -> cents -> dollars without drift", () => {
    for (const amount of [10, 10.99, 0.1, 1234.56, 0.01, 999999.99]) {
      expect(convertToDollarUnit(convertToCents(amount))).toBe(amount);
    }
  });

  it("always stores an integer (survives float imprecision a naive *100 would not)", () => {
    // 19.99 * 100 === 1998.9999999999998 in JS; Math.round rescues it.
    expect(convertToCents(19.99)).toBe(1999);
    expect(Number.isInteger(convertToCents(19.99))).toBe(true);
  });
});

// FOLLOW-UP (ROADMAP must-do): a DB-level integration test proving the CSV
// bulk path round-trips ($10 imported -> $10 in analytics). The bug was
// `bulkWrite/insertOne` bypassing the cents setter; fixed in
// transaction.service.ts by switching to `insertMany`. Verifying it end-to-end
// needs a test DB harness (mongodb-memory-server) — the next test to add.
