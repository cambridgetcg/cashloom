import { describe, expect, it } from "bun:test";
import { prepareActivityImport } from "./import-export";

const account = { id: "one", currency: "USD", decimals: 2 };
const header = "date,title,amount,currency,category\r\n";

describe("reviewed activity import", () => {
  it("preserves exact large amounts, sign, quoted commas and repeated rows", () => {
    const row = '2026-09-29,"Books, paper",-90071992547409.91,USD,office\r\n';
    const preview = prepareActivityImport(account, header + row + row);
    expect(preview.rows.map((value) => value.amount_minor)).toEqual(["-9007199254740991", "-9007199254740991"]);
    expect(preview.rows[0].title).toBe("Books, paper");
    expect(preview.rows[0].external_id).not.toBe(preview.rows[1].external_id);
    expect(prepareActivityImport(account, header + row + row)).toEqual(preview);
  });
  it("binds review to the destination account and category edits", () => {
    const csv = header + "2026-09-29,Coffee,4.50,USD,food";
    const original = prepareActivityImport(account, csv);
    expect(prepareActivityImport({ ...account, id: "two" }, csv).preview_hash).not.toBe(original.preview_hash);
    const changed = prepareActivityImport(account, csv.replace("food", "work"));
    expect(changed.preview_hash).not.toBe(original.preview_hash);
    expect(changed.rows[0].external_id).toBe(original.rows[0].external_id);
  });
  it("keeps row identities stable when a file is reordered", () => {
    const a = "2026-09-29,Coffee,-4.50,USD,food\n";
    const b = "2026-09-28,Income,100,USD,work\n";
    const one = prepareActivityImport(account, header + a + b);
    const two = prepareActivityImport(account, header + b + a);
    expect(one.rows.map((row) => row.external_id).sort()).toEqual(two.rows.map((row) => row.external_id).sort());
  });
  it.each([
    "2026-02-30,Coffee,4.50,USD,food",
    "2026-09-29,Coffee,4.501,USD,food",
    "2026-09-29,Coffee,4.50,EUR,food",
    "2026-09-29,Coffee,1e3,USD,food",
    "2026-09-29,Coffee,NaN,USD,food",
    '2026-09-29,"Coffee,4.50,USD,food',
    '2026-09-29,"Coffee"tail,4.50,USD,food',
    '2026-09-29,"Coffee\nshop",4.50,USD,food',
    '2026-09-29,Coffee,4.50,USD,"food\u0000"',
  ])("refuses malformed input without a partial preview: %s", (row) => {
    expect(() => prepareActivityImport(account, header + row)).toThrow();
  });
  it("enforces input bounds and precise header shape", () => {
    expect(() => prepareActivityImport(account, "x".repeat(1_000_001))).toThrow(/smaller than/);
    expect(() => prepareActivityImport(account, header + "2026-09-29,A,1,USD,\n".repeat(2_001))).toThrow(/2,000/);
    expect(() => prepareActivityImport(account, "date,title,amount,amount\n2026-09-29,A,1,USD")).toThrow(/columns/);
  });
  it("binds normalized reusable references to a reviewed row and account", () => {
    const csv = header + "2026-09-29,Coffee,-4.50,USD,food";
    const original = prepareActivityImport(account, csv);
    const choice = { row_id: original.rows[0].row_id, reference: "  Statement 18  " };
    const reviewed = prepareActivityImport(account, csv, [choice]);
    expect(reviewed.distinct_rows).toEqual([{ ...choice, reference: "Statement 18" }]);
    expect(reviewed.preview_hash).not.toBe(original.preview_hash);
    expect(prepareActivityImport(account, csv, [{ ...choice, reference: "Statement 18" }]).preview_hash).toBe(reviewed.preview_hash);
    expect(prepareActivityImport({ ...account, id: "two" }, csv, [choice]).rows[0].external_id).not.toBe(reviewed.rows[0].external_id);
    const changed = prepareActivityImport(account, csv.replace("4.50", "9.00"));
    expect(prepareActivityImport(account, csv.replace("4.50", "9.00"), [{ ...choice, row_id: changed.rows[0].row_id }]).rows[0].external_id).toBe(reviewed.rows[0].external_id);
  });
  it("refuses unknown rows, repeated choices, duplicate references and unsafe reference text", () => {
    const csv = header + "2026-09-29,Coffee,-4.50,USD,food\n".repeat(2);
    const rows = prepareActivityImport(account, csv).rows;
    const choice = { row_id: rows[0].row_id, reference: "statement 18" };
    expect(() => prepareActivityImport(account, csv, [{ ...choice, row_id: "unknown" }])).toThrow(/from this preview/);
    expect(() => prepareActivityImport(account, csv, [choice, choice])).toThrow(/once/);
    expect(() => prepareActivityImport(account, csv, [choice, { ...choice, row_id: rows[1].row_id }])).toThrow(/different reference/);
    for (const reference of [" ", "x".repeat(121), "one\ntwo", "one\u0000two"]) {
      expect(() => prepareActivityImport(account, csv, [{ ...choice, reference }])).toThrow(/1–120/);
    }
  });
});
