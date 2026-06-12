import { InternalServerException } from "./app-error";

// BigInt rate math for the valuation/display layer. A rate is a non-negative
// decimal quote (e.g. "0.79" GBP per USD) re-encoded as an integer scaled to
// RATE_SCALE fraction digits, so every downstream conversion is pure BigInt —
// no float ever touches an amount.
//
// ROUNDING POLICY (deliberate contrast with gocardless decimalToMinor, which
// THROWS on excess fraction digits): rates are market QUOTES, not money — a
// quote carries source precision, not ledger truth, so truncating a long
// fraction with round-half-up loses nothing that was ours to keep. Amounts,
// by contrast, are never rounded on ingest anywhere in this codebase.
//
// minorToMajor (utils/minor-units.ts) is deliberately NOT used here or by any
// caller of this module: 18-decimal balances above ~0.009 ETH exceed
// Number.MAX_SAFE_INTEGER and throw there by design.

// Fraction digits a scaled rate carries. 12 covers BTC at ~$100k with 12
// fraction digits of quote fidelity — strictly more than scale 8 — at zero
// extra BigInt cost.
export const RATE_SCALE = 12;

// Non-negative decimal, optionally in scientific notation ("1e-7",
// "1.23E+4"). JSON doubles can stringify as e-notation, so it must be
// accepted and normalized BEFORE any digit math. Negative, empty, signed,
// bare-dot ("1." / ".5"), and non-numeric strings are rejected, never coerced.
const RATE_DECIMAL_PATTERN = /^\d+(\.\d+)?([eE][+-]?\d+)?$/;

// Integer minor-unit amount string: optional leading "-", then digits
// (minor-units.ts discipline).
const INTEGER_STRING_PATTERN = /^-?\d+$/;

// A JSON double's exponent lives within ±324; anything wildly beyond that is
// a programming error, and refusing it bounds string allocation.
const MAX_EXPONENT = 1000;

// Same bounds as Account.decimals (0–30); a fractional or negative scale is a
// programming error, not something to round over.
const assertScaleInt = (label: string, value: number): void => {
  if (!Number.isInteger(value) || value < 0 || value > 30) {
    throw new InternalServerException(
      `Invalid ${label} ${value}: expected an integer between 0 and 30`
    );
  }
};

// Expand scientific notation into plain whole/fraction digit strings using
// only string math: "1e-7" → { whole: "0", fraction: "0000001" },
// "1.23e+4" → { whole: "12300", fraction: "" }.
const normalizeScientific = (
  rateDecimal: string
): { whole: string; fraction: string } => {
  const [mantissa, exponentPart] = rateDecimal.split(/[eE]/);
  const exponent =
    exponentPart === undefined ? 0 : Number.parseInt(exponentPart, 10);
  if (Math.abs(exponent) > MAX_EXPONENT) {
    throw new InternalServerException(
      `Invalid rate "${rateDecimal}": exponent ${exponent} is out of range`
    );
  }
  const [wholeRaw, fractionRaw = ""] = mantissa.split(".");
  const digits = wholeRaw + fractionRaw;
  // Where the decimal point lands after applying the exponent.
  const pointPos = wholeRaw.length + exponent;
  if (pointPos <= 0) {
    return { whole: "0", fraction: "0".repeat(-pointPos) + digits };
  }
  if (pointPos >= digits.length) {
    return { whole: digits + "0".repeat(pointPos - digits.length), fraction: "" };
  }
  return { whole: digits.slice(0, pointPos), fraction: digits.slice(pointPos) };
};

// Re-encode a non-negative decimal rate string as a BigInt scaled to `scale`
// fraction digits: "0.79" → 790000000000n at scale 12. Pure string math —
// the fraction is padded or truncated to `scale` digits with ROUND-HALF-UP on
// the first truncated digit (see the rounding-policy note above). Rejects
// negative, empty, and malformed input with InternalServerException.
export const scaleRateToBigInt = (
  rateDecimal: string,
  scale: number = RATE_SCALE
): bigint => {
  if (
    typeof rateDecimal !== "string" ||
    !RATE_DECIMAL_PATTERN.test(rateDecimal)
  ) {
    throw new InternalServerException(
      `Invalid rate "${rateDecimal}": expected a non-negative decimal string like "0.79" or "1.2e-7"`
    );
  }
  assertScaleInt("rate scale", scale);
  const { whole, fraction } = normalizeScientific(rateDecimal);
  const kept = fraction.slice(0, scale).padEnd(scale, "0");
  // ROUND-HALF-UP on the first digit beyond `scale`. The rate is
  // non-negative, so half-up and half-away-from-zero coincide.
  const roundUp = fraction.length > scale && fraction[scale] >= "5";
  return BigInt(whole + kept) + (roundUp ? 1n : 0n);
};

// Convert an integer minor-unit amount between currencies through a scaled
// rate, fully in BigInt:
//
//   numerator   = amountMinor * rateScaled * 10^toDecimals
//   denominator = 10^(fromDecimals + RATE_SCALE)
//
// and round the quotient HALF-AWAY-FROM-ZERO — the single rounding event of
// a conversion, computed as ((|numerator| * 2 + denominator) /
// (2 * denominator)) with the sign restored afterwards. Exact at any scale
// (wei-safe); the result is again an integer minor-unit decimal string.
// `rateScaled` must be scaled to RATE_SCALE (the scaleRateToBigInt default).
export const convertMinor = (args: {
  amountMinor: string;
  fromDecimals: number;
  rateScaled: bigint;
  toDecimals: number;
}): string => {
  const { amountMinor, fromDecimals, rateScaled, toDecimals } = args;
  if (
    typeof amountMinor !== "string" ||
    !INTEGER_STRING_PATTERN.test(amountMinor)
  ) {
    throw new InternalServerException(
      `Invalid minor-unit amount "${amountMinor}": expected a base-10 integer string`
    );
  }
  assertScaleInt("fromDecimals", fromDecimals);
  assertScaleInt("toDecimals", toDecimals);
  const numerator =
    BigInt(amountMinor) * rateScaled * 10n ** BigInt(toDecimals);
  const denominator = 10n ** BigInt(fromDecimals + RATE_SCALE);
  const negative = numerator < 0n;
  const magnitude = negative ? -numerator : numerator;
  const quotient = (magnitude * 2n + denominator) / (2n * denominator);
  // Restore the sign only on a non-zero magnitude — never emit "-0".
  return negative && quotient > 0n
    ? `-${quotient.toString()}`
    : quotient.toString();
};

// Minor-unit exponents for display/valuation. Deliberately a SMALL table:
// the common 2-decimal default plus the known exceptions this codebase deals
// in — not an ISO-4217 mirror.
const MINOR_UNITS_BY_CURRENCY: Record<string, number> = {
  JPY: 0,
  KRW: 0,
  BHD: 3,
  KWD: 3,
  OMR: 3,
  JOD: 3,
  BTC: 8,
  ETH: 18,
  USDC: 6,
};

// Number of minor-unit fraction digits for a currency code (case-insensitive,
// trimmed). Unknown codes default to 2 — the overwhelmingly common case.
export const minorUnitsFor = (currency: string): number =>
  MINOR_UNITS_BY_CURRENCY[currency.trim().toUpperCase()] ?? 2;
