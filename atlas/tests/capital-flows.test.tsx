import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { nativeValue, reportingPeriod, type CapitalFlowsSnapshot, type FlowSeries, type SeriesDefinition } from "../../sovereign/src/info/capital-flows/model.ts";
import { CapitalFlowsPage, CapitalFlowsView } from "../src/capital-flows/CapitalFlows";
import { CAPITAL_COMPLETION_CHECKS_MS, fetchCapitalFlows, parseCapitalFlowsSnapshot, readCapitalFlowsWindow } from "../src/capital-flows/api";
import { CATEGORY_LABELS, DEFAULT_FILTERS, filterSeries, groupSeries, latestObservation, resolveReceipt, sectionFor, valueText } from "../src/capital-flows/presentation";
import { CapitalReceipt, ReceiptContent, SourceLink } from "../src/capital-flows/Receipt";
import { safeHttpsUrl } from "../src/capital-flows/validation";

const retrievedAt = "2026-09-09T12:00:00.000Z";
const resource = "https://example.org/synthetic-flow.csv";
/** Deliberately synthetic, tiny amounts. Native values/periods use the actual backend constructors. */
function fixture(): CapitalFlowsSnapshot {
  const definition: SeriesDefinition = {
    id: "synthetic-issuance", sourceId: "synthetic-source", sourceSeriesId: "TEST.ISSUE", datasetId: "SYNTHETIC",
    label: "Synthetic US cash issuance", category: "sovereignDebt", metricKind: "issuance", frequency: "daily",
    unit: { currency: "USD", exponent: 6, label: "million USD" }, perspective: "Issuer financing",
    signConvention: "Positive issuance is cash raised; positive redemptions are an amount repaid, not an inflow.",
    geography: { issuer: { code: "US", label: "United States" }, investor: null, reporting: { code: "US", label: "United States" }, custodial: null, fundDomicile: null },
    instrument: "Synthetic public debt", sector: "Central government", fundMandate: null,
    valuation: "Cash basis", seasonalAdjustment: "unadjusted", annualization: "notAnnualized",
    methodologyUrl: "https://example.org/methodology", sourceUrl: "https://example.org/source", limitations: ["Synthetic test observation; not financial data."],
  };
  function series(d: SeriesDefinition, amount: string, period = reportingPeriod(d.frequency, d.frequency === "quarterly" ? "2026-Q2" : "2026-09-08")): FlowSeries {
    return { definition: d, state: "current", reportingRecency: "expectation_unknown", history: [{
      id: `${d.id}:${period.label}`, seriesId: d.id, period, value: nativeValue(amount, d.unit), status: "observed",
      provisional: false, revised: false, estimated: false, publisherStatus: "A", publisherConfidentiality: "F", break: false, completeness: "complete",
      receipt: { sourceId: d.sourceId, sourceSeriesId: d.sourceSeriesId, datasetId: d.datasetId, resourceUrl: resource, retrievedAt,
        publicationAt: null, method: "publisherReported", recipe: "Synthetic publisher row; no conversion.", inputObservationIds: [], limitations: ["Synthetic only."] },
    }] };
  }
  const issuance = series(definition, "1.25");
  const redemption = series({ ...definition, id: "synthetic-redemption", label: "Synthetic cash redemptions", sourceSeriesId: "TEST.REDEEM", metricKind: "redemptions" }, "0");
  const net = series({ ...definition, id: "synthetic-net", label: "Synthetic net financing", sourceSeriesId: "TEST.NET", metricKind: "netIssuance" }, "1.25");
  net.history[0].receipt = { ...net.history[0].receipt, method: "derivedCompatibleComponents", recipe: "Cash issues minus cash redemptions", inputObservationIds: [issuance.history[0].id, redemption.history[0].id] };
  const fund = series({ ...definition, id: "synthetic-fund", label: "Synthetic equity-fund shares", sourceSeriesId: "TEST.FUND", category: "equities", metricKind: "netSubscriptions", frequency: "quarterly", unit: { currency: "EUR", exponent: 6, label: "million EUR" }, valuation: "Transaction value",
    geography: { issuer: null, investor: null, reporting: { code: "U2", label: "Euro area" }, custodial: null, fundDomicile: { code: "U2", label: "Euro area" } }, fundMandate: "Equity investment policy" }, "-2.500");
  const purchases = series({ ...definition, id: "synthetic-tic", label: "Synthetic foreign Treasury purchases", sourceSeriesId: "TEST.TIC", metricKind: "purchases", perspective: "Foreign residents", valuation: "Transaction value",
    geography: { ...definition.geography, investor: { code: "Z5", label: "Foreign residents" } } }, "3");
  return {
    schema: "cashloom.capital-flows/1", generatedAt: retrievedAt, scope: "selectedPublisherReportedFlows", historyPolicy: "latestRevisedPublisherHistoryNotVintageArchive",
    refresh: { state: "idle", health: "available", launchReadiness: "notAssessed" },
    sources: [{ definition: { id: "synthetic-source", name: "Synthetic publisher", sourceUrl: "https://example.org/source", methodologyUrl: "https://example.org/methodology", rights: { status: "allowed", attribution: "Synthetic fixture attribution", evidenceUrl: "https://example.org/rights", checkedAt: retrievedAt, note: "Synthetic fixture reuse note" }, resources: [resource], cadence: "daily", limitations: ["Synthetic tests only"] },
      retrievalState: "current", lastAttemptAt: retrievedAt, lastSuccessAt: retrievedAt, nextAttemptAt: "2026-09-09T13:00:00.000Z", fallbackExpiresAt: "2026-09-16T12:00:00.000Z", failure: null,
      receipts: [{ url: resource, retrievedAt, lastModified: "Wed, 09 Sep 2026 11:00:00 GMT", etag: '"synthetic-source"', decodedBytes: 128 }],
    }],
    series: [issuance, redemption, net, fund, purchases],
    coverage: [
      { id: "sovereignDebt", label: "Sovereign debt", dimension: "assetCategory", state: "scopedData", seriesIds: [definition.id], limitation: "Synthetic scoped issuer series." },
      { id: "equities", label: "Equities", dimension: "assetCategory", state: "scopedData", seriesIds: [fund.definition.id], limitation: "Synthetic fund shares, not underlying purchases." },
    ], limitations: ["Synthetic; no global total."],
  };
}
const jsonResponse = (body: unknown, etag = '"snapshot-1"') => new Response(JSON.stringify(body), { headers: { "content-type": "application/vnd.cashloom.capital-flows.v1+json", etag } });
const cached = (snapshot = fixture()) => ({ snapshot, etag: '"snapshot-1"', receivedAt: Date.parse(retrievedAt) });
const selected = () => ({ seriesId: fixture().series[0].definition.id, observationId: fixture().series[0].history[0].id });
const text = (markup: string) => markup.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ");

afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.restoreAllMocks(); vi.useRealTimers(); });

describe("capital-flows wire validation against actual model constructors", () => {
  it("accepts the complete source/series/observation contract without server-runtime imports in the view", () => {
    expect(parseCapitalFlowsSnapshot(fixture())).toEqual(fixture());
  });
  it("whitelists nested data rather than preserving hidden unknown fields", () => {
    const body = fixture();
    Object.assign(body.series[0].history[0].receipt, { hiddenFinancialValue: "not retained" });
    expect(JSON.stringify(parseCapitalFlowsSnapshot(body))).not.toContain("hiddenFinancialValue");
  });
  it.each([
    ["wrong schema", (s: any) => { s.schema = "cashloom.world/1"; }],
    ["missing refresh", (s: any) => { delete s.refresh; }],
    ["marketing readiness", (s: any) => { s.refresh.launchReadiness = "ready"; }],
    ["fake reporting current", (s: any) => { s.series[0].reportingRecency = "current"; }],
    ["numeric decimal", (s: any) => { s.series[0].history[0].value.decimal = 1.25; }],
    ["wrong unit scale", (s: any) => { s.series[0].history[0].value.unitExponent = 0; }],
    ["misleading native label", (s: any) => { s.series[0].definition.unit.label = "USD"; }],
    ["mismatched publisher lexeme", (s: any) => { s.series[0].history[0].value.publisherLexeme = "1250000"; }],
    ["mismatched raw", (s: any) => { s.series[0].history[0].value.raw = "126"; }],
    ["missing publisher flags", (s: any) => { delete s.series[0].history[0].publisherStatus; }],
    ["impossible date", (s: any) => { s.series[0].history[0].period.start = "2026-02-31"; }],
    ["wrong period meaning", (s: any) => { s.series[3].history[0].period.label = "2026-Q3"; }],
    ["duplicate observation", (s: any) => { s.series[0].history.push(s.series[0].history[0]); }],
    ["wrong source", (s: any) => { s.series[0].history[0].receipt.sourceId = "other"; }],
    ["mixed old observation/new receipt", (s: any) => { s.sources[0].receipts[0].retrievedAt = "2026-09-09T13:00:00.000Z"; }],
    ["dangling derived input", (s: any) => { s.series[2].history[0].receipt.inputObservationIds[0] = "removed"; }],
    ["incompatible component basis", (s: any) => { s.series[1].definition.valuation = "Face value"; }],
    ["wrong derived amount", (s: any) => { s.series[2].history[0].value = nativeValue("9", s.series[2].definition.unit); }],
    ["rights-withheld hidden history", (s: any) => { s.sources[0].definition.rights.status = "restricted"; s.sources[0].retrievalState = "rightsWithheld"; }],
    ["non-https source", (s: any) => { s.sources[0].definition.sourceUrl = "javascript:alert(1)"; }],
    ["unreceipted resource", (s: any) => { s.series[0].history[0].receipt.resourceUrl = "https://example.org/other"; }],
    ["unknown coverage series", (s: any) => { s.coverage[0].seriesIds = ["absent"]; }],
    ["oversized sources", (s: any) => { s.sources = Array(9).fill(s.sources[0]); }],
    ["oversized history", (s: any) => { s.series[3].history = Array(21).fill(s.series[3].history[0]); }],
  ])("rejects %s", (_label, mutate) => {
    const s = fixture(); mutate(s); expect(() => parseCapitalFlowsSnapshot(s)).toThrow(/schema or source-receipt/);
  });
  it.each(["missing", "suppressed", "notYetReported", "withdrawn"] as const)("distinguishes %s from zero", status => {
    const s = fixture(); s.series = [s.series[1]]; s.coverage = [];
    const o = s.series[0].history[0];
    expect(valueText(o)).toBe("0 million USD");
    o.status = status; o.value = null;
    expect(parseCapitalFlowsSnapshot(s).series[0].history[0].value).toBeNull();
    expect(valueText(o)).not.toContain("0");
    o.value = nativeValue("0", s.series[0].definition.unit);
    expect(() => parseCapitalFlowsSnapshot(s)).toThrow();
  });
  it("accepts rights-withheld sources without receipts, amounts or rights evidence", () => {
    const s = fixture(); s.coverage = [];
    s.sources[0].definition.rights = { status: "unknown", evidenceUrl: "", attribution: "", checkedAt: null, note: "Unknown" };
    s.sources[0].retrievalState = "rightsWithheld"; s.sources[0].receipts = [];
    s.series.forEach(series => { series.history = []; series.state = "rightsWithheld"; });
    expect(parseCapitalFlowsSnapshot(s)).toEqual(s);
  });
  it("retains large exact amounts and bounded exponent lexemes without Number arithmetic", () => {
    const s = fixture(); s.series = [s.series[0]]; s.coverage = [];
    const o = s.series[0].history[0];
    o.value = nativeValue("9007199254740993.125", s.series[0].definition.unit);
    expect(parseCapitalFlowsSnapshot(s)).toEqual(s);
    expect(valueText(o)).toBe("9,007,199,254,740,993.125 million USD");
    o.value = nativeValue("+1.2500e-2", s.series[0].definition.unit);
    expect(parseCapitalFlowsSnapshot(s)).toEqual(s);
    expect(valueText(o)).toBe("0.0125 million USD");
  });
});

describe("bounded, in-memory capital-flow reads", () => {
  it("recognizes a missing deployed feed and stops without completion polling", async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn().mockResolvedValue(new Response("private upstream detail", { status: 404 }));
    vi.stubGlobal("fetch", fetcher);
    const onSnapshot = vi.fn();
    await expect(readCapitalFlowsWindow({ signal: new AbortController().signal, onSnapshot })).rejects.toMatchObject({ status: 404, message: "The capital-flows feed is not enabled on this server (HTTP 404)." });
    await vi.advanceTimersByTimeAsync(60000);
    expect(fetcher).toHaveBeenCalledOnce();
    expect(onSnapshot).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
  it("uses public GET, endpoint(), no credentials, and completion revalidation", async () => {
    const fetcher = vi.fn().mockResolvedValue(jsonResponse(fixture())); vi.stubGlobal("fetch", fetcher);
    const result = await fetchCapitalFlows();
    expect(result.snapshot).toEqual(fixture()); expect(result.etag).toBe('"snapshot-1"');
    expect(fetcher).toHaveBeenCalledWith("/v1/capital-flows", expect.objectContaining({ method: "GET", credentials: "omit", cache: "no-cache", signal: expect.any(AbortSignal) }));
    expect(fetcher.mock.calls[0][1].headers).not.toHaveProperty("If-None-Match");
  });
  it("uses configured World endpoint helper without adding a second origin configuration", async () => {
    vi.resetModules(); vi.stubEnv("VITE_CASHLOOM_API_BASE", " https://info.example.org/ ");
    const { fetchCapitalFlows: configuredFetch } = await import("../src/capital-flows/api");
    const fetcher = vi.fn().mockResolvedValue(jsonResponse(fixture())); vi.stubGlobal("fetch", fetcher);
    await configuredFetch(); expect(fetcher.mock.calls[0][0]).toBe("https://info.example.org/v1/capital-flows");
    vi.resetModules();
  });
  it("accepts 304 only with the matching cached body and preserves its assembly/source timestamps", async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(null, { status: 304 })); vi.stubGlobal("fetch", fetcher);
    const result = await fetchCapitalFlows({ cached: cached() });
    expect(result.kind).toBe("not-modified"); expect(result.snapshot).toEqual(fixture());
    expect(fetcher.mock.calls[0][1].headers["If-None-Match"]).toBe('"snapshot-1"');
    expect(result.snapshot.sources[0].lastSuccessAt).toBe(retrievedAt);
  });
  it.each(["no body", "no validator", "mismatched validator"])("rejects 304 with %s", async mode => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 304, headers: mode === "mismatched validator" ? { etag: '"different"' } : {} })));
    await expect(fetchCapitalFlows({ cached: mode === "no body" ? undefined : { ...cached(), etag: mode === "no validator" ? undefined : '"snapshot-1"' } })).rejects.toThrow(/matching in-memory body/);
  });
  it.each([
    ["HTTP failure", () => new Response("upstream private-looking text", { status: 503 })],
    ["HTML response", () => new Response("<html>not a feed</html>", { headers: { "content-type": "text/html" } })],
    ["bad JSON", () => new Response("{bad", { headers: { "content-type": "application/json" } })],
    ["bad schema", () => jsonResponse({ schema: "wrong" })],
    ["oversized body", () => new Response(" ".repeat(2 * 1024 * 1024 + 1), { headers: { "content-type": "application/json" } })],
  ])("rejects %s without mutating a trusted previous snapshot", async (_label, response) => {
    const prior = cached(); vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response()));
    await expect(fetchCapitalFlows({ cached: prior })).rejects.toThrow(); expect(prior.snapshot).toEqual(fixture());
  });
  it("times out an ignored abort, aborts the request, and cleans up timers", async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn().mockImplementation(() => new Promise(() => {})); vi.stubGlobal("fetch", fetcher);
    const result = fetchCapitalFlows({ timeoutMs: 20 }).catch(e => e);
    await vi.advanceTimersByTimeAsync(20);
    expect((await result).message).toContain("timed out");
    expect(fetcher.mock.calls[0][1].signal.aborted).toBe(true); expect(vi.getTimerCount()).toBe(0);
  });
  it("bounds a hanging streamed body and cancels its reader", async () => {
    vi.useFakeTimers(); const cancel = vi.fn();
    const body = new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode("{")); }, cancel });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(body, { headers: { "content-type": "application/json" } })));
    const result = fetchCapitalFlows({ timeoutMs: 20 }).catch(e => e);
    await vi.advanceTimersByTimeAsync(20); expect((await result).message).toContain("timed out");
    expect(cancel).toHaveBeenCalledOnce(); expect(vi.getTimerCount()).toBe(0);
  });
  it("performs no completion checks for an idle snapshot", async () => {
    vi.useFakeTimers(); const fetcher = vi.fn().mockImplementation(() => Promise.resolve(jsonResponse(fixture()))); vi.stubGlobal("fetch", fetcher);
    const onSnapshot = vi.fn(); const result = await readCapitalFlowsWindow({ signal: new AbortController().signal, onSnapshot });
    await vi.advanceTimersByTimeAsync(60000);
    expect(result.checksStopped).toBe(false); expect(fetcher).toHaveBeenCalledOnce(); expect(onSnapshot).toHaveBeenCalledOnce(); expect(vi.getTimerCount()).toBe(0);
  });
  it("stops after exactly four followups within 30 seconds, including 304 refreshing bodies", async () => {
    vi.useFakeTimers();
    const s = fixture(); s.refresh.state = "refreshing";
    const fetcher = vi.fn().mockImplementationOnce(() => Promise.resolve(jsonResponse(s))).mockImplementation(() => Promise.resolve(new Response(null, { status: 304 })));
    vi.stubGlobal("fetch", fetcher); const onSnapshot = vi.fn();
    const result = readCapitalFlowsWindow({ signal: new AbortController().signal, onSnapshot });
    await vi.advanceTimersByTimeAsync(30000);
    expect((await result).checksStopped).toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(1 + CAPITAL_COMPLETION_CHECKS_MS.length); expect(onSnapshot).toHaveBeenCalledTimes(5);
    await vi.advanceTimersByTimeAsync(60000); expect(fetcher).toHaveBeenCalledTimes(5); expect(vi.getTimerCount()).toBe(0);
  });
  it("stops completion checks as soon as a snapshot becomes idle", async () => {
    vi.useFakeTimers(); const s = fixture(); s.refresh.state = "refreshing";
    const fetcher = vi.fn().mockImplementationOnce(() => Promise.resolve(jsonResponse(s))).mockImplementation(() => Promise.resolve(jsonResponse(fixture(), '"snapshot-2"')));
    vi.stubGlobal("fetch", fetcher);
    const result = readCapitalFlowsWindow({ signal: new AbortController().signal, onSnapshot: vi.fn() });
    await vi.advanceTimersByTimeAsync(30000); expect((await result).checksStopped).toBe(false); expect(fetcher).toHaveBeenCalledTimes(2); expect(vi.getTimerCount()).toBe(0);
  });
  it("stops on API/schema failure, retaining only previously delivered data", async () => {
    vi.useFakeTimers(); const s = fixture(); s.refresh.state = "refreshing";
    const fetcher = vi.fn().mockImplementationOnce(() => Promise.resolve(jsonResponse(s))).mockImplementation(() => Promise.resolve(jsonResponse({ wrong: true })));
    vi.stubGlobal("fetch", fetcher); const onSnapshot = vi.fn();
    const result = readCapitalFlowsWindow({ signal: new AbortController().signal, onSnapshot }).catch(e => e);
    await vi.advanceTimersByTimeAsync(30000); expect((await result).message).toContain("schema"); expect(fetcher).toHaveBeenCalledTimes(2); expect(onSnapshot).toHaveBeenCalledOnce(); expect(vi.getTimerCount()).toBe(0);
  });
  it("aborts pending waits and makes no requests or callbacks after unmount cancellation", async () => {
    vi.useFakeTimers(); const s = fixture(); s.refresh.state = "refreshing";
    const fetcher = vi.fn().mockImplementation(() => Promise.resolve(jsonResponse(s))); vi.stubGlobal("fetch", fetcher);
    const controller = new AbortController(), onSnapshot = vi.fn();
    const result = readCapitalFlowsWindow({ signal: controller.signal, onSnapshot }).catch(e => e);
    await vi.advanceTimersByTimeAsync(1); controller.abort(); await vi.advanceTimersByTimeAsync(60000);
    expect((await result).name).toBe("AbortError"); expect(fetcher).toHaveBeenCalledOnce(); expect(onSnapshot).toHaveBeenCalledOnce(); expect(vi.getTimerCount()).toBe(0);
  });
  it("enforces the overall 30-second deadline even when the last completion transport stalls", async () => {
    vi.useFakeTimers(); const s = fixture(); s.refresh.state = "refreshing";
    const fetcher = vi.fn().mockImplementation(() => fetcher.mock.calls.length < 5 ? Promise.resolve(jsonResponse(s)) : new Promise(() => {}));
    vi.stubGlobal("fetch", fetcher);
    const result = readCapitalFlowsWindow({ signal: new AbortController().signal, onSnapshot: vi.fn() }).catch(e => e);
    await vi.advanceTimersByTimeAsync(30000);
    expect((await result).message).toContain("completion window ended"); expect(fetcher).toHaveBeenCalledTimes(5);
    expect(fetcher.mock.calls[4][1].signal.aborted).toBe(true); expect(vi.getTimerCount()).toBe(0);
  });
  it("aborts in-flight completion requests and suppresses late callbacks", async () => {
    vi.useFakeTimers(); const s = fixture(); s.refresh.state = "refreshing";
    let resolveLate: ((r: Response) => void) | undefined;
    const fetcher = vi.fn().mockImplementationOnce(() => Promise.resolve(jsonResponse(s))).mockImplementation(() => new Promise<Response>(resolve => { resolveLate = resolve; }));
    vi.stubGlobal("fetch", fetcher); const c = new AbortController(), onSnapshot = vi.fn();
    const result = readCapitalFlowsWindow({ signal: c.signal, onSnapshot }).catch(e => e);
    await vi.advanceTimersByTimeAsync(3001); c.abort();
    expect((await result).name).toBe("AbortError"); expect(fetcher.mock.calls[1][1].signal.aborted).toBe(true);
    resolveLate?.(jsonResponse(fixture())); await vi.advanceTimersByTimeAsync(60000);
    expect(onSnapshot).toHaveBeenCalledOnce(); expect(fetcher).toHaveBeenCalledTimes(2); expect(vi.getTimerCount()).toBe(0);
  });
  it("does not start a pre-aborted read", async () => {
    const fetcher = vi.fn(); vi.stubGlobal("fetch", fetcher); const c = new AbortController(); c.abort();
    await expect(fetchCapitalFlows({ signal: c.signal })).rejects.toMatchObject({ name: "AbortError" }); expect(fetcher).not.toHaveBeenCalled();
  });
});

describe("capital-flows scope and SSR markup (not browser interaction proof)", () => {
  it("shows source-native scaling, explicit period, sign, status, and all seven categories", () => {
    const html = renderToStaticMarkup(<CapitalFlowsView snapshot={fixture()} />);
    for (const label of Object.values(CATEGORY_LABELS)) expect(text(html)).toContain(label);
    for (const phrase of ["1.25 million USD", "0 million USD", "-2.5 million EUR", "2026-Q2", "2026-04-01 through 2026-06-30", "quarterly", "Cash basis", "Reporting recency: expectation unknown", "Positive issuance", "Retrieved", "Read-only. No account or wallet required."]) expect(text(html)).toContain(phrase);
    expect(html).toContain("<table"); expect(html).toContain("<caption"); expect(html).toContain('scope="col"'); expect(html).toContain('scope="row"'); expect(html).toContain("<summary>History");
    expect(html).not.toMatch(/<svg|<canvas/); expect(html).not.toContain("$1.25");
  });
  it("separates TIC transactions, cash/face value, fund shares and uncovered markets without overclaims", () => {
    const html = text(renderToStaticMarkup(<CapitalFlowsView snapshot={fixture()} />));
    for (const phrase of ["primary issuance/redemptions AND secondary trades", "not pure secondary-market turnover", "not cash-only subscriptions", "not the funds&#x27; underlying asset purchases", "face-value amounts, not cash proceeds", "Positive redemptions are a magnitude, not an inflow", "Japanese government bonds (JGBs)", "UK and China", "BIS", "comprehensive global transaction volumes", "direct property", "NOT investment flows"]) expect(html).toContain(phrase);
  });
  it("scopes geography by explicit dimension, not ambiguous country", () => {
    const s = fixture();
    expect(filterSeries(s.series, { ...DEFAULT_FILTERS, dimension: "fundDomicile", geography: "U2" }).map(s => s.definition.id)).toEqual(["synthetic-fund"]);
    expect(filterSeries(s.series, { ...DEFAULT_FILTERS, dimension: "issuer", geography: "U2" })).toEqual([]);
    expect(filterSeries(s.series, { ...DEFAULT_FILTERS, category: "sovereignDebt", measure: "purchases" }).map(s => s.definition.id)).toEqual(["synthetic-tic"]);
    expect(sectionFor(s.series[3].definition)).toBe("fund-share-transactions"); expect(sectionFor(s.series[4].definition)).toBe("cross-border-transactions");
    expect(groupSeries([s.series[3]])[0].label).toContain("Fund domicile: Euro area");
    // Actual ECB share/unit transaction definitions use netIssuance, not cash-only subscriptions.
    s.series[3].definition.metricKind = "netIssuance";
    expect(sectionFor(s.series[3].definition)).toBe("fund-share-transactions");
    expect(groupSeries([s.series[3]])[0].label).toContain("Net issuance · Fund domicile: Euro area");
  });
  it("keeps coverage and gaps unfiltered when every report table is filtered out", () => {
    const html = renderToStaticMarkup(<CapitalFlowsView snapshot={fixture()} initialFilters={{ ...DEFAULT_FILTERS, category: "crypto" }} />);
    expect(html).toContain("0 registered series"); expect(html).not.toContain("1.25 million USD");
    for (const label of Object.values(CATEGORY_LABELS)) expect(text(html)).toContain(label);
    expect(html).toContain("Important gaps, not silently dropped"); expect(html).toContain('href="/onchain"');
  });
  it("does not backfill a missing latest period with the previous observed amount", () => {
    const s = fixture().series[0];
    s.history.push({ ...s.history[0], id: "missing-latest", period: reportingPeriod("daily", "2026-09-09"), value: null, status: "missing" });
    expect(valueText(latestObservation(s)!)).toBe("Missing");
  });
  it("offers useful navigation when the server has no capital-flows feed", () => {
    const html = renderToStaticMarkup(<CapitalFlowsView error="The capital-flows feed is not enabled on this server (HTTP 404)." feedUnavailable />);
    expect(html).toContain('href="/world">Explore available money insights');
    expect(html).toContain("Further checks have stopped");
    expect(html).not.toContain("Refresh reports");
    expect(html).toContain("No source amounts are available");
  });
  it("renders loading, unavailable, failed refresh and stopped checking states without fabricated zeros", () => {
    const loading = renderToStaticMarkup(<CapitalFlowsView busy />);
    expect(loading).toContain("Loading reported data"); expect(loading).toContain("No source reports loaded yet"); expect(loading).toContain("No sources loaded");
    const failed = renderToStaticMarkup(<CapitalFlowsView snapshot={fixture()} error="Synthetic failure" checksStopped />);
    expect(failed).toContain('role="alert"'); expect(failed).toContain("Last trusted snapshot — update unavailable"); expect(failed).toContain("original observations and timestamps"); expect(failed).toContain("Automatic completion checks have stopped"); expect(failed).toContain("1.25 million USD");
  });
  it("retains original timestamps and amounts when the source reports fallback after a failed attempt", () => {
    const s = fixture(); s.sources[0].retrievalState = "fallback"; s.sources[0].lastAttemptAt = "2026-09-09T13:00:00.000Z"; s.sources[0].failure = "adapter_deadline";
    s.series.forEach(series => { series.state = "fallback"; });
    const parsed = parseCapitalFlowsSnapshot(s);
    const html = renderToStaticMarkup(<CapitalFlowsView snapshot={parsed} />);
    expect(html).toContain("Retained after delayed or failed retrieval"); expect(html).toContain("Original observation timestamps retained");
    expect(html).toContain("1.25 million USD"); expect(parsed.series[0].history[0].receipt.retrievedAt).toBe(retrievedAt);
    expect(parsed.sources[0].lastSuccessAt).toBe(retrievedAt);
  });
  it("opens a capital-specific native dialog in markup and exposes exact provenance, unknown publication, flags and inputs", () => {
    const s = fixture(); const o = s.series[2].history[0]; o.estimated = true; o.revised = true; o.provisional = true; o.break = true;
    const html = renderToStaticMarkup(<CapitalReceipt snapshot={s} selection={{ seriesId: o.seriesId, observationId: o.id }} onClose={() => {}} />);
    expect(html).toContain("<dialog"); expect(html).toContain('aria-labelledby="capital-receipt-title"'); expect(html).toContain("Close receipt");
    for (const phrase of ["Exact native decimal", "Publisher lexeme", "Publisher unit multiplier", "1000000", "Derived from compatible components", "Cash issues minus cash redemptions", "Derivation inputs", "estimated", "revised", "provisional", "series break", "Unknown — not supplied by publisher", "Transport Last-Modified", "Wed, 09 Sep 2026 11:00:00 GMT", "Synthetic fixture attribution", "Synthetic fixture reuse note"]) expect(text(html)).toContain(phrase);
  });
  it("resolves revised, suppressed, removed and rights-revoked selections only against the current snapshot", () => {
    const selection = selected(), s = fixture();
    expect(resolveReceipt(s, selection)?.observation.value?.decimal).toBe("1.25");
    s.series[0].history[0].value = nativeValue("7.125", s.series[0].definition.unit); s.series[0].history[0].revised = true;
    let html = renderToStaticMarkup(<ReceiptContent snapshot={s} selection={selection} />);
    expect(html).toContain("7.125 million USD"); expect(html).not.toContain("1.25 million USD");
    s.series[0].history[0].value = null; s.series[0].history[0].status = "suppressed";
    html = renderToStaticMarkup(<ReceiptContent snapshot={s} selection={selection} />);
    expect(html).toContain("Suppressed"); expect(html).not.toContain("7.125");
    s.series[0].history = [];
    expect(resolveReceipt(s, selection)).toBeUndefined();
    const revoked = fixture(); revoked.sources[0].definition.rights.status = "restricted";
    html = renderToStaticMarkup(<ReceiptContent snapshot={revoked} selection={selection} />);
    expect(html).toContain("no longer available"); expect(html).not.toContain("1.25");
  });
  it("does not combine an old observation with a new source transport receipt", () => {
    const s = fixture(); s.sources[0].receipts[0].retrievedAt = "2026-09-09T13:00:00.000Z";
    expect(resolveReceipt(s, selected())).toBeUndefined();
  });
  it("shows free ECB access and modification notice when the publisher is ECB", () => {
    const s = fixture(); s.sources[0].definition.sourceUrl = "https://data.ecb.europa.eu/data";
    const html = renderToStaticMarkup(<ReceiptContent snapshot={s} selection={selected()} />);
    expect(html).toContain("available free of charge from the ECB"); expect(html).toContain("selects and reformats series"); expect(html).toContain("not an ECB publication or endorsement");
  });
  it.each(["javascript:alert(1)", "data:text/html,evil", "http://example.org", "https://user:password@example.org"])("rejects unsafe external href %s", href => {
    expect(safeHttpsUrl(href)).toBeUndefined();
    expect(renderToStaticMarkup(<SourceLink url={href}>Source</SourceLink>)).not.toContain("href=");
  });
  it("escapes publisher text and gives external HTTPS links safe relationships", () => {
    const s = fixture(); s.series[0].definition.label = '<img src=x onerror="alert(1)">';
    const html = renderToStaticMarkup(<CapitalFlowsView snapshot={s} />);
    expect(html).not.toContain("<img"); expect(html).toContain("&lt;img"); expect(html).toContain('rel="noopener noreferrer"');
  });
  it("routes trailing-slash Capital flows lazily without fetching during SSR", async () => {
    const fetcher = vi.fn(); vi.stubGlobal("fetch", fetcher);
    vi.stubGlobal("window", { location: { pathname: "/capital-flows/" } });
    const { default: App } = await import("../src/App");
    renderToStaticMarkup(<App />);
    await vi.dynamicImportSettled();
    const html = renderToStaticMarkup(<App />);
    expect(html).toContain('id="capital-title"'); expect(html).toContain("Capital flows"); expect(fetcher).not.toHaveBeenCalled();
  });
  it("offers useful service destinations on the not-found route", async () => {
    vi.stubGlobal("window", { location: { pathname: "/not-a-route" } });
    const { default: App } = await import("../src/App");
    const html = renderToStaticMarkup(<App />);
    expect(html).toContain('href="/"'); expect(html).toContain("Back to overview");
    expect(html).toContain('href="/plan"'); expect(html).toContain("Money plan");
    expect(html).toContain('href="/world"'); expect(html).toContain("Money insights");
    expect(html).toContain('href="/wallet"');
  });
  it("does not fetch or touch storage while rendering the route shell on the server", () => {
    const fetcher = vi.fn(); vi.stubGlobal("fetch", fetcher);
    vi.stubGlobal("localStorage", { getItem: () => { throw new Error("unexpected storage"); }, setItem: () => { throw new Error("unexpected storage"); } });
    renderToStaticMarkup(<CapitalFlowsPage />); expect(fetcher).not.toHaveBeenCalled();
  });
});
