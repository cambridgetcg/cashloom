import { describe, it, expect } from "vitest";
import {
  RATE_SCALE,
  scaleRateToBigInt,
  convertMinor,
  minorUnitsFor,
} from "./rate-math";
import { AppError } from "./app-error";

// 123.456789012345678901 ETH in wei — far above Number.MAX_SAFE_INTEGER, so
// any float on the path would corrupt it.
const BIG_WEI = "123456789012345678901";

// 2000.5 GBP per ETH at scale 12.
const ETH_GBP_RATE = 2000500000000000n;

describe("RATE_SCALE", () => {
  it("is pinned at 12 (P2-4/P2-5 build against this)", () => {
    expect(RATE_SCALE).toBe(12);
  });
});

describe("scaleRateToBigInt", () => {
  it("scales plain decimals to scale-12 BigInts", () => {
    expect(scaleRateToBigInt("0.1")).toBe(100000000000n);
    expect(scaleRateToBigInt("0.79")).toBe(790000000000n);
    expect(scaleRateToBigInt("1")).toBe(1000000000000n);
    expect(scaleRateToBigInt("2000.5")).toBe(2000500000000000n);
    expect(scaleRateToBigInt("67123.45")).toBe(67123450000000000n);
    expect(scaleRateToBigInt("0")).toBe(0n);
    expect(scaleRateToBigInt("0.000000000001")).toBe(1n);
  });

  it("keeps long fractions exactly up to the scale", () => {
    expect(scaleRateToBigInt("0.123456789012")).toBe(123456789012n);
    expect(scaleRateToBigInt("195.123456789012")).toBe(195123456789012n);
  });

  it("rounds the first truncated digit HALF-UP", () => {
    expect(scaleRateToBigInt("0.1234567890125")).toBe(123456789013n);
    expect(scaleRateToBigInt("0.1234567890124999")).toBe(123456789012n);
    // Carry propagates through every digit.
    expect(scaleRateToBigInt("0.9999999999995")).toBe(1000000000000n);
    expect(scaleRateToBigInt("1.9999999999996")).toBe(2000000000000n);
  });

  it("normalizes scientific notation before scaling (JSON doubles stringify as e-notation)", () => {
    expect(scaleRateToBigInt("1e-7")).toBe(100000n);
    expect(scaleRateToBigInt("1.23e+4")).toBe(12300000000000000n);
    expect(scaleRateToBigInt("1.5E3")).toBe(1500000000000000n);
    expect(scaleRateToBigInt("1e0")).toBe(1000000000000n);
    // Below the scale: half-up applies at the boundary digit.
    expect(scaleRateToBigInt("5e-13")).toBe(1n);
    expect(scaleRateToBigInt("4e-13")).toBe(0n);
    expect(scaleRateToBigInt("2.5e-12")).toBe(3n);
  });

  it("honors an explicit scale argument", () => {
    expect(scaleRateToBigInt("0.1", 2)).toBe(10n);
    expect(scaleRateToBigInt("0.125", 2)).toBe(13n);
    expect(scaleRateToBigInt("1.005", 2)).toBe(101n);
    expect(scaleRateToBigInt("123.45", 0)).toBe(123n);
  });

  it("rejects negative, empty, and malformed rates", () => {
    for (const bad of [
      "-1",
      "-0.5",
      "",
      " 0.1",
      "0.1 ",
      "+1",
      "1.",
      ".5",
      "1.2.3",
      "1e",
      "abc",
      "NaN",
      "Infinity",
      "0x10",
    ]) {
      expect(
        () => scaleRateToBigInt(bad),
        `input ${JSON.stringify(bad)}`
      ).toThrow(AppError);
    }
  });

  it("rejects an out-of-range exponent and an invalid scale", () => {
    expect(() => scaleRateToBigInt("1e+5000")).toThrow(AppError);
    expect(() => scaleRateToBigInt("1e-5000")).toThrow(AppError);
    expect(() => scaleRateToBigInt("0.1", -1)).toThrow(AppError);
    expect(() => scaleRateToBigInt("0.1", 2.5)).toThrow(AppError);
    expect(() => scaleRateToBigInt("0.1", 31)).toThrow(AppError);
    expect(() => scaleRateToBigInt("0.1", NaN)).toThrow(AppError);
  });
});

describe("convertMinor", () => {
  it("converts an 18-decimal wei amount above Number.MAX_SAFE_INTEGER exactly", () => {
    // 123.456789012345678901 ETH × 2000.5 GBP/ETH = 246975.306314237540
    // 766... GBP → 24697531 pence (hand-computed, half-away-from-zero).
    expect(
      convertMinor({
        amountMinor: BIG_WEI,
        fromDecimals: 18,
        rateScaled: ETH_GBP_RATE,
        toDecimals: 2,
      })
    ).toBe("24697531");
  });

  it("subtracts negative amounts (sign restored after the rounding)", () => {
    expect(
      convertMinor({
        amountMinor: `-${BIG_WEI}`,
        fromDecimals: 18,
        rateScaled: ETH_GBP_RATE,
        toDecimals: 2,
      })
    ).toBe("-24697531");
    expect(
      convertMinor({
        amountMinor: "-12345",
        fromDecimals: 2,
        rateScaled: 1000000000000n,
        toDecimals: 2,
      })
    ).toBe("-12345");
  });

  it("targets a 0-decimal currency (JPY)", () => {
    // 123.45 GBP × 195.123456789012 JPY/GBP = 24087.990740603... → 24088 yen.
    expect(
      convertMinor({
        amountMinor: "12345",
        fromDecimals: 2,
        rateScaled: 195123456789012n,
        toDecimals: 0,
      })
    ).toBe("24088");
  });

  it("targets a 3-decimal currency (BHD)", () => {
    // 1000.00 USD × 0.376 BHD/USD = 376.000 BHD → 376000 fils.
    expect(
      convertMinor({
        amountMinor: "100000",
        fromDecimals: 2,
        rateScaled: 376000000000n,
        toDecimals: 3,
      })
    ).toBe("376000");
  });

  it("converts sats (8-decimal BTC) to pence exactly", () => {
    // 1 BTC × 67123.45 GBP/BTC → 6712345 pence, exact.
    expect(
      convertMinor({
        amountMinor: "100000000",
        fromDecimals: 8,
        rateScaled: 67123450000000000n,
        toDecimals: 2,
      })
    ).toBe("6712345");
    // 0.12345678 BTC × 67123.45 = 8286.844999491 GBP → 828684 pence
    // (remainder just below half — must NOT round up).
    expect(
      convertMinor({
        amountMinor: "12345678",
        fromDecimals: 8,
        rateScaled: 67123450000000000n,
        toDecimals: 2,
      })
    ).toBe("828684");
  });

  it("rounds an exact .5 AWAY FROM ZERO for both signs", () => {
    // 0.01 × 0.5 = 0.005 → exactly half a minor unit.
    const half = { fromDecimals: 2, rateScaled: 500000000000n, toDecimals: 2 };
    expect(convertMinor({ amountMinor: "1", ...half })).toBe("1");
    expect(convertMinor({ amountMinor: "-1", ...half })).toBe("-1");
    expect(convertMinor({ amountMinor: "3", ...half })).toBe("2");
    expect(convertMinor({ amountMinor: "-3", ...half })).toBe("-2");
  });

  it("is the identity under the identity rate and matching decimals", () => {
    expect(
      convertMinor({
        amountMinor: "123456",
        fromDecimals: 2,
        rateScaled: 10n ** 12n,
        toDecimals: 2,
      })
    ).toBe("123456");
  });

  it("expands scale exactly when the target has more decimals", () => {
    // 0.01 (2-dec) → 18-dec at rate 1: 10^16 wei, far above MAX_SAFE_INTEGER.
    expect(
      convertMinor({
        amountMinor: "1",
        fromDecimals: 2,
        rateScaled: 10n ** 12n,
        toDecimals: 18,
      })
    ).toBe("10000000000000000");
  });

  it("normalizes zero (never emits -0) and handles a zero rate", () => {
    expect(
      convertMinor({
        amountMinor: "0",
        fromDecimals: 2,
        rateScaled: ETH_GBP_RATE,
        toDecimals: 2,
      })
    ).toBe("0");
    expect(
      convertMinor({
        amountMinor: "-0",
        fromDecimals: 2,
        rateScaled: ETH_GBP_RATE,
        toDecimals: 2,
      })
    ).toBe("0");
    expect(
      convertMinor({
        amountMinor: "-12345",
        fromDecimals: 2,
        rateScaled: 0n,
        toDecimals: 2,
      })
    ).toBe("0");
  });

  it("rejects non-integer amount strings", () => {
    for (const bad of ["12.5", "", " 12", "+5", "1e5", "0x10", "abc", "-"]) {
      expect(
        () =>
          convertMinor({
            amountMinor: bad,
            fromDecimals: 2,
            rateScaled: 10n ** 12n,
            toDecimals: 2,
          }),
        `input ${JSON.stringify(bad)}`
      ).toThrow(AppError);
    }
  });

  it("rejects decimals outside 0..30", () => {
    for (const [fromDecimals, toDecimals] of [
      [-1, 2],
      [2.5, 2],
      [31, 2],
      [2, -1],
      [2, 2.5],
      [2, 31],
      [NaN, 2],
    ]) {
      expect(
        () =>
          convertMinor({
            amountMinor: "100",
            fromDecimals,
            rateScaled: 10n ** 12n,
            toDecimals,
          }),
        `decimals ${fromDecimals}/${toDecimals}`
      ).toThrow(AppError);
    }
  });
});

// ADDITIVITY BOUND — the executable rationale for converting GROUP SUBTOTALS
// in P2-5: each conversion rounds half-away-from-zero once, with error
// ≤ 0.5 minor unit, so convert(a) + convert(b) can drift from convert(a + b)
// by at most 1 minor unit (1.5 absolute bound; integers, hence ≤ 1). Summing
// in minor units FIRST and converting the subtotal once keeps displayed
// components additive to the total by construction.
describe("convertMinor additivity bound (property)", () => {
  // Deterministic mulberry32 PRNG — no dependency, reproducible failures.
  const makeRng = (seed: number) => (): number => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  const randomDigits = (rng: () => number, maxDigits: number): string => {
    const length = 1 + Math.floor(rng() * maxDigits);
    let digits = "";
    for (let i = 0; i < length; i++) {
      digits += Math.floor(rng() * 10).toString();
    }
    return digits;
  };

  const randomAmount = (rng: () => number): bigint => {
    const magnitude = BigInt(randomDigits(rng, 24)); // up to ~10^24: wei range
    return rng() < 0.5 ? -magnitude : magnitude;
  };

  const pick = <T>(rng: () => number, values: readonly T[]): T =>
    values[Math.floor(rng() * values.length)];

  it("convert(a) + convert(b) differs from convert(a + b) by at most 1 minor unit", () => {
    const rng = makeRng(0xca5108);
    const fromChoices = [0, 2, 3, 6, 8, 18] as const;
    const toChoices = [0, 2, 3] as const;
    for (let i = 0; i < 1000; i++) {
      const a = randomAmount(rng);
      const b = randomAmount(rng);
      const rateScaled = BigInt(randomDigits(rng, 17)); // rates up to ~10^5
      const fromDecimals = pick(rng, fromChoices);
      const toDecimals = pick(rng, toChoices);
      const convert = (amount: bigint): bigint =>
        BigInt(
          convertMinor({
            amountMinor: amount.toString(),
            fromDecimals,
            rateScaled,
            toDecimals,
          })
        );
      const parts = convert(a) + convert(b);
      const whole = convert(a + b);
      const diff = parts > whole ? parts - whole : whole - parts;
      expect(
        diff <= 1n,
        `iteration ${i}: a=${a} b=${b} rate=${rateScaled} ` +
          `from=${fromDecimals} to=${toDecimals} parts=${parts} whole=${whole}`
      ).toBe(true);
    }
  });
});

describe("minorUnitsFor", () => {
  it("defaults to 2 for ordinary fiat and unknown codes", () => {
    expect(minorUnitsFor("GBP")).toBe(2);
    expect(minorUnitsFor("USD")).toBe(2);
    expect(minorUnitsFor("EUR")).toBe(2);
    expect(minorUnitsFor("XYZ")).toBe(2);
  });

  it("knows the 0-decimal currencies", () => {
    expect(minorUnitsFor("JPY")).toBe(0);
    expect(minorUnitsFor("KRW")).toBe(0);
  });

  it("knows the 3-decimal currencies", () => {
    expect(minorUnitsFor("BHD")).toBe(3);
    expect(minorUnitsFor("KWD")).toBe(3);
    expect(minorUnitsFor("OMR")).toBe(3);
    expect(minorUnitsFor("JOD")).toBe(3);
  });

  it("knows the crypto scales", () => {
    expect(minorUnitsFor("BTC")).toBe(8);
    expect(minorUnitsFor("ETH")).toBe(18);
    expect(minorUnitsFor("USDC")).toBe(6);
  });

  it("normalizes case and whitespace", () => {
    expect(minorUnitsFor("jpy")).toBe(0);
    expect(minorUnitsFor(" btc ")).toBe(8);
    expect(minorUnitsFor("Usdc")).toBe(6);
  });
});
