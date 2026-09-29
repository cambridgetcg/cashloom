import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import {
  CAPITAL_FLOWS_SCHEMA, CAPITAL_LIMITS, HISTORY_LIMIT, nativeValue, sourceTtlMs, validatePeriod,
  type CapitalFlowAdapter, type CapitalFlowsSnapshot, type CoverageRecord, type FlowObservation,
  type Rights, type SeriesDefinition, type SourceBatch, type SourceDefinition, type SourceRetrievalState,
} from "./model.ts";
import { abortable, CapitalFlowError, createAdapterTransport, createRequestPool, safeFailure, validateResourceUrl, type FetchLike } from "./transport.ts";

export interface CapitalFlowsCacheOptions {
  fetch?: FetchLike;
  now?: () => number;
  /** Re-evaluated before fetch, commit and every serialization/read. */
  rights?: (definition: SourceDefinition) => Rights;
  /** Tests may shorten deadlines, never enlarge production ceilings. */
  adapterDeadlineMs?: number;
  refreshDeadlineMs?: number;
  coldWaitMs?: number;
}
export interface CapitalFlowsDelivery {
  snapshot: CapitalFlowsSnapshot;
  serialized: string;
  etag: string;
  storedAt: number;
  deliveredAt: number;
  cacheState: "empty" | "refreshing" | "current" | "fallback";
}
export interface CapitalFlowsCache {
  /** Reading requests a refresh if due; manual reads cannot bypass cadence/backoff. */
  read(): Promise<CapitalFlowsDelivery>;
  waitForIdle(): Promise<void>;
  dispose(): void;
}
interface SourceEntry {
  adapter: CapitalFlowAdapter;
  good: SourceBatch | null;
  lastSuccess: number | null;
  lastAttempt: number | null;
  nextAttempt: number;
  failures: number;
  failure: string | null;
  refreshing: boolean;
  controller: AbortController | null;
  rights: Rights;
}
/** Exact JSON UTF-8 accounting for plain data only; returns limit + 1 at overflow.
 * Never expands a whole unchecked object/string. Repeated references count again;
 * cycles, accessors, sparse arrays, non-JSON values and depth > 32 are rejected.
 */
export function boundedJsonBytes(value: unknown, limit: number): number {
  if (!Number.isSafeInteger(limit) || limit < 0) throw new CapitalFlowError("invalid_batch");
  let bytes = 0;
  const ancestors = new Set<object>();
  const add = (count: number) => { bytes += count; return bytes <= limit; };
  const string = (value: string): boolean => {
    if (!add(2)) return false; // Quotes.
    if (value.length > limit - bytes) return false; // UTF-8/escaping cannot be shorter than UTF-16.
    for (let i = 0; i < value.length; i++) {
      const code = value.charCodeAt(i);
      let count: number;
      if (code === 0x22 || code === 0x5c || code === 8 || code === 9 || code === 10 || code === 12 || code === 13) count = 2;
      else if (code < 0x20) count = 6;
      else if (code < 0x80) count = 1;
      else if (code < 0x800) count = 2;
      else if (code >= 0xd800 && code <= 0xdbff && value.charCodeAt(i + 1) >= 0xdc00 && value.charCodeAt(i + 1) <= 0xdfff) { count = 4; i++; }
      else count = code >= 0xd800 && code <= 0xdfff ? 6 : 3;
      if (!add(count)) return false;
    }
    return true;
  };
  const visit = (value: unknown, depth: number): boolean => {
    if (value === null) return add(4);
    if (typeof value === "string") return string(value);
    if (typeof value === "boolean") return add(value ? 4 : 5);
    if (typeof value === "number" && Number.isFinite(value)) return add(String(value).length);
    if (typeof value !== "object" || depth > 32 || ancestors.has(value)) throw new CapitalFlowError("invalid_batch");
    const array = Array.isArray(value), proto = Object.getPrototypeOf(value);
    if ((!array && proto !== Object.prototype && proto !== null) ||
        (array && proto !== Array.prototype) || Object.getOwnPropertyDescriptor(value, "toJSON") || Object.getOwnPropertySymbols(value).length) throw new CapitalFlowError("invalid_batch");
    ancestors.add(value);
    try {
      if (!add(2)) return false; // Braces/brackets.
      if (array) {
        for (let i = 0; i < value.length; i++) {
          const field = Object.getOwnPropertyDescriptor(value, String(i));
          if (!field || !("value" in field)) throw new CapitalFlowError("invalid_batch");
          if ((i > 0 && !add(1)) || !visit(field.value, depth + 1)) return false;
        }
      } else {
        let first = true;
        for (const key in value) if (Object.hasOwn(value, key)) {
          const field = Object.getOwnPropertyDescriptor(value, key)!;
          if (!("value" in field)) throw new CapitalFlowError("invalid_batch");
          if ((!first && !add(1)) || !string(key) || !add(1) || !visit(field.value, depth + 1)) return false;
          first = false;
        }
      }
      return true;
    } finally { ancestors.delete(value); }
  };
  return visit(value, 0) ? bytes : limit + 1;
}
function text(value: unknown, max = 4_096): asserts value is string {
  if (typeof value !== "string" || value.length > max) throw new CapitalFlowError("invalid_batch");
}
function texts(value: unknown): asserts value is string[] {
  if (!Array.isArray(value) || value.length > 64) throw new CapitalFlowError("invalid_batch");
  value.forEach(item => text(item));
}
function timestamp(value: unknown): void {
  if (typeof value !== "string" || value.length > 40 || !/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(value) || !Number.isFinite(Date.parse(value)) ||
      // Date.parse alone normalizes impossible publisher dates such as February 30.
      new Date(`${value.slice(0, 10)}T00:00:00Z`).toISOString().slice(0, 10) !== value.slice(0, 10)) throw new CapitalFlowError("invalid_batch");
}
function allowed(rights: Rights): boolean {
  if (rights.status !== "allowed" || !rights.attribution.trim() || !rights.evidenceUrl) return false;
  try { validateResourceUrl(rights.evidenceUrl); return true; } catch { return false; }
}
function cleanRights(rights: Rights): Rights {
  for (const field of [rights.attribution, rights.evidenceUrl, rights.note]) text(field);
  if (!["allowed", "restricted", "unknown"].includes(rights.status)) throw new CapitalFlowError("invalid_batch");
  if (rights.checkedAt !== null) timestamp(rights.checkedAt);
  return { status: rights.status, attribution: rights.attribution, evidenceUrl: rights.evidenceUrl, checkedAt: rights.checkedAt, note: rights.note };
}
function sourceDefinition(entry: SourceEntry): SourceDefinition {
  const d = entry.adapter.definition;
  return { id: d.id, name: d.name, sourceUrl: d.sourceUrl, methodologyUrl: d.methodologyUrl,
    resources: [...d.resources], cadence: d.cadence, limitations: [...d.limitations], rights: { ...entry.rights } };
}
function cleanSeries(d: SeriesDefinition): SeriesDefinition {
  const geo = (value: { code: string; label: string } | null) => value === null ? null : { code: value.code, label: value.label };
  return { id: d.id, sourceId: d.sourceId, sourceSeriesId: d.sourceSeriesId, datasetId: d.datasetId,
    label: d.label, category: d.category, metricKind: d.metricKind, frequency: d.frequency,
    unit: { currency: d.unit.currency, exponent: d.unit.exponent, label: d.unit.label },
    perspective: d.perspective, signConvention: d.signConvention,
    geography: { issuer: geo(d.geography.issuer), investor: geo(d.geography.investor), reporting: geo(d.geography.reporting), custodial: geo(d.geography.custodial), fundDomicile: geo(d.geography.fundDomicile) },
    instrument: d.instrument, sector: d.sector, fundMandate: d.fundMandate, valuation: d.valuation,
    seasonalAdjustment: d.seasonalAdjustment, annualization: d.annualization, methodologyUrl: d.methodologyUrl,
    sourceUrl: d.sourceUrl, limitations: [...d.limitations] };
}
/** Atomic, whitelisted normalization: malformed or incomplete batches cannot overwrite last-good data. */
export function validateSourceBatch(adapter: CapitalFlowAdapter, batch: SourceBatch): SourceBatch {
  if (!batch || batch.complete !== true || !Array.isArray(batch.observations) || !Array.isArray(batch.receipts) ||
      batch.observations.length > CAPITAL_LIMITS.rows || batch.receipts.length > CAPITAL_LIMITS.pages) throw new CapitalFlowError("incomplete_batch");
  if (boundedJsonBytes(batch, CAPITAL_LIMITS.normalizedBytes) > CAPITAL_LIMITS.normalizedBytes) throw new CapitalFlowError("normalized_byte_limit");
  const definitions = new Map(adapter.series.map(d => [d.id, d]));
  const ids = new Set<string>(), periods = new Set<string>();
  const counts = new Map<string, number>();
  const receipts = batch.receipts.map(r => {
    timestamp(r.retrievedAt); text(r.url);
    if (!adapter.definition.resources.includes(r.url) || !Number.isSafeInteger(r.decodedBytes) || r.decodedBytes < 0 || r.decodedBytes > CAPITAL_LIMITS.responseBytes) throw new CapitalFlowError("invalid_batch");
    if (r.lastModified !== null) text(r.lastModified, 512);
    if (r.etag !== null) text(r.etag, 512);
    return { url: r.url, retrievedAt: r.retrievedAt, lastModified: r.lastModified, etag: r.etag, decodedBytes: r.decodedBytes };
  });
  const observations = batch.observations.map(o => {
    const d = definitions.get(o.seriesId);
    if (!d) throw new CapitalFlowError("invalid_batch");
    text(o.id, 256); validatePeriod(o.period);
    const key = `${o.seriesId}:${o.period.start}:${o.period.end}`;
    if (!o.id || ids.has(o.id) || periods.has(key) || o.period.frequency !== d.frequency) throw new CapitalFlowError("invalid_batch");
    ids.add(o.id); periods.add(key);
    counts.set(o.seriesId, (counts.get(o.seriesId) ?? 0) + 1);
    if (counts.get(o.seriesId)! > HISTORY_LIMIT[d.frequency]) throw new CapitalFlowError("row_limit");
    if (!["observed", "missing", "suppressed", "notYetReported", "withdrawn"].includes(o.status) ||
        [o.provisional, o.revised, o.estimated, o.break].some(flag => typeof flag !== "boolean") || !["complete", "partial", "unknown"].includes(o.completeness)) throw new CapitalFlowError("invalid_batch");
    if (o.publisherStatus !== null) text(o.publisherStatus, 64);
    if (o.publisherConfidentiality !== null) text(o.publisherConfidentiality, 64);
    let value = null;
    if (o.status === "observed") {
      if (!o.value) throw new CapitalFlowError("invalid_batch");
      value = nativeValue(o.value.publisherLexeme, d.unit);
      for (const key of Object.keys(value) as (keyof typeof value)[]) if (value[key] !== o.value[key]) throw new CapitalFlowError("invalid_batch");
    } else if (o.value !== null) throw new CapitalFlowError("invalid_batch");
    const r = o.receipt;
    if (!r || r.sourceId !== adapter.definition.id || r.sourceSeriesId !== d.sourceSeriesId || r.datasetId !== d.datasetId ||
        !receipts.some(receipt => receipt.url === r.resourceUrl && receipt.retrievedAt === r.retrievedAt)) throw new CapitalFlowError("invalid_batch");
    timestamp(r.retrievedAt); if (r.publicationAt !== null) timestamp(r.publicationAt);
    text(r.recipe); texts(r.limitations); texts(r.inputObservationIds);
    if (!["publisherReported", "derivedCompatibleComponents"].includes(r.method) || (r.method === "publisherReported" && r.inputObservationIds.length)) throw new CapitalFlowError("invalid_batch");
    return { id: o.id, seriesId: o.seriesId,
      period: { frequency: o.period.frequency, label: o.period.label, start: o.period.start, end: o.period.end },
      value, status: o.status, provisional: o.provisional, revised: o.revised, estimated: o.estimated,
      publisherStatus: o.publisherStatus, publisherConfidentiality: o.publisherConfidentiality, break: o.break, completeness: o.completeness,
      receipt: { sourceId: r.sourceId, sourceSeriesId: r.sourceSeriesId, datasetId: r.datasetId,
        resourceUrl: r.resourceUrl, retrievedAt: r.retrievedAt, publicationAt: r.publicationAt,
        method: r.method, recipe: r.recipe, inputObservationIds: [...r.inputObservationIds], limitations: [...r.limitations] } };
  });
  for (const d of adapter.series) if (!counts.has(d.id)) throw new CapitalFlowError("incomplete_batch");
  const byId = new Map(observations.map(o => [o.id, o]));
  const components = { netIssuance: ["issuance", "redemptions"], netAcquisition: ["purchases", "sales"], netSubscriptions: ["subscriptions", "fundRedemptions"] } as const;
  for (const o of observations) if (o.receipt.method === "derivedCompatibleComponents") {
    const d = definitions.get(o.seriesId)!;
    const kinds = components[d.metricKind as keyof typeof components];
    const inputs = o.receipt.inputObservationIds.map(id => byId.get(id));
    if (!kinds || inputs.length !== 2) throw new CapitalFlowError("invalid_batch");
    for (let i = 0; i < 2; i++) {
      const input = inputs[i];
      if (!input || input.receipt.method !== "publisherReported") throw new CapitalFlowError("invalid_batch");
      const component = definitions.get(input.seriesId)!;
      if (component.metricKind !== kinds[i] || JSON.stringify(input.period) !== JSON.stringify(o.period)) throw new CapitalFlowError("invalid_batch");
      for (const field of ["unit", "geography", "perspective", "instrument", "sector", "valuation", "seasonalAdjustment", "annualization", "fundMandate", "category"] as const) {
        if (JSON.stringify(component[field]) !== JSON.stringify(d[field])) throw new CapitalFlowError("invalid_batch");
      }
    }
    const [a, b] = inputs as [FlowObservation, FlowObservation];
    if (a.value === null || b.value === null) {
      // Missing arithmetic is a valid replacement, not a transport failure. Both
      // input IDs/scopes still validate above and unavailable input values were
      // required to be null during normalization. A generic missing net or an
      // unavailable status witnessed on an input is honest; invented reasons are not.
      const unavailable = [a, b].filter(input => input.value === null);
      if (o.value !== null || (o.status !== "missing" && !unavailable.some(input => input.status === o.status))) throw new CapitalFlowError("invalid_batch");
      continue;
    }
    if (!o.value || [a, b, o].some(input => input.completeness !== "complete")) throw new CapitalFlowError("invalid_batch");
    const scale = Math.max(a.value.decimals, b.value.decimals, o.value.decimals);
    const integer = (v: NonNullable<FlowObservation["value"]>) => BigInt(v.raw) * 10n ** BigInt(scale - v.decimals);
    if (integer(a.value) - integer(b.value) !== integer(o.value)) throw new CapitalFlowError("invalid_batch");
  }
  observations.sort((a, b) => a.seriesId.localeCompare(b.seriesId) || a.period.start.localeCompare(b.period.start) || a.id.localeCompare(b.id));
  return { complete: true, observations, receipts };
}
function coverage(series: CapitalFlowsSnapshot["series"]): CoverageRecord[] {
  const records: CoverageRecord[] = [];
  const assets = [
    ["sovereignDebt", "Sovereign debt", "Selected financing and securities transactions; not global secondary-market turnover."],
    ["equities", "Equities", "Scoped securities/fund transactions, not all equity-market capital flows."],
    ["bonds", "Bonds", "Scoped securities/fund transactions; wrappers and underlying holdings must not be added."],
    ["preciousMetals", "Precious metals", "No cleared broad precious-metals investment-flow feed; any reserve transactions are narrower."],
    ["crypto", "Crypto", "No verified broad investment-flow feed. Onchain supply, bridges, prices and TVL are not investment flows."],
    ["privateEquity", "Private equity", "Any reported fund transactions are not worldwide deals, commitments or calls/distributions."],
    ["realEstate", "Real estate", "Real-estate fund flows are not direct property transactions."],
  ];
  const add = (id: string, label: string, dimension: CoverageRecord["dimension"], selected: typeof series, limitation: string) => {
    const seriesIds = selected.filter(s => s.history.some(o => o.value !== null)).map(s => s.definition.id);
    records.push({ id, label, dimension, state: seriesIds.length ? "scopedData" : "unavailable", seriesIds, limitation });
  };
  for (const [id, label, limitation] of assets) add(id!, label!, "assetCategory", series.filter(s => s.definition.category === id), limitation!);
  for (const [id, label] of [["US", "United States"], ["DE", "Germany"], ["ES", "Spain"], ["JP", "Japan"], ["GB", "United Kingdom"], ["CN", "China"]]) {
    add(id!, label!, "issuerMarket", series.filter(s => s.definition.category === "sovereignDebt" && s.definition.geography.issuer?.code === id), "Issuer geography only; foreign purchases of US debt do not cover a non-US issuer market.");
  }
  for (const [id, label, limitation] of [
    ["otherSovereigns", "Other sovereign issuer markets", "Not a worldwide issuer census; broader BIS series remain unvalidated."],
    ["secondaryTurnover", "Global secondary securities turnover", "No global turnover feed or total."],
    ["directProperty", "Direct property transactions", "Fund-share transactions do not measure direct property investment."],
    ["worldwidePeCalls", "Worldwide private-equity calls/distributions", "No validated global calls/distributions or commitments coverage."],
  ]) add(id!, label!, "marketScope", [], limitation!);
  return records;
}
function boundedDuration(value: number | undefined, ceiling: number): number {
  if (value === undefined) return ceiling;
  if (!Number.isFinite(value) || value < 0 || value > ceiling) throw new Error("invalid_deadline");
  return value;
}
export function createCapitalFlowsCache(adapters: readonly CapitalFlowAdapter[], options: CapitalFlowsCacheOptions = {}): CapitalFlowsCache {
  if (adapters.length > CAPITAL_LIMITS.sources || adapters.reduce((sum, a) => sum + a.series.length, 0) > CAPITAL_LIMITS.series) throw new Error("registry_limit");
  const sourceIds = new Set<string>(), seriesIds = new Set<string>();
  for (const a of adapters) {
    if (!a.definition.id || sourceIds.has(a.definition.id) || !a.series.length || a.definition.resources.length > 12) throw new Error("invalid_registry");
    sourceIds.add(a.definition.id);
    for (const url of a.definition.resources) validateResourceUrl(url);
    if (boundedJsonBytes([a.definition, a.series], 128 * 1024) > 128 * 1024) throw new Error("registry_limit");
    for (const d of a.series) {
      if (!d.id || d.sourceId !== a.definition.id || seriesIds.has(d.id) || !(d.frequency in HISTORY_LIMIT)) throw new Error("invalid_registry");
      nativeValue("0", d.unit); cleanSeries(d); seriesIds.add(d.id);
    }
  }
  const now = options.now ?? Date.now;
  const adapterMs = boundedDuration(options.adapterDeadlineMs, CAPITAL_LIMITS.adapterMs);
  const refreshMs = boundedDuration(options.refreshDeadlineMs, CAPITAL_LIMITS.refreshMs);
  const coldMs = boundedDuration(options.coldWaitMs, CAPITAL_LIMITS.coldWaitMs);
  const pool = createRequestPool();
  const entries: SourceEntry[] = adapters.map(adapter => ({ adapter, good: null, lastSuccess: null,
    lastAttempt: null, nextAttempt: 0, failures: 0, failure: null, refreshing: false, controller: null,
    rights: cleanRights((options.rights ?? (d => d.rights))(adapter.definition)) }));
  let disposed = false, generation = 0;
  let inflight: Promise<void> | null = null;
  let generationController: AbortController | null = null;
  let delivery: CapitalFlowsDelivery | null = null;
  let fingerprint = "";
  const coldControllers = new Set<AbortController>();
  const rightsNow = (entry: SourceEntry): Rights => {
    try { return cleanRights((options.rights ?? (d => d.rights))(entry.adapter.definition)); }
    catch { return { status: "unknown", evidenceUrl: "", attribution: "", checkedAt: null, note: "Rights assessment unavailable." }; }
  };
  const sync = () => {
    const at = now();
    for (const e of entries) {
      const wasAllowed = allowed(e.rights);
      e.rights = rightsNow(e);
      if (!allowed(e.rights)) {
        e.controller?.abort(); e.good = null; e.lastSuccess = null; e.failure = null;
      } else if (!wasAllowed) { e.nextAttempt = 0; e.failures = 0; }
      if (e.good && e.lastSuccess !== null && at >= e.lastSuccess + CAPITAL_LIMITS.fallbackMs) e.good = null;
    }
  };
  const state = (e: SourceEntry): SourceRetrievalState => {
    if (!allowed(e.rights)) return "rightsWithheld";
    if (e.refreshing) return "refreshing";
    if (e.good) return e.failure || now() >= e.lastSuccess! + sourceTtlMs(e.adapter.definition.cadence) ? "fallback" : "current";
    return e.lastAttempt === null ? "empty" : "unavailable";
  };
  const project = (): Omit<CapitalFlowsSnapshot, "generatedAt"> => {
    sync();
    const series = entries.flatMap(e => e.adapter.series.map(definition => ({ definition: cleanSeries(definition),
      state: state(e), reportingRecency: "expectation_unknown" as const,
      history: allowed(e.rights) ? (e.good?.observations.filter(o => o.seriesId === definition.id) ?? []) : [] })));
    const available = entries.filter(e => e.good && allowed(e.rights)).length;
    return { schema: CAPITAL_FLOWS_SCHEMA, scope: "selectedPublisherReportedFlows", historyPolicy: "latestRevisedPublisherHistoryNotVintageArchive",
      refresh: { state: inflight ? "refreshing" : "idle", health: !available ? "empty" : available === entries.length ? "available" : "partial", launchReadiness: "notAssessed" },
      sources: entries.map(e => ({ definition: sourceDefinition(e), retrievalState: state(e),
        lastAttemptAt: e.lastAttempt === null ? null : new Date(e.lastAttempt).toISOString(),
        lastSuccessAt: e.lastSuccess === null ? null : new Date(e.lastSuccess).toISOString(),
        nextAttemptAt: allowed(e.rights) && e.lastAttempt !== null ? new Date(e.nextAttempt).toISOString() : null,
        fallbackExpiresAt: e.good && e.lastSuccess !== null ? new Date(e.lastSuccess + CAPITAL_LIMITS.fallbackMs).toISOString() : null,
        failure: allowed(e.rights) ? e.failure : null, receipts: allowed(e.rights) ? (e.good?.receipts ?? []) : [] })),
      series, coverage: coverage(series),
      limitations: ["Selected source-backed series, not a global capital-flow total or launch-readiness assessment.",
        "Latest-revised publisher history, not an archive of release vintages; missing and suppressed are not zero.",
        "Source batches replace atomically. Incomplete/malformed refreshes preserve original last-good histories and receipts for at most seven days; restart clears RAM.",
        "Publication schedules are not inferred. Transport Last-Modified is not a publication timestamp.",
        "No holdings-change proxies, current-FX historical conversions, cross-source totals or wrapper-plus-underlying sums."] };
  };
  const serialize = (): CapitalFlowsDelivery => {
    const snapshotBody = project();
    const storedAt = now();
    const snapshot: CapitalFlowsSnapshot = { ...snapshotBody, generatedAt: new Date(storedAt).toISOString() };
    if (boundedJsonBytes(snapshot, CAPITAL_LIMITS.serializedBytes) > CAPITAL_LIMITS.serializedBytes) throw new CapitalFlowError("serialized_byte_limit");
    // Both materializations below are now bounded, including dynamic rights metadata.
    const nextFingerprint = JSON.stringify(snapshotBody);
    if (!delivery || fingerprint !== nextFingerprint) {
      const serialized = JSON.stringify(snapshot);
      fingerprint = nextFingerprint;
      delivery = { snapshot, serialized, etag: `W/"sha256-${createHash("sha256").update(serialized).digest("base64url")}"`, storedAt, deliveredAt: storedAt, cacheState: "empty" };
    }
    const cacheState = inflight ? "refreshing" : entries.some(e => state(e) === "fallback") ? "fallback" : entries.some(e => e.good) ? "current" : "empty";
    // Expose no mutable reference to private normalized rows or cached metadata.
    return { ...delivery, snapshot: JSON.parse(delivery.serialized) as CapitalFlowsSnapshot, deliveredAt: now(), cacheState };
  };
  const begin = () => {
    if (disposed || inflight) return;
    sync();
    const due = entries.filter(e => allowed(e.rights) && now() >= e.nextAttempt);
    if (!due.length) return;
    const currentGeneration = ++generation;
    const controller = new AbortController(); generationController = controller;
    const refreshExpires = performance.now() + refreshMs;
    const refreshTimer = setTimeout(() => controller.abort(new CapitalFlowError("refresh_deadline")), refreshMs);
    const run = async (e: SourceEntry) => {
      const adapterExpires = performance.now() + adapterMs;
      e.lastAttempt = now(); e.refreshing = true;
      const child = new AbortController(); e.controller = child;
      const parentAbort = () => child.abort(new CapitalFlowError("refresh_deadline"));
      controller.signal.addEventListener("abort", parentAbort, { once: true });
      if (controller.signal.aborted) parentAbort();
      const adapterTimer = setTimeout(() => child.abort(new CapitalFlowError("adapter_deadline")), adapterMs);
      const rightsAllowed = () => allowed(rightsNow(e));
      const checkAcceptance = () => {
        if (disposed || generation !== currentGeneration || child.signal.aborted) throw new CapitalFlowError("aborted");
        if (!rightsAllowed()) throw new CapitalFlowError("rights_withheld");
        // Timers cannot fire during synchronous parsing/validation. Check the
        // earliest absolute monotonic deadline too, independent of wall-clock time.
        if (performance.now() >= Math.min(refreshExpires, adapterExpires)) throw new CapitalFlowError(refreshExpires <= adapterExpires ? "refresh_deadline" : "adapter_deadline");
      };
      try {
        checkAcceptance();
        const transport = createAdapterTransport({ definition: e.adapter.definition, signal: child.signal, pool, fetch: options.fetch, now, rightsAllowed });
        const result = await abortable(Promise.resolve().then(() => e.adapter.load(transport.context)), child.signal);
        checkAcceptance();
        transport.validateBatchAccounting(result.receipts, result.observations.length);
        const normalized = validateSourceBatch(e.adapter, result);
        checkAcceptance();
        if (boundedJsonBytes(entries.map(other => other === e ? normalized : other.good), CAPITAL_LIMITS.normalizedBytes) > CAPITAL_LIMITS.normalizedBytes) throw new CapitalFlowError("normalized_byte_limit");
        checkAcceptance();
        const prior = e.good, priorSuccess = e.lastSuccess;
        e.good = normalized; e.lastSuccess = now();
        // Projected-size and final deadline checks share rollback protection.
        try {
          if (boundedJsonBytes({ ...project(), generatedAt: new Date(now()).toISOString() }, CAPITAL_LIMITS.serializedBytes - 4_096) > CAPITAL_LIMITS.serializedBytes - 4_096) throw new CapitalFlowError("serialized_byte_limit");
          checkAcceptance();
        } catch (error) {
          const permitted = rightsAllowed();
          e.good = permitted ? prior : null; e.lastSuccess = permitted ? priorSuccess : null;
          throw error;
        }
        e.lastSuccess = now(); e.failure = null; e.failures = 0;
        e.nextAttempt = e.lastSuccess + sourceTtlMs(e.adapter.definition.cadence);
      } catch (error) {
        if (!disposed && generation === currentGeneration) {
          e.failure = safeFailure(child.signal.aborted && child.signal.reason instanceof CapitalFlowError ? child.signal.reason : error);
          e.failures++;
          e.nextAttempt = now() + Math.min(CAPITAL_LIMITS.maxFailureBackoffMs, CAPITAL_LIMITS.failureBackoffMs * 2 ** Math.min(16, e.failures - 1));
        }
      } finally {
        // Promise.all can fail while a cooperative sibling request still holds a
        // pool slot. Cancel all source work before discarding its cancellation paths.
        child.abort();
        clearTimeout(adapterTimer); controller.signal.removeEventListener("abort", parentAbort);
        e.refreshing = false; e.controller = null;
      }
    };
    // Start on a microtask, so all projections see an installed single-flight generation.
    const work = Promise.resolve().then(() => Promise.all(due.map(run))).then(() => undefined).finally(() => {
      clearTimeout(refreshTimer);
      if (inflight === work) { inflight = null; generationController = null; }
    });
    inflight = work;
  };
  return {
    async read() {
      if (disposed) throw new CapitalFlowError("aborted");
      const cold = delivery === null;
      begin();
      if (cold && inflight && coldMs > 0) {
        const controller = new AbortController(); coldControllers.add(controller);
        const timer = setTimeout(() => controller.abort(), coldMs);
        try { await abortable(inflight, controller.signal); } catch { /* Honest cold partial response. */ }
        finally { clearTimeout(timer); coldControllers.delete(controller); }
      }
      if (disposed) throw new CapitalFlowError("aborted");
      return serialize();
    },
    async waitForIdle() { await inflight; },
    dispose() {
      disposed = true; generation++; generationController?.abort();
      for (const e of entries) e.controller?.abort();
      for (const controller of coldControllers) controller.abort();
      pool.dispose();
    },
  };
}
