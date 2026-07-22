import { describe, it, expect } from "vitest";
import { divHalfEven, applyRate } from "./minor-units";

describe("divHalfEven", () => {
  it("rounds half to even, both parities", () => {
    expect(divHalfEven(7n, 2n)).toBe(4n); // 3.5 → 4 (3 is odd)
    expect(divHalfEven(5n, 2n)).toBe(2n); // 2.5 → 2 (2 is even)
    expect(divHalfEven(1n, 2n)).toBe(0n); // 0.5 → 0
    expect(divHalfEven(3n, 2n)).toBe(2n); // 1.5 → 2
  });

  it("rounds non-ties normally", () => {
    expect(divHalfEven(1n, 3n)).toBe(0n);
    expect(divHalfEven(2n, 3n)).toBe(1n);
    expect(divHalfEven(10n, 3n)).toBe(3n);
  });

  it("is sign-correct", () => {
    expect(divHalfEven(-5n, 2n)).toBe(-2n);
    expect(divHalfEven(-7n, 2n)).toBe(-4n);
    expect(divHalfEven(5n, -2n)).toBe(-2n);
    expect(divHalfEven(-5n, -2n)).toBe(2n);
  });

  it("refuses division by zero", () => {
    expect(() => divHalfEven(1n, 0n)).toThrow();
  });
});

describe("applyRate", () => {
  it("converts fiat→fiat exactly (100.00 GBP @ 1.28 → 128.00 USD)", () => {
    expect(applyRate("10000", 2, "128", 2, 2)).toBe("12800");
  });

  it("survives wei scale without precision loss (1 ETH @ 3500.00000000 USD)", () => {
    expect(applyRate("1000000000000000000", 18, "350000000000", 8, 2)).toBe("350000");
  });

  it("applies half-even at the final digit only", () => {
    // 1 unit @ rate 2.5, to 0 decimals: 2.5 → 2 (even)
    expect(applyRate("1", 0, "25", 1, 0)).toBe("2");
    // 3 units @ rate 2.5 → 7.5 → 8 (7 is odd)
    expect(applyRate("3", 0, "25", 1, 0)).toBe("8");
  });

  it("handles negative amounts", () => {
    expect(applyRate("-10000", 2, "128", 2, 2)).toBe("-12800");
  });

  it("scales up exactly when the exponent is positive", () => {
    // 5.00 (dec 2) @ rate 2 (scale 0) into an 8-decimal asset: 10.00000000
    expect(applyRate("500", 2, "2", 0, 8)).toBe("1000000000");
  });

  it("refuses malformed inputs", () => {
    expect(() => applyRate("1.5", 2, "128", 2, 2)).toThrow();
    expect(() => applyRate("10000", 2, "1.28", 2, 2)).toThrow();
    expect(() => applyRate("10000", -1, "128", 2, 2)).toThrow();
    expect(() => applyRate("10000", 2, "128", 31, 2)).toThrow();
  });
});
