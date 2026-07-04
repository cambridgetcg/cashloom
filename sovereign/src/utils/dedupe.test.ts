import { describe, it, expect } from "vitest";
import { transactionKey, splitNewRows, dedupeKey, externalKey } from "./dedupe";

describe("transactionKey", () => {
  it("keys by lowercased+trimmed title, calendar day, and 2dp amount", () => {
    expect(transactionKey("  Tesco ", "2026-05-01T10:00:00Z", 42.1)).toBe(
      "tesco|2026-05-01|42.10"
    );
  });

  it("treats the same calendar day as equal regardless of time", () => {
    const morning = transactionKey("X", "2026-05-01T09:00:00Z", 5);
    const night = transactionKey("X", "2026-05-01T23:30:00Z", 5);
    expect(morning).toBe(night);
  });

  it("matches case/spacing-insensitively and on the rounded amount", () => {
    expect(transactionKey("Coffee Shop", "2026-05-03", 3.5)).toBe(
      transactionKey("  coffee shop ", "2026-05-03T12:00:00Z", 3.5)
    );
  });
});

describe("splitNewRows", () => {
  it("skips rows whose key already exists", () => {
    const incoming = [
      { title: "Tesco", date: "2026-05-01", amount: 42.1 },
      { title: "Salary", date: "2026-05-02", amount: 2200 },
    ];
    const existing = new Set([transactionKey("Tesco", "2026-05-01", 42.1)]);
    const { toInsert, skippedCount } = splitNewRows(incoming, existing);
    expect(skippedCount).toBe(1);
    expect(toInsert).toHaveLength(1);
    expect(toInsert[0].title).toBe("Salary");
  });

  it("keeps everything when nothing matches", () => {
    const incoming = [{ title: "A", date: "2026-05-01", amount: 1 }];
    const { toInsert, skippedCount } = splitNewRows(incoming, new Set());
    expect(skippedCount).toBe(0);
    expect(toInsert).toHaveLength(1);
  });

  it("skips a whole re-imported batch (all keys already present)", () => {
    const batch = [
      { title: "Tesco", date: "2026-05-01", amount: 42.1 },
      { title: "Salary", date: "2026-05-02", amount: 2200 },
    ];
    const existing = new Set(
      batch.map((b) => transactionKey(b.title, b.date, b.amount))
    );
    const { toInsert, skippedCount } = splitNewRows(batch, existing);
    expect(skippedCount).toBe(2);
    expect(toInsert).toHaveLength(0);
  });
});

describe("dedupeKey (connector rows)", () => {
  it("keys connector rows on account + externalId, ignoring title/date/amount", () => {
    const a = dedupeKey({
      title: "Whatever",
      date: "2026-05-01",
      amount: 5,
      accountId: "acc1",
      externalId: "txn_123",
    });
    const b = dedupeKey({
      title: "Totally different",
      date: "2026-06-09",
      amount: 999,
      accountId: "acc1",
      externalId: "txn_123",
    });
    expect(a).toBe(b);
    expect(a).toBe(externalKey("acc1", "txn_123"));
  });

  it("falls back to the day|title|amount heuristic when externalId is absent", () => {
    expect(
      dedupeKey({ title: "Tesco", date: "2026-05-01", amount: 42.1 })
    ).toBe(transactionKey("Tesco", "2026-05-01", 42.1));
  });

  it("does not collide across accounts that share an externalId", () => {
    const a = dedupeKey({
      title: "x",
      date: "2026-05-01",
      amount: 1,
      accountId: "accA",
      externalId: "txn_1",
    });
    const b = dedupeKey({
      title: "x",
      date: "2026-05-01",
      amount: 1,
      accountId: "accB",
      externalId: "txn_1",
    });
    expect(a).not.toBe(b);
  });
});

describe("splitNewRows with connector ids", () => {
  it("dedupes two rows sharing accountId+externalId down to none-new", () => {
    const incoming = [
      { title: "A", date: "2026-05-01", amount: 1, accountId: "acc1", externalId: "e1" },
      { title: "A again", date: "2026-05-02", amount: 2, accountId: "acc1", externalId: "e1" },
    ];
    const { toInsert, skippedCount } = splitNewRows(
      incoming,
      new Set([externalKey("acc1", "e1")])
    );
    expect(skippedCount).toBe(2);
    expect(toInsert).toHaveLength(0);
  });

  it("still applies the heuristic to rows without an externalId", () => {
    const incoming = [{ title: "Tesco", date: "2026-05-01", amount: 42.1 }];
    const existing = new Set([transactionKey("Tesco", "2026-05-01", 42.1)]);
    const { toInsert, skippedCount } = splitNewRows(incoming, existing);
    expect(skippedCount).toBe(1);
    expect(toInsert).toHaveLength(0);
  });
});
