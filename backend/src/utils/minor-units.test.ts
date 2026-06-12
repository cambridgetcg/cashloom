import { describe, it, expect } from "vitest";
import { formatMinor, minorToMajor, minorToMajorIsSafe } from "./minor-units";
import { AppError } from "./app-error";

const MAX_SAFE = String(Number.MAX_SAFE_INTEGER); // "9007199254740991"
const ONE_ETH_WEI = "1000000000000000000"; // 1e18 > MAX_SAFE_INTEGER

describe("formatMinor", () => {
  it("formats 2-decimal fiat (GBP/USD)", () => {
    expect(formatMinor("123456", 2)).toBe("1234.56");
    expect(formatMinor("1210", 2)).toBe("12.10");
    expect(formatMinor("5", 2)).toBe("0.05");
    expect(formatMinor("0", 2)).toBe("0.00");
  });

  it("formats 0-decimal currencies (JPY) without a decimal point", () => {
    expect(formatMinor("500", 0)).toBe("500");
    expect(formatMinor("-42", 0)).toBe("-42");
    expect(formatMinor("0", 0)).toBe("0");
  });

  it("formats 6-decimal assets (USDC)", () => {
    expect(formatMinor("1230000", 6)).toBe("1.230000");
    expect(formatMinor("123456789", 6)).toBe("123.456789");
    expect(formatMinor("1", 6)).toBe("0.000001");
  });

  it("formats 18-decimal assets (ETH wei) exactly — no float anywhere", () => {
    expect(formatMinor(ONE_ETH_WEI, 18)).toBe("1.000000000000000000");
    expect(formatMinor("1", 18)).toBe("0.000000000000000001");
    expect(formatMinor("-1", 18)).toBe("-0.000000000000000001");
    // Well beyond MAX_SAFE_INTEGER: every digit must survive.
    expect(formatMinor("123456789012345678901234567890", 18)).toBe(
      "123456789012.345678901234567890"
    );
  });

  it("handles negative amounts", () => {
    expect(formatMinor("-123456", 2)).toBe("-1234.56");
    expect(formatMinor("-5", 2)).toBe("-0.05");
  });

  it("normalizes leading zeros and -0", () => {
    expect(formatMinor("007", 2)).toBe("0.07");
    expect(formatMinor("-007", 2)).toBe("-0.07");
    expect(formatMinor("-0", 2)).toBe("0.00");
    expect(formatMinor("-0", 0)).toBe("0");
    expect(formatMinor("000", 2)).toBe("0.00");
  });

  it("rejects non-integer strings", () => {
    for (const bad of ["12.5", "", " 12", "12 ", "+5", "1e5", "0x10", "--1", "-", "abc"]) {
      expect(() => formatMinor(bad, 2), `input ${JSON.stringify(bad)}`).toThrow(
        AppError
      );
    }
  });

  it("rejects invalid decimals", () => {
    expect(() => formatMinor("100", -1)).toThrow(AppError);
    expect(() => formatMinor("100", 2.5)).toThrow(AppError);
    expect(() => formatMinor("100", 31)).toThrow(AppError);
    expect(() => formatMinor("100", NaN)).toThrow(AppError);
  });
});

describe("minorToMajor", () => {
  it("converts 2-decimal fiat exactly", () => {
    expect(minorToMajor("1210", 2)).toBe(12.1);
    expect(minorToMajor("123456", 2)).toBe(1234.56);
    expect(minorToMajor("0", 2)).toBe(0);
  });

  it("converts 0-decimal currencies (JPY)", () => {
    expect(minorToMajor("500", 0)).toBe(500);
    expect(minorToMajor("-42", 0)).toBe(-42);
  });

  it("converts 6-decimal assets (USDC)", () => {
    expect(minorToMajor("1230000", 6)).toBe(1.23);
    expect(minorToMajor("123456789", 6)).toBe(123.456789);
  });

  it("handles negatives, leading zeros, and -0", () => {
    expect(minorToMajor("-1210", 2)).toBe(-12.1);
    expect(minorToMajor("007", 2)).toBe(0.07);
    expect(minorToMajor("-0", 2)).toBe(0);
  });

  it("survives the full safe range at the boundary", () => {
    expect(minorToMajor(MAX_SAFE, 0)).toBe(Number.MAX_SAFE_INTEGER);
    // /100 then back: the round-trip guard must hold right at the edge.
    expect(minorToMajor(MAX_SAFE, 2)).toBe(90071992547409.91);
    expect(minorToMajor(`-${MAX_SAFE}`, 2)).toBe(-90071992547409.91);
  });

  it("allows small 18-decimal amounts (the value itself is safe)", () => {
    expect(minorToMajor("1000", 18)).toBe(1e-15);
    expect(minorToMajor("-1", 18)).toBe(-1e-18);
  });

  it("throws when |amount| exceeds Number.MAX_SAFE_INTEGER (wei must not reach the float path)", () => {
    expect(() => minorToMajor(ONE_ETH_WEI, 18)).toThrow(AppError);
    expect(() => minorToMajor(`-${ONE_ETH_WEI}`, 18)).toThrow(AppError);
    // First unsafe integer, even for plain fiat decimals.
    expect(() => minorToMajor("9007199254740992", 2)).toThrow(AppError);
    expect(() => minorToMajor("-9007199254740992", 2)).toThrow(AppError);
  });

  it("names the offending amount, not a mangled float, in the error", () => {
    expect(() => minorToMajor(ONE_ETH_WEI, 18)).toThrow(ONE_ETH_WEI);
  });

  it("rejects non-integer strings and invalid decimals", () => {
    expect(() => minorToMajor("12.5", 2)).toThrow(AppError);
    expect(() => minorToMajor("", 2)).toThrow(AppError);
    expect(() => minorToMajor("1e5", 2)).toThrow(AppError);
    expect(() => minorToMajor("100", -1)).toThrow(AppError);
    expect(() => minorToMajor("100", 2.5)).toThrow(AppError);
  });

  it("agrees with formatMinor across scales", () => {
    for (const [minor, decimals] of [
      ["123456", 2],
      ["-1210", 2],
      ["500", 0],
      ["1230000", 6],
      ["1000", 18],
    ] as const) {
      expect(minorToMajor(minor, decimals)).toBe(
        Number(formatMinor(minor, decimals))
      );
    }
  });
});

describe("minorToMajorIsSafe", () => {
  it("is true for the fiat range", () => {
    expect(minorToMajorIsSafe("123456", 2)).toBe(true);
    expect(minorToMajorIsSafe("-123456", 2)).toBe(true);
    expect(minorToMajorIsSafe("500", 0)).toBe(true);
    expect(minorToMajorIsSafe(MAX_SAFE, 2)).toBe(true);
  });

  it("is false beyond the safe-integer range", () => {
    expect(minorToMajorIsSafe(ONE_ETH_WEI, 18)).toBe(false);
    expect(minorToMajorIsSafe("9007199254740992", 2)).toBe(false);
  });

  it("is false for malformed input instead of throwing", () => {
    expect(minorToMajorIsSafe("12.5", 2)).toBe(false);
    expect(minorToMajorIsSafe("", 2)).toBe(false);
    expect(minorToMajorIsSafe("100", -1)).toBe(false);
  });
});
