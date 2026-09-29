import { decimalFromRaw, exactValueFromDecimal, type ExactValue } from "../blockchain/model.ts";

export const CAPITAL_FLOWS_SCHEMA = "cashloom.capital-flows/1" as const;
export const CAPITAL_FLOWS_MEDIA_TYPE = "application/vnd.cashloom.capital-flows.v1+json";
export const CAPITAL_LIMITS = Object.freeze({
  sources: 8, series: 128, concurrentRequests: 3, adapterMs: 8_000, refreshMs: 25_000,
  coldWaitMs: 1_000, responseBytes: 2 * 1024 * 1024, adapterBytes: 4 * 1024 * 1024,
  pages: 3, rows: 15_000, normalizedBytes: 8 * 1024 * 1024, serializedBytes: 2 * 1024 * 1024,
  decimalChars: 128, fallbackMs: 7 * 24 * 60 * 60 * 1_000,
  failureBackoffMs: 5 * 60 * 1_000, maxFailureBackoffMs: 6 * 60 * 60 * 1_000,
});
export type Frequency = "daily" | "weekly" | "monthly" | "quarterly" | "event";
export type AssetCategory = "sovereignDebt" | "equities" | "bonds" | "preciousMetals" | "crypto" | "privateEquity" | "realEstate";
export type MetricKind = "issuance" | "redemptions" | "netIssuance" | "auctionAllotment" | "purchases" | "sales" | "netAcquisition" | "subscriptions" | "fundRedemptions" | "netSubscriptions" | "portfolioTransactions" | "turnover";
export interface Rights {
  status: "allowed" | "restricted" | "unknown";
  attribution: string;
  evidenceUrl: string;
  checkedAt: string | null;
  note: string;
}
export interface Geography { code: string; label: string }
export interface NativeUnit {
  currency: string;
  /** Publisher's power-of-ten multiplier; a value of 12 at exponent 6 is 12 million. */
  exponent: number;
  label: string;
}
export interface NativeValue extends ExactValue {
  publisherLexeme: string;
  currency: string;
  unitExponent: number;
  unitMultiplier: string;
}
/** Expand bounded scientific notation exactly; never pass the publisher's value through Number. */
export function expandDecimalLexeme(lexeme: string): string {
  if (typeof lexeme !== "string" || lexeme.length > CAPITAL_LIMITS.decimalChars) throw new Error("invalid_decimal");
  const match = /^([+-]?)(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d{1,3}))?$/.exec(lexeme);
  if (!match) throw new Error("invalid_decimal");
  const [, sign, whole, fraction = "", exponentText = "0"] = match;
  const exponent = Number(exponentText); // Only a bounded scale, never the value.
  if (Math.abs(exponent) > CAPITAL_LIMITS.decimalChars) throw new Error("invalid_decimal");
  const digits = whole + fraction;
  const point = whole.length + exponent;
  const decimal = point <= 0 ? `0.${"0".repeat(-point)}${digits}`
    : point >= digits.length ? digits + "0".repeat(point - digits.length)
      : `${digits.slice(0, point)}.${digits.slice(point)}`;
  const expanded = `${sign === "-" ? "-" : ""}${decimal}`;
  if (expanded.length > CAPITAL_LIMITS.decimalChars) throw new Error("invalid_decimal");
  return expanded;
}
export function nativeValue(lexeme: string, unit: NativeUnit): NativeValue {
  const expanded = expandDecimalLexeme(lexeme);
  if (!/^[A-Z]{3}$/.test(unit.currency) || !Number.isInteger(unit.exponent) || unit.exponent < 0 || unit.exponent > 12) throw new Error("invalid_unit");
  const prefix: Record<number, string> = { 0: "", 3: "thousand ", 6: "million ", 9: "billion ", 12: "trillion " };
  const label = `${prefix[unit.exponent] ?? `10^${unit.exponent} `}${unit.currency}`;
  if (unit.label !== label) throw new Error("misleading_unit_label");
  const exact = exactValueFromDecimal(expanded, label);
  return { ...exact, decimal: decimalFromRaw(exact.raw, exact.decimals), publisherLexeme: lexeme,
    currency: unit.currency, unitExponent: unit.exponent, unitMultiplier: `1${"0".repeat(unit.exponent)}` };
}
export interface Period { frequency: Frequency; label: string; start: string; end: string }
function validDate(value: string): boolean {
  // Contemporary flow histories support years 1000–9999. Excluding early years
  // also avoids Date.UTC's special remapping of years 0–99 into 1900–1999.
  if (!/^[1-9]\d{3}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}
export function validatePeriod(period: Period): void {
  if (!period || !validDate(period.start) || !validDate(period.end) || period.start > period.end) throw new Error("invalid_period");
  const start = new Date(`${period.start}T00:00:00Z`);
  const end = new Date(`${period.end}T00:00:00Z`);
  const days = (end.getTime() - start.getTime()) / 86_400_000;
  switch (period.frequency) {
    case "daily": case "event": if (days !== 0 || period.label !== period.start) throw new Error("invalid_period"); break;
    case "weekly": if (days !== 6 || period.label !== `${period.start}/${period.end}`) throw new Error("invalid_period"); break;
    case "monthly": {
      const last = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 0)).toISOString().slice(0, 10);
      if (start.getUTCDate() !== 1 || period.end !== last || period.label !== period.start.slice(0, 7)) throw new Error("invalid_period"); break;
    }
    case "quarterly": {
      const month = start.getUTCMonth();
      const last = new Date(Date.UTC(start.getUTCFullYear(), month + 3, 0)).toISOString().slice(0, 10);
      if (start.getUTCDate() !== 1 || month % 3 !== 0 || period.end !== last || period.label !== `${start.getUTCFullYear()}-Q${month / 3 + 1}`) throw new Error("invalid_period"); break;
    }
    default: throw new Error("invalid_period");
  }
}
export function reportingPeriod(frequency: Frequency, label: string): Period {
  let start = label, end = label;
  if (frequency === "monthly") {
    if (!/^[1-9]\d{3}-(0[1-9]|1[0-2])$/.test(label)) throw new Error("invalid_period");
    start = `${label}-01`;
    end = new Date(Date.UTC(Number(label.slice(0, 4)), Number(label.slice(5)), 0)).toISOString().slice(0, 10);
  } else if (frequency === "quarterly") {
    if (!/^[1-9]\d{3}-Q[1-4]$/.test(label)) throw new Error("invalid_period");
    const month = (Number(label.slice(-1)) - 1) * 3;
    start = `${label.slice(0, 4)}-${String(month + 1).padStart(2, "0")}-01`;
    end = new Date(Date.UTC(Number(label.slice(0, 4)), month + 3, 0)).toISOString().slice(0, 10);
  } else if (frequency === "weekly") {
    [start, end] = label.split("/") as [string, string];
  }
  const result = { frequency, label, start, end };
  validatePeriod(result);
  return result;
}
export interface SeriesDefinition {
  id: string;
  sourceId: string;
  sourceSeriesId: string;
  datasetId: string;
  label: string;
  category: AssetCategory;
  metricKind: MetricKind;
  frequency: Frequency;
  unit: NativeUnit;
  perspective: string;
  signConvention: string;
  geography: {
    issuer: Geography | null; investor: Geography | null; reporting: Geography | null;
    custodial: Geography | null; fundDomicile: Geography | null;
  };
  instrument: string;
  sector: string;
  fundMandate: string | null;
  valuation: string;
  seasonalAdjustment: "unadjusted" | "seasonallyAdjusted" | "unknown";
  annualization: "notAnnualized" | "annualizedRate" | "unknown";
  methodologyUrl: string;
  sourceUrl: string;
  limitations: string[];
}
export interface TransportReceipt {
  /** Exact final allowlisted URL (including fixed query). */
  url: string;
  retrievedAt: string;
  /** Transport metadata, never substituted for publicationAt. */
  lastModified: string | null;
  etag: string | null;
  decodedBytes: number;
}
export interface ObservationReceipt {
  sourceId: string;
  sourceSeriesId: string;
  datasetId: string;
  resourceUrl: string;
  retrievedAt: string;
  publicationAt: string | null;
  method: "publisherReported" | "derivedCompatibleComponents";
  recipe: string;
  /** Identifiers only; no hidden input values. Inputs must be in this same batch. */
  inputObservationIds: string[];
  limitations: string[];
}
export interface FlowObservation {
  id: string;
  seriesId: string;
  period: Period;
  value: NativeValue | null;
  status: "observed" | "missing" | "suppressed" | "notYetReported" | "withdrawn";
  provisional: boolean;
  revised: boolean;
  estimated: boolean;
  /** Raw publisher codes, retained separately from interpreted flags (normal is not final). */
  publisherStatus: string | null;
  publisherConfidentiality: string | null;
  break: boolean;
  completeness: "complete" | "partial" | "unknown";
  receipt: ObservationReceipt;
}
export interface SourceDefinition {
  id: string;
  name: string;
  sourceUrl: string;
  methodologyUrl: string;
  rights: Rights;
  /** Exact, predeclared HTTPS resources. Includes every metadata/page/redirect destination. */
  resources: readonly string[];
  cadence: Frequency;
  limitations: string[];
}
export interface TextResponse { text: string; url: string; headers: Readonly<Record<string, string>>; receipt: TransportReceipt }
export interface AdapterContext {
  signal: AbortSignal;
  /** GET only. Shared concurrency, body, redirect, page and adapter budgets are enforced here. */
  fetchText(url: string): Promise<TextResponse>;
  /** Charge every parsed row (including filtered-out rows) before creating observations. */
  consumeRows(count: number): void;
  /**
   * Required after the final consumeRows: assert completion of the declared
   * response/selection window, not the publisher's entire historical dataset.
   * A validated unpaginated CSV uses assertComplete(rows, rows). A paginated
   * selection must validate its expected row count and all pages/paired records
   * first; do not label a truncated page set complete or sum across periods.
   */
  assertComplete(receivedRows: number, expectedRows: number): void;
}
export interface SourceBatch {
  /** Full bounded replacement of the source's selected histories; not a partial patch. */
  complete: true;
  observations: FlowObservation[];
  /** Return the actual receipts from context.fetchText, not invented timestamps. */
  receipts: TransportReceipt[];
}
export interface CapitalFlowAdapter {
  definition: SourceDefinition;
  series: readonly SeriesDefinition[];
  load(context: AdapterContext): Promise<SourceBatch>;
}
export type SourceRetrievalState = "empty" | "refreshing" | "current" | "fallback" | "unavailable" | "rightsWithheld";
export interface SourceState {
  definition: SourceDefinition;
  retrievalState: SourceRetrievalState;
  lastAttemptAt: string | null;
  lastSuccessAt: string | null;
  nextAttemptAt: string | null;
  fallbackExpiresAt: string | null;
  failure: string | null;
  receipts: TransportReceipt[];
}
export interface FlowSeries {
  definition: SeriesDefinition;
  state: SourceRetrievalState;
  reportingRecency: "expectation_unknown";
  history: FlowObservation[];
}
export interface CoverageRecord {
  id: string;
  label: string;
  dimension: "assetCategory" | "issuerMarket" | "marketScope";
  state: "scopedData" | "unavailable";
  seriesIds: string[];
  limitation: string;
}
export interface CapitalFlowsSnapshot {
  schema: typeof CAPITAL_FLOWS_SCHEMA;
  generatedAt: string;
  scope: "selectedPublisherReportedFlows";
  historyPolicy: "latestRevisedPublisherHistoryNotVintageArchive";
  refresh: { state: "idle" | "refreshing"; health: "empty" | "partial" | "available"; launchReadiness: "notAssessed" };
  sources: SourceState[];
  series: FlowSeries[];
  coverage: CoverageRecord[];
  limitations: string[];
}
export const HISTORY_LIMIT: Record<Frequency, number> = { daily: 60, weekly: 26, monthly: 24, quarterly: 20, event: 30 };
export function sourceTtlMs(cadence: Frequency): number {
  return cadence === "monthly" || cadence === "quarterly" ? 6 * 60 * 60 * 1_000 : 60 * 60 * 1_000;
}
