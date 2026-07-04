/**
 * Money you can read.
 *
 * Amounts are integer minor-unit STRINGS with per-account decimals.
 * All arithmetic is BigInt — parseFloat never touches money here.
 */

/** Known asset decimals for the pay rails. */
export const ASSET_DECIMALS: Record<string, number> = {
  ETH: 18,
  USDC: 6,
  BTC: 8,
  // Fee-asset label the EVM sender emits: the amount is ALREADY in wei,
  // so it formats at 0 decimals — without this entry it fell through to the
  // SENT asset's decimals and mislabelled USDC-send fees.
  "ETH(wei)": 0,
};

function group(digits: string): string {
  return digits.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/**
 * "1234" with decimals 2 → "12.34". Handles signed strings.
 * If the input is not an integer string, it is returned untouched —
 * we would rather show you the raw truth than invent a number.
 */
export function formatMinor(amountMinor: string, decimals: number): string {
  let s = (amountMinor ?? "").trim();
  let neg = false;
  if (s.startsWith("-")) {
    neg = true;
    s = s.slice(1);
  } else if (s.startsWith("+")) {
    s = s.slice(1);
  }
  if (!/^\d+$/.test(s)) return amountMinor;

  const d = Math.max(0, Math.floor(decimals));
  const base = 10n ** BigInt(d);
  const v = BigInt(s);
  const whole = group((v / base).toString());
  const out = d > 0 ? `${whole}.${(v % base).toString().padStart(d, "0")}` : whole;
  return neg && v !== 0n ? `-${out}` : out;
}

/** formatMinor, then trim trailing fractional zeros (for crypto fees). */
export function formatMinorCompact(amountMinor: string, decimals: number): string {
  const s = formatMinor(amountMinor, decimals);
  if (!s.includes(".")) return s;
  return s.replace(/0+$/, "").replace(/\.$/, "");
}

/**
 * Human decimal input → minor-unit string, or null when unreadable.
 * Rejects more fractional digits than the account carries.
 */
export function parseToMinor(input: string, decimals: number): string | null {
  const s = input.trim().replace(/,/g, "");
  if (s === "" || !/^(\d+(\.\d*)?|\.\d+)$/.test(s)) return null;
  const dot = s.indexOf(".");
  const wholeRaw = dot === -1 ? s : s.slice(0, dot);
  const fracRaw = dot === -1 ? "" : s.slice(dot + 1);
  const d = Math.max(0, Math.floor(decimals));
  if (fracRaw.length > d) return null;
  const whole = wholeRaw === "" ? "0" : wholeRaw;
  const frac = fracRaw.padEnd(d, "0");
  const minor = BigInt(whole) * 10n ** BigInt(d) + BigInt(frac === "" ? "0" : frac);
  return minor.toString();
}

export function isNegativeMinor(amountMinor: string): boolean {
  const s = (amountMinor ?? "").trim();
  return s.startsWith("-") && /^-\d+$/.test(s) && BigInt(s) < 0n;
}

export function sumMinor(values: string[]): bigint {
  let total = 0n;
  for (const v of values) {
    const s = (v ?? "").trim();
    if (/^[+-]?\d+$/.test(s)) total += BigInt(s);
  }
  return total;
}

export function shortAddress(addr: string): string {
  if (!addr || addr.length <= 16) return addr;
  return `${addr.slice(0, 8)}…${addr.slice(-6)}`;
}

export function formatDate(s: string): string {
  const t = Date.parse(s);
  if (Number.isNaN(t)) return s;
  return new Date(t).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

export function formatDateTime(s: string): string {
  const t = Date.parse(s);
  if (Number.isNaN(t)) return s;
  return new Date(t).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function todayISO(): string {
  const d = new Date();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${m}-${day}`;
}
