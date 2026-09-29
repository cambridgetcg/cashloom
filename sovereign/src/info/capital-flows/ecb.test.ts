import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { createEcbFundAdapter, createEcbSovereignAdapter } from "./ecb.ts";
import { parseCsv } from "./csv.ts";
import { validateSourceBatch } from "./snapshot.ts";
import { nativeValue, type AdapterContext, type CapitalFlowAdapter, type FlowObservation, type TextResponse } from "./model.ts";

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");
const csec = fixture("ecb-csec-es-de-total-2026-06_2026-07.csv");
const historicalCsec = fixture("ecb-csec-es-de-total-2020-12_2021-01.csv");
const requiredIvf = fixture("ecb-ivf-required-quarterly.csv");
const peIvf = fixture("ecb-ivf-private-equity-quarterly.csv");
const encode = (rows: string[][]) => rows.map(row => row.map(cell => `"${cell.replaceAll('"', '""')}"`).join(",")).join("\r\n");
// Assembly, not a purported native one-response fixture: preserve all selected native rows,
// explicitly exclude Netherlands, and keep exactly one header. Production must reject NL.
const [ivfHeader, ...requiredRows] = parseCsv(requiredIvf);
const [peHeader, ...peRows] = parseCsv(peIvf);
const peU2Rows = peRows.filter(row => row[peHeader!.indexOf("REF_AREA")] === "U2");
const ivf = encode([ivfHeader!, ...requiredRows, ...peU2Rows]);

function context(adapter: CapitalFlowAdapter, text: string, signal = new AbortController().signal) {
  const url = adapter.definition.resources[0]!;
  // Intentionally synthetic clock and HTTP metadata; never fixture publication evidence.
  const response: TextResponse = { text, url, headers: { "last-modified": "Wed, 02 Sep 2026 09:00:00 GMT" },
    receipt: { url, retrievedAt: "2026-09-09T16:12:34.567Z", lastModified: "Wed, 02 Sep 2026 09:00:00 GMT", etag: '"fixture"', decodedBytes: Buffer.byteLength(text) } };
  const ctx: AdapterContext = { signal, fetchText: vi.fn(async () => response), consumeRows: vi.fn(), assertComplete: vi.fn() };
  return { ctx, response };
}
async function load(adapter: CapitalFlowAdapter, text: string) {
  return adapter.load(context(adapter, text).ctx);
}
function mutate(text: string, changes: Record<string, string>, index = 1): string {
  const rows = parseCsv(text), header = rows[0]!;
  for (const [column, value] of Object.entries(changes)) {
    const at = header.indexOf(column);
    if (at < 0) throw new Error(`test_missing_column_${column}`);
    rows[index]![at] = value;
  }
  return encode(rows);
}
function observation(observations: FlowObservation[], sourceKey: string, period: string) {
  const result = observations.find(o => o.receipt.sourceSeriesId === sourceKey && o.period.label === period);
  if (!result) throw new Error("test_observation_absent");
  return result;
}
const csecKey = (country: string, entry: string) => `CSEC.M.N.${country}.W0.S1311.S1.N.${entry}.F.F3.T._Z.EUR._T.F.V.N._T`;
const ivfKey = (policy: string) => `IVF.Q.U2.N.${policy}.L30.A.4.Z5.0000.Z01.E`;

describe("ECB source contracts and rights", () => {
  it("declares only the exact fixed rolling baskets and cleared statistical reuse", () => {
    const sovereign = createEcbSovereignAdapter(), funds = createEcbFundAdapter();
    expect(sovereign.definition.resources).toEqual(["https://data-api.ecb.europa.eu/service/data/CSEC/M.N.ES+DE.W0.S1311.S1.N.L+LD+LI.F.F3.T._Z.EUR._T.F.V.N._T?format=csvdata&lastNObservations=24"]);
    expect(funds.definition.resources).toEqual(["https://data-api.ecb.europa.eu/service/data/IVF/Q.U2.N.10+20+40+TP.L30.A.4.Z5.0000.Z01.E?format=csvdata&lastNObservations=20"]);
    for (const adapter of [sovereign, funds]) {
      expect(adapter.definition.rights.status).toBe("allowed");
      expect(adapter.definition.rights.attribution).toContain("Data available free from ECB. Presentation by CashLoom; no cross-series totals.");
      expect(adapter.definition.rights.evidenceUrl).toBe("https://www.ecb.europa.eu/services/using-our-site/disclaimer/html/index.en.html");
      expect(adapter.definition.rights.checkedAt).toBeNull(); // Known day, unknown exact clock time.
      expect(adapter.definition.rights.note).toContain("checked 2026-09-09");
      expect(adapter.definition.rights.note).toContain("before payment and at each access");
      expect(adapter.definition.rights.note).toContain("modifications");
      for (const series of adapter.series) {
        expect(series.unit).toEqual({ currency: "EUR", exponent: 6, label: "million EUR" });
        expect(series.annualization).toBe("notAnnualized");
        expect(series.seasonalAdjustment).toBe("unadjusted");
        expect(series.sourceUrl).toContain(series.sourceSeriesId);
        expect(series.limitations.join(" ")).toContain("Source-provided revision policy");
      }
    }
    expect(sovereign.series.map(s => s.sourceSeriesId).sort()).toEqual(["ES", "DE"].flatMap(country => ["L", "LI", "LD"].map(entry => csecKey(country, entry))).sort());
    expect(funds.series.map(s => s.sourceSeriesId)).toEqual(["10", "20", "40", "TP"].map(ivfKey));
  });
  it("identifies issuer and fund-domicile geography without investor or global-flow claims", () => {
    for (const series of createEcbSovereignAdapter().series) {
      expect(["ES", "DE"]).toContain(series.geography.issuer?.code);
      expect(series.sector).toContain("excluding social security");
      expect(series.instrument).toContain("all original maturities (T)");
      expect(series.valuation).toContain("not cash proceeds");
      expect(series.geography.investor).toBeNull();
    }
    for (const series of createEcbFundAdapter().series) {
      expect(series.label).toContain("Net fund-share issuance — financial transactions");
      expect(series.metricKind).toBe("netIssuance");
      expect(series.geography.fundDomicile).toEqual({ code: "U2", label: "Euro area (changing composition)" });
      expect(series.geography.investor).toBeNull();
      expect(series.geography.issuer).toBeNull();
      expect(series.instrument).toContain("L30");
      expect(series.instrument).toContain("DATA_TYPE 4");
      expect(series.limitations.join(" ")).toContain("classification overlap is unverified");
      expect(series.limitations.join(" ")).toContain("no cash-only subscription claim");
      expect(series.sector).toContain("excluding money-market and pension funds");
    }
  });
});

describe("ECB native statistical fixtures", () => {
  it("reads comma-containing titles without column drift", () => {
    for (const text of [csec, historicalCsec, requiredIvf, peIvf]) {
      const [header, ...rows] = parseCsv(text);
      expect(rows.every(row => row.length === header!.length)).toBe(true);
      expect(rows[0]![header!.indexOf("TITLE")]).toContain(",");
      expect(rows[0]![header!.indexOf("UNIT_MULT")]).toBe("6");
    }
  });
  it("retains all six July 2026 values, positive redemptions and reported net signs", async () => {
    const adapter = createEcbSovereignAdapter();
    const { ctx, response } = context(adapter, csec);
    const batch = await adapter.load(ctx);
    expect(batch.complete).toBe(true);
    expect(batch.observations).toHaveLength(12);
    expect(batch.receipts).toEqual([response.receipt]);
    expect(batch.receipts[0]).toBe(response.receipt);
    expect(ctx.fetchText).toHaveBeenCalledExactlyOnceWith(adapter.definition.resources[0]);
    expect(ctx.consumeRows).toHaveBeenCalledExactlyOnceWith(12);
    expect(ctx.assertComplete).toHaveBeenCalledExactlyOnceWith(12, 12); // Selected unpaginated response, not global history.
    expect(vi.mocked(ctx.assertComplete).mock.invocationCallOrder[0]).toBeGreaterThan(vi.mocked(ctx.consumeRows).mock.invocationCallOrder[0]!);
    for (const [country, entry, lexeme] of [
      ["ES", "LI", "21402.775"], ["ES", "LD", "33628.396"], ["ES", "L", "-12225.621"],
      ["DE", "LI", "50845.493"], ["DE", "LD", "14058.9235"], ["DE", "L", "36786.5695"],
    ]) {
      const o = observation(batch.observations, csecKey(country!, entry!), "2026-07");
      expect(o.value).toEqual(nativeValue(lexeme!, { currency: "EUR", exponent: 6, label: "million EUR" }));
      expect(o.status).toBe("observed");
      expect(o.provisional).toBe(true);
      expect(o.publisherStatus).toBe("P");
      expect(o.publisherConfidentiality).toBe("F");
      expect(o.completeness).toBe("unknown");
      expect(o.period).toEqual({ frequency: "monthly", label: "2026-07", start: "2026-07-01", end: "2026-07-31" });
      expect(o.receipt).toMatchObject({ resourceUrl: response.url, retrievedAt: response.receipt.retrievedAt, publicationAt: null, method: "publisherReported", inputObservationIds: [] });
    }
    const netJune = observation(batch.observations, csecKey("DE", "L"), "2026-06");
    expect(netJune.value?.publisherLexeme).toBe("5495.886020000005"); // Do not recompute or round the residual.
    expect(netJune.value?.unitMultiplier).toBe("1000000");
    expect(netJune.publisherStatus).toBe("A");
    expect(netJune.provisional).toBe(false);
    expect(netJune.revised).toBe(false);
    expect(netJune.estimated).toBe(false);
    expect(netJune.break).toBe(false);
  });
  it("preserves the native December 2020 break rather than hiding or rewriting it", async () => {
    const batch = await load(createEcbSovereignAdapter(), historicalCsec);
    const december = batch.observations.filter(o => o.period.label === "2020-12");
    expect(december).toHaveLength(6);
    expect(december.every(o => o.break && o.publisherStatus === "B" && o.status === "observed")).toBe(true);
    expect(observation(batch.observations, csecKey("ES", "L"), "2020-12").value?.publisherLexeme).toBe("-2686.9789999999994");
    expect(observation(batch.observations, csecKey("DE", "L"), "2021-01").break).toBe(false);
  });
  it("retains all four quarterly fund classes and native precision, not DECIMALS rounding", async () => {
    expect(ivfHeader).toEqual(peHeader);
    expect(peRows).toHaveLength(8);
    expect(peU2Rows).toHaveLength(4);
    const adapter = createEcbFundAdapter(), { ctx } = context(adapter, ivf);
    const batch = await adapter.load(ctx);
    expect(batch.observations).toHaveLength(28);
    expect(ctx.consumeRows).toHaveBeenCalledExactlyOnceWith(28);
    expect(ctx.assertComplete).toHaveBeenCalledExactlyOnceWith(28, 28);
    expect(vi.mocked(ctx.assertComplete).mock.invocationCallOrder[0]).toBeGreaterThan(vi.mocked(ctx.consumeRows).mock.invocationCallOrder[0]!);
    for (const [policy, lexeme] of [["10", "83854.69386896017"], ["20", "65306.18036389985"], ["40", "26.156910720004618"], ["TP", "903.0999503100106"]]) {
      const o = observation(batch.observations, ivfKey(policy!), "2026-Q2");
      expect(o.value?.publisherLexeme).toBe(lexeme);
      expect(o.value?.decimal).toBe(lexeme);
      expect(o.value?.unitExponent).toBe(6);
      expect(o.value?.currency).toBe("EUR");
      expect(o.period).toEqual({ frequency: "quarterly", label: "2026-Q2", start: "2026-04-01", end: "2026-06-30" });
      expect(o).toMatchObject({ provisional: true, publisherStatus: "P", publisherConfidentiality: "F", completeness: "unknown" });
      expect(o.receipt.publicationAt).toBeNull();
    }
    expect(observation(batch.observations, ivfKey("40"), "2025-Q4").value?.publisherLexeme).toBe("-7624.610838520014");
    expect(batch.observations.every(o => !o.receipt.sourceSeriesId.includes(".NL."))).toBe(true);
  });
});

const baskets = [
  { name: "CSEC", factory: createEcbSovereignAdapter, text: csec, conf: "CONF_STATUS", expectedCount: 12, frequency: "monthly", limit: 24 },
  { name: "IVF", factory: createEcbFundAdapter, text: ivf, conf: "OBS_CONF", expectedCount: 28, frequency: "quarterly", limit: 20 },
] as const;
for (const basket of baskets) describe(`${basket.name} synthetic defensive cases (not live missing-value evidence)`, () => {
  it.each(["", "null", "NULL", "   "])("never turns blank/null lexeme %j into zero", async lexeme => {
    const batch = await load(basket.factory(), mutate(basket.text, { OBS_VALUE: lexeme }));
    const o = batch.observations.find(o => o.value === null)!;
    expect(o.status).toBe("missing");
    expect(o.publisherStatus).toBe("A");
  });
  it("distinguishes explicit zero from absent, suppressed or missing", async () => {
    const batch = await load(basket.factory(), mutate(basket.text, { OBS_VALUE: "0" }));
    expect(batch.observations.find(o => o.value?.publisherLexeme === "0")).toMatchObject({ status: "observed", value: { raw: "0" } });
  });
  it.each(["H", "L", "M", "O", "Q"])("retains missing status %s and never exposes its numeric cell", async code => {
    const batch = await load(basket.factory(), mutate(basket.text, { OBS_STATUS: code, OBS_VALUE: "987654321.1234567" }));
    expect(batch.observations.find(o => o.publisherStatus === code)).toMatchObject({ value: null, status: code === "Q" ? "suppressed" : "missing", publisherStatus: code });
    expect(JSON.stringify(batch)).not.toContain("987654321.1234567");
  });
  it.each(["C", "N", "D", "S", "", "UNRECOGNIZED"])("conservatively suppresses non-free confidentiality %j", async code => {
    const batch = await load(basket.factory(), mutate(basket.text, { [basket.conf]: code, OBS_VALUE: "987654321.1234567" }));
    expect(batch.observations.find(o => o.publisherConfidentiality === code)).toMatchObject({ status: "suppressed", value: null, publisherConfidentiality: code });
    expect(JSON.stringify(batch)).not.toContain("987654321.1234567");
  });
  it.each([["R", "revised"], ["E", "estimated"], ["B", "break"], ["P", "provisional"]] as const)("preserves %s and its %s interpretation", async (code, flag) => {
    const batch = await load(basket.factory(), mutate(basket.text, { OBS_STATUS: code, OBS_VALUE: "1.230000" }));
    const first = batch.observations.find(o => o.value?.publisherLexeme === "1.230000")!;
    expect(first.publisherStatus).toBe(code);
    for (const key of ["provisional", "revised", "estimated", "break"] as const) expect(first[key]).toBe(key === flag);
    expect(first.status).toBe("observed");
  });
  it.each(["", "Z", "F", "AP", "a"])("rejects unknown status %j rather than call it final or normal", async code => {
    await expect(load(basket.factory(), mutate(basket.text, { OBS_STATUS: code }))).rejects.toThrow("ecb_unknown_status");
  });
  it.each(["NaN", "Infinity", "12,345.6", "1x", "9".repeat(129), "1e999"])("rejects invalid or unbounded observed decimals %j", async lexeme => {
    await expect(load(basket.factory(), mutate(basket.text, { OBS_VALUE: lexeme }))).rejects.toThrow("invalid_decimal");
  });
  it("preserves bounded scientific notation lexeme and exact scale without floating point", async () => {
    const batch = await load(basket.factory(), mutate(basket.text, { OBS_VALUE: "1.234567890123456789e-4" }));
    expect(batch.observations.find(o => o.value?.publisherLexeme === "1.234567890123456789e-4")?.value?.decimal).toBe("0.0001234567890123456789");
  });
  it.each(["", " ", "KEY\n"])("treats empty 200 response %j as unavailable, not a successful deletion", async body => {
    await expect(load(basket.factory(), body)).rejects.toThrow("ecb_unavailable");
  });
  it("rejects a header-only native response", async () => {
    await expect(load(basket.factory(), encode([parseCsv(basket.text)[0]!]))).rejects.toThrow("ecb_unavailable");
  });
  it("rejects any missing expected series rather than silently commit a partial basket", async () => {
    const [header, ...rows] = parseCsv(basket.text);
    for (const s of basket.factory().series) {
      const body = encode([header!, ...rows.filter(row => row[header!.indexOf("KEY")] !== s.sourceSeriesId)]);
      await expect(load(basket.factory(), body)).rejects.toThrow("ecb_incomplete_series");
    }
  });
  it("accepts an explicitly missing series without fabricating observations or values", async () => {
    const [header, ...rows] = parseCsv(basket.text), key = rows[0]![header!.indexOf("KEY")];
    for (const row of rows) if (row[header!.indexOf("KEY")] === key) {
      row[header!.indexOf("OBS_VALUE")] = "";
      row[header!.indexOf("OBS_STATUS")] = "M";
    }
    const batch = await load(basket.factory(), encode([header!, ...rows]));
    expect(batch.observations).toHaveLength(basket.expectedCount);
    expect(batch.observations.filter(o => o.receipt.sourceSeriesId === key).every(o => o.status === "missing" && o.value === null)).toBe(true);
  });
  it("rejects unknown keys, duplicate periods, inconsistent row widths and headers", async () => {
    await expect(load(basket.factory(), mutate(basket.text, { KEY: "UNEXPECTED.KEY" }))).rejects.toThrow("ecb_unexpected_key");
    const rows = parseCsv(basket.text);
    await expect(load(basket.factory(), encode([...rows, rows[1]!]))).rejects.toThrow("ecb_duplicate_period");
    await expect(load(basket.factory(), encode([rows[0]!, ...rows.slice(1).map((row, i) => i === 0 ? row.slice(0, -1) : row)]))).rejects.toThrow("ecb_invalid_row");
    const duplicate = rows.map(row => [...row]); duplicate[0]![0] = duplicate[0]![1]!;
    await expect(load(basket.factory(), encode(duplicate))).rejects.toThrow("ecb_duplicate_header");
    const absent = rows.map(row => [...row]); absent[0]![0] = "MISSING_KEY_HEADER";
    await expect(load(basket.factory(), encode(absent))).rejects.toThrow("ecb_missing_column");
  });
  it.each(["2026", "2026-13", "2026-Q5", "2026-02-30", "26-01", "0000-01"])("rejects invalid or wrong-frequency period %j", async period => {
    await expect(load(basket.factory(), mutate(basket.text, { TIME_PERIOD: period }))).rejects.toThrow("invalid_period");
  });
  it("accepts the selected window limit and rejects overflow without truncation", async () => {
    const [header, ...rows] = parseCsv(basket.text), periodIndex = header!.indexOf("TIME_PERIOD");
    const representatives = [...new Map(rows.map(row => [row[0], row])).values()];
    const build = (count: number) => encode([header!, ...representatives.flatMap(row => Array.from({ length: count }, (_, i) => {
      const next = [...row];
      next[periodIndex] = basket.frequency === "monthly"
        ? `${2020 + Math.floor(i / 12)}-${String(i % 12 + 1).padStart(2, "0")}`
        : `${2020 + Math.floor(i / 4)}-Q${i % 4 + 1}`;
      return next;
    }))]);
    expect((await load(basket.factory(), build(basket.limit))).observations).toHaveLength(representatives.length * basket.limit);
    await expect(load(basket.factory(), build(basket.limit + 1))).rejects.toThrow("ecb_history_limit");
  });
  it("round-trips publisher flags and suppression through the core batch whitelist", async () => {
    const adapter = basket.factory();
    for (const code of ["A", "P", "R", "B", "E"]) {
      const batch = await load(adapter, mutate(basket.text, { OBS_STATUS: code }));
      expect(validateSourceBatch(adapter, batch)).toEqual(batch);
    }
    const suppressed = await load(adapter, mutate(basket.text, { [basket.conf]: "C", OBS_VALUE: "987654321.1234567" }));
    const normalized = validateSourceBatch(adapter, suppressed);
    expect(normalized).toEqual(suppressed);
    expect(JSON.stringify(normalized)).not.toContain("987654321.1234567");
  });
  it("asserts only a fully processed selected response, after all row accounting", async () => {
    const adapter = basket.factory(), { ctx } = context(adapter, basket.text);
    const events: string[] = [];
    ctx.consumeRows = count => { events.push(`rows:${count}`); };
    ctx.assertComplete = (received, total) => {
      events.push(`complete:${received}:${total}`);
      throw new Error("test_completion_rejected");
    };
    await expect(adapter.load(ctx)).rejects.toThrow("test_completion_rejected");
    expect(events).toEqual([`rows:${basket.expectedCount}`, `complete:${basket.expectedCount}:${basket.expectedCount}`]);

    const [header, ...rows] = parseCsv(basket.text);
    // A late malformed row and an absent selected series must not assert success.
    for (const body of [
      mutate(basket.text, { OBS_STATUS: "UNKNOWN" }, rows.length),
      encode([header!, ...rows.filter(row => row[0] !== rows[0]![0])]),
    ]) {
      const failed = context(adapter, body).ctx;
      await expect(adapter.load(failed)).rejects.toThrow();
      expect(failed.consumeRows).toHaveBeenCalledExactlyOnceWith(parseCsv(body).length - 1);
      expect(failed.assertComplete).not.toHaveBeenCalled();
    }
  });
  it("retains the minimum year 1000 guard independently of core date handling", async () => {
    const suffix = basket.frequency === "monthly" ? "01" : "Q1";
    for (const year of ["0000", "0001", "0099", "0100", "0999"]) {
      await expect(load(basket.factory(), mutate(basket.text, { TIME_PERIOD: `${year}-${suffix}` }))).rejects.toThrow("invalid_period");
    }
    const batch = await load(basket.factory(), mutate(basket.text, { TIME_PERIOD: `1000-${suffix}` }));
    expect(batch.observations.find(o => o.period.label === `1000-${suffix}`)?.period.start).toBe("1000-01-01");
  });
  it("charges all parsed rows before validation and respects cancellation", async () => {
    const adapter = basket.factory();
    const { ctx } = context(adapter, mutate(basket.text, { KEY: "EXTRA.KEY" }));
    await expect(adapter.load(ctx)).rejects.toThrow("ecb_unexpected_key");
    expect(ctx.consumeRows).toHaveBeenCalledExactlyOnceWith(basket.expectedCount);
    expect(ctx.assertComplete).not.toHaveBeenCalled();
    const controller = new AbortController(); controller.abort();
    const cancelled = context(adapter, basket.text, controller.signal).ctx;
    await expect(adapter.load(cancelled)).rejects.toThrow();
    expect(cancelled.fetchText).not.toHaveBeenCalled();
    const afterFetch = context(adapter, basket.text);
    afterFetch.ctx.consumeRows = () => { throw new Error("test_row_budget"); };
    await expect(adapter.load(afterFetch.ctx)).rejects.toThrow("test_row_budget");
  });
});

describe("synthetic exact dimension contract regressions", () => {
  it.each([
    ["FREQ", "Q"], ["ADJUSTMENT", "S"], ["REF_AREA", "FR"], ["COUNTERPART_AREA", "W1"],
    ["REF_SECTOR", "S13"], ["COUNTERPART_SECTOR", "S11"], ["CONSOLIDATION", "C"], ["ACCOUNTING_ENTRY", "LI"],
    ["STO", "S"], ["INSTR_ASSET", "F4"], ["MATURITY", "L"], ["EXPENDITURE", "T"],
    ["UNIT_MEASURE", "USD"], ["CURRENCY_DENOM", "EUR"], ["VALUATION", "M"], ["PRICES", "Q"],
    ["TRANSFORMATION", "A"], ["CUST_BREAKDOWN", "S"], ["UNIT_MULT", "3"], ["UNIT_MULT", "06"], ["TIME_FORMAT", "P3M"],
  ])("rejects CSEC %s=%s even when full KEY is unchanged", async (column, value) => {
    await expect(load(createEcbSovereignAdapter(), mutate(csec, { [column]: value }))).rejects.toThrow("ecb_dimension_mismatch");
  });
  it.each([
    ["FREQ", "M"], ["REF_AREA", "NL"], ["ADJUSTMENT", "S"], ["IVF_REP_SECTOR", "20"],
    ["IVF_ITEM", "T00"], ["MATURITY_ORIG", "L"], ["DATA_TYPE", "1"], ["COUNT_AREA", "U2"],
    ["BS_COUNT_SECTOR", "1000"], ["CURRENCY_TRANS", "EUR"], ["BS_SUFFIX", "A"],
    ["UNIT", "USD"], ["UNIT_MULT", "0"], ["UNIT_MULT", "6.0"], ["TIME_FORMAT", "P1M"],
  ])("rejects IVF %s=%s even when full KEY is unchanged", async (column, value) => {
    await expect(load(createEcbFundAdapter(), mutate(ivf, { [column]: value }))).rejects.toThrow("ecb_dimension_mismatch");
  });
  it("rejects a self-consistent unselected key/dimension and NL fixture rows in production", async () => {
    await expect(load(createEcbSovereignAdapter(), mutate(csec, { KEY: csecKey("FR", "L"), REF_AREA: "FR" }))).rejects.toThrow("ecb_unexpected_key");
    await expect(load(createEcbFundAdapter(), encode([ivfHeader!, ...requiredRows, ...peRows]))).rejects.toThrow("ecb_unexpected_key");
  });
  it("does not negate negative gross magnitudes into plausible financing", async () => {
    const rows = parseCsv(csec), grossIndex = rows.findIndex(row => row[0]?.includes(".LD.F."));
    await expect(load(createEcbSovereignAdapter(), mutate(csec, { OBS_VALUE: "-10" }, grossIndex))).rejects.toThrow("ecb_unexpected_gross_sign");
  });
  it("validates leap-month and year-crossing quarterly boundaries", async () => {
    const monthly = await load(createEcbSovereignAdapter(), mutate(csec, { TIME_PERIOD: "2024-02" }));
    expect(monthly.observations.find(o => o.period.label === "2024-02")?.period.end).toBe("2024-02-29");
    const quarterly = await load(createEcbFundAdapter(), mutate(ivf, { TIME_PERIOD: "2023-Q4" }));
    expect(quarterly.observations.find(o => o.period.label === "2023-Q4")?.period).toEqual({ frequency: "quarterly", label: "2023-Q4", start: "2023-10-01", end: "2023-12-31" });
  });
  it("does not fabricate periods to fill an internal gap", async () => {
    const [header, ...rows] = parseCsv(ivf), at = header!.indexOf("TIME_PERIOD");
    const batch = await load(createEcbFundAdapter(), encode([header!, ...rows.filter(row => row[at] !== "2025-Q4")]));
    expect(batch.observations).toHaveLength(24);
    expect(batch.observations.some(o => o.period.label === "2025-Q4")).toBe(false);
  });
});
