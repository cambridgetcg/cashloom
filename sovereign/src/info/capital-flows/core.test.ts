import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CAPITAL_FLOWS_MEDIA_TYPE, CAPITAL_FLOWS_SCHEMA, CAPITAL_LIMITS, HISTORY_LIMIT,
  expandDecimalLexeme, nativeValue, reportingPeriod, sourceTtlMs, validatePeriod,
  type CapitalFlowAdapter, type FlowObservation, type Rights, type SeriesDefinition,
  type SourceBatch, type TransportReceipt,
} from "./model.ts";
import {
  abortable, CapitalFlowError, createAdapterTransport, createRequestPool, safeFailure,
  validateResourceUrl, type FetchLike, type RequestPool,
} from "./transport.ts";
import { boundedJsonBytes, createCapitalFlowsCache, validateSourceBatch, type CapitalFlowsCache, type CapitalFlowsCacheOptions } from "./snapshot.ts";
import { mountCapitalFlowsDoor } from "./door.ts";

const AT = Date.parse("2026-09-09T12:00:00.000Z");
const UNIT = { currency: "EUR", exponent: 6, label: "million EUR" };
const RIGHTS: Rights = {
  status: "allowed", attribution: "Fixture publisher", evidenceUrl: "https://publisher.example/terms",
  checkedAt: null, note: "Terms reviewed on 2026-09-09; precise review time was not recorded.",
};
function series(id = "publisher"): SeriesDefinition {
  return {
    id: `${id}-issuance`, sourceId: id, sourceSeriesId: "ISSUE", datasetId: "TEST", label: "Debt issuance",
    category: "sovereignDebt", metricKind: "issuance", frequency: "monthly", unit: { ...UNIT },
    perspective: "Issuer financing", signConvention: "Positive is gross issuance",
    geography: { issuer: { code: "DE", label: "Germany" }, investor: null, reporting: null, custodial: null, fundDomicile: null },
    instrument: "Government debt securities", sector: "General government", fundMandate: null,
    valuation: "Nominal value", seasonalAdjustment: "unadjusted", annualization: "notAnnualized",
    methodologyUrl: "https://publisher.example/method", sourceUrl: `https://publisher.example/${id}.csv`, limitations: ["A fixture, not a live fact."],
  };
}
function receipt(url = "https://publisher.example/publisher.csv"): TransportReceipt {
  return { url, retrievedAt: new Date(AT).toISOString(), etag: '"upstream-v1"', lastModified: "Wed, 09 Sep 2026 10:00:00 GMT", decodedBytes: 7 };
}
function observation(d = series(), r = receipt(d.sourceUrl), lexeme = "9007199254740993.0100", label = "2026-08"): FlowObservation {
  return {
    id: `${d.id}:${label}`, seriesId: d.id, period: reportingPeriod(d.frequency, label),
    value: nativeValue(lexeme, d.unit), status: "observed", provisional: true, revised: true, estimated: true,
    publisherStatus: "E", publisherConfidentiality: "F", break: false, completeness: "complete",
    receipt: {
      sourceId: d.sourceId, sourceSeriesId: d.sourceSeriesId, datasetId: d.datasetId,
      resourceUrl: r.url, retrievedAt: r.retrievedAt, publicationAt: null,
      method: "publisherReported", recipe: "Use the publisher's flow value; no currency conversion.",
      inputObservationIds: [], limitations: ["A selected reporting scope, not a global total."],
    },
  };
}
function adapter(id = "publisher"): CapitalFlowAdapter {
  const d = series(id);
  return {
    definition: { id, name: id, sourceUrl: d.sourceUrl, methodologyUrl: d.methodologyUrl,
      rights: { ...RIGHTS }, resources: [d.sourceUrl], cadence: "monthly", limitations: ["Selected histories only."] },
    series: [d],
    async load(context) {
      const response = await context.fetchText(d.sourceUrl);
      context.consumeRows(1);
      context.assertComplete(1, 1);
      return { complete: true, observations: [observation(d, response.receipt)], receipts: [response.receipt] };
    },
  };
}
function batch(a = adapter()): SourceBatch {
  const r = receipt(a.definition.resources[0]);
  return { complete: true, observations: a.series.map(d => observation(d, r)), receipts: [r] };
}
const fakeFetch = () => vi.fn<FetchLike>(async () => new Response("fixture", {
  headers: { "last-modified": "Wed, 09 Sep 2026 10:00:00 GMT", etag: '"upstream-v1"' },
}));
const caches: CapitalFlowsCache[] = [];
const pools: RequestPool[] = [];
const controllers: AbortController[] = [];
function cache(adapters: CapitalFlowAdapter[], options: CapitalFlowsCacheOptions = {}) {
  const result = createCapitalFlowsCache(adapters, { fetch: fakeFetch(), now: () => AT, coldWaitMs: 0, ...options });
  caches.push(result);
  return result;
}
async function settle(c: CapitalFlowsCache) {
  await c.read();
  await c.waitForIdle();
  return c.read();
}
function transport(a = adapter(), fetch = fakeFetch()) {
  const pool = createRequestPool(); pools.push(pool);
  const controller = new AbortController(); controllers.push(controller);
  let permitted = true;
  return {
    ...createAdapterTransport({ definition: a.definition, signal: controller.signal, pool, fetch, now: () => AT, rightsAllowed: () => permitted }),
    fetch, controller, pool, revoke: () => { permitted = false; },
  };
}
afterEach(() => {
  caches.splice(0).forEach(c => c.dispose());
  controllers.splice(0).forEach(c => c.abort());
  pools.splice(0).forEach(p => p.dispose());
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("bounded plain-JSON UTF-8 accounting", () => {
  it.each([
    null, true, false, 0, -0, 1e21, 1e-7, Number.MAX_VALUE,
    "quote\" backslash\\ slash/ \b\f\n\r\t" + String.fromCharCode(0, 31),
    "ASCII é € " + String.fromCodePoint(0x1f600) + " \ud800 \udfff",
    { "escaped\"key\n€": [null, true, { value: "𐀀\ud800" }] },
  ])("matches JSON.stringify UTF-8 size exactly for %# without materializing the payload", value => {
    const expected = Buffer.byteLength(JSON.stringify(value));
    for (const limit of [0, Math.max(0, expected - 1), expected, expected + 10]) {
      expect(boundedJsonBytes(value, limit)).toBe(expected > limit ? limit + 1 : expected);
    }
  });
  it("accounts for every UTF-16 code unit, including well-formed pairs and escaped lone surrogates", () => {
    for (let first = 0; first < 0x10000; first += 257) {
      const value = String.fromCharCode(...Array.from({ length: Math.min(257, 0x10000 - first) }, (_, i) => first + i));
      const expected = Buffer.byteLength(JSON.stringify(value));
      expect(boundedJsonBytes(value, expected)).toBe(expected);
      expect(boundedJsonBytes(value, expected - 2)).toBe(expected - 1);
    }
  });
  it("counts repeated shared references per occurrence without confusing them with cycles", () => {
    const shared = { nested: ["repeated", "€"] }, value = [shared, shared, { again: shared }];
    const expected = Buffer.byteLength(JSON.stringify(value));
    expect(boundedJsonBytes(value, expected)).toBe(expected);
    expect(boundedJsonBytes(value, expected - 10)).toBe(expected - 9);
  });
  it("rejects cycles, excessive depth and non-JSON objects without invoking accessors or toJSON", () => {
    const cyclic: { self?: unknown } = {}; cyclic.self = cyclic;
    let deep: unknown = null; for (let i = 0; i < 40; i++) deep = { child: deep };
    const getter = vi.fn(() => "secret"), serializer = vi.fn(() => "secret");
    const accessor = Object.defineProperty({}, "value", { enumerable: true, get: getter });
    for (const value of [cyclic, deep, accessor, { toJSON: serializer }, new Date(), new Map(), new Uint8Array(1),
      undefined, NaN, Infinity, 1n, () => 1, [undefined], new Array(2), { [Symbol("hidden")]: "secret" }]) {
      expect(() => boundedJsonBytes(value, 1_000_000)).toThrow("invalid_batch");
    }
    expect(getter).not.toHaveBeenCalled(); expect(serializer).not.toHaveBeenCalled();
  });
  it("rejects repeated 33-MB normalized expansion before calling JSON.stringify or encoding it", () => {
    const a = adapter(); a.series = Array.from({ length: 4 }, (_, i) => ({ ...series(), id: `daily-${i}`, frequency: "daily" }));
    const b = batch(); const shared = Array.from({ length: 64 }, () => "x".repeat(4_096));
    b.observations = a.series.flatMap(d => Array.from({ length: 32 }, (_, i) => {
      const date = new Date(AT - i * 86_400_000).toISOString().slice(0, 10);
      const o = observation(d, b.receipts[0], "1", date); o.receipt.limitations = shared; return o;
    }));
    const stringify = vi.spyOn(JSON, "stringify").mockImplementation(() => { throw new Error("unchecked_json_materialization"); });
    expect(() => validateSourceBatch(a, b)).toThrow("normalized_byte_limit");
    expect(stringify).not.toHaveBeenCalled();
  });
  it("bounds shared registry expansion before eager serialization too", () => {
    const a = adapter(); a.definition.limitations = Array.from({ length: 64 }, () => "x".repeat(4_096));
    const stringify = vi.spyOn(JSON, "stringify").mockImplementation(() => { throw new Error("unchecked_json_materialization"); });
    expect(() => cache([a])).toThrow("registry_limit"); expect(stringify).not.toHaveBeenCalled();
  });
});

describe("exact native values and reporting periods", () => {
  it.each([
    ["9007199254740993.0100", "9007199254740993.01", "90071992547409930100", 4],
    ["+001.2300e+3", "1230", "12300", 1],
    ["-7.003E-4", "-0.0007003", "-7003", 7],
    ["-0.000e2", "0", "0", 1],
    ["1e20", "100000000000000000000", "100000000000000000000", 0],
  ])("preserves publisher lexeme %s and exact scale", (lexeme, decimal, raw, decimals) => {
    const result = nativeValue(lexeme, UNIT);
    expect(result).toMatchObject({ publisherLexeme: lexeme, decimal, raw, decimals,
      currency: "EUR", unitExponent: 6, unitMultiplier: "1000000", unit: "million EUR", display: `${decimal} million EUR` });
    expect(JSON.parse(JSON.stringify(result))).toEqual(result);
  });
  it.each(["", "NaN", "Infinity", "1,000", " 1", "1 ", ".5", "1.", "1e999", "1e-128", "1e128", "1".repeat(129)])("rejects malformed or excessive decimal %s", lexeme => {
    expect(() => expandDecimalLexeme(lexeme)).toThrow("invalid_decimal");
  });
  it("accepts bounded very large and small exact values without numeric rounding", () => {
    expect(nativeValue("9".repeat(128), UNIT).raw).toBe("9".repeat(128));
    expect(expandDecimalLexeme("1e-126")).toHaveLength(128);
  });
  it.each([
    { ...UNIT, currency: "eur" }, { ...UNIT, exponent: -1 }, { ...UNIT, exponent: 13 },
    { ...UNIT, exponent: 1.5 }, { ...UNIT, label: "EUR" },
  ])("rejects invalid or misleading native unit %#", unit => expect(() => nativeValue("1", unit)).toThrow());
  it.each([
    ["daily", "2024-02-29", "2024-02-29", "2024-02-29"],
    ["event", "2026-09-09", "2026-09-09", "2026-09-09"],
    ["weekly", "2026-08-29/2026-09-04", "2026-08-29", "2026-09-04"],
    ["monthly", "2024-02", "2024-02-01", "2024-02-29"],
    ["monthly", "2026-02", "2026-02-01", "2026-02-28"],
    ["quarterly", "2026-Q4", "2026-10-01", "2026-12-31"],
  ] as const)("validates %s %s boundaries", (frequency, label, start, end) => {
    expect(reportingPeriod(frequency, label)).toEqual({ frequency, label, start, end });
  });
  it.each([
    ["daily", "2026-02-29"], ["event", "2026-09-31"], ["monthly", "2026-13"],
    ["monthly", "2026-2"], ["quarterly", "2026-Q5"], ["weekly", "2026-09-01/2026-09-08"],
    ["weekly", "2026-09-01/2026-09-07/extra"],
  ] as const)("rejects invalid %s %s", (frequency, label) => expect(() => reportingPeriod(frequency, label)).toThrow("invalid_period"));
  it("rejects a plausible label with incompatible actual period", () => {
    expect(() => validatePeriod({ frequency: "monthly", label: "2026-08", start: "2026-08-02", end: "2026-08-31" })).toThrow("invalid_period");
    expect(() => validatePeriod({ frequency: "monthly", label: "0000-01", start: "0000-01-01", end: "1900-01-31" })).toThrow("invalid_period");
    expect(() => validatePeriod({ frequency: "quarterly", label: "0099-Q1", start: "0099-01-01", end: "1999-03-31" })).toThrow("invalid_period");
  });
  it.each(["0000", "0001", "0099", "0100", "0999"])("rejects unsupported early year %s consistently across frequencies", year => {
    for (const [frequency, label] of [
      ["daily", `${year}-01-01`], ["event", `${year}-01-01`], ["weekly", `${year}-01-01/${year}-01-07`],
      ["monthly", `${year}-01`], ["quarterly", `${year}-Q1`],
    ] as const) expect(() => reportingPeriod(frequency, label)).toThrow("invalid_period");
  });
  it("supports four-digit years without cross-century monthly or quarterly spans", () => {
    expect(reportingPeriod("monthly", "1000-01").end).toBe("1000-01-31");
    expect(reportingPeriod("quarterly", "1000-Q1").end).toBe("1000-03-31");
    expect(reportingPeriod("monthly", "9999-12").end).toBe("9999-12-31");
    expect(() => validatePeriod({ frequency: "monthly", label: "1000-01", start: "1000-01-01", end: "2900-01-31" })).toThrow("invalid_period");
  });
});

describe("bounded allowlisted transport", () => {
  it.each([
    "http://publisher.example/data", "https://user:password@publisher.example/data", "https://publisher.example/data#fragment",
    "https://publisher.example:8443/data", "https://127.0.0.1/data", "https://2130706433/data", "https://[::1]/data",
    "https://localhost/data", "https://host.local/data", "https://host.localhost/data", "https://Publisher.example/data", "https://publisher.example:443/data",
  ])("rejects unsafe/noncanonical resource %s", url => expect(() => validateResourceUrl(url)).toThrow("resource_not_allowed"));
  it("GETs exact resources with credentials omitted and manual redirects; records actual transport, not publication", async () => {
    const t = transport();
    const result = await t.context.fetchText(adapter().definition.sourceUrl);
    expect(t.fetch).toHaveBeenCalledWith(result.url, expect.objectContaining({ method: "GET", redirect: "manual", credentials: "omit", signal: t.controller.signal }));
    expect(result.receipt).toEqual(receipt());
    t.context.consumeRows(1); t.context.assertComplete(1, 1);
    expect(() => t.validateBatchAccounting([result.receipt], 1)).not.toThrow();
  });
  it("never requests query variants or undeclared URLs", async () => {
    const t = transport();
    await expect(t.context.fetchText(`${adapter().definition.sourceUrl}?url=https://attacker.example`)).rejects.toThrow("resource_not_allowed");
    expect(t.fetch).not.toHaveBeenCalled();
  });
  it("checks redirect destinations before requesting and supports predeclared redirects", async () => {
    const a = adapter(); a.definition.resources = [...a.definition.resources, "https://publisher.example/final.csv"];
    const fetch = fakeFetch().mockImplementationOnce(async () => new Response(null, { status: 302, headers: { location: "/final.csv" } }));
    const t = transport(a, fetch);
    const result = await t.context.fetchText(a.definition.sourceUrl);
    expect(result.url).toBe(a.definition.resources[1]);
    expect(result.receipt.url).toBe(result.url);
    expect(fetch).toHaveBeenCalledTimes(2);
    const blocked = transport(a, fakeFetch().mockResolvedValue(new Response(null, { status: 302, headers: { location: "https://attacker.example/secret" } })));
    await expect(blocked.context.fetchText(a.definition.sourceUrl)).rejects.toThrow("resource_not_allowed");
    expect(blocked.fetch).toHaveBeenCalledTimes(1);
  });
  it("bounds redirect loops and page count, without nested pool deadlock", async () => {
    const a = adapter();
    const t = transport(a, fakeFetch().mockImplementation(async () => new Response(null, { status: 302, headers: { location: a.definition.sourceUrl } })));
    await expect(t.context.fetchText(a.definition.sourceUrl)).rejects.toThrow("page_limit");
    expect(t.fetch).toHaveBeenCalledTimes(CAPITAL_LIMITS.pages);
  });
  it("rejects opaque automatic redirect results and upstream HTTP errors", async () => {
    const redirected = new Response("secret"); Object.defineProperty(redirected, "url", { value: "https://attacker.example/data" });
    const t = transport(adapter(), fakeFetch().mockResolvedValue(redirected));
    await expect(t.context.fetchText(adapter().definition.sourceUrl)).rejects.toThrow("resource_not_allowed");
    const bad = transport(adapter(), fakeFetch().mockResolvedValue(new Response("secret credentials", { status: 500 })));
    await expect(bad.context.fetchText(adapter().definition.sourceUrl)).rejects.toThrow("upstream_http");
    expect(safeFailure(new Error("secret credentials"))).toBe("upstream_failed");
  });
  it("bounds decoded streaming bytes even when Content-Length lies, and cancels the body", async () => {
    let cancelled = false;
    const response = new Response(new ReadableStream<Uint8Array>({
      start(c) { c.enqueue(new Uint8Array(CAPITAL_LIMITS.responseBytes + 1)); },
      cancel() { cancelled = true; },
    }), { headers: { "content-length": "1" } });
    const t = transport(adapter(), fakeFetch().mockResolvedValue(response));
    await expect(t.context.fetchText(adapter().definition.sourceUrl)).rejects.toThrow("response_byte_limit");
    expect(cancelled).toBe(true); expect(t.receipts).toEqual([]);
  });
  it("rejects oversized declared bodies and invalid UTF-8", async () => {
    const a = adapter();
    const declared = transport(a, fakeFetch().mockResolvedValue(new Response("small", { headers: { "content-length": String(CAPITAL_LIMITS.responseBytes + 1) } })));
    await expect(declared.context.fetchText(a.definition.sourceUrl)).rejects.toThrow("response_byte_limit");
    const malformed = transport(a, fakeFetch().mockResolvedValue(new Response(new Uint8Array([0xc3, 0x28]))));
    await expect(malformed.context.fetchText(a.definition.sourceUrl)).rejects.toThrow();
    expect(malformed.receipts).toEqual([]);
  });
  it("measures decoded UTF-8 bytes, not JavaScript string length", async () => {
    const t = transport(adapter(), fakeFetch().mockResolvedValue(new Response("€\u{10400}")));
    const response = await t.context.fetchText(adapter().definition.sourceUrl);
    expect(response.receipt.decodedBytes).toBe(7); expect(response.text.length).toBe(3);
  });
  it("enforces aggregate adapter bytes separately from each response", async () => {
    const a = adapter();
    const t = transport(a, fakeFetch().mockImplementation(async () => new Response(new Uint8Array(CAPITAL_LIMITS.responseBytes))));
    await t.context.fetchText(a.definition.sourceUrl); await t.context.fetchText(a.definition.sourceUrl);
    await expect(t.context.fetchText(a.definition.sourceUrl)).rejects.toThrow("adapter_byte_limit");
    expect(t.receipts).toHaveLength(2);
  });
  it("charges every parsed row, requires final completeness assertion, allows an explicit bounded selection", async () => {
    const t = transport(); const result = await t.context.fetchText(adapter().definition.sourceUrl);
    t.context.consumeRows(1_000); // Includes rows filtered out before selecting the latest 120.
    t.context.assertComplete(120, 120);
    expect(() => t.validateBatchAccounting([result.receipt], 180)).not.toThrow(); // Derived rows may exceed selected inputs.
    t.context.consumeRows(1);
    expect(() => t.validateBatchAccounting([result.receipt], 1)).toThrow("incomplete_batch");
    t.context.assertComplete(1_001, 1_001);
    expect(() => t.validateBatchAccounting([result.receipt], 1)).not.toThrow();
    expect(() => t.context.assertComplete(120, 121)).toThrow("incomplete_batch");
    expect(() => t.context.assertComplete(1_002, 1_002)).toThrow("incomplete_batch");
  });
  it("accepts explicit complete unpaginated response accounting without claiming a publisher history total", async () => {
    const t = transport(adapter(), fakeFetch().mockResolvedValue(new Response("period,value\n2026-07,1\n2026-08,2\n")));
    const result = await t.context.fetchText(adapter().definition.sourceUrl);
    t.context.consumeRows(2);
    expect(() => t.validateBatchAccounting([result.receipt], 2)).toThrow("incomplete_batch");
    t.context.assertComplete(2, 2); // Two complete selected CSV records, not the publisher's entire history.
    expect(() => t.validateBatchAccounting([result.receipt], 2)).not.toThrow();
  });
  it.each([-1, 0.5, NaN, Infinity, CAPITAL_LIMITS.rows + 1])("rejects invalid parsed row count %s", count => {
    expect(() => transport().context.consumeRows(count)).toThrow("row_limit");
  });
  it("rejects invented, omitted, changed or unused transport receipts", async () => {
    const t = transport(); const response = await t.context.fetchText(adapter().definition.sourceUrl);
    t.context.consumeRows(1); t.context.assertComplete(1, 1);
    expect(() => t.validateBatchAccounting([], 1)).toThrow("invalid_batch");
    expect(() => t.validateBatchAccounting([{ ...response.receipt, retrievedAt: "2026-09-09T13:00:00Z" }], 1)).toThrow("invalid_batch");
    expect(() => t.validateBatchAccounting([response.receipt, response.receipt], 1)).toThrow("invalid_batch");
    const unused = transport(); unused.context.consumeRows(0); unused.context.assertComplete(0, 0);
    expect(() => unused.validateBatchAccounting([], 0)).toThrow("invalid_batch");
  });
  it("authenticates receipts as a one-to-one multiset when parallel requests finish in reverse order", async () => {
    const a = adapter(); const second = "https://publisher.example/second.csv";
    a.definition.resources = [a.definition.sourceUrl, second]; let release!: () => void;
    const fetch = fakeFetch().mockImplementation(async url => {
      if (url === a.definition.sourceUrl) await new Promise<void>(resolve => { release = resolve; });
      return new Response("fixture");
    });
    const t = transport(a, fetch);
    const pendingFirst = t.context.fetchText(a.definition.sourceUrl), pendingSecond = t.context.fetchText(second);
    const b = await pendingSecond; release(); const first = await pendingFirst;
    expect(t.receipts.map(r => r.url)).toEqual([second, a.definition.sourceUrl]);
    t.context.consumeRows(2); t.context.assertComplete(2, 2);
    expect(() => t.validateBatchAccounting([first.receipt, b.receipt], 2)).not.toThrow();
    const reorderedKeys = Object.fromEntries(Object.entries(first.receipt).reverse()) as unknown as TransportReceipt;
    expect(() => t.validateBatchAccounting([reorderedKeys, b.receipt], 2)).not.toThrow();
    for (const invalid of [[first.receipt, first.receipt], [first.receipt],
      [first.receipt, { ...b.receipt, decodedBytes: 99 }], [first.receipt, { ...b.receipt, extra: "tampered" }]]) {
      expect(() => t.validateBatchAccounting(invalid, 2)).toThrow("invalid_batch");
    }
  });
  it("does not let an adapter rewrite the actual receipt baseline through an alias", async () => {
    const t = transport(); const result = await t.context.fetchText(adapter().definition.sourceUrl);
    const original = structuredClone(result.receipt);
    try { result.receipt.retrievedAt = "2030-01-01T00:00:00.000Z"; } catch { /* Frozen receipts reject writes. */ }
    expect(t.receipts).toEqual([original]);
  });
  it("rechecks rights before requests and after bodies complete", async () => {
    const a = adapter(); const t = transport(a); t.revoke();
    await expect(t.context.fetchText(a.definition.sourceUrl)).rejects.toThrow("rights_withheld");
    expect(t.fetch).not.toHaveBeenCalled();
    const during = transport(a);
    during.fetch.mockImplementationOnce(async () => { during.revoke(); return new Response("secret"); });
    await expect(during.context.fetchText(a.definition.sourceUrl)).rejects.toThrow("rights_withheld");
    expect(during.receipts).toEqual([]);
  });
  it("limits actual concurrent work to three even when timed-out work ignores abort", async () => {
    const pool = createRequestPool(); pools.push(pool);
    const control = new AbortController(); controllers.push(control);
    const release: (() => void)[] = [];
    let active = 0, peak = 0;
    const work = () => new Promise<void>(resolve => { peak = Math.max(peak, ++active); release.push(() => { active--; resolve(); }); });
    const old = Array.from({ length: 5 }, () => pool.run(control.signal, work).catch(e => e));
    await Promise.resolve(); expect(active).toBe(3);
    control.abort(); await Promise.all(old);
    const next = new AbortController(); controllers.push(next);
    const pending = pool.run(next.signal, work);
    await Promise.resolve(); expect(release).toHaveLength(3);
    release.shift()!(); await new Promise(resolve => setTimeout(resolve, 0));
    expect(active).toBe(3); expect(peak).toBe(3);
    release.splice(0).forEach(done => done()); await pending;
  });
  it("aborts queued requests without starting them and handles late rejections", async () => {
    const controller = new AbortController(); controller.abort();
    await expect(abortable(Promise.reject(new Error("late")), controller.signal)).rejects.toThrow("aborted");
    const pool = createRequestPool(); pools.push(pool); const work = vi.fn(async () => 1);
    await expect(pool.run(controller.signal, work)).rejects.toThrow("aborted");
    pool.dispose(); await expect(pool.run(new AbortController().signal, work)).rejects.toThrow("aborted");
    expect(work).not.toHaveBeenCalled();
  });
});

describe("atomic whitelisted batch normalization", () => {
  it("preserves exact scientific lexemes, publisher flags and null publication time; drops undeclared fields", () => {
    const a = adapter(); const input = batch(a);
    input.observations[0]!.value = nativeValue("+001.2300e+3", UNIT);
    for (const value of [input, input.observations[0], input.observations[0]!.period, input.observations[0]!.value, input.observations[0]!.receipt, input.receipts[0]]) {
      Object.assign(value!, { secret: "must not serialize" });
    }
    const result = validateSourceBatch(a, input);
    expect(result.observations[0]).toMatchObject({ estimated: true, provisional: true, revised: true, publisherStatus: "E", publisherConfidentiality: "F", value: { publisherLexeme: "+001.2300e+3" }, receipt: { publicationAt: null } });
    expect(JSON.stringify(result)).not.toContain("secret");
    input.observations[0]!.receipt.limitations.push("late mutation");
    expect(JSON.stringify(result)).not.toContain("late mutation");
  });
  it.each(["missing", "suppressed", "notYetReported", "withdrawn"] as const)("keeps %s distinct from observed zero", status => {
    const a = adapter(); const b = batch(a); b.observations[0]!.status = status; b.observations[0]!.value = null;
    expect(validateSourceBatch(a, b).observations[0]).toMatchObject({ status, value: null });
    b.observations[0]!.value = nativeValue("0", UNIT);
    expect(() => validateSourceBatch(a, b)).toThrow("invalid_batch");
  });
  it.each([
    (b: SourceBatch) => { b.complete = false as true; },
    (b: SourceBatch) => { b.observations = []; },
    (b: SourceBatch) => { b.observations.push(structuredClone(b.observations[0]!)); },
    (b: SourceBatch) => { b.observations[0]!.seriesId = "undeclared"; },
    (b: SourceBatch) => { b.observations[0]!.value!.raw = "1"; },
    (b: SourceBatch) => { b.observations[0]!.value!.decimal = "1"; },
    (b: SourceBatch) => { b.observations[0]!.value!.unitMultiplier = "1"; },
    (b: SourceBatch) => { b.observations[0]!.value = null; },
    (b: SourceBatch) => { b.observations[0]!.estimated = undefined as unknown as boolean; },
    (b: SourceBatch) => { b.observations[0]!.publisherStatus = undefined as unknown as null; },
    (b: SourceBatch) => { b.observations[0]!.publisherConfidentiality = "X".repeat(65); },
    (b: SourceBatch) => { b.observations[0]!.receipt.sourceId = "other"; },
    (b: SourceBatch) => { b.observations[0]!.receipt.sourceSeriesId = "other"; },
    (b: SourceBatch) => { b.observations[0]!.receipt.datasetId = "other"; },
    (b: SourceBatch) => { b.observations[0]!.receipt.retrievedAt = "2026-09-09T13:00:00Z"; },
    (b: SourceBatch) => { b.observations[0]!.receipt.publicationAt = "2026-09-09"; },
    (b: SourceBatch) => { b.observations[0]!.receipt.publicationAt = "2026-02-30T12:00:00Z"; },
    (b: SourceBatch) => { b.receipts[0]!.retrievedAt = b.observations[0]!.receipt.retrievedAt = "2026-02-30T12:00:00Z"; },
    (b: SourceBatch) => { b.observations[0]!.receipt.inputObservationIds = ["hidden"]; },
    (b: SourceBatch) => { b.receipts[0]!.url = "https://attacker.example/data"; },
    (b: SourceBatch) => { b.receipts[0]!.decodedBytes = CAPITAL_LIMITS.responseBytes + 1; },
  ])("rejects invalid or incomplete batches without repairing them %#", mutate => {
    const a = adapter(); const b = batch(a); mutate(b);
    expect(() => validateSourceBatch(a, b)).toThrow();
  });
  it("bounds selected per-series history and full normalized input bytes", () => {
    const a = adapter(); const b = batch(a); const d = a.series[0]!;
    b.observations = Array.from({ length: HISTORY_LIMIT.monthly + 1 }, (_, i) => observation(d, b.receipts[0], "1", `${2026 - Math.floor(i / 12)}-${String(12 - i % 12).padStart(2, "0")}`));
    expect(() => validateSourceBatch(a, b)).toThrow("row_limit");
    const oversized = batch(a); Object.assign(oversized, { padding: "x".repeat(CAPITAL_LIMITS.normalizedBytes) });
    expect(() => validateSourceBatch(a, oversized)).toThrow("normalized_byte_limit");
  });
  function derived() {
    const a = adapter(); const gross = a.series[0]!;
    const redemptions: SeriesDefinition = { ...gross, id: "redemptions", sourceSeriesId: "REDEEM", metricKind: "redemptions" };
    const net: SeriesDefinition = { ...gross, id: "net", sourceSeriesId: "NET", metricKind: "netIssuance" };
    a.series = [gross, redemptions, net];
    const b = batch(a);
    b.observations[0]!.value = nativeValue("9007199254740993.0001", UNIT);
    b.observations[1]!.value = nativeValue("9007199254740994", UNIT);
    b.observations[2]!.value = nativeValue("-0.9999", UNIT);
    b.observations[2]!.receipt.method = "derivedCompatibleComponents";
    b.observations[2]!.receipt.inputObservationIds = b.observations.slice(0, 2).map(o => o.id);
    return { a, b };
  }
  it.each(["missing", "suppressed", "notYetReported", "withdrawn"] as const)("accepts null compatible nets with a %s leg, but never fabricates a value or reason", status => {
    for (const side of [0, 1]) {
      const { a, b } = derived(); const input = b.observations[side]!, net = b.observations[2]!;
      input.status = status; input.value = null; net.status = status; net.value = null;
      expect(() => validateSourceBatch(a, b)).not.toThrow();
      net.status = "missing"; // Generic unavailable arithmetic is also honest; exact reasons remain on the input IDs.
      expect(() => validateSourceBatch(a, b)).not.toThrow();
      input.completeness = "unknown"; net.completeness = "unknown";
      expect(() => validateSourceBatch(a, b)).not.toThrow();
      net.status = status === "withdrawn" ? "suppressed" : "withdrawn";
      expect(() => validateSourceBatch(a, b)).toThrow("invalid_batch");
      net.status = "observed"; net.value = nativeValue("-0.9999", UNIT);
      expect(() => validateSourceBatch(a, b)).toThrow("invalid_batch");
      net.status = "missing"; net.value = null; input.value = nativeValue("123", UNIT);
      expect(() => validateSourceBatch(a, b)).toThrow("invalid_batch"); // Suppressed/missing input numerics cannot be hidden inside a null net.
    }
  });
  it("rejects unsupported null nets when both compatible inputs are observed", () => {
    const { a, b } = derived(); b.observations[2]!.status = "missing"; b.observations[2]!.value = null;
    expect(() => validateSourceBatch(a, b)).toThrow("invalid_batch");
  });
  it.each(["period", "geography", "unit", "perspective", "instrument", "valuation", "annualization", "inputs", "metricKind"])("still rejects %s incompatibility when a derived net is null", field => {
    const { a, b } = derived();
    b.observations[0]!.status = "suppressed"; b.observations[0]!.value = null;
    b.observations[2]!.status = "missing"; b.observations[2]!.value = null;
    if (field === "period") b.observations[1]!.period = reportingPeriod("monthly", "2026-07");
    else if (field === "inputs") b.observations[2]!.receipt.inputObservationIds[0] = "hidden-suppressed-input";
    else if (field === "geography") a.series[1]!.geography = { ...a.series[1]!.geography, issuer: { code: "US", label: "United States" } };
    else if (field === "unit") { a.series[1]!.unit = { currency: "USD", exponent: 6, label: "million USD" }; b.observations[1]!.value = nativeValue("9007199254740994", a.series[1]!.unit); }
    else Object.assign(a.series[1]!, { [field]: "incompatible" });
    expect(() => validateSourceBatch(a, b)).toThrow("invalid_batch");
  });
  it.each(["missing", "suppressed", "notYetReported", "withdrawn"] as const)("atomically replaces an older numeric net with a successful %s-input batch, never a fallback", async status => {
    let now = AT, missing = false, rights = { ...RIGHTS }; const { a, b } = derived();
    a.load = async context => {
      const response = await context.fetchText(a.definition.sourceUrl); const result = structuredClone(b);
      result.receipts = [response.receipt];
      for (const o of result.observations) { o.receipt.resourceUrl = response.url; o.receipt.retrievedAt = response.receipt.retrievedAt; }
      if (missing) {
        result.observations[0]!.status = status; result.observations[0]!.value = null;
        result.observations[2]!.status = "missing"; result.observations[2]!.value = null;
      }
      context.consumeRows(2); context.assertComplete(2, 2);
      return result;
    };
    const c = cache([a], { now: () => now, rights: () => rights }); const first = await settle(c);
    expect(first.snapshot.series.find(s => s.definition.id === "net")!.history[0]!.value!.decimal).toBe("-0.9999");
    missing = true; now += sourceTtlMs("monthly"); const next = await settle(c);
    expect(next.snapshot.sources[0]).toMatchObject({ retrievalState: "current", failure: null, lastSuccessAt: new Date(now).toISOString() });
    expect(next.snapshot.series.find(s => s.definition.id === "net")!.history[0]).toMatchObject({ status: "missing", value: null });
    expect(next.snapshot.sources[0]!.receipts[0]!.retrievedAt).toBe(new Date(now).toISOString());
    rights = { ...RIGHTS, status: "restricted" }; const withheld = await c.read();
    expect(withheld.snapshot.series.every(s => s.history.length === 0)).toBe(true);
    expect(withheld.snapshot.sources[0]).toMatchObject({ retrievalState: "rightsWithheld", receipts: [] });
  });
  it("checks exact compatible gross-minus-redemption arithmetic without summing across dates", () => {
    const { a, b } = derived(); expect(() => validateSourceBatch(a, b)).not.toThrow();
    b.observations[2]!.value = nativeValue("-1", UNIT);
    expect(() => validateSourceBatch(a, b)).toThrow("invalid_batch");
  });
  it.each(["period", "geography", "unit", "perspective", "instrument", "valuation", "annualization", "completeness", "inputs"])("rejects incompatible derivation %s", field => {
    const { a, b } = derived();
    if (field === "period") b.observations[1]!.period = reportingPeriod("monthly", "2026-07");
    else if (field === "completeness") b.observations[1]!.completeness = "partial";
    else if (field === "inputs") b.observations[2]!.receipt.inputObservationIds[1] = "hidden";
    else if (field === "geography") a.series[1]!.geography = { ...a.series[1]!.geography, issuer: { code: "US", label: "United States" } };
    else if (field === "unit") { a.series[1]!.unit = { currency: "USD", exponent: 6, label: "million USD" }; b.observations[1]!.value = nativeValue("9007199254740994", a.series[1]!.unit); }
    else Object.assign(a.series[1]!, { [field]: "incompatible" });
    expect(() => validateSourceBatch(a, b)).toThrow("invalid_batch");
  });
});

describe("bounded source-aware RAM cache", () => {
  it("keeps retrieval freshness separate from reporting currentness and preserves rights/flags", async () => {
    const a = adapter(); const original = a.load;
    a.load = async context => { const b = await original(context); b.observations[0]!.period = reportingPeriod("monthly", "2020-01"); return b; };
    Object.assign(a.definition, { secret: "do not serialize" }); Object.assign(a.series[0]!, { secret: "do not serialize" });
    const c = cache([a]); const d = await settle(c);
    expect(d.snapshot).toMatchObject({ schema: CAPITAL_FLOWS_SCHEMA, scope: "selectedPublisherReportedFlows", historyPolicy: "latestRevisedPublisherHistoryNotVintageArchive",
      refresh: { health: "available", launchReadiness: "notAssessed" }, sources: [{ retrievalState: "current", definition: { rights: RIGHTS } }],
      series: [{ reportingRecency: "expectation_unknown", history: [{ estimated: true, publisherStatus: "E", publisherConfidentiality: "F", receipt: { publicationAt: null } }] }] });
    expect(d.serialized).not.toContain("secret");
    expect(d.snapshot.coverage.find(x => x.id === "DE")!.state).toBe("scopedData");
    expect(d.snapshot.coverage.find(x => x.id === "US")!.state).toBe("unavailable");
    expect(d.snapshot.coverage.find(x => x.id === "crypto")!.state).toBe("unavailable");
  });
  it("holds stable bytes/ETag/generatedAt while only delivery age changes and returns detached objects", async () => {
    let now = AT; const c = cache([adapter()], { now: () => now }); const first = await settle(c);
    first.snapshot.series[0]!.history[0]!.value!.raw = "corrupted";
    first.snapshot.sources[0]!.definition.rights.status = "restricted";
    now += 65_000; const second = await c.read();
    expect(second.serialized).toBe(first.serialized); expect(second.etag).toBe(first.etag); expect(second.storedAt).toBe(AT); expect(second.deliveredAt).toBe(now);
    expect(second.etag).toBe(`W/"sha256-${createHash("sha256").update(second.serialized).digest("base64url")}"`);
    expect(second.snapshot.series[0]!.history[0]!.value!.raw).not.toBe("corrupted");
    expect(second.snapshot.sources[0]!.definition.rights.status).toBe("allowed");
  });
  it("preserves the entire original batch and original receipt times on malformed refresh; respects backoff", async () => {
    let now = AT; const a = adapter(); const load = a.load; let fail = false;
    a.load = async context => { const b = await load(context); if (fail) b.observations[0]!.value!.decimal = "fabricated"; return b; };
    const fetch = fakeFetch(); const c = cache([a], { now: () => now, fetch }); const original = await settle(c);
    fail = true; now += sourceTtlMs("monthly"); const failed = await settle(c);
    expect(failed.snapshot.series[0]!.history).toEqual(original.snapshot.series[0]!.history);
    expect(failed.snapshot.sources[0]!.receipts).toEqual(original.snapshot.sources[0]!.receipts);
    expect(failed.snapshot.sources[0]).toMatchObject({ retrievalState: "fallback", failure: "invalid_batch", lastSuccessAt: new Date(AT).toISOString(), nextAttemptAt: new Date(now + CAPITAL_LIMITS.failureBackoffMs).toISOString() });
    await Promise.all(Array.from({ length: 10 }, () => c.read())); expect(fetch).toHaveBeenCalledTimes(2);
    now += CAPITAL_LIMITS.failureBackoffMs; await settle(c);
    expect(fetch).toHaveBeenCalledTimes(3);
    expect((await c.read()).snapshot.sources[0]!.nextAttemptAt).toBe(new Date(now + CAPITAL_LIMITS.failureBackoffMs * 2).toISOString());
    fail = false; now += CAPITAL_LIMITS.failureBackoffMs * 2; const recovered = await settle(c);
    expect(recovered.snapshot.sources[0]).toMatchObject({ retrievalState: "current", failure: null, nextAttemptAt: new Date(now + sourceTtlMs("monthly")).toISOString() });
  });
  it("expires fallback at the seven-day ceiling and never persists across cache instances", async () => {
    let now = AT; const a = adapter(); const c = cache([a], { now: () => now }); await settle(c);
    a.load = async () => { throw new Error("API_KEY=secret"); }; now += CAPITAL_LIMITS.fallbackMs;
    const d = await settle(c);
    expect(d.snapshot.series[0]!.history).toEqual([]); expect(d.snapshot.sources[0]!.receipts).toEqual([]);
    expect(d.snapshot.sources[0]!.retrievalState).toBe("unavailable"); expect(d.serialized).not.toContain("API_KEY");
    expect((await settle(cache([a]))).snapshot.series[0]!.history).toEqual([]);
  });
  it.each(["unknown", "restricted"] as const)("withholds %s rights before fetch and purges earlier good values before delivery", async status => {
    let rights = { ...RIGHTS }; const fetch = fakeFetch(); const c = cache([adapter()], { rights: () => rights, fetch }); await settle(c);
    rights = { ...RIGHTS, status }; const withdrawn = await c.read();
    expect(withdrawn.snapshot.sources[0]).toMatchObject({ retrievalState: "rightsWithheld", receipts: [], lastSuccessAt: null });
    expect(withdrawn.snapshot.series[0]!.history).toEqual([]); expect(fetch).toHaveBeenCalledTimes(1);
    rights = { ...RIGHTS }; await settle(c); expect(fetch).toHaveBeenCalledTimes(2);
    const deniedFetch = fakeFetch(); await settle(cache([adapter()], { rights: () => ({ ...RIGHTS, status }), fetch: deniedFetch })); expect(deniedFetch).not.toHaveBeenCalled();
  });
  it("treats rights resolver failure as unknown on reads, never a stale-data allowance", async () => {
    let fail = false; const c = cache([adapter()], { rights: () => { if (fail) throw new Error("secret"); return RIGHTS; } }); await settle(c); fail = true;
    const d = await c.read(); expect(d.snapshot.sources[0]!.retrievalState).toBe("rightsWithheld"); expect(d.snapshot.series[0]!.history).toEqual([]);
  });
  it("rejects source batches that invent receipts or omit final row accounting", async () => {
    for (const mode of ["invent", "unaccounted"] as const) {
      const a = adapter(); a.load = async context => {
        const r = await context.fetchText(a.definition.sourceUrl); const b = batch(a);
        if (mode === "invent") { context.consumeRows(1); context.assertComplete(1, 1); b.receipts[0]!.retrievedAt = "2030-01-01T00:00:00Z"; }
        else b.receipts = [r.receipt];
        return b;
      };
      const d = await settle(cache([a]));
      expect(d.snapshot.sources[0]!.retrievalState).toBe("unavailable"); expect(d.snapshot.series[0]!.history).toEqual([]);
      expect(d.snapshot.sources[0]!.failure).toBe(mode === "invent" ? "invalid_batch" : "incomplete_batch");
    }
  });
  it("single-flights parallel reads, limits cross-source request concurrency and reports partial sources", async () => {
    const sources = Array.from({ length: 5 }, (_, i) => adapter(`source-${i}`));
    const release: (() => void)[] = []; let active = 0, peak = 0;
    const fetch = vi.fn<FetchLike>(() => new Promise(resolve => { peak = Math.max(peak, ++active); release.push(() => { active--; resolve(new Response("fixture")); }); }));
    const c = cache(sources, { fetch }); await Promise.all(Array.from({ length: 20 }, () => c.read()));
    await new Promise(resolve => setTimeout(resolve, 0)); // Let adapter and pool microtasks start, not a deadline.
    expect(fetch).toHaveBeenCalledTimes(3); expect(peak).toBe(3);
    release.splice(0).forEach(done => done()); await new Promise(resolve => setTimeout(resolve, 0));
    expect(fetch).toHaveBeenCalledTimes(5); release.splice(0).forEach(done => done()); await c.waitForIdle();
    expect((await c.read()).snapshot.refresh.health).toBe("available"); expect(peak).toBe(3);
    const bad = adapter("bad"); bad.load = async () => { throw new Error("secret"); };
    const partial = await settle(cache([adapter(), bad])); expect(partial.snapshot.refresh.health).toBe("partial");
  });
  it("cancels cooperative sibling fetches after repeated parallel-source failures and releases pool capacity", async () => {
    let now = AT, failing = true, pending = 0;
    const a = adapter(), healthy = adapter("healthy"), load = a.load;
    const sibling = "https://publisher.example/pending.csv"; a.definition.resources = [a.definition.sourceUrl, sibling];
    const signals: AbortSignal[] = [];
    a.load = async context => {
      if (!failing) return load(context);
      await Promise.all([context.fetchText(a.definition.sourceUrl), context.fetchText(sibling)]);
      throw new Error("unreachable");
    };
    const fetch = vi.fn<FetchLike>(async (url, init) => {
      if (url === sibling) return new Promise<Response>((_resolve, reject) => {
        const signal = init.signal!; signals.push(signal); pending++;
        signal.addEventListener("abort", () => { pending--; reject(new Error("cancelled")); }, { once: true });
      });
      return new Response("fixture", { status: failing && url === a.definition.sourceUrl ? 500 : 200 });
    });
    const c = cache([a, healthy], { fetch, now: () => now });
    for (let attempt = 0; attempt < 4; attempt++) {
      const d = await settle(c); await new Promise(resolve => setTimeout(resolve, 0));
      expect(d.snapshot.sources[0]!.failure).toBe("upstream_http");
      expect(pending).toBe(0); expect(signals.every(signal => signal.aborted)).toBe(true);
      expect(d.snapshot.sources[1]!.retrievalState).toBe("current");
      now = Date.parse(d.snapshot.sources[0]!.nextAttemptAt!);
    }
    expect(signals).toHaveLength(4); failing = false;
    expect((await settle(c)).snapshot.refresh.health).toBe("available");
  });
  it.each([
    ["adapter", "load", 4], ["adapter", "normalization", 5], ["adapter", "projected size", 7],
    ["refresh", "load", 4], ["refresh", "normalization", 5], ["refresh", "projected size", 7],
  ] as const)("rejects a synchronous %s deadline overrun after %s without altering last-good data", async (deadline, _stage, checkpoint) => {
    let now = AT, late = false, checks = 0;
    // Exact monotonic checkpoints, no busy wait and no yielding to timeout callbacks.
    // begin/start, then acceptance before load, after load, normalization, aggregate, projection.
    const monotonic = vi.spyOn(performance, "now").mockImplementation(() => late && ++checks >= checkpoint ? 30 : 0);
    const a = adapter(), load = a.load;
    a.load = async context => {
      const b = await load(context); if (late) b.observations[0]!.value = nativeValue("2", UNIT); return b;
    };
    const c = cache([a], { now: () => now, adapterDeadlineMs: deadline === "adapter" ? 5 : 10, refreshDeadlineMs: deadline === "refresh" ? 5 : 10 });
    const first = await settle(c); expect(first.snapshot.sources[0]!.retrievalState).toBe("current");
    now += sourceTtlMs("monthly"); late = true; checks = 0;
    const rejected = await settle(c); monotonic.mockRestore();
    expect(checks).toBe(checkpoint);
    expect(rejected.snapshot.sources[0]).toMatchObject({ retrievalState: "fallback", failure: `${deadline}_deadline`, lastSuccessAt: new Date(AT).toISOString() });
    expect(rejected.snapshot.sources[0]!.receipts).toEqual(first.snapshot.sources[0]!.receipts);
    expect(rejected.snapshot.series[0]!.history).toEqual(first.snapshot.series[0]!.history);
  });
  it.each(["adapter", "refresh"] as const)("enforces %s deadlines and rejects late results from noncooperative adapters", async deadline => {
    vi.useFakeTimers(); vi.setSystemTime(AT); const a = adapter(); const load = a.load;
    let release!: () => void;
    a.load = async context => { const b = await load(context); await new Promise<void>(resolve => { release = resolve; }); return b; };
    const c = cache([a], { now: Date.now, adapterDeadlineMs: deadline === "adapter" ? 50 : 500, refreshDeadlineMs: deadline === "refresh" ? 50 : 500 });
    await c.read(); await vi.advanceTimersByTimeAsync(51); await c.waitForIdle();
    const d = await c.read(); expect(d.snapshot.sources[0]!.failure).toBe(`${deadline}_deadline`); expect(d.snapshot.series[0]!.history).toEqual([]);
    release(); await vi.advanceTimersByTimeAsync(0); expect((await c.read()).snapshot.series[0]!.history).toEqual([]);
  });
  it("returns a cold partial response within the bounded wait and disposes active work", async () => {
    vi.useFakeTimers(); vi.setSystemTime(AT); const a = adapter(); let signal!: AbortSignal;
    a.load = context => { signal = context.signal; return new Promise(() => undefined); };
    const c = cache([a], { now: Date.now, coldWaitMs: 25, adapterDeadlineMs: 500 }); const pending = c.read();
    await vi.advanceTimersByTimeAsync(25); const d = await pending;
    expect(d.snapshot.refresh).toMatchObject({ state: "refreshing", health: "empty" });
    expect(signal.aborted).toBe(false); c.dispose(); expect(signal.aborted).toBe(true); await c.waitForIdle();
    await expect(c.read()).rejects.toThrow("aborted");
  });
  it("disposal releases a cold reader without waiting for its full deadline", async () => {
    vi.useFakeTimers(); const a = adapter(); a.load = async () => new Promise(() => undefined);
    const c = cache([a], { coldWaitMs: 1_000 }); const pending = c.read(); const rejected = expect(pending).rejects.toThrow("aborted");
    await vi.advanceTimersByTimeAsync(0); c.dispose(); await rejected; await c.waitForIdle();
  });
  function bulky(a: CapitalFlowAdapter, rows: number) {
    const original = a.load;
    a.load = async context => {
      const b = await original(context); const d = a.series[0]!;
      b.observations = Array.from({ length: rows }, (_, i) => {
        const o = observation(d, b.receipts[0], "1", `2026-${String(i + 1).padStart(2, "0")}`);
        o.receipt.limitations = Array.from({ length: 64 }, () => "x".repeat(4_096));
        return o;
      });
      context.consumeRows(rows); context.assertComplete(rows + 1, rows + 1);
      return b;
    };
  }
  it("rejects whole-source serialized overflow atomically, preserving previous good values", async () => {
    let now = AT; const a = adapter(); const c = cache([a], { now: () => now }); const before = await settle(c);
    bulky(a, 9); now += sourceTtlMs("monthly"); const after = await settle(c);
    expect(after.snapshot.sources[0]!.failure).toBe("serialized_byte_limit");
    expect(after.snapshot.series[0]!.history).toEqual(before.snapshot.series[0]!.history);
    expect(after.snapshot.sources[0]!.receipts).toEqual(before.snapshot.sources[0]!.receipts);
    expect(Buffer.byteLength(after.serialized)).toBeLessThanOrEqual(CAPITAL_LIMITS.serializedBytes);
  });
  it("checks the serialized budget across sources, never truncating a batch or response", async () => {
    const first = adapter("first"), second = adapter("second"); bulky(first, 5); bulky(second, 5);
    const d = await settle(cache([first, second]));
    expect(d.snapshot.sources.filter(s => s.failure === "serialized_byte_limit")).toHaveLength(1);
    expect(d.snapshot.series.map(s => s.history.length).sort()).toEqual([0, 5]);
    expect(d.snapshot.refresh.health).toBe("partial"); expect(Buffer.byteLength(d.serialized)).toBeLessThan(CAPITAL_LIMITS.serializedBytes);
  });
  it("returns honest empty coverage with no provider registry and rejects oversized registries/deadlines", async () => {
    const d = await settle(cache([])); expect(d.snapshot.refresh.health).toBe("empty"); expect(d.snapshot.sources).toEqual([]);
    expect(d.snapshot.coverage.every(c => c.state === "unavailable")).toBe(true);
    expect(() => cache(Array.from({ length: CAPITAL_LIMITS.sources + 1 }, (_, i) => adapter(`s${i}`)))).toThrow("registry_limit");
    expect(() => cache([adapter(), adapter()])).toThrow("invalid_registry");
    const many = adapter(); many.series = Array.from({ length: CAPITAL_LIMITS.series + 1 }, (_, i) => ({ ...series(), id: `s${i}` }));
    expect(() => cache([many])).toThrow("registry_limit");
    expect(() => cache([], { adapterDeadlineMs: CAPITAL_LIMITS.adapterMs + 1 })).toThrow("invalid_deadline");
  });
});

describe("GET/HEAD conditional capital-flows door", () => {
  it("constructs an explicitly empty test door independent of the production provider registry", async () => {
    const app = new Hono(), fetch = fakeFetch();
    const c = mountCapitalFlowsDoor(app, { adapters: [], fetch, now: () => AT, coldWaitMs: 0 }); caches.push(c);
    const response = await app.request("/v1/capital-flows"); expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ sources: [], series: [], refresh: { health: "empty" } });
    expect(fetch).not.toHaveBeenCalled();
  });
  it("serves vendor JSON, stable representation ETags, bodyless HEAD and weak/strong/list/wildcard 304", async () => {
    let now = AT; const fetch = fakeFetch(); const c = cache([adapter()], { now: () => now, fetch }); await settle(c);
    const app = new Hono(); expect(mountCapitalFlowsDoor(app, { cache: c })).toBe(c);
    const get = await app.request("/v1/capital-flows"); const body = await get.text(); const etag = get.headers.get("etag")!;
    expect(get.status).toBe(200); expect(get.headers.get("content-type")).toBe(CAPITAL_FLOWS_MEDIA_TYPE);
    expect(get.headers.get("content-length")).toBe(String(Buffer.byteLength(body))); expect(get.headers.get("cache-control")).toBe("public, max-age=0, must-revalidate");
    expect(get.headers.get("vary")).toBe("Accept"); expect(get.headers.get("x-cashloom-cache")).toBe("current");
    now += 12_345;
    const head = await app.request("/v1/capital-flows", { method: "HEAD" }); expect(head.status).toBe(200); expect(await head.text()).toBe("");
    expect(head.headers.get("etag")).toBe(etag); expect(head.headers.get("age")).toBe("12"); expect(head.headers.get("content-length")).toBe(String(Buffer.byteLength(body)));
    for (const header of [etag, etag.replace(/^W\//, ""), `"miss", ${etag}`, "*"]) {
      const notModified = await app.request("/v1/capital-flows", { headers: { "If-None-Match": header } });
      expect(notModified.status).toBe(304); expect(await notModified.text()).toBe(""); expect(notModified.headers.get("etag")).toBe(etag);
    }
    const mismatched = await app.request("/v1/capital-flows", { headers: { "If-None-Match": '"miss"' } }); expect(mismatched.status).toBe(200);
    const query = await app.request("/v1/capital-flows?refresh=true&url=https://attacker.example&pages=999"); expect(await query.text()).toBe(body); expect(fetch).toHaveBeenCalledTimes(1);
    expect((await app.request("/v1/capital-flows", { method: "POST" })).status).toBe(404);
  });
  it("rechecks rights before conditional delivery and does not return 304 for withdrawn data", async () => {
    let rights = { ...RIGHTS }; const c = cache([adapter()], { rights: () => rights }); await settle(c);
    const app = new Hono(); mountCapitalFlowsDoor(app, { cache: c });
    const first = await app.request("/v1/capital-flows"); rights = { ...RIGHTS, status: "restricted" };
    const denied = await app.request("/v1/capital-flows", { headers: { "If-None-Match": first.headers.get("etag")! } });
    expect(denied.status).toBe(200); expect(denied.headers.get("etag")).not.toBe(first.headers.get("etag"));
    expect((await denied.json()).series[0].history).toEqual([]);
  });
  it("returns a no-store sanitized 503 (and bodyless HEAD) on delivery failure", async () => {
    const c = cache([]); c.dispose(); const app = new Hono(); mountCapitalFlowsDoor(app, { cache: c });
    for (const method of ["GET", "HEAD"]) {
      const response = await app.request("/v1/capital-flows", { method }); expect(response.status).toBe(503);
      expect(response.headers.get("cache-control")).toBe("no-store"); expect(response.headers.get("content-type")).toBe("application/problem+json");
      const body = await response.text(); if (method === "HEAD") expect(body).toBe(""); else expect(JSON.parse(body).status).toBe(503);
    }
  });
});
