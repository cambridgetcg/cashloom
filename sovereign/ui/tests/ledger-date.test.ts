import { describe, expect, test } from "bun:test";
import { activityDate, ledgerDateToIso } from "../src/views/Ledger";

describe("ledger calendar date to API instant", () => {
  test("preserves the selected local day and emits the ISO datetime required by the API", () => {
    const result = ledgerDateToIso("2026-09-23")!;
    expect(result).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    const date = new Date(result);
    expect([date.getFullYear(), date.getMonth() + 1, date.getDate(), date.getHours()]).toEqual([2026, 9, 23, 0]);
    expect(ledgerDateToIso("")).toBeUndefined();
  });
  test("rejects invalid calendar dates instead of normalizing into a different day", () => {
    for (const day of ["2026-02-30", "2026-13-01", "not a date", "2026-09-23T12:00:00Z"]) expect(() => ledgerDateToIso(day)).toThrow();
  });
  test("imported calendar days use UTC even at an instant that falls on a different local day", () => {
    const date = "2026-09-29T12:00:00.000Z";
    const expected = new Date(date).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
    expect(activityDate({ date, source: "CSV" })).toBe(expected);
    expect(activityDate({ date: "not-a-date", source: "CSV" })).toBe("not-a-date");
  });
});
