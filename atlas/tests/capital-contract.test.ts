import { readFileSync } from "node:fs";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
// Server factories/normalization belong only in tests, never the browser import graph.
import { createTicTransactionsAdapter, createUsCashFinancingAdapter } from "../../sovereign/src/info/capital-flows/us.ts";
import { createCapitalFlowsCache, validateSourceBatch, type CapitalFlowsCache } from "../../sovereign/src/info/capital-flows/snapshot.ts";
import { nativeValue, reportingPeriod, sourceTtlMs, type CapitalFlowAdapter, type CapitalFlowsSnapshot, type FlowObservation, type SeriesDefinition, type SourceBatch } from "../../sovereign/src/info/capital-flows/model.ts";
import { readCapitalFlowsWindow, type CapitalFlowsMemory, type CapitalFlowsFetchResult } from "../src/capital-flows/api";
import { latestObservation, resolveReceipt, valueText } from "../src/capital-flows/presentation";
import { parseCapitalFlowsSnapshot } from "../src/capital-flows/validation";

const fixtureDir = new URL("../../sovereign/src/info/capital-flows/fixtures/", import.meta.url);
const dtsTexts = ["issues", "redemptions"].map(leg => readFileSync(new URL(`us-dts-${leg}-rolling.native.json`, fixtureDir), "utf8"));
const ticText = readFileSync(new URL("tic-table4-grand-total.excerpt.txt", fixtureDir), "utf8");
// Explicit synthetic transport clocks, not publisher/replay metadata. DTS requests finish independently.
const receiptTimes = ["2026-09-09T22:43:14.296Z", "2026-09-09T22:43:15.739Z"];
const ticTime = "2026-09-09T22:45:00.000Z";
const ticIds = ["us-tic-treas-purchases", "us-tic-treas-sales", "us-tic-treas-netAcquisition"];
async function settle(cache: CapitalFlowsCache) {
  await cache.read(); await cache.waitForIdle(); return cache.read();
}
async function nativeSnapshot(adapter: CapitalFlowAdapter, texts: string[], times = [ticTime]) {
  let clock = Date.parse(times[0]);
  const fetcher = vi.fn(async (url: string) => {
    const index = adapter.definition.resources.indexOf(url);
    expect(index).toBeGreaterThanOrEqual(0);
    clock = Date.parse(times[index]);
    return new Response(texts[index], { headers: { etag: `"synthetic-native-${index}"` } });
  });
  const cache = createCapitalFlowsCache([adapter], { now: () => clock, fetch: fetcher, coldWaitMs: 0 });
  try {
    const delivery = await settle(cache);
    // The real transport/accounting/validateSourceBatch/cache path must accept before the UI is tested.
    expect(delivery.snapshot.sources[0]).toMatchObject({ retrievalState: "current", failure: null });
    expect(fetcher.mock.calls.map(([url]) => url)).toEqual(adapter.definition.resources);
    return JSON.parse(delivery.serialized) as CapitalFlowsSnapshot;
  } finally { cache.dispose(); }
}
function changeTicTokens(tokens: Record<string, string>): string {
  const lines = ticText.split(/\r?\n/);
  const header = lines.find(line => line.startsWith("country\tcountry_code\tdate\t"))!.split("\t");
  const index = lines.findIndex(line => line.startsWith("Grand Total\t99996\t2026-06\t"));
  expect(index).toBeGreaterThanOrEqual(0);
  const row = lines[index].split("\t");
  for (const [column, token] of Object.entries(tokens)) {
    expect(header).toContain(column); row[header.indexOf(column)] = token;
  }
  lines[index] = row.join("\t"); return lines.join("\n");
}
let dts: CapitalFlowsSnapshot, tic: CapitalFlowsSnapshot;
beforeAll(async () => {
  dts = await nativeSnapshot(createUsCashFinancingAdapter(), dtsTexts, receiptTimes);
  tic = await nativeSnapshot(createTicTransactionsAdapter(), [ticText]);
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });
const latest = (s: CapitalFlowsSnapshot, id: string) => latestObservation(s.series.find(row => row.definition.id === id)!)!;
// Deliberately reduced/mutated contract cases below are not additional publisher observations.
function contractSnapshot() {
  const s = structuredClone(tic);
  s.series = ticIds.map(id => s.series.find(row => row.definition.id === id)!);
  s.series.forEach(row => { row.history = [latestObservation(row)!]; });
  s.coverage = []; return s;
}
const legs = (s: CapitalFlowsSnapshot) => ticIds.map(id => latest(s, id)) as [FlowObservation, FlowObservation, FlowObservation];
function missingInput(s: CapitalFlowsSnapshot, side = 0, status: FlowObservation["status"] = "missing") {
  const inputs = legs(s), input = inputs[side], net = inputs[2];
  input.value = null; input.status = status; net.value = null; net.status = "missing";
  return inputs;
}
// Differential oracle: revalidate synthetic wire mutations against the authoritative core rules first.
function normalize(s: CapitalFlowsSnapshot) {
  return s.sources.map(source => {
    const series = s.series.filter(row => row.definition.sourceId === source.definition.id);
    const batch: SourceBatch = { complete: true, receipts: source.receipts, observations: series.flatMap(row => row.history) };
    return validateSourceBatch({ definition: source.definition, series: series.map(row => row.definition), load: async () => batch }, batch);
  });
}
function accepts(s: CapitalFlowsSnapshot) {
  expect(() => normalize(s)).not.toThrow();
  expect(parseCapitalFlowsSnapshot(JSON.parse(JSON.stringify(s)))).toEqual(s);
}
function rejects(s: CapitalFlowsSnapshot) {
  expect(() => normalize(s)).toThrow();
  expect(() => parseCapitalFlowsSnapshot(s)).toThrow(/schema or source-receipt/);
}

describe("receipt timestamp calendar parity", () => {
  function receiptTime(s: CapitalFlowsSnapshot, field: "publicationAt" | "retrievedAt", value: string) {
    for (const row of s.series) for (const o of row.history) o.receipt[field] = value;
    if (field === "retrievedAt") for (const t of s.sources[0].receipts) t.retrievedAt = value;
  }
  it.each(["publicationAt", "retrievedAt"] as const)("rejects impossible %s dates even when matching receipts agree", field => {
    for (const value of ["2026-02-30T12:00:00.000Z", "2025-02-29T00:30:00+14:00"]) {
      const s = contractSnapshot(); receiptTime(s, field, value); rejects(s);
    }
  });
  it.each(["publicationAt", "retrievedAt"] as const)("preserves valid leap-day and offset %s instants", field => {
    for (const value of ["2024-02-29T12:00:00.000Z", "2026-03-01T00:30:00+14:00"]) {
      const s = contractSnapshot(); receiptTime(s, field, value); accepts(s);
    }
  });
});

describe("native US adapter → backend normalizer → browser wire contract", () => {
  it("accepts all 180 DTS observations with distinct declared URLs and receipt instants", () => {
    expect(dts.series.map(row => row.history.length)).toEqual([60, 60, 60]);
    expect(dts.sources[0].receipts.map(r => r.retrievedAt)).toEqual(receiptTimes);
    const [issue, redemption, net] = ["issuance", "redemptions", "netIssuance"].map(kind => latest(dts, `us-dts-${kind}`));
    expect(issue.receipt.resourceUrl).not.toBe(redemption.receipt.resourceUrl);
    expect(issue.receipt.retrievedAt).toBe(receiptTimes[0]);
    expect(redemption.receipt.retrievedAt).toBe(receiptTimes[1]);
    expect(net.receipt.retrievedAt).toBe(receiptTimes[1]);
    expect(net.receipt.inputObservationIds).toEqual([issue.id, redemption.id]);
    expect(net.value?.decimal).toBe("-26022"); accepts(dts);
    const parsed = parseCapitalFlowsSnapshot(dts);
    for (const o of [issue, redemption, net]) {
      expect(resolveReceipt(parsed, { seriesId: o.seriesId, observationId: o.id })?.observation.receipt).toEqual(o.receipt);
    }
  });
  it.each(["input time", "net time", "input URL", "transport time"])('rejects a forged DTS %s rather than permitting an unreceipted value', field => {
    const s = structuredClone(dts), issue = latest(s, "us-dts-issuance"), net = latest(s, "us-dts-netIssuance");
    if (field === "input time") issue.receipt.retrievedAt = receiptTimes[1]; // Valid instant, wrong resource/instant pair.
    if (field === "net time") net.receipt.retrievedAt = receiptTimes[0];
    if (field === "input URL") issue.receipt.resourceUrl = s.sources[0].receipts[1].url;
    if (field === "transport time") s.sources[0].receipts[0].retrievedAt = ticTime;
    rejects(s);
  });
  it("accepts all 216 TIC observations and the native Treasury net 6778", () => {
    expect(tic.series).toHaveLength(9); expect(tic.series.every(row => row.history.length === 24)).toBe(true);
    expect(latest(tic, ticIds[2]).value?.decimal).toBe("6778"); accepts(tic);
  });
  it.each([
    ["n.a.", "3846831", null], ["3853609", "n.a.", null], ["n.a.", "n.a.", null],
    ["-0", "0", "0"], ["0", "0", "0"], ["1", "2", "-1"],
    ["9007199254740993.10", "9007199254740992.009", "1.091"],
  ])("preserves TIC %s minus %s as %s through both validators", async (a, b, expected) => {
    const s = await nativeSnapshot(createTicTransactionsAdapter(), [changeTicTokens({ for_lt_treas_sale: a!, for_lt_treas_pur: b! })]);
    accepts(s);
    const [purchases, sales, net] = legs(s);
    expect(net.value?.decimal ?? null).toBe(expected);
    expect(net.status).toBe(expected === null ? "missing" : "observed");
    expect(net.publisherStatus).toBeNull();
    for (const [input, token] of [[purchases, a], [sales, b]] as const) {
      expect(input.publisherStatus).toBe(token === "n.a." ? "n.a." : null);
      if (token !== "n.a.") expect(input.value?.publisherLexeme).toBe(token);
    }
    if (expected === null) expect(valueText(net)).toBe("Missing");
    if (expected === "0") expect(valueText(net)).toBe("0 million USD");
  });
});

describe("derived missing arithmetic stays as strict as core normalization", () => {
  it.each(["missing", "suppressed", "notYetReported", "withdrawn"] as const)("accepts either unavailable leg with a witnessed %s status, never invented amounts/reasons", status => {
    for (const side of [0, 1]) {
      const s = contractSnapshot(), inputs = missingInput(s, side, status), net = inputs[2];
      // Core permits unavailable arithmetic even when completeness is not known.
      inputs[side].completeness = "unknown"; net.completeness = "partial";
      accepts(s); net.status = status; accepts(s);
      for (const invented of ["suppressed", "notYetReported", "withdrawn"] as const) {
        if (invented !== status) { net.status = invented; rejects(s); }
      }
      for (const amount of ["0", "1", "-1"]) {
        net.status = "observed"; net.value = nativeValue(amount, s.series[2].definition.unit); rejects(s);
      }
      net.status = "missing"; net.value = null;
      inputs[side].value = nativeValue("123", s.series[side].definition.unit); rejects(s);
      inputs[side].value = null; inputs[side].status = "observed"; rejects(s);
    }
  });
  it("accepts either witnessed reason with two unavailable legs, but not a third invented reason", () => {
    const s = contractSnapshot(), [a, b, net] = missingInput(s, 0, "suppressed");
    b.value = null; b.status = "withdrawn"; a.completeness = "partial"; b.completeness = "unknown";
    for (const reason of ["missing", "suppressed", "withdrawn"] as const) { net.status = reason; accepts(s); }
    net.status = "notYetReported"; rejects(s);
  });
  it("does not invent a missing net when both inputs are observed", () => {
    const s = contractSnapshot(), net = legs(s)[2]; net.value = null; net.status = "missing"; rejects(s);
  });
  it.each([0, 1, 2])("requires complete observed arithmetic at position %s and its exact difference", position => {
    const s = contractSnapshot(), inputs = legs(s);
    inputs[position].completeness = "partial"; rejects(s);
    inputs[position].completeness = "complete";
    inputs[2].value = nativeValue("6779", s.series[2].definition.unit); rejects(s);
  });
  const incompatible: [string, (d: SeriesDefinition) => void][] = [
    ["unit", d => { d.unit = { currency: "EUR", exponent: 6, label: "million EUR" }; }],
    ["geography", d => { d.geography.investor = { code: "other", label: "Other scope" }; }],
    ["perspective", d => { d.perspective = "Other perspective"; }],
    ["instrument", d => { d.instrument = "Other instrument"; }],
    ["sector", d => { d.sector = "Other sector"; }],
    ["valuation", d => { d.valuation = "Face value"; }],
    ["seasonalAdjustment", d => { d.seasonalAdjustment = "seasonallyAdjusted"; }],
    ["annualization", d => { d.annualization = "annualizedRate"; }],
    ["fundMandate", d => { d.fundMandate = "Other mandate"; }],
    ["category", d => { d.category = "equities"; }],
    ["metricKind", d => { d.metricKind = "issuance"; }],
  ];
  it.each(incompatible)("rejects incompatible %s before either missing or observed arithmetic", (_field, mutate) => {
    for (const missing of [false, true]) {
      const s = contractSnapshot(); if (missing) missingInput(s);
      mutate(s.series[0].definition);
      const a = legs(s)[0];
      if (a.value) a.value = nativeValue(a.value.publisherLexeme, s.series[0].definition.unit);
      rejects(s);
    }
  });
  it.each(["period", "frequency", "source", "input ID", "duplicate input", "input method", "sourceSeriesId", "datasetId"])("rejects incompatible %s even with a null net", field => {
    const s = contractSnapshot(), [a, , net] = missingInput(s);
    if (field === "period") a.period = reportingPeriod("monthly", "2026-05");
    if (field === "frequency") { s.series[0].definition.frequency = "daily"; a.period = reportingPeriod("daily", "2026-06-01"); }
    if (field === "source") {
      const other = structuredClone(s.sources[0]); other.definition.id = "other-source"; s.sources.push(other);
      s.series[0].definition.sourceId = other.definition.id; a.receipt.sourceId = other.definition.id;
    }
    if (field === "input ID") net.receipt.inputObservationIds[0] = "absent";
    if (field === "duplicate input") net.receipt.inputObservationIds[1] = a.id;
    if (field === "input method") a.receipt.method = "derivedCompatibleComponents";
    if (field === "sourceSeriesId") a.receipt.sourceSeriesId = "wrong-series";
    if (field === "datasetId") a.receipt.datasetId = "wrong-dataset";
    rejects(s);
  });
});

describe("native TIC cache replacement through the frontend API/onSnapshot contract", () => {
  it("replaces selected 6778 with current n.a./null, retaining originals only on malformed updates", async () => {
    let clock = Date.parse(ticTime), text = ticText;
    const adapter = createTicTransactionsAdapter();
    const sourceFetch = vi.fn(async (url: string) => {
      expect(url).toBe(adapter.definition.resources[0]); return new Response(text);
    });
    const cache = createCapitalFlowsCache([adapter], { now: () => clock, fetch: sourceFetch, coldWaitMs: 0 });
    let memory: CapitalFlowsMemory | undefined;
    const onSnapshot = vi.fn((result: CapitalFlowsFetchResult) => { memory = result; });
    const browserFetch = vi.fn(); vi.stubGlobal("fetch", browserFetch);
    const read = () => readCapitalFlowsWindow({ signal: new AbortController().signal, cached: memory, onSnapshot });
    const respond = (body: unknown, etag: string) => browserFetch.mockResolvedValueOnce(new Response(JSON.stringify(body), {
      headers: { "content-type": "application/vnd.cashloom.capital-flows.v1+json", etag },
    }));
    try {
      const initial = await settle(cache); respond(JSON.parse(initial.serialized), initial.etag); await read();
      const original = memory!, net = latest(original.snapshot, ticIds[2]);
      const selection = { seriesId: net.seriesId, observationId: net.id };
      expect(resolveReceipt(original.snapshot, selection)?.observation.value?.decimal).toBe("6778");

      const forged = structuredClone(initial.snapshot); latest(forged, ticIds[0]).receipt.retrievedAt = receiptTimes[0];
      respond(forged, '"forged"'); await expect(read()).rejects.toThrow(/schema or source-receipt/);
      expect(memory).toBe(original); expect(onSnapshot).toHaveBeenCalledTimes(1);

      clock += sourceTtlMs("monthly") + 1; text = changeTicTokens({ for_lt_treas_sale: "n.a." });
      const missing = await settle(cache);
      expect(missing.snapshot.sources[0]).toMatchObject({ retrievalState: "current", failure: null });
      expect(latest(missing.snapshot, ticIds[2])).toMatchObject({ status: "missing", value: null });
      respond(JSON.parse(missing.serialized), missing.etag);
      const updated = await read(); // Must resolve and deliver, not signal an error and leave 6778 in memory.
      expect(updated.latest).toBe(memory); expect(updated.checksStopped).toBe(false);
      expect(onSnapshot).toHaveBeenCalledTimes(2); expect(memory).not.toBe(original);
      expect(memory!.etag).toBe(missing.etag); expect(memory!.etag).not.toBe(original.etag);
      const selected = resolveReceipt(memory!.snapshot, selection)!;
      expect(selected.observation).toMatchObject({ id: net.id, status: "missing", value: null });
      expect(valueText(selected.observation)).toBe("Missing");
      expect(selected.observation.receipt.retrievedAt).not.toBe(net.receipt.retrievedAt);
      expect(resolveReceipt(original.snapshot, selection)?.observation.value?.decimal).toBe("6778");
      expect(browserFetch.mock.calls[2][1].headers["If-None-Match"]).toBe(original.etag);

      const trustedMissing = memory!;
      const hidden = structuredClone(missing.snapshot);
      latest(hidden, ticIds[0]).value = nativeValue("3853609", hidden.series[0].definition.unit);
      respond(hidden, '"hidden-suppressed-amount"'); await expect(read()).rejects.toThrow(/schema or source-receipt/);
      expect(memory).toBe(trustedMissing); expect(onSnapshot).toHaveBeenCalledTimes(2);

      clock += sourceTtlMs("monthly") + 1; text = changeTicTokens({ for_lt_treas_sale: "oops" });
      const fallback = await settle(cache);
      expect(fallback.snapshot.sources[0].retrievalState).toBe("fallback");
      expect(fallback.snapshot.sources[0].receipts).toEqual(missing.snapshot.sources[0].receipts);
      respond(JSON.parse(fallback.serialized), fallback.etag); await read();
      expect(resolveReceipt(memory!.snapshot, selection)?.observation).toEqual(selected.observation);
      expect(onSnapshot).toHaveBeenCalledTimes(3); expect(sourceFetch).toHaveBeenCalledTimes(3);
      expect(browserFetch.mock.calls.every(([url]) => url === "/v1/capital-flows")).toBe(true);
    } finally { cache.dispose(); }
  });
});
