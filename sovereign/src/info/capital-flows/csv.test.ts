import { describe, expect, it } from "vitest";
import { CAPITAL_LIMITS } from "./model.ts";
import { parseCsv } from "./csv.ts";

describe("bounded quoted CSV/TSV parser (synthetic inputs)", () => {
  it("preserves quoted commas, doubled quotes, line endings and exact decimal strings", () => {
    expect(parseCsv('KEY,TITLE,OBS_VALUE\r\nx,"Shares, \"\"issued\"\"\r\nby funds",-7624.610838520014\r\n'))
      .toEqual([["KEY", "TITLE", "OBS_VALUE"], ["x", 'Shares, "issued"\r\nby funds', "-7624.610838520014"]]);
  });
  it("accepts BOM, LF, CR, no final newline, empty fields and quoted empties", () => {
    expect(parseCsv('﻿A,B,C\nx,,""\ry," a ",')).toEqual([["A", "B", "C"], ["x", "", ""], ["y", " a ", ""]]);
    expect(parseCsv(",")).toEqual([["", ""]]);
    expect(parseCsv('""')).toEqual([[""]]);
  });
  it("does not fabricate records after final newline or drop interior blank records", () => {
    expect(parseCsv("A\nx\n")).toEqual([["A"], ["x"]]);
    expect(parseCsv("A\n\nx\n")).toEqual([["A"], [""], ["x"]]);
    expect(parseCsv("")).toEqual([]);
    expect(parseCsv("﻿")).toEqual([]);
  });
  it("can parse tab-delimited US data without treating commas as delimiters", () => {
    expect(parseCsv('a\tb\n"x\ty"\t1,234\n', "\t")).toEqual([["a", "b"], ["x\ty", "1,234"]]);
  });
  it.each(['a"b,c', '"a"x,b', '"a" "b",c', '"unclosed', '"a"\"'])
    ("rejects malformed quotation %j", input => expect(() => parseCsv(input)).toThrow(/csv_/));
  it("bounds input size, a field, columns and rows before unbounded allocation", () => {
    expect(() => parseCsv("x".repeat(CAPITAL_LIMITS.responseBytes + 1))).toThrow("csv_size_limit");
    expect(() => parseCsv("x".repeat(128 * 1024 + 1))).toThrow("csv_field_limit");
    expect(() => parseCsv(new Array(129).fill("").join(","))).toThrow("csv_column_limit");
    expect(() => parseCsv("x\n".repeat(CAPITAL_LIMITS.rows + 2))).toThrow("csv_row_limit");
    expect(parseCsv("x\n".repeat(CAPITAL_LIMITS.rows + 1))).toHaveLength(CAPITAL_LIMITS.rows + 1);
  });
  it("rejects unsupported delimiters at the runtime boundary", () => {
    expect(() => parseCsv("a;b", ";" as ",")).toThrow("csv_delimiter");
  });
});
