import type {
  CapitalFlowsSnapshot, CoverageRecord, FlowObservation, FlowSeries, Geography,
  NativeUnit, NativeValue, ObservationReceipt, Period, Rights, SeriesDefinition,
  SourceDefinition, SourceState, TransportReceipt,
} from "./types";

export class CapitalFlowsApiError extends Error {
  constructor(message: string, readonly status?: number) { super(message); this.name = "CapitalFlowsApiError"; }
}
function invalid(): never { throw new CapitalFlowsApiError("The capital-flows response failed its schema or source-receipt checks. No replacement values were accepted."); }
type Parser<T> = (value: unknown) => T;
function object<T>(fields: { [K in keyof T]-?: Parser<T[K]> }): Parser<T> {
  return value => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return invalid();
    const input = value as Record<string, unknown>;
    // Whitelist the contract, including nested objects; unknown hidden fields are discarded.
    return Object.fromEntries(Object.entries(fields).map(([key, parse]) =>
      [key, (parse as Parser<unknown>)(input[key])])) as T;
  };
}
function text(max = 4096): Parser<string> {
  return value => typeof value === "string" && value.length <= max ? value : invalid();
}
const id: Parser<string> = value => { const s = text(256)(value); return s.trim() ? s : invalid(); };
const bool: Parser<boolean> = value => typeof value === "boolean" ? value : invalid();
function integer(max: number): Parser<number> {
  return value => typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= max ? value : invalid();
}
function oneOf<const T extends readonly string[]>(...values: T): Parser<T[number]> {
  return value => typeof value === "string" && values.includes(value) ? value : invalid();
}
function nullable<T>(parse: Parser<T>): Parser<T | null> { return value => value === null ? null : parse(value); }
function array<T>(parse: Parser<T>, max = 64): Parser<T[]> {
  return value => Array.isArray(value) && value.length <= max ? value.map(parse) : invalid();
}
const texts = array(text());
const timestamp: Parser<string> = value => {
  const s = text(40)(value);
  if (!/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(s) || !Number.isFinite(Date.parse(s))) return invalid();
  // Match the backend calendar check; Date.parse normalizes February 30.
  date(s.slice(0, 10));
  return s;
};
const date: Parser<string> = value => {
  const s = text(10)(value);
  return /^\d{4}-\d{2}-\d{2}$/.test(s) && Number.isFinite(Date.parse(s)) && new Date(s).toISOString().slice(0, 10) === s ? s : invalid();
};
export function safeHttpsUrl(value: string): string | undefined {
  try { const u = new URL(value); return u.protocol === "https:" && !u.username && !u.password ? u.href : undefined; }
  catch { return undefined; }
}
const url: Parser<string> = value => { const s = text()(value); return safeHttpsUrl(s) ? s : invalid(); };
const frequency = oneOf("daily", "weekly", "monthly", "quarterly", "event");
const retrieval = oneOf("empty", "refreshing", "current", "fallback", "unavailable", "rightsWithheld");
const category = oneOf("sovereignDebt", "equities", "bonds", "preciousMetals", "crypto", "privateEquity", "realEstate");
const metric = oneOf("issuance", "redemptions", "netIssuance", "auctionAllotment", "purchases", "sales", "netAcquisition", "subscriptions", "fundRedemptions", "netSubscriptions", "portfolioTransactions", "turnover");
const geography = nullable(object<Geography>({ code: id, label: id }));
const rights = object<Rights>({ status: oneOf("allowed", "restricted", "unknown"), attribution: text(), evidenceUrl: text(), checkedAt: nullable(timestamp), note: text() });
const unit = object<NativeUnit>({ currency: text(3), exponent: integer(12), label: text(64) });
const native = object<NativeValue>({ raw: text(128), decimal: text(128), decimals: integer(128), unit: text(64), display: text(256), publisherLexeme: text(128), currency: text(3), unitExponent: integer(12), unitMultiplier: text(13) });
const period = object<Period>({ frequency, label: text(32), start: date, end: date });
const transport = object<TransportReceipt>({ url, retrievedAt: timestamp, lastModified: nullable(text(512)), etag: nullable(text(512)), decodedBytes: integer(2 * 1024 * 1024) });
const receipt = object<ObservationReceipt>({ sourceId: id, sourceSeriesId: id, datasetId: id, resourceUrl: url, retrievedAt: timestamp, publicationAt: nullable(timestamp), method: oneOf("publisherReported", "derivedCompatibleComponents"), recipe: text(), inputObservationIds: array(id), limitations: texts });
const observation = object<FlowObservation>({ id, seriesId: id, period, value: nullable(native), status: oneOf("observed", "missing", "suppressed", "notYetReported", "withdrawn"), provisional: bool, revised: bool, estimated: bool, publisherStatus: nullable(text(64)), publisherConfidentiality: nullable(text(64)), break: bool, completeness: oneOf("complete", "partial", "unknown"), receipt });
const definition = object<SeriesDefinition>({
  id, sourceId: id, sourceSeriesId: id, datasetId: id, label: text(), category, metricKind: metric,
  frequency, unit, perspective: text(), signConvention: text(),
  geography: object<SeriesDefinition["geography"]>({ issuer: geography, investor: geography, reporting: geography, custodial: geography, fundDomicile: geography }),
  instrument: text(), sector: text(), fundMandate: nullable(text()), valuation: text(),
  seasonalAdjustment: oneOf("unadjusted", "seasonallyAdjusted", "unknown"), annualization: oneOf("notAnnualized", "annualizedRate", "unknown"),
  methodologyUrl: url, sourceUrl: url, limitations: texts,
});
const sourceDefinition = object<SourceDefinition>({ id, name: text(), sourceUrl: url, methodologyUrl: url, rights, resources: array(url, 12), cadence: frequency, limitations: texts });
const source = object<SourceState>({ definition: sourceDefinition, retrievalState: retrieval, lastAttemptAt: nullable(timestamp), lastSuccessAt: nullable(timestamp), nextAttemptAt: nullable(timestamp), fallbackExpiresAt: nullable(timestamp), failure: nullable(text()), receipts: array(transport, 3) });
const series = object<FlowSeries>({ definition, state: retrieval, reportingRecency: oneOf("expectation_unknown"), history: array(observation, 60) });
const coverage = object<CoverageRecord>({ id, label: text(), dimension: oneOf("assetCategory", "issuerMarket", "marketScope"), state: oneOf("scopedData", "unavailable"), seriesIds: array(id, 128), limitation: text() });
const snapshot = object<CapitalFlowsSnapshot>({
  schema: oneOf("cashloom.capital-flows/1"), generatedAt: timestamp, scope: oneOf("selectedPublisherReportedFlows"), historyPolicy: oneOf("latestRevisedPublisherHistoryNotVintageArchive"),
  refresh: object<CapitalFlowsSnapshot["refresh"]>({ state: oneOf("idle", "refreshing"), health: oneOf("empty", "partial", "available"), launchReadiness: oneOf("notAssessed") }),
  sources: array(source, 8), series: array(series, 128), coverage: array(coverage), limitations: texts,
});
const historyLimit = { daily: 60, weekly: 26, monthly: 24, quarterly: 20, event: 30 };

function checkPeriod(p: Period): void {
  if (p.start > p.end) invalid();
  const start = new Date(p.start), end = new Date(p.end);
  const days = (end.getTime() - start.getTime()) / 86400000;
  const month = start.getUTCMonth(), year = start.getUTCFullYear();
  if (p.frequency === "daily" || p.frequency === "event") {
    if (days !== 0 || p.label !== p.start) invalid();
  } else if (p.frequency === "weekly") {
    if (days !== 6 || p.label !== `${p.start}/${p.end}`) invalid();
  } else {
    const months = p.frequency === "monthly" ? 1 : 3;
    const last = new Date(Date.UTC(year, month + months, 0)).toISOString().slice(0, 10);
    const label = months === 1 ? p.start.slice(0, 7) : `${year}-Q${month / 3 + 1}`;
    if (start.getUTCDate() !== 1 || (months === 3 && month % 3 !== 0) || p.end !== last || p.label !== label) invalid();
  }
}
function canonicalDecimal(raw: string, scale: number): string {
  if (!/^-?\d+$/.test(raw)) return invalid();
  const n = BigInt(raw), digits = (n < 0n ? -n : n).toString().padStart(scale + 1, "0");
  const fraction = scale ? digits.slice(-scale).replace(/0+$/, "") : "";
  return `${n < 0n ? "-" : ""}${scale ? digits.slice(0, -scale) : digits}${fraction ? `.${fraction}` : ""}`;
}
function publisherDecimal(lexeme: string): string {
  const m = /^([+-]?)(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d{1,3}))?$/.exec(lexeme);
  if (!m) return invalid();
  const [, sign, whole, fraction = "", exp = "0"] = m;
  const exponent = Number(exp); // Bounded scale only; never the financial amount.
  if (Math.abs(exponent) > 128) return invalid();
  const scale = fraction.length - exponent;
  const raw = `${sign === "-" ? "-" : ""}${whole}${fraction}${scale < 0 ? "0".repeat(-scale) : ""}`;
  const result = canonicalDecimal(raw, Math.max(0, scale));
  return result.length <= 128 ? result : invalid();
}
function checkValue(value: NativeValue, u: NativeUnit): void {
  if (value.currency !== u.currency || value.unitExponent !== u.exponent || value.unitMultiplier !== `1${"0".repeat(u.exponent)}` || value.unit !== u.label ||
    value.decimal !== canonicalDecimal(value.raw, value.decimals) || value.decimal !== publisherDecimal(value.publisherLexeme) || value.display !== `${value.decimal} ${u.label}`) invalid();
}
function unique<T>(values: T[], key: (value: T) => string): Map<string, T> {
  const map = new Map(values.map(v => [key(v), v]));
  if (map.size !== values.length) invalid();
  return map;
}
/** Validate every displayed field and its cross-links; no loose World-style records. */
export function parseCapitalFlowsSnapshot(body: unknown): CapitalFlowsSnapshot {
  const result = snapshot(body);
  const sources = unique(result.sources, s => s.definition.id);
  const allSeries = unique(result.series, s => s.definition.id);
  const observations = unique(result.series.flatMap(s => s.history), o => o.id);
  unique(result.coverage, c => `${c.dimension}:${c.id}`);
  for (const s of result.sources) {
    const r = s.definition.rights;
    if (r.evidenceUrl && !safeHttpsUrl(r.evidenceUrl)) invalid();
    if (r.status === "allowed" && (!r.attribution.trim() || !safeHttpsUrl(r.evidenceUrl))) invalid();
    if (r.status !== "allowed" && (s.receipts.length || s.retrievalState !== "rightsWithheld")) invalid();
    for (const t of s.receipts) if (!s.definition.resources.includes(t.url)) invalid();
  }
  for (const s of result.series) {
    const d = s.definition, owner = sources.get(d.sourceId);
    const prefixes: Record<number, string> = { 0: "", 3: "thousand ", 6: "million ", 9: "billion ", 12: "trillion " };
    if (!/^[A-Z]{3}$/.test(d.unit.currency) || d.unit.label !== `${prefixes[d.unit.exponent] ?? `10^${d.unit.exponent} `}${d.unit.currency}`) invalid();
    if (!owner || owner.retrievalState !== s.state || s.history.length > historyLimit[d.frequency]) invalid();
    if ((owner.definition.rights.status !== "allowed" || ["rightsWithheld", "empty", "unavailable"].includes(s.state)) && s.history.length) invalid();
    unique(s.history, o => `${o.period.start}:${o.period.end}`);
    for (const o of s.history) {
      checkPeriod(o.period);
      if (o.seriesId !== d.id || o.period.frequency !== d.frequency || (o.status === "observed") !== (o.value !== null)) invalid();
      if (o.value) checkValue(o.value, d.unit);
      const r = o.receipt;
      if (r.sourceId !== d.sourceId || r.sourceSeriesId !== d.sourceSeriesId || r.datasetId !== d.datasetId || !owner.receipts.some(t => t.url === r.resourceUrl && t.retrievedAt === r.retrievedAt)) invalid();
      if (r.method === "publisherReported" && r.inputObservationIds.length) invalid();
      if (r.method === "derivedCompatibleComponents" && r.inputObservationIds.length !== 2) invalid();
      if (r.method === "derivedCompatibleComponents") {
        const componentKinds = { netIssuance: ["issuance", "redemptions"], netAcquisition: ["purchases", "sales"], netSubscriptions: ["subscriptions", "fundRedemptions"] };
        const kinds = componentKinds[d.metricKind as keyof typeof componentKinds];
        if (!kinds) invalid();
        const inputs = r.inputObservationIds.map(inputId => {
          const input = observations.get(inputId);
          // Each observation is checked against its own declared transport receipt above,
          // not one shared URL or retrieval instant for independently fetched resources.
          if (!input || input.receipt.sourceId !== d.sourceId || input.receipt.method !== "publisherReported" || JSON.stringify(input.period) !== JSON.stringify(o.period)) return invalid();
          return input;
        });
        for (let i = 0; i < inputs.length; i++) {
          const component = allSeries.get(inputs[i].seriesId)?.definition;
          if (!component || component.metricKind !== kinds[i]) invalid();
          for (const field of ["unit", "geography", "perspective", "instrument", "sector", "valuation", "seasonalAdjustment", "annualization", "fundMandate", "category"] as const) {
            if (JSON.stringify(component[field]) !== JSON.stringify(d[field])) invalid();
          }
        }
        const [a, b] = inputs;
        if (a.value === null || b.value === null) {
          // Match core validateSourceBatch: validate input scopes first, then permit
          // null arithmetic with a generic missing or actually witnessed unavailable status.
          const unavailable = inputs.filter(input => input.value === null);
          if (o.value !== null || (o.status !== "missing" && !unavailable.some(input => input.status === o.status))) invalid();
          continue;
        }
        if (!o.value || [a, b, o].some(input => input.completeness !== "complete")) invalid();
        const scale = Math.max(a.value.decimals, b.value.decimals, o.value.decimals);
        const integer = (v: NativeValue) => BigInt(v.raw) * 10n ** BigInt(scale - v.decimals);
        if (integer(a.value) - integer(b.value) !== integer(o.value)) invalid();
      }
    }
  }
  for (const c of result.coverage) {
    if (c.seriesIds.some(id => !allSeries.has(id)) || new Set(c.seriesIds).size !== c.seriesIds.length) invalid();
    if ((c.state === "scopedData") !== (c.seriesIds.length > 0)) invalid();
  }
  return result;
}
