/**
 * ECB foreign-exchange reference rates — fiat as a PEER in the money world, not
 * a special case. The European Central Bank publishes daily EUR-based reference
 * rates (freely usable, ~16:00 CET each TARGET business day). This adapter turns
 * them into MoneyFacts, honestly graded on Xenia's proof axis:
 *
 *   - a DIRECT ECB rate (EUR→X) is `observed` + `asserted` — ECB's authoritative
 *     fixing: you can re-fetch it, but you cannot recompute how ECB set it.
 *   - a CROSS / INVERSE (X→Y) is `derived` + `tested` — a stranger re-derives our
 *     number from the two cited public ECB rates via the stated formula, so our
 *     arithmetic is checkable (an error would be caught), not merely trusted.
 *
 * All ECB reference rates are `public-domain` redistribution class — no license
 * firewall. Values stay exact fixed-point strings; a float never touches money.
 */

const ECB_URL = "https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml";
const SCALE = 8; // fixed-point decimals carried on every FX value
const REFRESH_MS = 60 * 60 * 1000; // ECB updates once/day; refresh at most hourly

const TEN = 10n;
const pow = (n: number) => TEN ** BigInt(n);

type Rates = { refDate: string; eurPer: Map<string, bigint> }; // ccy -> (ccy per 1 EUR) × 10^SCALE
let cache: { at: number; rates: Rates } | null = null;

// "1.1408" → BigInt scaled by 10^SCALE, exact (no float).
function parseScaled(s: string): bigint {
  const [wholeRaw, fracRaw = ""] = s.trim().split(".");
  const whole = wholeRaw || "0";
  const frac = (fracRaw + "0".repeat(SCALE)).slice(0, SCALE);
  return BigInt(whole) * pow(SCALE) + BigInt(frac || "0");
}

async function loadRates(): Promise<Rates> {
  if (cache && Date.now() - cache.at < REFRESH_MS) return cache.rates;
  const res = await fetch(ECB_URL, { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`ECB HTTP ${res.status}`);
  const xml = await res.text();
  const refDate = xml.match(/time=['"]([0-9-]+)['"]/)?.[1] ?? "";
  const eurPer = new Map<string, bigint>();
  eurPer.set("EUR", pow(SCALE)); // 1 EUR = 1 EUR
  for (const m of xml.matchAll(/currency=['"]([A-Z]{3})['"]\s+rate=['"]([0-9.]+)['"]/g)) {
    eurPer.set(m[1], parseScaled(m[2]));
  }
  if (eurPer.size < 2) throw new Error("ECB feed parsed empty");
  const rates: Rates = { refDate, eurPer };
  cache = { at: Date.now(), rates };
  return rates;
}

export interface FxFact {
  base: string;
  quote: string;
  valueScaled: string; // quote per 1 base, × 10^decimals, exact integer string
  decimals: number;
  method: "observed" | "derived";
  proof_state: "asserted" | "tested";
  recompute: { how: string };
  refDate: string;
  sourceUrl: string;
}

export interface FxError {
  error: string;
  available: string[];
}

export async function getFxRate(base: string, quote: string): Promise<FxFact | FxError> {
  base = base.toUpperCase();
  quote = quote.toUpperCase();
  const { refDate, eurPer } = await loadRates();
  if (!eurPer.has(base) || !eurPer.has(quote)) {
    return { error: "unknown currency", available: [...eurPer.keys()].sort() };
  }
  const b = eurPer.get(base)!;
  const q = eurPer.get(quote)!;

  // quote per 1 base = (EUR→quote) / (EUR→base).
  let valueScaled: bigint;
  let method: "observed" | "derived";
  let proof_state: "asserted" | "tested";
  let how: string;
  if (base === "EUR") {
    valueScaled = q; // ECB publishes EUR→quote directly
    method = "observed";
    proof_state = "asserted";
    how = `ECB daily euro reference rate EUR→${quote} (ref date ${refDate})`;
  } else {
    valueScaled = (q * pow(SCALE) + b / 2n) / b; // q/b at SCALE decimals, rounded
    method = "derived";
    proof_state = "tested";
    how = `ECB(EUR→${quote}) ÷ ECB(EUR→${base}) = ${quote} per ${base}; both rates from ${ECB_URL} (ref date ${refDate})`;
  }
  return {
    base,
    quote,
    valueScaled: valueScaled.toString(),
    decimals: SCALE,
    method,
    proof_state,
    recompute: { how },
    refDate,
    sourceUrl: ECB_URL,
  };
}

export async function listQuotesFrom(base: string): Promise<{ refDate: string; quotes: string[] }> {
  const { refDate, eurPer } = await loadRates();
  const B = base.toUpperCase();
  return { refDate, quotes: [...eurPer.keys()].filter((c) => c !== B).sort() };
}
