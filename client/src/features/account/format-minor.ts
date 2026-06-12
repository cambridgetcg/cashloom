// Format an integer-minor-unit decimal STRING into a major-unit display
// string using pure string math. balanceMinor can be wei-scale (18 decimals),
// which an IEEE-754 double cannot hold, so no parseFloat/Number anywhere.
export const formatMinor = (minor: string, decimals: number): string => {
  const trimmed = (minor ?? "0").trim();
  const negative = trimmed.startsWith("-");
  const raw = trimmed.replace(/^[+-]/, "");

  // Not a plain integer string we understand — show it untouched.
  if (!/^\d+$/.test(raw)) return minor;

  const digits = raw.replace(/^0+(?=\d)/, "");
  const padded = digits.padStart(decimals + 1, "0");
  const whole = decimals > 0 ? padded.slice(0, -decimals) : padded;
  const frac = decimals > 0 ? padded.slice(-decimals) : "";

  // Group the whole part: 1234567 -> 1,234,567
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",");

  // Trim trailing zeros but keep at least two fraction digits, so fiat reads
  // "12.50" while an 18-decimal ETH balance doesn't drag 18 zeros around.
  const minFrac = Math.min(decimals, 2);
  const fracTrimmed = frac.replace(/0+$/, "");
  const fracOut =
    fracTrimmed.length >= minFrac
      ? fracTrimmed
      : fracTrimmed.padEnd(minFrac, "0");

  const formatted = fracOut ? `${grouped}.${fracOut}` : grouped;
  return negative && digits !== "0" ? `-${formatted}` : formatted;
};
