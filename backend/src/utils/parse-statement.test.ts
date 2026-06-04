import { describe, it, expect } from "vitest";
import { normalizeParsedRows, MAX_IMPORT_ROWS } from "./parse-statement";
import {
  PaymentMethodEnum,
  TransactionTypeEnum,
} from "../models/transaction.model";

describe("normalizeParsedRows", () => {
  it("returns [] for non-array input", () => {
    expect(normalizeParsedRows(null)).toEqual([]);
    expect(normalizeParsedRows(undefined)).toEqual([]);
    expect(normalizeParsedRows("nope")).toEqual([]);
    expect(normalizeParsedRows({})).toEqual([]);
  });

  it("drops rows missing a title, amount, or date", () => {
    const rows = [
      { amount: 10, date: "2026-05-01" }, // no title
      { title: "  ", amount: 10, date: "2026-05-01" }, // blank title
      { title: "No amount", date: "2026-05-01" }, // no amount
      { title: "Bad date", amount: 10, date: "not-a-date" }, // bad date
      { title: "Good", amount: 10, date: "2026-05-01" },
    ];
    const out = normalizeParsedRows(rows);
    expect(out).toHaveLength(1);
    expect(out[0].title).toBe("Good");
  });

  it("requires a positive amount (drops zero / negative)", () => {
    const rows = [
      { title: "Zero", amount: 0, date: "2026-05-01" },
      { title: "Negative", amount: -5, date: "2026-05-01" },
      { title: "Positive", amount: 5, date: "2026-05-01" },
    ];
    const out = normalizeParsedRows(rows);
    expect(out.map((r) => r.title)).toEqual(["Positive"]);
    expect(out[0].amount).toBe(5);
  });

  it("coerces the date to an ISO string", () => {
    const out = normalizeParsedRows([
      { title: "T", amount: 1, date: "2026-05-01" },
    ]);
    expect(out[0].date).toBe(new Date("2026-05-01").toISOString());
  });

  it("defaults type to EXPENSE, keeps INCOME when stated", () => {
    const out = normalizeParsedRows([
      { title: "Spend", amount: 1, date: "2026-05-01" },
      { title: "Earn", amount: 1, date: "2026-05-01", type: "INCOME" },
      { title: "Junk", amount: 1, date: "2026-05-01", type: "WHATEVER" },
    ]);
    expect(out[0].type).toBe(TransactionTypeEnum.EXPENSE);
    expect(out[1].type).toBe(TransactionTypeEnum.INCOME);
    expect(out[2].type).toBe(TransactionTypeEnum.EXPENSE);
  });

  it("keeps a valid paymentMethod, falls back to BANK_TRANSFER otherwise", () => {
    const out = normalizeParsedRows([
      { title: "A", amount: 1, date: "2026-05-01", paymentMethod: "CARD" },
      { title: "B", amount: 1, date: "2026-05-01", paymentMethod: "PIGEON" },
      { title: "C", amount: 1, date: "2026-05-01" },
    ]);
    expect(out[0].paymentMethod).toBe(PaymentMethodEnum.CARD);
    expect(out[1].paymentMethod).toBe(PaymentMethodEnum.BANK_TRANSFER);
    expect(out[2].paymentMethod).toBe(PaymentMethodEnum.BANK_TRANSFER);
  });

  it("lowercases + trims category, defaults to 'uncategorized'", () => {
    const out = normalizeParsedRows([
      { title: "A", amount: 1, date: "2026-05-01", category: "  Groceries " },
      { title: "B", amount: 1, date: "2026-05-01" },
      { title: "C", amount: 1, date: "2026-05-01", category: "   " },
    ]);
    expect(out[0].category).toBe("groceries");
    expect(out[1].category).toBe("uncategorized");
    expect(out[2].category).toBe("uncategorized");
  });

  it("keeps description only when it is a string", () => {
    const out = normalizeParsedRows([
      { title: "A", amount: 1, date: "2026-05-01", description: "note" },
      { title: "B", amount: 1, date: "2026-05-01", description: 123 },
    ]);
    expect(out[0].description).toBe("note");
    expect(out[1].description).toBeUndefined();
  });

  it("caps the batch at MAX_IMPORT_ROWS", () => {
    const many = Array.from({ length: MAX_IMPORT_ROWS + 50 }, (_, i) => ({
      title: `tx ${i}`,
      amount: 1,
      date: "2026-05-01",
    }));
    expect(normalizeParsedRows(many)).toHaveLength(MAX_IMPORT_ROWS);
  });
});
