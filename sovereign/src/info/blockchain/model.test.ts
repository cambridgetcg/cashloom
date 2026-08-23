import { describe, expect, it } from "vitest";
import { decimalFromRaw, exactValue, exactValueFromDecimal } from "./model.ts";

describe("onchain exact values", () => {
  it("renders fixed-point chain integers without Number", () => {
    expect(decimalFromRaw("123456789012345678901", 18)).toBe("123.456789012345678901");
    expect(decimalFromRaw("1000000", 6)).toBe("1");
    expect(decimalFromRaw("-125", 2)).toBe("-1.25");
  });

  it("retains the raw integer beside the human decimal", () => {
    expect(exactValue("130", 2, "basis_points")).toEqual({
      raw: "130",
      decimal: "1.3",
      decimals: 2,
      unit: "basis_points",
      display: "1.3 basis_points",
    });
  });

  it("preserves publisher decimal lexemes as integer plus scale", () => {
    expect(exactValueFromDecimal("12.50", "sat/vB")).toEqual({
      raw: "1250",
      decimal: "12.5",
      decimals: 2,
      unit: "sat/vB",
      display: "12.5 sat/vB",
    });
    expect(() => exactValueFromDecimal("1e3", "units")).toThrow();
  });
});
