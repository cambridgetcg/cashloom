import { AsyncLocalStorage } from "node:async_hooks";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { parseCsv } from "./csv.ts";
import { createEcbFundAdapter, createEcbSovereignAdapter } from "./ecb.ts";
import { CAPITAL_LIMITS, nativeValue, sourceTtlMs, type CapitalFlowAdapter, type CapitalFlowsSnapshot, type FlowObservation, type TransportReceipt } from "./model.ts";
import { createCapitalFlowsCache, validateSourceBatch } from "./snapshot.ts";
import { createAdapterTransport, createRequestPool } from "./transport.ts";

interface Replay {
  adapter: CapitalFlowAdapter;
  text: string;
  receipt: TransportReceipt;
  rows: number;
}
const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");
const encode = (rows: string[][]) => rows.map(row => row.map(cell => `"${cell.replaceAll('"', '""')}"`).join(",")).join("\r\n");
const csec = createEcbSovereignAdapter(), ivf = createEcbFundAdapter();
const [fundHeader, ...fundRows] = parseCsv(fixture("ecb-ivf-required-quarterly.csv"));
const [peHeader, ...peRows] = parseCsv(fixture("ecb-ivf-private-equity-quarterly.csv"));
// Explicit fixture assembly, not a native one-response capture. Production rejects NL.
const fundBody = encode([fundHeader!, ...fundRows, ...peRows.filter(row => row[peHeader!.indexOf("REF_AREA")] === "U2")]);
function synthetic(adapter: CapitalFlowAdapter, text: string, rows: number, retrievedAt: string): Replay {
  return { adapter, text, rows, receipt: { url: adapter.definition.resources[0]!, retrievedAt,
    lastModified: "Wed, 02 Sep 2026 09:00:00 GMT", etag: '"synthetic-fixture"', decodedBytes: Buffer.byteLength(text) } };
}
// Repository captures lack original retrieval clocks; these HTTP receipts are synthetic.
const fixtures = [
  synthetic(csec, fixture("ecb-csec-es-de-total-2026-06_2026-07.csv"), 12, "2026-09-09T16:12:34.567Z"),
  synthetic(ivf, fundBody, 28, "2026-09-09T16:12:36.789Z"),
];
const historical = synthetic(csec, fixture("ecb-csec-es-de-total-2020-12_2021-01.csv"), 12, "2026-09-09T16:12:34.567Z");
function response(replay: Replay, text = replay.text): Response {
  const headers = new Headers({ "content-type": "text/csv; charset=utf-8" });
  if (replay.receipt.lastModified !== null) headers.set("last-modified", replay.receipt.lastModified);
  if (replay.receipt.etag !== null) headers.set("etag", replay.receipt.etag);
  return new Response(text, { status: 200, headers });
}
function assertRows(replay: Replay, observations: FlowObservation[]) {
  const [header, ...rows] = parseCsv(replay.text);
  expect(rows).toHaveLength(replay.rows);
  expect(observations).toHaveLength(replay.rows);
  const at = (name: string) => header!.indexOf(name);
  const nativeRows = new Map(rows.map(row => [`${row[at("KEY")]}:${row[at("TIME_PERIOD")]}`, row]));
  for (const observation of observations) {
    const row = nativeRows.get(`${observation.receipt.sourceSeriesId}:${observation.period.label}`)!;
    expect(row).toBeDefined();
    const definition = replay.adapter.series.find(s => s.id === observation.seriesId)!;
    expect(observation.value).toEqual(nativeValue(row[at("OBS_VALUE")]!, definition.unit));
    expect(observation).toMatchObject({ status: "observed", publisherStatus: row[at("OBS_STATUS")],
      publisherConfidentiality: row[at(replay.adapter.definition.id === "ecb-csec" ? "CONF_STATUS" : "OBS_CONF")],
      provisional: row[at("OBS_STATUS")] === "P", revised: row[at("OBS_STATUS")] === "R",
      estimated: row[at("OBS_STATUS")] === "E", break: row[at("OBS_STATUS")] === "B", completeness: "unknown" });
    expect(observation.receipt).toMatchObject({ resourceUrl: replay.receipt.url, retrievedAt: replay.receipt.retrievedAt,
      publicationAt: null, method: "publisherReported", inputObservationIds: [] });
  }
}
async function throughTransport(replay: Replay) {
  const pool = createRequestPool();
  const fetch = vi.fn(async (url: string, init: RequestInit) => {
    expect(url).toBe(replay.receipt.url);
    expect(init).toMatchObject({ method: "GET", redirect: "manual", credentials: "omit" });
    return response(replay);
  });
  const transport = createAdapterTransport({ definition: replay.adapter.definition, pool,
    signal: new AbortController().signal, fetch, now: () => Date.parse(replay.receipt.retrievedAt), rightsAllowed: () => true });
  try {
    const batch = await replay.adapter.load(transport.context);
    expect(() => transport.validateBatchAccounting(batch.receipts, batch.observations.length)).not.toThrow();
    expect(batch.receipts).toEqual([replay.receipt]);
    expect(batch.receipts[0]).toBe(transport.receipts[0]);
    expect(Object.isFrozen(batch.receipts[0])).toBe(true);
    expect(validateSourceBatch(replay.adapter, batch)).toEqual(batch);
    assertRows(replay, batch.observations);
    expect(fetch).toHaveBeenCalledTimes(1);
    return batch;
  } finally { pool.dispose(); }
}
function replayCache(replays: Replay[]) {
  // Replay each recorded retrieval clock through real transport, including concurrent
  // source loads. Never replace/mutate its receipts or label replay time as publication.
  const receiptClock = new AsyncLocalStorage<number>();
  let now = Math.max(...replays.map(replay => Date.parse(replay.receipt.retrievedAt)));
  const bodies = new Map(replays.map(replay => [replay.receipt.url, replay.text]));
  const fetch = vi.fn(async (url: string, init: RequestInit) => {
    const replay = replays.find(replay => replay.receipt.url === url);
    if (!replay) throw new Error("unexpected_offline_resource"); // No network fallback.
    expect(init).toMatchObject({ method: "GET", redirect: "manual", credentials: "omit" });
    return response(replay, bodies.get(url)!);
  });
  const adapters = replays.map(replay => ({ ...replay.adapter,
    load: (ctx: Parameters<CapitalFlowAdapter["load"]>[0]) => receiptClock.run(Date.parse(replay.receipt.retrievedAt), () => replay.adapter.load(ctx)),
  }));
  const cache = createCapitalFlowsCache(adapters, { fetch, now: () => receiptClock.getStore() ?? now });
  return { cache, fetch, bodies, advance: (ms: number) => { now += ms; } };
}
function assertSnapshot(snapshot: CapitalFlowsSnapshot, replays: Replay[]) {
  expect(snapshot.refresh).toEqual({ state: "idle", health: "available", launchReadiness: "notAssessed" });
  expect(snapshot.sources).toHaveLength(replays.length);
  expect(snapshot.series).toHaveLength(replays.reduce((sum, replay) => sum + replay.adapter.series.length, 0));
  for (const replay of replays) {
    const source = snapshot.sources.find(source => source.definition.id === replay.adapter.definition.id)!;
    expect(source).toMatchObject({ retrievalState: "current", failure: null, receipts: [replay.receipt] });
    const series = snapshot.series.filter(series => series.definition.sourceId === replay.adapter.definition.id);
    expect(series.every(series => series.state === "current")).toBe(true);
    assertRows(replay, series.flatMap(series => series.history));
  }
}
const latestValues: Record<string, string> = {
  "ecb-csec-es-issuance": "21402.775", "ecb-csec-es-redemptions": "33628.396", "ecb-csec-es-netIssuance": "-12225.621",
  "ecb-csec-de-issuance": "50845.493", "ecb-csec-de-redemptions": "14058.9235", "ecb-csec-de-netIssuance": "36786.5695",
  "ecb-ivf-equities": "83854.69386896017", "ecb-ivf-bonds": "65306.18036389985",
  "ecb-ivf-realEstate": "26.156910720004618", "ecb-ivf-privateEquity": "903.0999503100106",
};
function assertLatest(snapshot: CapitalFlowsSnapshot) {
  expect(snapshot.series).toHaveLength(10);
  for (const series of snapshot.series) {
    const latest = series.history.at(-1)!;
    expect(latest.period.label).toBe(series.definition.datasetId === "CSEC" ? "2026-07" : "2026-Q2");
    expect(latest.value).toEqual(nativeValue(latestValues[series.definition.id]!, series.definition.unit));
    expect(latest).toMatchObject({ provisional: true, publisherStatus: "P", publisherConfidentiality: "F", completeness: "unknown" });
    expect(latest.receipt.publicationAt).toBeNull();
  }
}

describe("ECB offline real transport/cache integration (repository fixtures, synthetic HTTP metadata)", () => {
  it.each([...fixtures, historical].map((replay, index) => [index, replay] as const))("accepts fully accounted fixture %i with original transport receipt identity", async (_index, replay) => {
    await throughTransport(replay);
  });
  it("commits both selected baskets atomically and retains all ten exact latest values", async () => {
    const { cache, fetch } = replayCache(fixtures);
    try {
      await cache.read(); await cache.waitForIdle();
      const delivery = await cache.read();
      expect(delivery.cacheState).toBe("current");
      assertSnapshot(delivery.snapshot, fixtures);
      assertLatest(delivery.snapshot);
      expect(JSON.parse(delivery.serialized)).toEqual(delivery.snapshot);
      expect(fetch).toHaveBeenCalledTimes(2);
    } finally { cache.dispose(); }
  });
  it("still rejects both legacy adapters when the final accounting assertion is omitted", async () => {
    const unasserted = fixtures.map(replay => ({ ...replay, adapter: { ...replay.adapter,
      load: (ctx: Parameters<CapitalFlowAdapter["load"]>[0]) => replay.adapter.load({ ...ctx, assertComplete: () => undefined }),
    } }));
    const { cache, fetch } = replayCache(unasserted);
    try {
      await cache.read(); await cache.waitForIdle();
      const { snapshot } = await cache.read();
      expect(snapshot.sources.map(source => source.failure)).toEqual(["incomplete_batch", "incomplete_batch"]);
      expect(snapshot.sources.every(source => source.retrievalState === "unavailable" && source.receipts.length === 0)).toBe(true);
      expect(snapshot.series.every(series => series.history.length === 0)).toBe(true);
      expect(fetch).toHaveBeenCalledTimes(2);
    } finally { cache.dispose(); }
  });
  it("preserves last-good histories and receipts when the next selected bodies are incomplete", async () => {
    const { cache, bodies, advance, fetch } = replayCache(fixtures);
    try {
      await cache.read(); await cache.waitForIdle();
      const before = (await cache.read()).snapshot;
      for (const replay of fixtures) bodies.set(replay.receipt.url, encode([parseCsv(replay.text)[0]!]));
      advance(sourceTtlMs("monthly"));
      await cache.read(); await cache.waitForIdle();
      const after = await cache.read();
      expect(after.cacheState).toBe("fallback");
      expect(after.snapshot.series.map(series => series.history)).toEqual(before.series.map(series => series.history));
      expect(after.snapshot.sources.map(source => source.receipts)).toEqual(before.sources.map(source => source.receipts));
      expect(after.snapshot.sources.map(source => source.lastSuccessAt)).toEqual(before.sources.map(source => source.lastSuccessAt));
      expect(after.snapshot.sources.every(source => source.retrievalState === "fallback" && source.failure !== null)).toBe(true);
      expect(fetch).toHaveBeenCalledTimes(4);
    } finally { cache.dispose(); }
  });
});

// Optional, finite replay of previously saved public bodies and receipt JSON; never fetch.
// Set CASHLOOM_ECB_REPLAY_DIR to their directory. No permanent test depends on a /tmp path.
const replayDirectory = process.env.CASHLOOM_ECB_REPLAY_DIR;
describe.runIf(Boolean(replayDirectory))("ECB saved rolling public-response offline replay (original HTTP metadata)", () => {
  it("accepts 144 CSEC + 80 IVF observations through real accounting, normalization and cache", async () => {
    const replays = ([[createEcbSovereignAdapter(), "ecb-csec", 144], [createEcbFundAdapter(), "ecb-ivf", 80]] as const).map(([adapter, prefix, rows]) => {
      const text = readFileSync(join(replayDirectory!, `${prefix}-rolling-live.csv`), "utf8");
      const receipt = JSON.parse(readFileSync(join(replayDirectory!, `${prefix}-rolling-receipt.json`), "utf8")) as TransportReceipt;
      const replay = { adapter, text, receipt, rows };
      expect(receipt.url).toBe(replay.adapter.definition.resources[0]);
      expect(receipt.decodedBytes).toBe(Buffer.byteLength(text));
      return replay;
    });
    const batches = await Promise.all(replays.map(throughTransport));
    expect(batches.map(batch => batch.observations.length)).toEqual([144, 80]);
    expect(Buffer.byteLength(JSON.stringify(batches))).toBeLessThan(CAPITAL_LIMITS.normalizedBytes);
    const { cache, fetch } = replayCache(replays);
    try {
      await cache.read(); await cache.waitForIdle();
      const delivery = await cache.read();
      expect(delivery.cacheState).toBe("current");
      assertSnapshot(delivery.snapshot, replays);
      assertLatest(delivery.snapshot);
      expect(delivery.snapshot.series.reduce((sum, series) => sum + series.history.length, 0)).toBe(224);
      for (const series of delivery.snapshot.series) expect(series.history).toHaveLength(series.definition.datasetId === "CSEC" ? 24 : 20);
      expect(JSON.parse(delivery.serialized)).toEqual(delivery.snapshot);
      expect(Buffer.byteLength(delivery.serialized)).toBeLessThan(CAPITAL_LIMITS.serializedBytes);
      expect(fetch).toHaveBeenCalledTimes(2);
    } finally { cache.dispose(); }
  });
});
