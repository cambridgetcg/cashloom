/**
 * Official, keyless macro-economic source adapters for CashLoom World.
 *
 * Design rules:
 *   - decimal values never pass through Number; their source lexeme is
 *     validated and normalised as an exact decimal string;
 *   - a reference date is not promoted to a made-up midnight instant;
 *   - "published_at" is null when the publisher does not expose it;
 *   - official reference/modelled yields are never described as live prices;
 *   - every network call is independently timeout-bounded and injectable;
 *   - the aggregate snapshot preserves successful sources when peers fail.
 *
 * The module is deliberately independent of MoneyFact. Policy rates and bond
 * yields are percentages, not asset minor units, and therefore deserve a
 * scalar observation schema rather than overloading a money amount schema.
 */

export type MacroJurisdiction = "US" | "XM" | "GB" | "JP";
export type MacroIndicator = "central_bank_policy_rate" | "sovereign_yield";
export type MacroCadence = "business_daily" | "daily_values_weekly_release" | "daily";
export type MacroMethod = "official_observation" | "official_model";
export type MacroRetrieval = "live_fetch" | "verified_transcription";
export type MacroMaturity =
  | "1M"
  | "1.5M"
  | "2M"
  | "3M"
  | "4M"
  | "6M"
  | "1Y"
  | "2Y"
  | "3Y"
  | "4Y"
  | "5Y"
  | "6Y"
  | "7Y"
  | "8Y"
  | "9Y"
  | "10Y"
  | "15Y"
  | "20Y"
  | "25Y"
  | "30Y"
  | "40Y";

export type KnownMacroSourceId =
  | "bis_policy_rates"
  | "us_treasury_par_yields"
  | "ecb_euro_area_yield_curve"
  | "japan_mof_jgb_yields"
  | "fed_meeting_calendar"
  | "ecb_meeting_calendar"
  | "boe_meeting_calendar"
  | "boj_meeting_calendar";

/** Known adapters get a closed union; consumers may still construct fixtures
 * or downstream sources without a cast. */
export type MacroSourceId = KnownMacroSourceId | (string & {});

export interface MacroLicence {
  class:
    | "public-domain"
    | "attribution-required"
    | "attribution-required-commercial-conditions"
    | "official-terms"
    | "public_domain"
    | "attribution_required"
    | "official_terms";
  terms_url: string;
  attribution: string;
  redistribution_note: string;
}

export interface MacroSourceDefinition {
  id: MacroSourceId;
  publisher: string;
  title: string;
  landing_page_url: string;
  methodology_url: string | null;
  licence: MacroLicence;
}

export interface MacroSource extends MacroSourceDefinition {
  /** The exact resource URL used, including series selection. */
  url: string;
  fetched_at: string;
  published_at: string | null;
  published_at_status: "reported" | "source_timestamp" | "http_last_modified" | "not_exposed";
  /** How this response acquired the source facts. Present on all adapter output. */
  retrieval?: MacroRetrieval;
  /** Fixed verification date for checked-in transcriptions; null for request-time fetches. */
  verified_at?: string | null;
}

export interface MacroReference {
  kind: "policy_rate" | "par_yield" | "modelled_spot_yield" | "constant_maturity_yield";
  authority?: "official" | "official_aggregator";
  is_live: false;
  frequency: MacroCadence;
  delay: string;
  temporal_precision: "date";
  note: string;
}

export interface MacroObservation {
  "@type": "MacroObservation";
  schema: "cashloom.macro-observation/1";
  id: string;
  indicator: MacroIndicator;
  jurisdiction: MacroJurisdiction;
  jurisdiction_name: string;
  institution: string;
  series_key: string;
  label: string;
  maturity?: MacroMaturity;
  /** Exact percentage lexeme. It is never parsed as a binary float. */
  value: string;
  unit: "percent_per_annum";
  method: MacroMethod;
  /** ISO 8601 calendar date from the source (not a fabricated instant). */
  observed_at: string;
  temporal_precision: "date";
  published_at: string | null;
  fetched_at: string;
  cadence: MacroCadence;
  reference: MacroReference;
  source: MacroSource;
}

export interface MacroEvent {
  "@type": "MacroEvent";
  schema: "cashloom.macro-event/1";
  id: string;
  category: "central_bank_meeting";
  jurisdiction: MacroJurisdiction;
  jurisdiction_name: string;
  institution: string;
  institution_code: "FED" | "ECB" | "BOE" | "BOJ";
  title: string;
  /** Date-only because several authorities do not promise a decision time. */
  starts_on: string;
  ends_on: string;
  decision_on: string;
  time_status: "not_announced";
  projection_release: boolean;
  schedule_status: "confirmed" | "scheduled" | "provisional" | "tentative";
  published_at: string | null;
  fetched_at: string;
  /** Calendar events are checked-in facts, not a request-time page scrape. */
  retrieval?: MacroRetrieval;
  verified_at?: string | null;
  source: MacroSource;
}

export interface MacroWarning {
  source_id: MacroSourceId;
  code: "series_missing" | "value_missing" | "row_skipped";
  detail: string;
}

export interface MacroFailure {
  source_id: MacroSourceId;
  kind: "timeout" | "http" | "network" | "parse";
  detail: string;
  retryable: boolean;
  status_code?: number;
  url: string;
}

export interface MacroBatch {
  source: MacroSource;
  observations: MacroObservation[];
  warnings: MacroWarning[];
}

export interface MacroSourceStatus {
  source_id: MacroSourceId;
  status: "ok" | "degraded" | "failed";
  observation_count: number;
  event_count: number;
  warning_count: number;
  fetched_at: string | null;
  published_at: string | null;
  url: string;
  retrieval?: MacroRetrieval;
  verified_at?: string | null;
  detail?: string;
}

export interface MacroSnapshot {
  "@type": "MacroSnapshot";
  schema: "cashloom.macro-snapshot/1";
  generated_at: string;
  status: "ok" | "partial" | "unavailable";
  complete: boolean;
  policy: MacroObservation[];
  sovereigns: MacroObservation[];
  calendar: MacroEvent[];
  sources: MacroSourceStatus[];
  warnings: MacroWarning[];
  failures: MacroFailure[];
}

export type MacroFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export type MacroNow = () => Date;

export interface MacroParseContext {
  fetchedAt: string;
  publishedAt?: string | null;
  publishedAtStatus?: "source_timestamp" | "http_last_modified";
  sourceUrl?: string;
  retrieval?: MacroRetrieval;
  verifiedAt?: string | null;
}

export interface MacroAdapterOptions {
  fetcher?: MacroFetch;
  now?: MacroNow;
  timeoutMs?: number;
}

export interface YieldAdapterOptions extends MacroAdapterOptions {
  maturities?: readonly MacroMaturity[];
}

const BIS_POLICY_URL =
  "https://stats.bis.org/api/v2/data/dataflow/BIS/WS_CBPOL/1.0/D.US+XM+GB+JP?format=csvfile&lastNObservations=1&detail=dataonly";
const TREASURY_BASE_URL =
  "https://home.treasury.gov/resource-center/data-chart-center/interest-rates/pages/xml?data=daily_treasury_yield_curve";
const ECB_YIELD_BASE_URL =
  "https://data-api.ecb.europa.eu/service/data/YC/B.U2.EUR.4F.G_N_A.SV_C_YM";
const MOF_JGB_URL =
  "https://www.mof.go.jp/english/policy/jgbs/reference/interest_rate/jgbcme.csv";

/**
 * The checked-in calendars were manually compared with all four official
 * authority pages on this date. Midnight is a canonical serialization of the
 * verification date, not a claim that an automated fetch ran at that instant.
 */
export const CALENDAR_VERIFIED_AT = "2026-08-20T00:00:00.000Z";
export const CALENDAR_VERIFICATION_MAX_AGE_DAYS = 45;

/** Build the Treasury's small, official month-filtered Atom feed URL. */
export function treasuryMonthUrl(date: Date): string {
  if (!Number.isFinite(date.getTime())) throw new Error("Treasury month requires a valid date");
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  return `${TREASURY_BASE_URL}&field_tdr_date_value_month=${date.getUTCFullYear()}${month}`;
}

function previousUtcMonth(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() - 1, 1));
}

export const MACRO_SOURCE_DEFINITIONS: Record<KnownMacroSourceId, MacroSourceDefinition> = {
  bis_policy_rates: {
    id: "bis_policy_rates",
    publisher: "Bank for International Settlements",
    title: "Central bank policy rates",
    landing_page_url: "https://data.bis.org/topics/CBPOL",
    methodology_url: "https://www.bis.org/statistics/cbpol/cbpol_doc.pdf",
    licence: {
      class: "attribution-required-commercial-conditions",
      terms_url: "https://www.bis.org/terms_statistics.htm",
      attribution: "Bank for International Settlements and the relevant national central bank",
      redistribution_note: "BIS statistics may be reused with appropriate source attribution. If included in a commercial product, their inclusion must not itself impose an additional charge on subscribers or other users; all BIS statistical-use conditions continue to apply.",
    },
  },
  us_treasury_par_yields: {
    id: "us_treasury_par_yields",
    publisher: "U.S. Department of the Treasury",
    title: "Daily Treasury Par Yield Curve Rates",
    landing_page_url: "https://home.treasury.gov/treasury-daily-interest-rate-xml-feed",
    methodology_url: "https://home.treasury.gov/policy-issues/financing-the-government/interest-rate-statistics/treasury-yield-curve-methodology",
    licence: {
      class: "public-domain",
      terms_url: "https://home.treasury.gov/utility-policies",
      attribution: "U.S. Department of the Treasury",
      redistribution_note: "Official U.S. government yield-curve data; retain source attribution and do not imply Treasury endorsement.",
    },
  },
  ecb_euro_area_yield_curve: {
    id: "ecb_euro_area_yield_curve",
    publisher: "European Central Bank",
    title: "Euro area central government bond yield curves",
    landing_page_url: "https://data.ecb.europa.eu/methodology/yield-curves",
    methodology_url: "https://www.ecb.europa.eu/stats/financial_markets_and_interest_rates/euro_area_yield_curves/html/technical_notes.pdf",
    licence: {
      class: "attribution-required",
      terms_url: "https://www.ecb.europa.eu/stats/ecb_statistics/governance_and_quality_framework/html/usage_policy.en.html",
      attribution: "European Central Bank",
      redistribution_note: "ECB statistics may be reused with source attribution and without suggesting ECB endorsement.",
    },
  },
  japan_mof_jgb_yields: {
    id: "japan_mof_jgb_yields",
    publisher: "Ministry of Finance Japan",
    title: "Interest Rate (JGB constant-maturity yields)",
    landing_page_url: "https://www.mof.go.jp/english/policy/jgbs/reference/interest_rate/index.htm",
    methodology_url: "https://www.mof.go.jp/english/policy/jgbs/reference/interest_rate/qa.htm",
    licence: {
      class: "official-terms",
      terms_url: "https://www.mof.go.jp/english/about_mof/notice/index.html",
      attribution: "Ministry of Finance Japan",
      redistribution_note: "Use is governed by the Ministry's site terms; preserve attribution and verify terms before bulk commercial republication.",
    },
  },
  fed_meeting_calendar: {
    id: "fed_meeting_calendar",
    publisher: "Board of Governors of the Federal Reserve System",
    title: "FOMC meeting calendars and information",
    landing_page_url: "https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm",
    methodology_url: null,
    licence: {
      class: "public-domain",
      terms_url: "https://www.federalreserve.gov/aboutthefed/website-linking-policies.htm",
      attribution: "Board of Governors of the Federal Reserve System",
      redistribution_note: "Meeting dates are official U.S. government information; do not imply Federal Reserve endorsement.",
    },
  },
  ecb_meeting_calendar: {
    id: "ecb_meeting_calendar",
    publisher: "European Central Bank",
    title: "Governing Council monetary policy meeting schedule",
    landing_page_url: "https://www.ecb.europa.eu/press/calendars/mgcgc/html/index.en.html",
    methodology_url: null,
    licence: {
      class: "attribution-required",
      terms_url: "https://www.ecb.europa.eu/services/copyright/html/index.en.html",
      attribution: "European Central Bank",
      redistribution_note: "Reuse with source attribution and without suggesting ECB endorsement.",
    },
  },
  boe_meeting_calendar: {
    id: "boe_meeting_calendar",
    publisher: "Bank of England",
    title: "Monetary Policy Committee dates",
    landing_page_url: "https://www.bankofengland.co.uk/monetary-policy/upcoming-mpc-dates",
    methodology_url: null,
    licence: {
      class: "official-terms",
      terms_url: "https://www.bankofengland.co.uk/legal/terms-and-conditions",
      attribution: "Bank of England",
      redistribution_note: "Calendar facts are cited to the Bank; other page content remains subject to Bank of England terms.",
    },
  },
  boj_meeting_calendar: {
    id: "boj_meeting_calendar",
    publisher: "Bank of Japan",
    title: "Monetary Policy Meetings",
    landing_page_url: "https://www.boj.or.jp/en/mopo/mpmsche_minu/index.htm",
    methodology_url: null,
    licence: {
      class: "official-terms",
      terms_url: "https://www.boj.or.jp/en/about/copyright/index.htm",
      attribution: "Bank of Japan",
      redistribution_note: "Meeting facts are cited to the Bank of Japan; reproduction of Bank content remains subject to its terms.",
    },
  },
};

const POLICY_META: Record<MacroJurisdiction, { name: string; institution: string; order: number }> = {
  US: { name: "United States", institution: "Federal Reserve System", order: 0 },
  XM: { name: "Euro area", institution: "European Central Bank", order: 1 },
  GB: { name: "United Kingdom", institution: "Bank of England", order: 2 },
  JP: { name: "Japan", institution: "Bank of Japan", order: 3 },
};

const DEFAULT_MATURITIES: readonly MacroMaturity[] = ["2Y", "10Y"];

const TREASURY_FIELDS: Partial<Record<MacroMaturity, string>> = {
  "1M": "BC_1MONTH",
  "1.5M": "BC_1_5MONTH",
  "2M": "BC_2MONTH",
  "3M": "BC_3MONTH",
  "4M": "BC_4MONTH",
  "6M": "BC_6MONTH",
  "1Y": "BC_1YEAR",
  "2Y": "BC_2YEAR",
  "3Y": "BC_3YEAR",
  "5Y": "BC_5YEAR",
  "7Y": "BC_7YEAR",
  "10Y": "BC_10YEAR",
  "20Y": "BC_20YEAR",
  "30Y": "BC_30YEAR",
};

const ECB_FIELDS: Partial<Record<MacroMaturity, string>> = {
  "1Y": "SR_1Y",
  "2Y": "SR_2Y",
  "3Y": "SR_3Y",
  "4Y": "SR_4Y",
  "5Y": "SR_5Y",
  "6Y": "SR_6Y",
  "7Y": "SR_7Y",
  "8Y": "SR_8Y",
  "9Y": "SR_9Y",
  "10Y": "SR_10Y",
  "15Y": "SR_15Y",
  "20Y": "SR_20Y",
  "30Y": "SR_30Y",
};

const MOF_FIELDS: Partial<Record<MacroMaturity, string>> = {
  "1Y": "1Y",
  "2Y": "2Y",
  "3Y": "3Y",
  "4Y": "4Y",
  "5Y": "5Y",
  "6Y": "6Y",
  "7Y": "7Y",
  "8Y": "8Y",
  "9Y": "9Y",
  "10Y": "10Y",
  "15Y": "15Y",
  "20Y": "20Y",
  "25Y": "25Y",
  "30Y": "30Y",
  "40Y": "40Y",
};

class MacroAdapterError extends Error {
  constructor(
    readonly sourceId: KnownMacroSourceId,
    readonly kind: MacroFailure["kind"],
    message: string,
    readonly url: string,
    readonly retryable: boolean,
    readonly statusCode?: number,
  ) {
    super(message);
    this.name = "MacroAdapterError";
  }
}

function exactDecimal(raw: string): string {
  const value = raw.trim();
  const match = /^([+-]?)(\d*)(?:\.(\d+))?$/.exec(value);
  if (!match || (!match[2] && match[3] === undefined)) {
    throw new Error(`invalid decimal '${value}'`);
  }
  const whole = (match[2] || "0").replace(/^0+(?=\d)/, "");
  const fraction = match[3];
  const isZero = /^0+$/.test(whole) && (fraction === undefined || /^0+$/.test(fraction));
  const sign = match[1] === "-" && !isZero ? "-" : "";
  return `${sign}${whole}${fraction === undefined ? "" : `.${fraction}`}`;
}

function assertIsoDate(value: string): string {
  const trimmed = value.trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) throw new Error(`invalid ISO date '${trimmed}'`);
  const [year, month, day] = trimmed.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) throw new Error(`invalid calendar date '${trimmed}'`);
  return trimmed;
}

function httpDateToIso(raw: string | null): string | null {
  if (!raw) return null;
  const ms = Date.parse(raw);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

function asPublishedAt(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const value = raw.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return assertIsoDate(value);
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

function xmlDecode(value: string): string {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

function xmlAttributes(raw: string): Map<string, string> {
  const attrs = new Map<string, string>();
  for (const match of raw.matchAll(/([A-Za-z_][\w:.-]*)\s*=\s*(["'])([\s\S]*?)\2/g)) {
    attrs.set(match[1], xmlDecode(match[3]));
  }
  return attrs;
}

function xmlElementText(xml: string, localName: string): string | null {
  const escaped = localName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`<(?:[\\w.-]+:)?${escaped}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/(?:[\\w.-]+:)?${escaped}>`, "i").exec(xml);
  return match ? xmlDecode(match[1].trim()) : null;
}

/** RFC-4180-ish parser, including BOM, escaped quotes, commas and CRLF. */
export function parseMacroCsv(input: string): string[][] {
  const text = input.replace(/^\uFEFF/, "");
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (quoted) {
      if (char === '"' && text[i + 1] === '"') {
        field += '"';
        i += 1;
      } else if (char === '"') {
        quoted = false;
      } else {
        field += char;
      }
    } else if (char === '"') {
      quoted = true;
    } else if (char === ",") {
      row.push(field);
      field = "";
    } else if (char === "\n") {
      row.push(field.replace(/\r$/, ""));
      if (row.some((cell) => cell.length > 0)) rows.push(row);
      row = [];
      field = "";
    } else {
      field += char;
    }
  }
  if (quoted) throw new Error("unterminated quoted CSV field");
  row.push(field.replace(/\r$/, ""));
  if (row.some((cell) => cell.length > 0)) rows.push(row);
  return rows;
}

function sourceFor(
  sourceId: KnownMacroSourceId,
  url: string,
  context: MacroParseContext,
  fallbackPublishedAt: string | null = null,
): MacroSource {
  const contextualPublishedAt = asPublishedAt(context.publishedAt);
  const fallback = asPublishedAt(fallbackPublishedAt);
  const publishedAt = contextualPublishedAt ?? fallback;
  return {
    ...MACRO_SOURCE_DEFINITIONS[sourceId],
    url,
    fetched_at: context.fetchedAt,
    published_at: publishedAt,
    published_at_status: publishedAt
      ? contextualPublishedAt
        ? context.publishedAtStatus ?? "reported"
        : "source_timestamp"
      : "not_exposed",
    retrieval: context.retrieval ?? "live_fetch",
    verified_at: context.verifiedAt ?? null,
  };
}

function observation(args: Omit<MacroObservation, "@type" | "schema" | "unit" | "temporal_precision">): MacroObservation {
  return {
    "@type": "MacroObservation",
    schema: "cashloom.macro-observation/1",
    unit: "percent_per_annum",
    temporal_precision: "date",
    ...args,
  };
}

function parseFailure(sourceId: KnownMacroSourceId, url: string, error: unknown): never {
  if (error instanceof MacroAdapterError) throw error;
  const detail = error instanceof Error ? error.message : String(error);
  throw new MacroAdapterError(sourceId, "parse", detail, url, false);
}

/** Parse the actual BIS v2 `format=csvfile` payload. */
export function parseBisPolicyRatesCsv(csv: string, context: MacroParseContext): MacroBatch {
  const sourceId: KnownMacroSourceId = "bis_policy_rates";
  const url = context.sourceUrl ?? BIS_POLICY_URL;
  try {
    const rows = parseMacroCsv(csv);
    if (rows.length < 2) throw new Error("BIS policy-rate CSV has no data rows");
    const header = rows[0].map((cell) => cell.trim().toUpperCase());
    const index = new Map(header.map((name, i) => [name, i]));
    for (const required of ["FREQ", "REF_AREA", "TIME_PERIOD", "OBS_VALUE"]) {
      if (!index.has(required)) throw new Error(`BIS policy-rate CSV missing ${required}`);
    }

    const latest = new Map<MacroJurisdiction, { date: string; value: string }>();
    const warnings: MacroWarning[] = [];
    for (const row of rows.slice(1)) {
      const area = row[index.get("REF_AREA")!]?.trim().toUpperCase() as MacroJurisdiction;
      if (!(area in POLICY_META)) continue;
      if (row[index.get("FREQ")!]?.trim().toUpperCase() !== "D") continue;
      try {
        const date = assertIsoDate(row[index.get("TIME_PERIOD")!] ?? "");
        const value = exactDecimal(row[index.get("OBS_VALUE")!] ?? "");
        if (!latest.has(area) || date > latest.get(area)!.date) latest.set(area, { date, value });
      } catch (error) {
        warnings.push({
          source_id: sourceId,
          code: "row_skipped",
          detail: `Skipped BIS ${area || "unknown"} row: ${error instanceof Error ? error.message : String(error)}`,
        });
      }
    }

    const source = sourceFor(sourceId, url, context);
    const observations: MacroObservation[] = [];
    for (const area of Object.keys(POLICY_META) as MacroJurisdiction[]) {
      const found = latest.get(area);
      if (!found) {
        warnings.push({ source_id: sourceId, code: "series_missing", detail: `BIS daily policy-rate series D.${area} was absent` });
        continue;
      }
      const meta = POLICY_META[area];
      observations.push(observation({
        id: `policy_rate:${area}`,
        indicator: "central_bank_policy_rate",
        jurisdiction: area,
        jurisdiction_name: meta.name,
        institution: meta.institution,
        series_key: `WS_CBPOL.D.${area}`,
        label: `${meta.name} central bank policy rate (BIS-selected series)`,
        value: found.value,
        method: "official_observation",
        observed_at: found.date,
        published_at: source.published_at,
        fetched_at: source.fetched_at,
        cadence: "daily_values_weekly_release",
        reference: {
          kind: "policy_rate",
          authority: "official_aggregator",
          is_live: false,
          frequency: "daily_values_weekly_release",
          delay: "weekly_batch",
          temporal_precision: "date",
          note: "BIS-selected main policy instrument; for target bands BIS generally shows the midpoint. Daily values are released in a weekly batch and may trail a new central-bank announcement.",
        },
        source,
      }));
    }
    observations.sort((a, b) => POLICY_META[a.jurisdiction].order - POLICY_META[b.jurisdiction].order);
    if (observations.length === 0) throw new Error("BIS policy-rate CSV contained no supported daily series");
    return { source, observations, warnings };
  } catch (error) {
    return parseFailure(sourceId, url, error);
  }
}

/**
 * Compatibility parser for BIS structure-specific SDMX 2.1 XML. Production
 * uses the smaller v2 CSV endpoint above, but keeping this parser makes cached
 * legacy fixtures recoverable without pretending the wire formats are equal.
 */
export function parseBisPolicyRatesXml(xml: string, context: MacroParseContext): MacroBatch {
  const sourceId: KnownMacroSourceId = "bis_policy_rates";
  const url = context.sourceUrl ?? BIS_POLICY_URL;
  try {
    const rows = ["FREQ,REF_AREA,TIME_PERIOD,OBS_VALUE"];
    for (const series of xml.matchAll(/<(?:[\w.-]+:)?Series\b([^>]*)>([\s\S]*?)<\/(?:[\w.-]+:)?Series>/gi)) {
      const seriesAttrs = xmlAttributes(series[1]);
      const freq = seriesAttrs.get("FREQ") ?? "";
      const area = seriesAttrs.get("REF_AREA") ?? "";
      for (const obs of series[2].matchAll(/<(?:[\w.-]+:)?Obs\b([^>]*)/gi)) {
        const attrs = xmlAttributes(obs[1]);
        rows.push([freq, area, attrs.get("TIME_PERIOD") ?? "", attrs.get("OBS_VALUE") ?? ""].join(","));
      }
    }
    if (rows.length === 1) throw new Error("BIS policy-rate XML has no observations");
    return parseBisPolicyRatesCsv(rows.join("\n"), {
      ...context,
      sourceUrl: url,
    });
  } catch (error) {
    return parseFailure(sourceId, url, error);
  }
}

export function parseTreasuryParYieldXml(
  xml: string,
  context: MacroParseContext,
  maturities: readonly MacroMaturity[] = DEFAULT_MATURITIES,
): MacroBatch {
  const sourceId: KnownMacroSourceId = "us_treasury_par_yields";
  const url = context.sourceUrl ?? treasuryMonthUrl(new Date());
  try {
    const entries = [...xml.matchAll(/<entry(?:\s[^>]*)?>([\s\S]*?)<\/entry>/gi)].map((match) => match[1]);
    if (entries.length === 0) throw new Error("Treasury XML has no Atom entries");
    const parsed = entries.flatMap((entry) => {
      const rawDate = xmlElementText(entry, "NEW_DATE");
      if (!rawDate) return [];
      const date = assertIsoDate(rawDate.slice(0, 10));
      return [{ date, entry, updated: xmlElementText(entry, "updated") }];
    }).sort((a, b) => b.date.localeCompare(a.date));
    if (parsed.length === 0) throw new Error("Treasury XML entries have no NEW_DATE values");
    const latest = parsed[0];
    const source = sourceFor(sourceId, url, context, latest.updated);
    const observations: MacroObservation[] = [];
    const warnings: MacroWarning[] = [];
    for (const maturity of maturities) {
      const field = TREASURY_FIELDS[maturity];
      if (!field) {
        warnings.push({ source_id: sourceId, code: "series_missing", detail: `Treasury par curve does not publish requested maturity ${maturity}` });
        continue;
      }
      const raw = xmlElementText(latest.entry, field);
      if (!raw) {
        warnings.push({ source_id: sourceId, code: "value_missing", detail: `Treasury ${field} is missing for ${latest.date}` });
        continue;
      }
      let value: string;
      try {
        value = exactDecimal(raw);
      } catch (error) {
        warnings.push({ source_id: sourceId, code: "row_skipped", detail: `Treasury ${field}: ${error instanceof Error ? error.message : String(error)}` });
        continue;
      }
      observations.push(observation({
        id: `sovereign_yield:US:${maturity}`,
        indicator: "sovereign_yield",
        jurisdiction: "US",
        jurisdiction_name: "United States",
        institution: "U.S. Department of the Treasury",
        series_key: `daily_treasury_yield_curve.${field}`,
        label: `United States Treasury ${maturity} par yield`,
        maturity,
        value,
        method: "official_model",
        observed_at: latest.date,
        published_at: source.published_at,
        fetched_at: source.fetched_at,
        cadence: "business_daily",
        reference: {
          kind: "par_yield",
          authority: "official",
          is_live: false,
          frequency: "business_daily",
          delay: "end_of_day",
          temporal_precision: "date",
          note: "Official daily par yield curve derived from indicative secondary-market quotations; it is a reference curve, not an executable or intraday price.",
        },
        source,
      }));
    }
    if (observations.length === 0) throw new Error("Treasury XML contained none of the requested maturities");
    return { source, observations, warnings };
  } catch (error) {
    return parseFailure(sourceId, url, error);
  }
}

export function parseEcbYieldCurveCsv(
  csv: string,
  context: MacroParseContext,
  maturities: readonly MacroMaturity[] = DEFAULT_MATURITIES,
): MacroBatch {
  const sourceId: KnownMacroSourceId = "ecb_euro_area_yield_curve";
  const url = context.sourceUrl ?? `${ECB_YIELD_BASE_URL}.SR_2Y+SR_10Y?format=csvdata&lastNObservations=1&detail=dataonly`;
  try {
    const rows = parseMacroCsv(csv);
    if (rows.length < 2) throw new Error("ECB yield-curve CSV has no data rows");
    const header = rows[0].map((cell) => cell.trim().toUpperCase());
    const index = new Map(header.map((name, i) => [name, i]));
    for (const required of ["DATA_TYPE_FM", "TIME_PERIOD", "OBS_VALUE"]) {
      if (!index.has(required)) throw new Error(`ECB yield-curve CSV missing ${required}`);
    }
    const latest = new Map<string, { date: string; value: string; key: string }>();
    const warnings: MacroWarning[] = [];
    for (const row of rows.slice(1)) {
      const dataType = row[index.get("DATA_TYPE_FM")!]?.trim().toUpperCase();
      if (!dataType) continue;
      try {
        const date = assertIsoDate(row[index.get("TIME_PERIOD")!] ?? "");
        const value = exactDecimal(row[index.get("OBS_VALUE")!] ?? "");
        const key = index.has("KEY") ? row[index.get("KEY")!]?.trim() || dataType : dataType;
        if (!latest.has(dataType) || date > latest.get(dataType)!.date) latest.set(dataType, { date, value, key });
      } catch (error) {
        warnings.push({ source_id: sourceId, code: "row_skipped", detail: `Skipped ECB ${dataType} row: ${error instanceof Error ? error.message : String(error)}` });
      }
    }

    const source = sourceFor(sourceId, url, context);
    const observations: MacroObservation[] = [];
    for (const maturity of maturities) {
      const field = ECB_FIELDS[maturity];
      if (!field) {
        warnings.push({ source_id: sourceId, code: "series_missing", detail: `ECB configured curve does not expose requested maturity ${maturity}` });
        continue;
      }
      const found = latest.get(field);
      if (!found) {
        warnings.push({ source_id: sourceId, code: "series_missing", detail: `ECB yield-curve series ${field} was absent` });
        continue;
      }
      observations.push(observation({
        id: `sovereign_yield:XM:${maturity}`,
        indicator: "sovereign_yield",
        jurisdiction: "XM",
        jurisdiction_name: "Euro area",
        institution: "European Central Bank",
        series_key: found.key,
        label: `Euro area AAA central government bond ${maturity} modelled spot yield`,
        maturity,
        value: found.value,
        method: "official_model",
        observed_at: found.date,
        published_at: source.published_at,
        fetched_at: source.fetched_at,
        cadence: "business_daily",
        reference: {
          kind: "modelled_spot_yield",
          authority: "official",
          is_live: false,
          frequency: "business_daily",
          delay: "end_of_day",
          temporal_precision: "date",
          note: "ECB Svensson-model spot rate for AAA-rated euro-area central government bonds. It is a fitted official reference curve, not a directly traded or executable yield.",
        },
        source,
      }));
    }
    if (observations.length === 0) throw new Error("ECB CSV contained none of the requested maturities");
    return { source, observations, warnings };
  } catch (error) {
    return parseFailure(sourceId, url, error);
  }
}

export function parseMofJgbYieldCsv(
  csv: string,
  context: MacroParseContext,
  maturities: readonly MacroMaturity[] = DEFAULT_MATURITIES,
): MacroBatch {
  const sourceId: KnownMacroSourceId = "japan_mof_jgb_yields";
  const url = context.sourceUrl ?? MOF_JGB_URL;
  try {
    const rows = parseMacroCsv(csv);
    const headerIndex = rows.findIndex((row) => row.some((cell) => cell.trim().toUpperCase() === "DATE"));
    if (headerIndex < 0) throw new Error("MOF JGB CSV is missing its Date header row");
    const header = rows[headerIndex].map((cell) => cell.trim().toUpperCase());
    const index = new Map(header.map((name, i) => [name, i]));
    const parsed: Array<{ date: string; row: string[] }> = [];
    const warnings: MacroWarning[] = [];
    for (const row of rows.slice(headerIndex + 1)) {
      const rawDate = row[index.get("DATE")!]?.trim();
      if (!/^\d{4}\/\d{1,2}\/\d{1,2}$/.test(rawDate ?? "")) continue;
      try {
        const [year, month, day] = rawDate.split("/");
        const date = assertIsoDate(`${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`);
        parsed.push({ date, row });
      } catch (error) {
        warnings.push({ source_id: sourceId, code: "row_skipped", detail: `Skipped MOF row '${rawDate}': ${error instanceof Error ? error.message : String(error)}` });
      }
    }
    parsed.sort((a, b) => b.date.localeCompare(a.date));
    if (parsed.length === 0) throw new Error("MOF JGB CSV has no dated data rows");
    const latest = parsed[0];
    const source = sourceFor(sourceId, url, context);
    const observations: MacroObservation[] = [];
    for (const maturity of maturities) {
      const field = MOF_FIELDS[maturity];
      if (!field || !index.has(field)) {
        warnings.push({ source_id: sourceId, code: "series_missing", detail: `MOF JGB curve does not publish requested maturity ${maturity}` });
        continue;
      }
      const raw = latest.row[index.get(field)!]?.trim();
      if (!raw || raw === "-") {
        warnings.push({ source_id: sourceId, code: "value_missing", detail: `MOF ${field} is missing for ${latest.date}` });
        continue;
      }
      let value: string;
      try {
        value = exactDecimal(raw);
      } catch (error) {
        warnings.push({ source_id: sourceId, code: "row_skipped", detail: `MOF ${field}: ${error instanceof Error ? error.message : String(error)}` });
        continue;
      }
      observations.push(observation({
        id: `sovereign_yield:JP:${maturity}`,
        indicator: "sovereign_yield",
        jurisdiction: "JP",
        jurisdiction_name: "Japan",
        institution: "Ministry of Finance Japan",
        series_key: `jgbcme.${field}`,
        label: `Japanese Government Bond ${maturity} constant-maturity yield`,
        maturity,
        value,
        method: "official_model",
        observed_at: latest.date,
        published_at: source.published_at,
        fetched_at: source.fetched_at,
        cadence: "business_daily",
        reference: {
          kind: "constant_maturity_yield",
          authority: "official",
          is_live: false,
          frequency: "business_daily",
          delay: "end_of_day",
          temporal_precision: "date",
          note: "Official daily constant-maturity JGB reference yield published by Japan's Ministry of Finance; not an executable or intraday market quote.",
        },
        source,
      }));
    }
    if (observations.length === 0) throw new Error("MOF CSV contained none of the requested maturities");
    return { source, observations, warnings };
  } catch (error) {
    return parseFailure(sourceId, url, error);
  }
}

const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_TIMEOUT_MS = 30_000;
const MAX_RESPONSE_CHARS = 5_000_000;

function boundedTimeout(value?: number): number {
  if (value === undefined || !Number.isFinite(value)) return DEFAULT_TIMEOUT_MS;
  return Math.max(1, Math.min(MAX_TIMEOUT_MS, Math.trunc(value)));
}

async function fetchText(
  sourceId: KnownMacroSourceId,
  url: string,
  options: MacroAdapterOptions,
  accept: string,
): Promise<{ body: string; publishedAt: string | null }> {
  const fetcher = options.fetcher ?? globalThis.fetch;
  const timeoutMs = boundedTimeout(options.timeoutMs);
  const deadline = Date.now() + timeoutMs;
  const timeoutError = (phase: string) => new MacroAdapterError(
    sourceId,
    "timeout",
    `${sourceId} exceeded ${timeoutMs}ms${phase ? ` while ${phase}` : ""}`,
    url,
    true,
  );
  const beforeDeadline = <T>(promise: Promise<T>, phase: string): Promise<T> => {
    const remaining = Math.max(1, deadline - Date.now());
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => reject(timeoutError(phase)), remaining);
      promise.then(
        (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        (error) => {
          clearTimeout(timer);
          reject(error);
        },
      );
    });
  };
  let response: Response;
  try {
    response = await beforeDeadline(fetcher(url, {
      headers: { Accept: accept, "User-Agent": "CashLoom-World/1 (+https://cashloom.io)" },
      signal: AbortSignal.timeout(timeoutMs),
    }), "waiting for response headers");
  } catch (error) {
    if (error instanceof MacroAdapterError) throw error;
    const name = error instanceof Error ? error.name : "";
    const message = error instanceof Error ? error.message : String(error);
    if (name === "AbortError" || name === "TimeoutError") {
      throw new MacroAdapterError(sourceId, "timeout", `${sourceId} exceeded ${timeoutMs}ms`, url, true);
    }
    throw new MacroAdapterError(sourceId, "network", message, url, true);
  }
  if (!response.ok) {
    throw new MacroAdapterError(
      sourceId,
      "http",
      `${sourceId} answered HTTP ${response.status}`,
      url,
      response.status === 408 || response.status === 429 || response.status >= 500,
      response.status,
    );
  }
  const contentLength = Number(response.headers.get("content-length") ?? "0");
  if (Number.isFinite(contentLength) && contentLength > MAX_RESPONSE_CHARS) {
    throw new MacroAdapterError(sourceId, "parse", `${sourceId} response exceeded the ${MAX_RESPONSE_CHARS}-character safety bound`, url, false);
  }
  let body: string;
  try {
    body = await beforeDeadline(response.text(), "reading its body");
  } catch (error) {
    if (error instanceof MacroAdapterError) throw error;
    const name = error instanceof Error ? error.name : "";
    if (name === "AbortError" || name === "TimeoutError") {
      throw new MacroAdapterError(sourceId, "timeout", `${sourceId} exceeded ${timeoutMs}ms while reading its body`, url, true);
    }
    throw new MacroAdapterError(sourceId, "network", error instanceof Error ? error.message : String(error), url, true);
  }
  if (body.length > MAX_RESPONSE_CHARS) {
    throw new MacroAdapterError(sourceId, "parse", `${sourceId} response exceeded the ${MAX_RESPONSE_CHARS}-character safety bound`, url, false);
  }
  if (!body.trim()) throw new MacroAdapterError(sourceId, "parse", `${sourceId} returned an empty body`, url, false);
  return { body, publishedAt: httpDateToIso(response.headers.get("last-modified")) };
}

function fetchedAt(options: MacroAdapterOptions): string {
  return (options.now ?? (() => new Date()))().toISOString();
}

export async function fetchBisPolicyRates(options: MacroAdapterOptions = {}): Promise<MacroBatch> {
  const response = await fetchText("bis_policy_rates", BIS_POLICY_URL, options, "text/csv");
  return parseBisPolicyRatesCsv(response.body, {
    fetchedAt: fetchedAt(options),
    publishedAt: response.publishedAt,
    publishedAtStatus: response.publishedAt ? "http_last_modified" : undefined,
    sourceUrl: BIS_POLICY_URL,
  });
}

export async function fetchTreasuryParYields(options: YieldAdapterOptions = {}): Promise<MacroBatch> {
  const requestDate = (options.now ?? (() => new Date()))();
  const requestFetchedAt = requestDate.toISOString();
  const accept = "application/atom+xml, application/xml;q=0.9";
  const currentUrl = treasuryMonthUrl(requestDate);
  const current = await fetchText("us_treasury_par_yields", currentUrl, options, accept);
  try {
    return parseTreasuryParYieldXml(current.body, {
      fetchedAt: requestFetchedAt,
      publishedAt: current.publishedAt,
      publishedAtStatus: current.publishedAt ? "http_last_modified" : undefined,
      sourceUrl: currentUrl,
    }, options.maturities);
  } catch (error) {
    const isNoEntries = error instanceof MacroAdapterError
      && error.sourceId === "us_treasury_par_yields"
      && error.kind === "parse"
      && error.message === "Treasury XML has no Atom entries";
    if (!isNoEntries) throw error;
  }

  // At the start of a UTC month the new feed can legitimately contain no
  // business-day observations yet. Only that precise condition is allowed to
  // fall back; network, HTTP and malformed-entry failures remain visible.
  const fallbackUrl = treasuryMonthUrl(previousUtcMonth(requestDate));
  const fallback = await fetchText("us_treasury_par_yields", fallbackUrl, options, accept);
  return parseTreasuryParYieldXml(fallback.body, {
    fetchedAt: requestFetchedAt,
    publishedAt: fallback.publishedAt,
    publishedAtStatus: fallback.publishedAt ? "http_last_modified" : undefined,
    sourceUrl: fallbackUrl,
  }, options.maturities);
}

function ecbYieldUrl(maturities: readonly MacroMaturity[]): string {
  const fields = maturities.flatMap((maturity) => ECB_FIELDS[maturity] ? [ECB_FIELDS[maturity]!] : []);
  const selection = [...new Set(fields)].join("+") || "SR_2Y+SR_10Y";
  return `${ECB_YIELD_BASE_URL}.${selection}?format=csvdata&lastNObservations=1&detail=dataonly`;
}

export async function fetchEcbYieldCurve(options: YieldAdapterOptions = {}): Promise<MacroBatch> {
  const maturities = options.maturities ?? DEFAULT_MATURITIES;
  const url = ecbYieldUrl(maturities);
  const response = await fetchText("ecb_euro_area_yield_curve", url, options, "text/csv");
  return parseEcbYieldCurveCsv(response.body, {
    fetchedAt: fetchedAt(options),
    publishedAt: response.publishedAt,
    publishedAtStatus: response.publishedAt ? "http_last_modified" : undefined,
    sourceUrl: url,
  }, maturities);
}

export async function fetchMofJgbYields(options: YieldAdapterOptions = {}): Promise<MacroBatch> {
  const response = await fetchText("japan_mof_jgb_yields", MOF_JGB_URL, options, "text/csv");
  return parseMofJgbYieldCsv(response.body, {
    fetchedAt: fetchedAt(options),
    publishedAt: response.publishedAt,
    publishedAtStatus: response.publishedAt ? "http_last_modified" : undefined,
    sourceUrl: MOF_JGB_URL,
  }, options.maturities);
}

export interface ScheduledMeeting {
  readonly institution_code: MacroEvent["institution_code"];
  readonly starts_on: string;
  readonly ends_on: string;
  readonly decision_on: string;
  readonly projection_release: boolean;
  readonly schedule_status: MacroEvent["schedule_status"];
  readonly published_at: string | null;
}

type MeetingTuple = readonly [start: string, end: string, projection?: boolean];

function meetings(
  institutionCode: ScheduledMeeting["institution_code"],
  tuples: readonly MeetingTuple[],
  status: ScheduledMeeting["schedule_status"],
  publishedAt: string | null,
): ScheduledMeeting[] {
  return tuples.map(([start, end, projection = false]) => ({
    institution_code: institutionCode,
    starts_on: start,
    ends_on: end,
    decision_on: end,
    projection_release: projection,
    schedule_status: status,
    published_at: publishedAt,
  }));
}

const FED_2026: readonly MeetingTuple[] = [
  ["2026-01-27", "2026-01-28"], ["2026-03-17", "2026-03-18", true],
  ["2026-04-28", "2026-04-29"], ["2026-06-16", "2026-06-17", true],
  ["2026-07-28", "2026-07-29"], ["2026-09-15", "2026-09-16", true],
  ["2026-10-27", "2026-10-28"], ["2026-12-08", "2026-12-09", true],
];
const FED_2027: readonly MeetingTuple[] = [
  ["2027-01-26", "2027-01-27"], ["2027-03-16", "2027-03-17", true],
  ["2027-04-27", "2027-04-28"], ["2027-06-08", "2027-06-09", true],
  ["2027-07-27", "2027-07-28"], ["2027-09-14", "2027-09-15", true],
  ["2027-10-26", "2027-10-27"], ["2027-12-07", "2027-12-08", true],
];
const ECB_2026: readonly MeetingTuple[] = [
  ["2026-02-04", "2026-02-05"], ["2026-03-18", "2026-03-19", true],
  ["2026-04-29", "2026-04-30"], ["2026-06-10", "2026-06-11", true],
  ["2026-07-22", "2026-07-23"], ["2026-09-09", "2026-09-10", true],
  ["2026-10-28", "2026-10-29"], ["2026-12-16", "2026-12-17", true],
];
const ECB_2027: readonly MeetingTuple[] = [
  ["2027-02-03", "2027-02-04"], ["2027-03-17", "2027-03-18", true],
  ["2027-04-28", "2027-04-29"], ["2027-06-09", "2027-06-10", true],
  ["2027-07-21", "2027-07-22"], ["2027-09-08", "2027-09-09", true],
  ["2027-10-27", "2027-10-28"], ["2027-12-15", "2027-12-16", true],
];
const BOE_2026: readonly MeetingTuple[] = [
  ["2026-02-05", "2026-02-05", true], ["2026-03-19", "2026-03-19"],
  ["2026-04-30", "2026-04-30", true], ["2026-06-18", "2026-06-18"],
  ["2026-07-30", "2026-07-30", true], ["2026-09-17", "2026-09-17"],
  ["2026-11-05", "2026-11-05", true], ["2026-12-17", "2026-12-17"],
];
const BOE_2027: readonly MeetingTuple[] = [
  ["2027-02-04", "2027-02-04", true], ["2027-03-18", "2027-03-18"],
  ["2027-04-29", "2027-04-29", true], ["2027-06-17", "2027-06-17"],
  ["2027-07-29", "2027-07-29", true], ["2027-09-16", "2027-09-16"],
  ["2027-11-04", "2027-11-04", true], ["2027-12-16", "2027-12-16"],
];
const BOJ_2026: readonly MeetingTuple[] = [
  ["2026-01-22", "2026-01-23", true], ["2026-03-18", "2026-03-19"],
  ["2026-04-27", "2026-04-28", true], ["2026-06-15", "2026-06-16"],
  ["2026-07-30", "2026-07-31", true], ["2026-09-17", "2026-09-18"],
  ["2026-10-29", "2026-10-30", true], ["2026-12-17", "2026-12-18"],
];
const BOJ_2027: readonly MeetingTuple[] = [
  ["2027-01-21", "2027-01-22", true], ["2027-03-17", "2027-03-18"],
  ["2027-04-27", "2027-04-28", true], ["2027-06-10", "2027-06-11"],
  ["2027-07-21", "2027-07-22", true], ["2027-09-21", "2027-09-22"],
  ["2027-10-28", "2027-10-29", true], ["2027-12-16", "2027-12-17"],
];

/**
 * A deterministic, reviewable transcription of official 2026/2027 schedules.
 * It intentionally contains date facts only: no guessed release clock times.
 */
export const CENTRAL_BANK_MEETINGS: readonly ScheduledMeeting[] = Object.freeze([
  ...meetings("FED", FED_2026, "scheduled", "2026-08-19"),
  ...meetings("FED", FED_2027, "tentative", "2026-08-19"),
  ...meetings("ECB", ECB_2026, "scheduled", null),
  ...meetings("ECB", ECB_2027, "scheduled", null),
  ...meetings("BOE", BOE_2026, "confirmed", "2026-05-26"),
  ...meetings("BOE", BOE_2027, "provisional", "2026-05-26"),
  ...meetings("BOJ", BOJ_2026, "scheduled", "2025-07-31"),
  ...meetings("BOJ", BOJ_2027, "scheduled", "2026-07-31"),
]
  .sort((a, b) => a.starts_on.localeCompare(b.starts_on) || a.institution_code.localeCompare(b.institution_code))
  .map((meeting) => Object.freeze(meeting)));

const MEETING_META: Record<MacroEvent["institution_code"], {
  jurisdiction: MacroJurisdiction;
  jurisdictionName: string;
  institution: string;
  title: string;
  sourceId: KnownMacroSourceId;
}> = {
  FED: {
    jurisdiction: "US",
    jurisdictionName: "United States",
    institution: "Federal Open Market Committee",
    title: "FOMC monetary policy meeting",
    sourceId: "fed_meeting_calendar",
  },
  ECB: {
    jurisdiction: "XM",
    jurisdictionName: "Euro area",
    institution: "ECB Governing Council",
    title: "ECB Governing Council monetary policy meeting",
    sourceId: "ecb_meeting_calendar",
  },
  BOE: {
    jurisdiction: "GB",
    jurisdictionName: "United Kingdom",
    institution: "Bank of England Monetary Policy Committee",
    title: "Bank of England MPC decision, summary and minutes",
    sourceId: "boe_meeting_calendar",
  },
  BOJ: {
    jurisdiction: "JP",
    jurisdictionName: "Japan",
    institution: "Bank of Japan Policy Board",
    title: "Bank of Japan Monetary Policy Meeting",
    sourceId: "boj_meeting_calendar",
  },
};

export interface MeetingCalendarOptions {
  from?: string;
  to?: string;
  institutions?: readonly MacroEvent["institution_code"][];
  now?: MacroNow;
}

export function getCentralBankMeetings(options: MeetingCalendarOptions = {}): MacroEvent[] {
  const now = options.now ?? (() => new Date());
  const requestedAt = now().toISOString();
  const from = options.from ? assertIsoDate(options.from) : requestedAt.slice(0, 10);
  const to = options.to ? assertIsoDate(options.to) : null;
  const institutions = options.institutions ? new Set(options.institutions) : null;
  return CENTRAL_BANK_MEETINGS
    .filter((meeting) => meeting.decision_on >= from && (!to || meeting.starts_on <= to))
    .filter((meeting) => !institutions || institutions.has(meeting.institution_code))
    .map((meeting) => {
      const meta = MEETING_META[meeting.institution_code];
      const definition = MACRO_SOURCE_DEFINITIONS[meta.sourceId];
      const source = sourceFor(meta.sourceId, definition.landing_page_url, {
        fetchedAt: CALENDAR_VERIFIED_AT,
        publishedAt: meeting.published_at,
        publishedAtStatus: meeting.published_at ? "source_timestamp" : undefined,
        retrieval: "verified_transcription",
        verifiedAt: CALENDAR_VERIFIED_AT,
      });
      return {
        "@type": "MacroEvent" as const,
        schema: "cashloom.macro-event/1" as const,
        id: `central_bank_meeting:${meeting.institution_code}:${meeting.decision_on}`,
        category: "central_bank_meeting" as const,
        jurisdiction: meta.jurisdiction,
        jurisdiction_name: meta.jurisdictionName,
        institution: meta.institution,
        institution_code: meeting.institution_code,
        title: meta.title,
        starts_on: meeting.starts_on,
        ends_on: meeting.ends_on,
        decision_on: meeting.decision_on,
        time_status: "not_announced" as const,
        projection_release: meeting.projection_release,
        schedule_status: meeting.schedule_status,
        published_at: source.published_at,
        fetched_at: CALENDAR_VERIFIED_AT,
        retrieval: "verified_transcription" as const,
        verified_at: CALENDAR_VERIFIED_AT,
        source,
      };
    });
}

function failureFrom(sourceId: MacroSourceId, url: string, error: unknown): MacroFailure {
  if (error instanceof MacroAdapterError) {
    return {
      source_id: sourceId,
      kind: error.kind,
      detail: error.message,
      retryable: error.retryable,
      status_code: error.statusCode,
      url: error.url,
    };
  }
  return {
    source_id: sourceId,
    kind: "network",
    detail: error instanceof Error ? error.message : String(error),
    retryable: true,
    url,
  };
}

function calendarSourceStatuses(events: readonly MacroEvent[], asOf: string): MacroSourceStatus[] {
  const ids: KnownMacroSourceId[] = [
    "fed_meeting_calendar",
    "ecb_meeting_calendar",
    "boe_meeting_calendar",
    "boj_meeting_calendar",
  ];
  const verificationAgeDays = Math.max(0, (Date.parse(asOf) - Date.parse(CALENDAR_VERIFIED_AT)) / 86_400_000);
  const expired = verificationAgeDays > CALENDAR_VERIFICATION_MAX_AGE_DAYS;
  return ids.map((sourceId) => {
    const matching = events.filter((event) => event.source.id === sourceId);
    const first = matching[0];
    return {
      source_id: sourceId,
      status: expired ? "degraded" : "ok",
      observation_count: 0,
      event_count: matching.length,
      warning_count: 0,
      fetched_at: first?.fetched_at ?? CALENDAR_VERIFIED_AT,
      published_at: first?.published_at ?? null,
      url: MACRO_SOURCE_DEFINITIONS[sourceId].landing_page_url,
      retrieval: "verified_transcription",
      verified_at: CALENDAR_VERIFIED_AT,
      detail: expired
        ? `Checked-in calendar verification is older than ${CALENDAR_VERIFICATION_MAX_AGE_DAYS} days; re-check the official authority page before treating future dates as current.`
        : "Checked-in calendar transcription verified against the official authority page on 2026-08-20; it is not fetched live per request.",
    };
  });
}

export interface MacroSnapshotOptions extends MacroAdapterOptions {
  maturities?: readonly MacroMaturity[];
  calendarFrom?: string;
  calendarTo?: string;
}

/** Fetch every launch source concurrently and retain partial successes. */
export async function fetchMacroSnapshot(options: MacroSnapshotOptions = {}): Promise<MacroSnapshot> {
  const now = options.now ?? (() => new Date());
  const generatedAt = now().toISOString();
  const common: YieldAdapterOptions = {
    fetcher: options.fetcher,
    now,
    timeoutMs: options.timeoutMs,
    maturities: options.maturities,
  };
  const calls: Array<{ id: KnownMacroSourceId; url: string; run: () => Promise<MacroBatch> }> = [
    { id: "bis_policy_rates", url: BIS_POLICY_URL, run: () => fetchBisPolicyRates(common) },
    {
      id: "us_treasury_par_yields",
      url: treasuryMonthUrl(new Date(generatedAt)),
      run: () => fetchTreasuryParYields(common),
    },
    {
      id: "ecb_euro_area_yield_curve",
      url: ecbYieldUrl(options.maturities ?? DEFAULT_MATURITIES),
      run: () => fetchEcbYieldCurve(common),
    },
    { id: "japan_mof_jgb_yields", url: MOF_JGB_URL, run: () => fetchMofJgbYields(common) },
  ];
  const settled = await Promise.allSettled(calls.map((call) => call.run()));
  const batches: MacroBatch[] = [];
  const failures: MacroFailure[] = [];
  const sources: MacroSourceStatus[] = [];
  settled.forEach((result, index) => {
    const call = calls[index];
    if (result.status === "fulfilled") {
      const batch = result.value;
      batches.push(batch);
      sources.push({
        source_id: call.id,
        status: batch.warnings.length ? "degraded" : "ok",
        observation_count: batch.observations.length,
        event_count: 0,
        warning_count: batch.warnings.length,
        fetched_at: batch.source.fetched_at,
        published_at: batch.source.published_at,
        url: batch.source.url,
        retrieval: batch.source.retrieval ?? "live_fetch",
        verified_at: batch.source.verified_at ?? null,
        ...(batch.warnings.length ? { detail: batch.warnings.map((warning) => warning.detail).join("; ") } : {}),
      });
    } else {
      const failure = failureFrom(call.id, call.url, result.reason);
      failures.push(failure);
      sources.push({
        source_id: call.id,
        status: "failed",
        observation_count: 0,
        event_count: 0,
        warning_count: 0,
        fetched_at: null,
        published_at: null,
        url: failure.url,
        retrieval: "live_fetch",
        verified_at: null,
        detail: failure.detail,
      });
    }
  });

  const allObservations = batches.flatMap((batch) => batch.observations);
  const policy = allObservations.filter((item) => item.indicator === "central_bank_policy_rate");
  const sovereigns = allObservations.filter((item) => item.indicator === "sovereign_yield");
  const warnings = batches.flatMap((batch) => batch.warnings);
  const calendar = getCentralBankMeetings({
    from: options.calendarFrom ?? generatedAt.slice(0, 10),
    to: options.calendarTo,
    now,
  });
  const calendarSources = calendarSourceStatuses(calendar, generatedAt);
  sources.push(...calendarSources);

  const dataSourcesSucceeded = batches.length;
  const status: MacroSnapshot["status"] = dataSourcesSucceeded === 0
    ? "unavailable"
    : failures.length || warnings.length || calendarSources.some((source) => source.status === "degraded")
      ? "partial"
      : "ok";
  return {
    "@type": "MacroSnapshot",
    schema: "cashloom.macro-snapshot/1",
    generated_at: generatedAt,
    status,
    complete: status === "ok",
    policy,
    sovereigns,
    calendar,
    sources,
    warnings,
    failures,
  };
}
