/**
 * Official US overnight cash rates from the Federal Reserve Bank of New York.
 *
 * SOFR and EFFR are cash-market reference rates, not central-bank target rates
 * and not live quotes. The API's CSV form preserves exact decimal values so no
 * binary float is introduced on the data path (insignificant zeroes may be
 * normalised away).
 */

import type { Hono } from "hono";
import { parseMacroCsv, type MacroFetch } from "./macro-sources.ts";

export const NY_FED_RATES_URL = "https://markets.newyorkfed.org/api/rates/all/latest.csv";
export const NY_FED_RATES_PAGE = "https://www.newyorkfed.org/markets/reference-rates";
export const NY_FED_TERMS_URL = "https://www.newyorkfed.org/privacy/termsofuse";

export const NY_FED_REFERENCE_RATE_NOTICE =
  "The SOFR and EFFR data are subject to the Terms of Use posted at newyorkfed.org. The New York Fed is not responsible for publication of the SOFR and EFFR data by CashLoom, does not sanction or endorse this republication, and has no liability for your use.";
export const NY_FED_AFFILIATION_NOTICE =
  "CashLoom is not affiliated with the New York Fed. The New York Fed does not sanction, endorse, or recommend products or services offered by CashLoom.";

export type CashRateCode = "SOFR" | "EFFR";

export interface CashRateSource {
  id: "ny_fed_reference_rates";
  publisher: "Federal Reserve Bank of New York";
  title: "Reference Rates";
  url: string;
  landing_page_url: string;
  terms_url: string;
  licence: "attribution_required_with_reference_rate_notice";
  attribution: string;
  required_notice: string;
  affiliation_notice: string;
  fetched_at: string;
  published_at: string | null;
}

export interface CashRateObservation {
  "@type": "CashRateObservation";
  schema: "cashloom.cash-rate/1";
  id: string;
  code: CashRateCode;
  name: string;
  jurisdiction: "US";
  institution: "Federal Reserve Bank of New York";
  value: string;
  unit: "percent_per_annum";
  observed_at: string;
  temporal_precision: "date";
  published_at: string | null;
  fetched_at: string;
  cadence: "business_daily";
  method: "official_transaction_based_reference_rate";
  reference: {
    is_live: false;
    delay: "published_next_business_morning";
    note: string;
  };
  source: CashRateSource;
  revision_indicator: string | null;
}

export interface CashRateBatch {
  observations: CashRateObservation[];
  source: CashRateSource;
}

export interface CashRateOptions {
  fetcher?: MacroFetch;
  now?: () => Date;
  timeoutMs?: number;
}

const RATE_NAMES: Record<CashRateCode, string> = {
  SOFR: "Secured Overnight Financing Rate",
  EFFR: "Effective Federal Funds Rate",
};

const RATE_NOTES: Record<CashRateCode, string> = {
  SOFR: "Broad transaction-based measure of overnight cash borrowing collateralized by US Treasury securities; normally published around 08:00 ET for the prior business day's transactions.",
  EFFR: "Transaction-based measure of overnight unsecured federal-funds borrowing; normally published on the next business morning.",
};

function exactDecimal(raw: string): string {
  const value = raw.trim();
  if (!/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value)) throw new Error(`invalid exact decimal '${raw}'`);
  const negative = value.startsWith("-");
  const unsigned = negative ? value.slice(1) : value;
  const [whole, fraction = ""] = unsigned.split(".");
  const normalizedFraction = fraction.replace(/0+$/, "");
  const normalized = `${BigInt(whole).toString()}${normalizedFraction ? `.${normalizedFraction}` : ""}`;
  return negative && normalized !== "0" ? `-${normalized}` : normalized;
}

function usDateToIso(raw: string): string {
  const match = raw.trim().match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (!match) throw new Error(`invalid New York Fed date '${raw}'`);
  const iso = `${match[3]}-${match[1]}-${match[2]}`;
  const check = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(check.getTime()) || check.toISOString().slice(0, 10) !== iso) {
    throw new Error(`invalid New York Fed date '${raw}'`);
  }
  return iso;
}

function httpDate(raw: string | null): string | null {
  if (!raw) return null;
  const ms = Date.parse(raw);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

export function parseNyFedReferenceRatesCsv(
  csv: string,
  context: { fetchedAt: string; publishedAt?: string | null; sourceUrl?: string },
): CashRateBatch {
  const rows = parseMacroCsv(csv);
  if (rows.length < 2) throw new Error("New York Fed reference-rate CSV has no data rows");
  const header = rows[0].map((cell) => cell.trim().toUpperCase());
  const index = new Map(header.map((name, position) => [name, position]));
  for (const required of ["EFFECTIVE DATE", "RATE TYPE", "RATE (%)"]) {
    if (!index.has(required)) throw new Error(`New York Fed reference-rate CSV missing ${required}`);
  }
  const source: CashRateSource = {
    id: "ny_fed_reference_rates",
    publisher: "Federal Reserve Bank of New York",
    title: "Reference Rates",
    url: context.sourceUrl ?? NY_FED_RATES_URL,
    landing_page_url: NY_FED_RATES_PAGE,
    terms_url: NY_FED_TERMS_URL,
    licence: "attribution_required_with_reference_rate_notice",
    attribution: `© ${context.fetchedAt.slice(0, 4)} Federal Reserve Bank of New York. Content from the New York Fed subject to the Terms of Use at newyorkfed.org.`,
    required_notice: NY_FED_REFERENCE_RATE_NOTICE,
    affiliation_notice: NY_FED_AFFILIATION_NOTICE,
    fetched_at: context.fetchedAt,
    published_at: context.publishedAt ?? null,
  };
  const observations: CashRateObservation[] = [];
  for (const row of rows.slice(1)) {
    const code = row[index.get("RATE TYPE")!]?.trim().toUpperCase();
    if (code !== "SOFR" && code !== "EFFR") continue;
    const observedAt = usDateToIso(row[index.get("EFFECTIVE DATE")!] ?? "");
    const value = exactDecimal(row[index.get("RATE (%)")!] ?? "");
    const revision = index.has("REVISION INDICATOR (Y/N)")
      ? row[index.get("REVISION INDICATOR (Y/N)")!]?.trim() || null
      : null;
    observations.push({
      "@type": "CashRateObservation",
      schema: "cashloom.cash-rate/1",
      id: `cash_rate:US:${code}`,
      code,
      name: RATE_NAMES[code],
      jurisdiction: "US",
      institution: "Federal Reserve Bank of New York",
      value,
      unit: "percent_per_annum",
      observed_at: observedAt,
      temporal_precision: "date",
      published_at: source.published_at,
      fetched_at: source.fetched_at,
      cadence: "business_daily",
      method: "official_transaction_based_reference_rate",
      reference: { is_live: false, delay: "published_next_business_morning", note: RATE_NOTES[code] },
      source,
      revision_indicator: revision,
    });
  }
  observations.sort((a, b) => a.code.localeCompare(b.code));
  if (observations.length !== 2) throw new Error("New York Fed CSV did not contain both EFFR and SOFR");
  return { observations, source };
}

async function fetchCashRates(options: CashRateOptions): Promise<CashRateBatch> {
  const fetcher = options.fetcher ?? globalThis.fetch;
  const timeoutMs = Math.max(1, Math.min(30_000, Math.trunc(options.timeoutMs ?? 10_000)));
  const response = await fetcher(NY_FED_RATES_URL, {
    headers: { Accept: "text/csv", "User-Agent": "CashLoom-World/1 (+https://cashloom.io)" },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw new Error(`New York Fed reference rates answered HTTP ${response.status}`);
  const body = await response.text();
  if (!body.trim() || body.length > 1_000_000) throw new Error("New York Fed reference-rate response is empty or too large");
  return parseNyFedReferenceRatesCsv(body, {
    fetchedAt: (options.now ?? (() => new Date()))().toISOString(),
    publishedAt: httpDate(response.headers.get("last-modified")),
    sourceUrl: NY_FED_RATES_URL,
  });
}

let cache: { at: number; batch: CashRateBatch } | null = null;
let inflight: Promise<CashRateBatch> | null = null;

export async function readCashRates(options: CashRateOptions = {}): Promise<CashRateBatch> {
  if (options.fetcher || options.now) return fetchCashRates(options);
  if (cache && Date.now() - cache.at < 5 * 60_000) return cache.batch;
  inflight ??= fetchCashRates(options).then((batch) => {
    cache = { at: Date.now(), batch };
    return batch;
  }).finally(() => { inflight = null; });
  return inflight;
}

export function mountCashRatesDoor(app: Hono, reader: () => Promise<CashRateBatch> = readCashRates) {
  app.get("/v1/rates/cash", async (c) => {
    try {
      const batch = await reader();
      c.header("Cache-Control", "public, max-age=60, stale-while-revalidate=300");
      return c.json({ count: batch.observations.length, facts: batch.observations, source: batch.source });
    } catch {
      return c.json({
        type: "about:blank",
        title: "cash rates unavailable",
        status: 502,
        detail: "The New York Fed reference-rate feed did not answer with usable SOFR and EFFR observations.",
        next_actions: ["retry shortly", `open ${NY_FED_RATES_PAGE}`],
      }, 502);
    }
  });
}
