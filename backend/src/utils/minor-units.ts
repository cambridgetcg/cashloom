import { InternalServerException } from "./app-error";

// Precision helpers for integer minor-unit amount strings (Account.balanceMinor,
// NormalizedTransaction.amountMinor). Everything here is string/BigInt math; a
// float appears only at the very end of minorToMajor, behind explicit guards,
// so an 18-decimal wei-scale value can never silently lose precision on the
// way to a number.

// Largest minor-unit magnitude allowed onto the float path. Beyond this a
// double cannot represent the integer exactly, so we refuse rather than round.
const MAX_SAFE_MINOR = BigInt(Number.MAX_SAFE_INTEGER);

// An integer string: optional leading "-", then digits. Leading zeros and
// "-0" are tolerated (BigInt normalizes both); decimals, exponents,
// whitespace, "+", and "" are rejected, never coerced.
const INTEGER_STRING_PATTERN = /^-?\d+$/;

const parseMinor = (amountMinor: string): bigint => {
  if (
    typeof amountMinor !== "string" ||
    !INTEGER_STRING_PATTERN.test(amountMinor)
  ) {
    throw new InternalServerException(
      `Invalid minor-unit amount "${amountMinor}": expected a base-10 integer string`
    );
  }
  return BigInt(amountMinor);
};

// Same bounds as Account.decimals (0–30); a fractional or negative scale is a
// programming error, not something to round over.
const assertDecimals = (decimals: number): void => {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 30) {
    throw new InternalServerException(
      `Invalid decimals ${decimals}: expected an integer between 0 and 30`
    );
  }
};

// Display-style decimal string for a minor-unit amount: "123456" @ 2 →
// "1234.56", "500" @ 0 → "500", "1" @ 18 → "0.000000000000000001". Pure
// string/BigInt math, exact at any scale (wei-safe). Always renders exactly
// `decimals` fraction digits (none when decimals is 0); "-0" normalizes to
// zero with no sign.
export const formatMinor = (
  balanceMinor: string,
  decimals: number
): string => {
  assertDecimals(decimals);
  const minor = parseMinor(balanceMinor);
  const sign = minor < 0n ? "-" : "";
  const digits = (minor < 0n ? -minor : minor).toString();
  if (decimals === 0) {
    return `${sign}${digits}`;
  }
  const padded = digits.padStart(decimals + 1, "0");
  return `${sign}${padded.slice(0, -decimals)}.${padded.slice(-decimals)}`;
};

// Exact minor→major conversion for the fiat range, returned as a number.
// Throws when |amountMinor| exceeds Number.MAX_SAFE_INTEGER or when the
// resulting double would not round-trip back to the exact minor amount — the
// guard that keeps wei-scale crypto values from silently flowing into the
// float path. Use formatMinor instead when a string will do.
export const minorToMajor = (amountMinor: string, decimals: number): number => {
  const minor = parseMinor(amountMinor);
  const magnitude = minor < 0n ? -minor : minor;
  if (magnitude > MAX_SAFE_MINOR) {
    throw new InternalServerException(
      `Minor-unit amount "${amountMinor}" exceeds Number.MAX_SAFE_INTEGER and cannot be converted to a number exactly; use formatMinor instead`
    );
  }
  const major = Number(formatMinor(amountMinor, decimals));
  if (BigInt(Math.round(major * 10 ** decimals)) !== minor) {
    throw new InternalServerException(
      `Minor-unit amount "${amountMinor}" with ${decimals} decimals would lose precision as a number; use formatMinor instead`
    );
  }
  return major;
};

// True when minorToMajor(amountMinor, decimals) would succeed — i.e. the
// amount is a valid integer string whose value survives the float path
// exactly. Lets callers branch to string math instead of catching.
export const minorToMajorIsSafe = (
  amountMinor: string,
  decimals: number
): boolean => {
  try {
    minorToMajor(amountMinor, decimals);
    return true;
  } catch {
    return false;
  }
};
