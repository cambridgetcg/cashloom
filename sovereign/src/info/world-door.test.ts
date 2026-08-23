import { describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { makeFact } from "./money-fact.ts";
import {
  NY_FED_AFFILIATION_NOTICE,
  NY_FED_REFERENCE_RATE_NOTICE,
  parseNyFedReferenceRatesCsv,
} from "./cash-rates.ts";
import { parseFedMonetaryPolicyRss } from "./fed-announcements.ts";
import type {
  MacroEvent,
  MacroObservation,
  MacroSnapshot,
  MacroSource,
} from "./macro-sources.ts";
import type { FxFact } from "./fx.ts";
import type { OracleResult, PriceFeed } from "./price.ts";
import {
  businessDaysSinceDate,
  buildWorldSnapshot,
  createWorldSnapshotCache,
  mountWorldDoor,
  percentSpreadBps,
  WORLD_CACHE_FAILURE_BACKOFF_MS,
  WORLD_CACHE_FRESH_MS,
  WORLD_CACHE_STALE_WINDOW_MS,
  WORLD_CACHE_UNAVAILABLE_MS,
  type WorldDeps,
  type WorldSnapshot,
} from "./world-door.ts";

const NOW = new Date("2026-08-20T12:00:00.000Z");

const macroSource: MacroSource = {
  id: "bis_policy_rates",
  publisher: "Official Test Authority",
  title: "Official observations",
  url: "https://example.test/data",
  landing_page_url: "https://example.test",
  methodology_url: "https://example.test/method",
  licence: {
    class: "attribution-required",
    terms_url: "https://example.test/terms",
    attribution: "Source: Official Test Authority",
    redistribution_note: "Fixture observations may be displayed with attribution.",
  },
  fetched_at: NOW.toISOString(),
  published_at: "2026-08-20T09:00:00.000Z",
  published_at_status: "reported",
};

function observation(
  id: string,
  indicator: MacroObservation["indicator"],
  value: string,
  maturity?: MacroObservation["maturity"],
): MacroObservation {
  return {
    "@type": "MacroObservation",
    schema: "cashloom.macro-observation/1",
    id,
    indicator,
    jurisdiction: "US",
    jurisdiction_name: "United States",
    institution: indicator === "central_bank_policy_rate" ? "Federal Reserve" : "US Treasury",
    series_key: id,
    label: indicator === "central_bank_policy_rate" ? "Federal funds target rate" : `Treasury ${maturity}`,
    ...(maturity ? { maturity } : {}),
    value,
    unit: "percent_per_annum",
    method: "official_observation",
    observed_at: "2026-08-19",
    temporal_precision: "date",
    published_at: "2026-08-20T09:00:00.000Z",
    fetched_at: NOW.toISOString(),
    cadence: indicator === "central_bank_policy_rate" ? "daily_values_weekly_release" : "business_daily",
    reference: {
      kind: indicator === "central_bank_policy_rate" ? "policy_rate" : "par_yield",
      authority: indicator === "central_bank_policy_rate" ? "official_aggregator" : "official",
      is_live: false,
      frequency: indicator === "central_bank_policy_rate" ? "daily_values_weekly_release" : "business_daily",
      delay: indicator === "central_bank_policy_rate" ? "weekly_batch" : "end_of_day",
      temporal_precision: "date",
      note: "Not a live or executable quote.",
    },
    source: macroSource,
  };
}

const meeting: MacroEvent = {
  "@type": "MacroEvent",
  schema: "cashloom.macro-event/1",
  id: "fed-2026-09",
  category: "central_bank_meeting",
  jurisdiction: "US",
  jurisdiction_name: "United States",
  institution: "Federal Reserve",
  institution_code: "FED",
  title: "FOMC meeting",
  starts_on: "2026-09-15",
  ends_on: "2026-09-16",
  decision_on: "2026-09-16",
  time_status: "not_announced",
  projection_release: true,
  schedule_status: "confirmed",
  published_at: "2025-08-01T00:00:00.000Z",
  fetched_at: NOW.toISOString(),
  source: macroSource,
};

const macroSnapshot = {
  "@type": "MacroSnapshot",
  schema: "cashloom.macro-snapshot/1",
  generated_at: NOW.toISOString(),
  status: "ok",
  complete: true,
  policy: [observation("policy-us", "central_bank_policy_rate", "5.25")],
  sovereigns: [
    observation("ust-2y", "sovereign_yield", "4.20", "2Y"),
    observation("ust-10y", "sovereign_yield", "4.45", "10Y"),
  ],
  calendar: [meeting],
  sources: [],
  warnings: [],
  failures: [],
} as MacroSnapshot;

const cashBatch = parseNyFedReferenceRatesCsv(
  `Effective Date,Rate Type,Rate (%)
08/19/2026,EFFR,3.63
08/19/2026,SOFR,3.62
`,
  { fetchedAt: NOW.toISOString(), sourceUrl: "https://example.test/ny-fed.csv" },
);

const announcementBatch = parseFedMonetaryPolicyRss(
  `<rss><channel><item><title>Minutes of the Federal Open Market Committee, July 28–29, 2026</title><link>https://www.federalreserve.gov/newsevents/pressreleases/monetary20260819a.htm</link><pubDate>Wed, 19 Aug 2026 18:00:00 GMT</pubDate></item></channel></rss>`,
  { fetchedAt: NOW.toISOString() },
);

function fakeFx(base: string, quote: string): Promise<FxFact> {
  return Promise.resolve({
    base: base.toUpperCase(),
    quote: quote.toUpperCase(),
    valueScaled: quote.toUpperCase() === "GBP" ? "80000000" : "100000000",
    decimals: 8,
    method: base.toUpperCase() === "EUR" ? "observed" : "derived",
    proof_state: base.toUpperCase() === "EUR" ? "asserted" : "tested",
    recompute: { how: "fixture ECB cross" },
    refDate: "2026-08-19",
    fetchedAt: NOW.toISOString(),
    sourceUrl: "https://example.test/ecb-fx",
  });
}

function price(feed: PriceFeed): Promise<OracleResult> {
  const fact = makeFact({
    subject: feed.base,
    predicate: "spot_price",
    value: feed.symbol === "BTC" ? "6000000000000" : "300000000000",
    unit: "iso4217:USD",
    decimals: 8,
    plane: "public",
    method: "observed",
    proof_state: "tested",
    redistribution: "onchain-rederivable",
    sources: [{ name: `Chainlink ${feed.symbol}/USD`, url: "https://example.test/oracle", fetched_at: NOW.toISOString() }],
    observed_at: "2026-08-20T11:59:00.000Z",
    stale_after_s: feed.heartbeat_s,
    recompute: { how: "fixture oracle round" },
  });
  return Promise.resolve({ kind: "price", fact, age_s: 60, heartbeat_s: feed.heartbeat_s });
}

const btcFee = makeFact({
  subject: "bip122:test:mempool",
  predicate: "fee_per_vbyte_sat",
  value: "1250",
  unit: "bip122:test/slip44:0",
  decimals: 10,
  plane: "public",
  method: "observed",
  proof_state: "tested",
  redistribution: "onchain-rederivable",
  sources: [{ name: "esplora", url: "https://example.test/fees", fetched_at: NOW.toISOString() }],
  observed_at: NOW.toISOString(),
  stale_after_s: 60,
});

const deps: Partial<WorldDeps> = {
  now: () => NOW,
  macro: async () => macroSnapshot,
  announcements: async () => announcementBatch,
  cash: async () => cashBatch,
  fxRate: fakeFx,
  fees: async () => ({ facts: [btcFee], failed: [] }),
  price,
};

function cacheSnapshot(
  base: WorldSnapshot["base_currency"],
  generatedAt: number,
  marker: string,
  state: WorldSnapshot["status"]["state"] = "ready",
): WorldSnapshot {
  return {
    "@type": "WorldSnapshot",
    schema: "cashloom.world/1",
    generated_at: new Date(generatedAt).toISOString(),
    base_currency: base,
    status: {
      state,
      complete: state === "ready",
      available_sources: state === "unavailable" ? 0 : 1,
      total_sources: 1,
      stale_count: state === "partial" ? 1 : 0,
      unavailable: [],
    },
    briefing: [{ id: marker, key: marker, title: marker, label: marker, status: "observed", stale: false }],
    policy: [],
    sovereigns: [],
    fx: [],
    crypto: [],
    fees: [],
    energy: [],
    calendar: [],
    threads: [],
    sources: [],
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe("World snapshot", () => {
  it("composes independent official and on-chain sections with receipts", async () => {
    const world = await buildWorldSnapshot("GBP", deps);
    expect(world.schema).toBe("cashloom.world/1");
    expect(world.base_currency).toBe("GBP");
    expect(world.policy).toHaveLength(3);
    expect(world.policy.map((card) => card.symbol)).toEqual(["US", "EFFR", "SOFR"]);
    const nyFedJson = JSON.stringify(world.policy.filter((card) => card.source_id === "ny_fed_reference_rates"));
    expect(nyFedJson).toContain(NY_FED_REFERENCE_RATE_NOTICE);
    expect(nyFedJson).toContain(NY_FED_AFFILIATION_NOTICE);
    expect(nyFedJson).toContain("© 2026 Federal Reserve Bank of New York");
    expect(world.sovereigns).toHaveLength(1);
    expect(world.sovereigns[0].curve).toHaveLength(2);
    expect(world.calendar[0].value).toBe("2026-09-16");
    expect(world.fx.length).toBeGreaterThanOrEqual(6);
    expect(world.crypto).toHaveLength(2);
    expect(world.crypto.every((card) => card.unit === "GBP")).toBe(true);
    expect(world.crypto[0].status).toBe("derived");
    expect(world.fees[0].display_value).toBe("12.5 sat/vB");
    expect(world.briefing.find((card) => card.title === "Latest Fed monetary-policy release")?.label).toContain("Minutes");
    expect(world.briefing.find((card) => card.id === "briefing-us-curve")?.value).toBe("25");
    expect(world.sources.every((source) => source.url)).toBe(true);
  });

  it("discloses intentionally withheld energy coverage instead of substituting a proxy", async () => {
    const world = await buildWorldSnapshot("USD", deps);
    expect(world.energy[0].status).toBe("unavailable");
    expect(world.energy[0].display_value).toContain("rights");
    expect(world.status.state).toBe("partial");
    expect(world.status.unavailable.some((gap) => gap.id === "energy-benchmark-rights")).toBe(true);
    expect(world.threads.find((thread) => thread.id === "thread-oil-currencies")?.limits.join(" ")).toContain("not a currency peg");
  });

  it("marks an old fee fact stale and includes it in the snapshot count", async () => {
    const old = { ...btcFee, observed_at: "2026-08-20T00:00:00.000Z", stale_after_s: 30 };
    const world = await buildWorldSnapshot("USD", {
      ...deps,
      fees: async () => ({ facts: [old], failed: [] }),
    });
    expect(world.fees[0].stale).toBe(true);
    expect(world.fees[0].source?.status).toBe("partial");
    expect(world.status.stale_count).toBeGreaterThanOrEqual(1);
  });

  it("uses the stalest FX leg for a derived crypto card", async () => {
    const world = await buildWorldSnapshot("GBP", {
      ...deps,
      fxRate: async (base, quote) => ({
        ...(await fakeFx(base, quote)),
        refDate: "2026-08-05",
      }),
    });
    expect(world.crypto.every((card) => card.stale)).toBe(true);
    expect(world.crypto.every((card) => card.observed_at === "2026-08-05")).toBe(true);
    expect(world.crypto.every((card) => card.source?.status === "partial")).toBe(true);
    expect(world.crypto[0].sources).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "ecb-fx-reference-rates", status: "partial" }),
    ]));
  });

  it("maps macro failures and missing series to their real sections", async () => {
    const partial: MacroSnapshot = {
      ...macroSnapshot,
      status: "partial",
      complete: false,
      policy: [],
      sovereigns: [observation("ust-2y", "sovereign_yield", "4.20", "2Y")],
      warnings: [{
        source_id: "us_treasury_par_yields",
        code: "value_missing",
        detail: "Treasury 10Y is missing for 2026-08-19",
      }],
      failures: [{
        source_id: "bis_policy_rates",
        kind: "parse",
        detail: "BIS response did not contain supported policy series",
        retryable: false,
        url: "https://example.test/bis",
      }],
    };
    const world = await buildWorldSnapshot("USD", { ...deps, macro: async () => partial });
    expect(world.status.unavailable).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "bis_policy_rates", section: "policy", retryable: false }),
      expect.objectContaining({ section: "sovereigns", code: "macro_series_unavailable" }),
    ]));
    expect(world.sovereigns[0].curve).toHaveLength(1);
    expect(world.sovereigns[0].note).toContain("another requested tenor is missing");
  });

  it("ages a checked-in calendar verification instead of leaving it ok forever", async () => {
    const oldCalendar: MacroSnapshot = {
      ...macroSnapshot,
      sources: [{
        source_id: "fed_meeting_calendar",
        status: "ok",
        observation_count: 0,
        event_count: 1,
        warning_count: 0,
        fetched_at: "2026-01-01T00:00:00.000Z",
        published_at: null,
        url: "https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm",
        retrieval: "verified_transcription",
        verified_at: "2026-01-01T00:00:00.000Z",
      }],
    };
    const world = await buildWorldSnapshot("USD", { ...deps, macro: async () => oldCalendar });
    const source = world.sources.find((candidate) => candidate.id === "fed_meeting_calendar");
    expect(source?.status).toBe("partial");
    expect(source?.note).toContain("older than 45 days");
  });

  it("treats date-only daily rates by business-day age", async () => {
    expect(businessDaysSinceDate("2026-08-14", new Date("2026-08-17T23:00:00Z"))).toBe(1);
    expect(businessDaysSinceDate("2026-08-14", new Date("2026-08-18T23:00:00Z"))).toBe(2);
    expect(businessDaysSinceDate("2026-08-14", NOW)).toBe(4);

    const oldCash = parseNyFedReferenceRatesCsv(
      "Effective Date,Rate Type,Rate (%)\n08/14/2026,EFFR,3.63\n08/14/2026,SOFR,3.62\n",
      { fetchedAt: NOW.toISOString(), sourceUrl: "https://example.test/ny-fed.csv" },
    );
    const world = await buildWorldSnapshot("USD", { ...deps, cash: async () => oldCash });
    expect(world.policy.filter((card) => card.source_id === "ny_fed_reference_rates").every((card) => card.stale)).toBe(true);
    expect(world.sources.find((source) => source.id === "ny_fed_reference_rates")?.status).toBe("partial");
  });

  it("survives total upstream failure as a named unavailable snapshot", async () => {
    const sentinel = "https://upstream.example/DO-NOT-LEAK-WORLD-TOKEN";
    const world = await buildWorldSnapshot("USD", {
      now: () => NOW,
      macro: async () => { throw new Error(sentinel); },
      announcements: async () => { throw new Error(sentinel); },
      cash: async () => { throw new Error(sentinel); },
      fxRate: async () => { throw new Error(sentinel); },
      fees: async () => { throw new Error(sentinel); },
      price: async () => { throw new Error(sentinel); },
    });
    expect(world.policy).toEqual([]);
    expect(world.fx).toEqual([]);
    expect(world.crypto).toEqual([]);
    expect(world.status.state).toBe("unavailable");
    expect(world.status.unavailable.length).toBeGreaterThan(10);
    expect(world.status.unavailable.every((failure) => Boolean(failure.code))).toBe(true);
    expect(JSON.stringify(world)).not.toContain(sentinel);
  });

  it("sanitizes structured macro failure and warning diagnostics", async () => {
    const sentinel = "Authorization: Bearer DO-NOT-LEAK-MACRO-TOKEN";
    const poisoned: MacroSnapshot = {
      ...macroSnapshot,
      status: "partial",
      complete: false,
      sources: [{
        source_id: "bis_policy_rates",
        status: "failed",
        observation_count: 0,
        event_count: 0,
        warning_count: 1,
        fetched_at: null,
        published_at: null,
        url: "https://example.test/bis",
        detail: sentinel,
      }],
      warnings: [{ source_id: "us_treasury_par_yields", code: "value_missing", detail: sentinel }],
      failures: [{ source_id: "bis_policy_rates", kind: "network", detail: sentinel, retryable: true, url: "https://example.test/bis" }],
    };
    const world = await buildWorldSnapshot("USD", {
      ...deps,
      macro: async () => poisoned,
      price: async (feed) => ({
        kind: "unreachable",
        pair: `${feed.symbol}/USD`,
        code: "price_upstream_unavailable",
        detail: sentinel,
      }),
    });

    expect(JSON.stringify(world)).not.toContain(sentinel);
    expect(world.status.unavailable).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "macro_upstream_unavailable", detail: "The official macro source did not return a usable observation." }),
      expect.objectContaining({ code: "macro_series_unavailable", detail: "A requested official macro series did not return a usable observation." }),
    ]));
  });
});

describe("World snapshot delivery cache", () => {
  it("serves fresh, then stale immediately while deduplicating one rebuild per base", async () => {
    let now = NOW.getTime();
    const rebuild = deferred<WorldSnapshot>();
    const first = cacheSnapshot("USD", now, "one");
    const second = cacheSnapshot("USD", now + WORLD_CACHE_FRESH_MS, "two");
    const builder = vi.fn()
      .mockResolvedValueOnce(first)
      .mockReturnValueOnce(rebuild.promise);
    const cache = createWorldSnapshotCache(builder, { now: () => now });

    const miss = await cache.read("USD");
    expect(miss).toMatchObject({ cacheState: "miss", snapshot: first });
    expect(await cache.read("USD")).toMatchObject({ cacheState: "fresh", etag: miss.etag });

    now += WORLD_CACHE_FRESH_MS;
    const [staleOne, staleTwo] = await Promise.all([cache.read("USD"), cache.read("USD")]);
    expect(staleOne).toMatchObject({ cacheState: "stale", snapshot: first });
    expect(staleTwo).toMatchObject({ cacheState: "stale", snapshot: first });
    await Promise.resolve();
    expect(builder).toHaveBeenCalledTimes(2);

    rebuild.resolve(second);
    await cache.waitForIdle("USD");
    expect(await cache.read("USD")).toMatchObject({ cacheState: "fresh", snapshot: second });
  });

  it("waits for a new document at the max-stale boundary", async () => {
    let now = NOW.getTime();
    const rebuild = deferred<WorldSnapshot>();
    const builder = vi.fn()
      .mockResolvedValueOnce(cacheSnapshot("USD", now, "one"))
      .mockReturnValueOnce(rebuild.promise);
    const cache = createWorldSnapshotCache(builder, { now: () => now });
    await cache.read("USD");

    now += WORLD_CACHE_FRESH_MS + WORLD_CACHE_STALE_WINDOW_MS;
    let settled = false;
    const pending = cache.read("USD").finally(() => { settled = true; });
    await Promise.resolve();
    expect(builder).toHaveBeenCalledTimes(2);
    expect(settled).toBe(false);

    const next = cacheSnapshot("USD", now, "two");
    rebuild.resolve(next);
    await expect(pending).resolves.toMatchObject({ cacheState: "miss", snapshot: next });
  });

  it("keeps the last safe degraded snapshot and backs off after refresh failure", async () => {
    let now = NOW.getTime();
    const first = cacheSnapshot("USD", now, "one", "partial");
    const second = cacheSnapshot("USD", now + 60_000, "two");
    const builder = vi.fn()
      .mockResolvedValueOnce(first)
      .mockRejectedValueOnce(new Error("source network down"))
      .mockResolvedValueOnce(second);
    const cache = createWorldSnapshotCache(builder, { now: () => now });

    await cache.read("USD");
    now += WORLD_CACHE_FRESH_MS;
    expect((await cache.read("USD")).snapshot).toBe(first);
    await cache.waitForIdle("USD");
    expect(builder).toHaveBeenCalledTimes(2);

    now += WORLD_CACHE_FAILURE_BACKOFF_MS - 1;
    expect(await cache.read("USD")).toMatchObject({ cacheState: "stale", snapshot: first });
    expect(builder).toHaveBeenCalledTimes(2);

    now += 1;
    expect((await cache.read("USD")).snapshot).toBe(first);
    await cache.waitForIdle("USD");
    expect(builder).toHaveBeenCalledTimes(3);
    expect(await cache.read("USD")).toMatchObject({ cacheState: "fresh", snapshot: second });
  });

  it("does not let an all-unavailable refresh evict a safe stale document", async () => {
    let now = NOW.getTime();
    const safe = cacheSnapshot("USD", now, "safe");
    const unavailable = cacheSnapshot("USD", now + WORLD_CACHE_FRESH_MS, "outage", "unavailable");
    const builder = vi.fn().mockResolvedValueOnce(safe).mockResolvedValueOnce(unavailable);
    const cache = createWorldSnapshotCache(builder, { now: () => now });

    await cache.read("USD");
    now += WORLD_CACHE_FRESH_MS;
    expect((await cache.read("USD")).snapshot).toBe(safe);
    await cache.waitForIdle("USD");
    expect(await cache.read("USD")).toMatchObject({ cacheState: "stale", snapshot: safe });
    expect(builder).toHaveBeenCalledTimes(2);
  });

  it("short-caches a truthful unavailable receipt without promoting it to stale-safe", async () => {
    let now = NOW.getTime();
    const builder = vi.fn()
      .mockResolvedValueOnce(cacheSnapshot("USD", now, "outage-one", "unavailable"))
      .mockImplementationOnce(async () => cacheSnapshot("USD", ++now, "outage-two", "unavailable"));
    const cache = createWorldSnapshotCache(builder, { now: () => now });

    const first = await cache.read("USD");
    const second = await cache.read("USD");
    expect(first).toMatchObject({ cacheState: "miss", snapshot: { status: { state: "unavailable" } } });
    expect(second).toMatchObject({ cacheState: "fresh", snapshot: first.snapshot, etag: first.etag });
    expect(builder).toHaveBeenCalledTimes(1);

    now += WORLD_CACHE_UNAVAILABLE_MS;
    const rebuilt = await cache.read("USD");
    expect(rebuilt).toMatchObject({ cacheState: "miss", snapshot: { status: { state: "unavailable" } } });
    expect(rebuilt.snapshot.generated_at).not.toBe(first.snapshot.generated_at);
    expect(builder).toHaveBeenCalledTimes(2);
  });

  it("isolates snapshots, validators, inflight work, and cache hits by currency", async () => {
    let now = NOW.getTime();
    const builder = vi.fn(async (base: WorldSnapshot["base_currency"]) => cacheSnapshot(base, now, base));
    const cache = createWorldSnapshotCache(builder, { now: () => now });

    const [usd, eur] = await Promise.all([cache.read("USD"), cache.read("EUR")]);
    expect(usd.snapshot.base_currency).toBe("USD");
    expect(eur.snapshot.base_currency).toBe("EUR");
    expect(usd.etag).not.toBe(eur.etag);
    expect(builder).toHaveBeenCalledTimes(2);
    expect((await cache.read("USD")).etag).toBe(usd.etag);
    expect((await cache.read("EUR")).etag).toBe(eur.etag);
    expect(builder).toHaveBeenCalledTimes(2);
  });

  it("does not fabricate a cold snapshot and backs off a failed first build", async () => {
    let now = NOW.getTime();
    const failure = new Error("cold build failed");
    const builder = vi.fn().mockRejectedValue(failure);
    const cache = createWorldSnapshotCache(builder, { now: () => now });

    await expect(cache.read("USD")).rejects.toBe(failure);
    await expect(cache.read("USD")).rejects.toBe(failure);
    expect(builder).toHaveBeenCalledTimes(1);

    now += WORLD_CACHE_FAILURE_BACKOFF_MS;
    await expect(cache.read("USD")).rejects.toBe(failure);
    expect(builder).toHaveBeenCalledTimes(2);
  });
});

describe("World route", () => {
  it("never serializes credential-bearing upstream errors", async () => {
    const sentinel = "https://provider.example/token/DO-NOT-LEAK-WORLD-ROUTE";
    const app = new Hono();
    mountWorldDoor(app, {
      now: () => NOW,
      macro: async () => { throw new Error(sentinel); },
      announcements: async () => { throw new Error(sentinel); },
      cash: async () => { throw new Error(sentinel); },
      fxRate: async () => { throw new Error(sentinel); },
      fees: async () => { throw new Error(sentinel); },
      price: async () => { throw new Error(sentinel); },
    });

    const response = await app.request("/v1/world?base=USD");
    const text = await response.text();
    expect(response.status).toBe(200);
    expect(text).not.toContain(sentinel);
    const body = JSON.parse(text) as WorldSnapshot;
    expect(body.status.unavailable.every((failure) => Boolean(failure.code))).toBe(true);
  });

  it("validates base currencies and emits conditional, inspectable cache receipts", async () => {
    let now = NOW.getTime();
    const app = new Hono();
    mountWorldDoor(app, deps, { now: () => now });
    const bad = await app.request("/v1/world?base=ZZZ");
    expect(bad.status).toBe(422);
    expect((await bad.json()).next_actions[0]).toContain("USD");

    const good = await app.request("/v1/world?base=gbp");
    const etag = good.headers.get("etag");
    expect(good.status).toBe(200);
    expect(good.headers.get("content-type")).toContain("cashloom.world.v1");
    expect(good.headers.get("cache-control")).toContain("stale-while-revalidate");
    expect(good.headers.get("cache-control")).toContain("stale-if-error");
    expect(good.headers.get("x-cashloom-cache")).toBe("miss");
    expect(good.headers.get("x-cashloom-snapshot-age")).toBe("0");
    expect(good.headers.get("server-timing")).toContain('desc="miss"');
    expect(etag).toMatch(/^W\/"sha256-[A-Za-z0-9_-]+"$/);
    expect((await good.json()).base_currency).toBe("GBP");

    const conditional = await app.request("/v1/world?base=GBP", {
      headers: { "If-None-Match": `"not-this-one", ${etag}` },
    });
    expect(conditional.status).toBe(304);
    expect(await conditional.text()).toBe("");
    expect(conditional.headers.get("etag")).toBe(etag);
    expect(conditional.headers.get("x-cashloom-cache")).toBe("fresh");

    now += WORLD_CACHE_FRESH_MS;
    const stale = await app.request("/v1/world?base=GBP", {
      headers: { "If-None-Match": etag! },
    });
    expect(stale.status).toBe(304);
    expect(stale.headers.get("x-cashloom-cache")).toBe("stale");
    expect(stale.headers.get("x-cashloom-snapshot-age")).toBe(String(WORLD_CACHE_FRESH_MS / 1_000));
    expect(stale.headers.get("warning")).toContain("110");
    expect(stale.headers.get("cache-control")).toContain("max-age=0");
    expect(stale.headers.get("server-timing")).toContain('desc="stale"');

    const eur = await app.request("/v1/world?base=EUR", {
      headers: { "If-None-Match": etag! },
    });
    expect(eur.status).toBe(200);
    expect(eur.headers.get("etag")).not.toBe(etag);
    expect((await eur.json()).base_currency).toBe("EUR");
  });

  it("keeps downstream reuse inside the server window at the final stale millisecond", async () => {
    let now = NOW.getTime();
    const app = new Hono();
    mountWorldDoor(app, deps, { now: () => now });

    const fresh = await app.request("/v1/world?base=USD");
    const freshControl = fresh.headers.get("cache-control") ?? "";
    now += WORLD_CACHE_FRESH_MS + WORLD_CACHE_STALE_WINDOW_MS - 1;
    const stale = await app.request("/v1/world?base=USD");
    const staleControl = stale.headers.get("cache-control") ?? "";

    const directive = (header: string, name: string): number => {
      const value = new RegExp(`(?:^|[,\\s])${name}=(\\d+)`).exec(header)?.[1];
      return value ? Number(value) : 0;
    };
    const authorizedUntilAge = (header: string) => directive(header, "max-age") + Math.max(
      directive(header, "stale-while-revalidate"),
      directive(header, "stale-if-error"),
    );
    const serverWindowSeconds = (WORLD_CACHE_FRESH_MS + WORLD_CACHE_STALE_WINDOW_MS) / 1_000;

    expect(authorizedUntilAge(freshControl)).toBeLessThanOrEqual(serverWindowSeconds);
    expect(authorizedUntilAge(staleControl)).toBeLessThanOrEqual(serverWindowSeconds);
    expect(stale.headers.get("age")).toBe(String(Math.floor((WORLD_CACHE_FRESH_MS + WORLD_CACHE_STALE_WINDOW_MS - 1) / 1_000)));
    expect(Number(stale.headers.get("age"))).toBeGreaterThan(authorizedUntilAge(staleControl));
    expect(stale.headers.get("x-cashloom-cache")).toBe("stale");
    expect(stale.headers.get("x-cashloom-snapshot-age")).toBe(stale.headers.get("age"));
    expect(stale.headers.get("warning")).toContain("110");
  });
});

describe("exact curve arithmetic", () => {
  it("computes basis-point spreads without binary floats", () => {
    expect(percentSpreadBps("4.45", "4.20")).toBe("25");
    expect(percentSpreadBps("3.995", "4.005")).toBe("-1");
    expect(percentSpreadBps("4.005", "4.000")).toBe("0"); // +0.5 bp → half-even 0
    expect(percentSpreadBps("4.015", "4.000")).toBe("2"); // +1.5 bp → half-even 2
    expect(percentSpreadBps("4.0050001", "4")).toBe("1"); // precision beyond 6dp changes the rounded result
    expect(percentSpreadBps("3.9949999", "4")).toBe("-1");
    expect(percentSpreadBps("3.995", "4")).toBe("0"); // −0.5 bp → half-even 0
    expect(percentSpreadBps("3.985", "4")).toBe("-2"); // −1.5 bp → half-even −2
  });
});
