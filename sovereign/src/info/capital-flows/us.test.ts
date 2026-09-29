import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createTicTransactionsAdapter, createUsCashFinancingAdapter } from "./us.ts";
import { CAPITAL_LIMITS, nativeValue, type AdapterContext, type CapitalFlowAdapter, type SourceBatch } from "./model.ts";
import { createAdapterTransport, createRequestPool } from "./transport.ts";
import { createCapitalFlowsCache, validateSourceBatch } from "./snapshot.ts";

const fixture = readFileSync(new URL("./fixtures/tic-table4-grand-total.excerpt.txt", import.meta.url), "utf8");
const fetchedAt = "2026-09-09T22:45:00.000Z"; // Synthetic transport clock, never publisher metadata.
const marker = "country\tcountry_code\tdate\t";
function alter(text: string, mutate: (rows: string[][], header: string[]) => void): string {
  const lines = text.split(/\r\n|\n/);
  const start = lines.findIndex(line => line.startsWith(marker));
  const end = lines.findIndex((line, i) => i > start && /^\t*$/.test(line));
  const header = lines[start]!.split("\t");
  const rows = lines.slice(start + 1, end).map(line => line.split("\t"));
  mutate(rows, header);
  return [...lines.slice(0, start), header.join("\t"), ...rows.map(row => row.join("\t")), ...lines.slice(end)].join("\n");
}
function valueChanged(column: string, token: string): string {
  return alter(fixture, (rows, header) => { rows[0]![header.indexOf(column)] = token; });
}
async function load(text = fixture, adapter = createTicTransactionsAdapter()) {
  let charged = 0;
  let finalAssert: [number, number] | null = null;
  const receipt = { url: adapter.definition.resources[0]!, retrievedAt: fetchedAt, lastModified: "Mon, 17 Aug 2026 14:00:00 GMT", etag: '"fixture"', decodedBytes: Buffer.byteLength(text) };
  const ctx: AdapterContext = {
    signal: new AbortController().signal,
    async fetchText(url) { expect(url).toBe(receipt.url); return { text, url, headers: { "last-modified": receipt.lastModified }, receipt }; },
    consumeRows(count) { charged += count; finalAssert = null; if (charged > CAPITAL_LIMITS.rows) throw new Error("row_limit"); },
    assertComplete(received, expected) { expect(received).toBe(charged); expect(received).toBe(expected); finalAssert = [received, expected]; },
  };
  const batch = await adapter.load(ctx);
  expect(finalAssert).not.toBeNull();
  expect(batch.receipts[0]).toBe(receipt);
  return { batch, charged, adapter };
}
const find = (batch: SourceBatch, stem: string, kind: string, month = "2026-06") => batch.observations.find(o => o.seriesId === `us-tic-${stem}-${kind}` && o.period.label === month)!;

async function throughTransport(text: string, adapter: CapitalFlowAdapter = createTicTransactionsAdapter()) {
  const pool = createRequestPool();
  try {
    const transport = createAdapterTransport({
      definition: adapter.definition, signal: new AbortController().signal, pool, now: () => Date.parse(fetchedAt), rightsAllowed: () => true,
      fetch: async () => new Response(text, { headers: { "last-modified": "Mon, 17 Aug 2026 14:00:00 GMT" } }),
    });
    const batch = await adapter.load(transport.context);
    transport.validateBatchAccounting(batch.receipts, batch.observations.length);
    return validateSourceBatch(adapter, batch);
  } finally { pool.dispose(); }
}

describe("TIC Table 4 native source excerpt", () => {
  it("reconciles foreign-perspective signs, exact USD millions and complete month dates", async () => {
    const { batch, charged, adapter } = await load();
    expect(charged).toBe(41);
    expect(adapter.series).toHaveLength(9);
    expect(batch.observations).toHaveLength(24 * 9);
    for (const [stem, a, b, net] of [["treas", "3853609", "3846831", "6778"], ["corp", "389816", "354183", "35633"], ["eqty", "6815219", "6633793", "181426"]]) {
      const purchases = find(batch, stem!, "purchases"), sales = find(batch, stem!, "sales"), derived = find(batch, stem!, "netAcquisition");
      expect(purchases.value?.publisherLexeme).toBe(a);
      expect(sales.value?.publisherLexeme).toBe(b);
      expect(derived.value?.decimal).toBe(net);
      expect(derived.receipt.inputObservationIds).toEqual([purchases.id, sales.id]);
      expect(derived.receipt.method).toBe("derivedCompatibleComponents");
      expect(purchases.value).toMatchObject({ currency: "USD", unitExponent: 6, unitMultiplier: "1000000", unit: "million USD" });
      expect(derived.period).toEqual({ frequency: "monthly", label: "2026-06", start: "2026-06-01", end: "2026-06-30" });
    }
    const months = [...new Set(batch.observations.map(o => o.period.label))].sort();
    expect(months[0]).toBe("2024-07");
    expect(months[23]).toBe("2026-06");
    expect(validateSourceBatch(adapter, batch).observations).toHaveLength(216);
  });

  it("keeps actual retrieval receipts separate from unknown publication and revision metadata", async () => {
    const batch = await throughTransport(fixture);
    for (const o of batch.observations) {
      expect(o.receipt.retrievedAt).toBe(fetchedAt);
      expect(o.receipt.publicationAt).toBeNull();
      expect(o.provisional).toBe(false);
      expect(o.revised).toBe(false);
      expect(o.estimated).toBe(false);
      expect(o.publisherStatus).toBeNull();
    }
    expect(batch.receipts[0]?.lastModified).toBe("Mon, 17 Aug 2026 14:00:00 GMT");
    const adapter = createTicTransactionsAdapter();
    expect(adapter.definition.rights.status).toBe("allowed");
    expect(adapter.definition.rights.checkedAt).toBeNull();
    expect(adapter.definition.rights.note).toContain("Not an invented licence");
    for (const s of adapter.series) {
      expect(s.seasonalAdjustment).toBe("unknown");
      expect(s.annualization).toBe("notAnnualized");
      expect(s.valuation).toContain("settlement");
      expect(s.geography.issuer?.code).toBe("US");
      expect(s.geography.investor?.code).toBe("non-US");
    }
  });

  it("never sums overlapping countries or memo rows and charges discarded records", async () => {
    const text = alter(fixture, rows => {
      rows.push(["Of Which: Foreign Official", "99990", ...rows[0]!.slice(2)]);
      rows.push(["China, Mainland", "57006", ...rows[0]!.slice(2)]);
      rows.push(["Total Asia", "59998", ...rows[0]!.slice(2)]);
    });
    const { batch, charged } = await load(text);
    expect(charged).toBe(44);
    expect(batch.observations).toHaveLength(216);
    expect(find(batch, "treas", "netAcquisition").value?.decimal).toBe("6778");
    await throughTransport(text);
  });

  it("isolates human headings/footnotes and parses quoted fields with CRLF", async () => {
    const text = alter(fixture, rows => {
      rows[0] = rows[0]!.map(cell => `"${cell}"`);
      rows.push(['"A ""quoted"" country"', "11111", ...rows[1]!.slice(2)]);
    }).replaceAll("\n", "\r\n");
    const { batch, charged } = await load(text);
    expect(charged).toBe(42);
    expect(find(batch, "treas", "purchases").value?.decimal).toBe("3853609");
    expect(batch.observations.every(o => o.period.label.startsWith("202"))).toBe(true);
  });

  it("preserves precision beyond Number and performs exact decimal subtraction", async () => {
    const text = alter(fixture, (rows, header) => {
      rows[0]![header.indexOf("for_lt_treas_sale")] = "9007199254740993.10";
      rows[0]![header.indexOf("for_lt_treas_pur")] = "9007199254740992.009";
    });
    const batch = await throughTransport(text);
    expect(find(batch, "treas", "purchases").value).toMatchObject({ publisherLexeme: "9007199254740993.10", raw: "900719925474099310", decimals: 2 });
    expect(find(batch, "treas", "netAcquisition").value?.decimal).toBe("1.091");
  });

  it("distinguishes n.a., -0 and zero; missing leg makes the derived net explicitly missing", async () => {
    const text = alter(fixture, (rows, header) => {
      rows[0]![header.indexOf("for_lt_treas_sale")] = "n.a.";
      rows[0]![header.indexOf("for_lt_corp_sale")] = "-0";
      rows[0]![header.indexOf("for_lt_corp_pur")] = "0";
    });
    const batch = await throughTransport(text);
    expect(find(batch, "treas", "purchases")).toMatchObject({ value: null, status: "missing", publisherStatus: "n.a." });
    expect(find(batch, "treas", "netAcquisition")).toMatchObject({ value: null, status: "missing", publisherStatus: null });
    expect(find(batch, "corp", "purchases")).toMatchObject({ status: "observed", value: { publisherLexeme: "-0", decimal: "0" } });
    expect(find(batch, "corp", "netAcquisition").value?.decimal).toBe("0");
  });

  it("emits missing published legs and same-batch derived input IDs before core validation", async () => {
    const { batch } = await load(valueChanged("for_lt_treas_sale", "n.a."));
    const purchases = find(batch, "treas", "purchases"), sales = find(batch, "treas", "sales"), net = find(batch, "treas", "netAcquisition");
    expect(purchases).toMatchObject({ value: null, status: "missing", publisherStatus: "n.a." });
    expect(net).toMatchObject({ value: null, status: "missing", publisherStatus: null });
    expect(net.receipt.inputObservationIds).toEqual([purchases.id, sales.id]);
    const zero = await load(valueChanged("for_lt_treas_sale", "-0"));
    expect(find(zero.batch, "treas", "purchases")).toMatchObject({ status: "observed", value: { publisherLexeme: "-0", decimal: "0" } });
  });

  it("keeps signed net outflows negative rather than reversing the US columns", async () => {
    const { batch } = await load(valueChanged("for_lt_treas_sale", "1"));
    expect(find(batch, "treas", "netAcquisition").value?.decimal).toBe("-3846830");
  });

  it("accepts explicit missing across all series instead of treating them as absent declarations", async () => {
    const text = alter(fixture, rows => { for (const row of rows) row.fill("n.a.", 3); });
    const batch = await throughTransport(text);
    expect(batch.observations).toHaveLength(216);
    expect(batch.observations.every(o => o.status === "missing" && o.value === null)).toBe(true);
  });

  it("marks the February 2023 break when that reported period is in the selected history", async () => {
    const text = alter(fixture, rows => { rows.splice(0, rows.length - 2); });
    const { batch } = await load(text);
    expect(batch.observations.filter(o => o.period.label === "2023-02").every(o => o.break)).toBe(true);
    expect(batch.observations.filter(o => o.period.label === "2023-03").every(o => !o.break)).toBe(true);
  });
});

describe("TIC atomic validation and bounds", () => {
  it.each([
    ["duplicate Grand Total", (rows: string[][]) => { rows.push([...rows[0]!]); }],
    ["duplicate discarded country", (rows: string[][]) => { const row = ["China, Mainland", "57006", ...rows[0]!.slice(2)]; rows.push(row, [...row]); }],
    ["duplicate old excluded month", (rows: string[][]) => { rows.push([...rows[40]!]); }],
    ["Grand Total wrong code", (rows: string[][]) => { rows[0]![1] = "99990"; }],
    ["Grand Total wrong label", (rows: string[][]) => { rows[0]![0] = "Total Europe"; }],
    ["country code label conflict", (rows: string[][]) => { rows.push(["A", "11111", ...rows[0]!.slice(2)], ["B", "11111", ...rows[1]!.slice(2)]); }],
    ["missing interior month", (rows: string[][]) => { rows.splice(2, 1); }],
    ["latest Grand Total absent", (rows: string[][]) => { rows[0]![0] = "China, Mainland"; rows[0]![1] = "57006"; }],
    ["unknown period", (rows: string[][]) => { rows[0]![2] = "2026-13"; }],
    ["incomplete current month", (rows: string[][]) => { rows[0]![2] = "2026-09"; }],
    ["prebreak method mixing", (rows: string[][]) => { rows[0]![2] = "2023-01"; }],
    ["truncated record", (rows: string[][]) => { rows[0]!.pop(); }],
    ["blank middle record", (rows: string[][]) => { rows.splice(3, 0, [""]); }],
  ])("rejects %s", async (_label, mutate) => {
    await expect(load(alter(fixture, mutate))).rejects.toThrow();
  });

  it.each(["", "null", "NaN", "1,234", "n.a. ", "1*", "1e9", "1".repeat(129)])("rejects malformed expected numeric token %j without zero substitution", async token => {
    await expect(load(valueChanged("for_lt_treas_sale", token))).rejects.toThrow();
  });

  it("also rejects malformed excluded columns and discarded country values", async () => {
    await expect(load(valueChanged("us_lt_eqty_sale", "oops"))).rejects.toThrow();
    const text = alter(fixture, rows => { const row = ["A", "11111", ...rows[0]!.slice(2)]; row[3] = "oops"; rows.push(row); });
    await expect(load(text)).rejects.toThrow();
  });

  it.each([
    ["wrong unit", fixture.replace("Millions of dollars", "Billions of dollars")],
    ["wrong table", fixture.replace("Table 4:", "Table 3:")],
    ["wrong column name", fixture.replace("for_lt_treas_sale\t", "for_lt_bill_sale\t")],
    ["duplicate column", fixture.replace("for_lt_treas_sale\t", "for_lt_total_sale\t")],
    ["wrong direction note", fixture.replace("Sales are sales by the U.S.", "Sales are purchases by the U.S.")],
    ["missing footer", fixture.slice(0, fixture.indexOf("Definitions:"))],
  ])("rejects %s", async (_label, text) => { await expect(load(text)).rejects.toThrow(); });

  it("rejects an early footer that would silently truncate selected history", async () => {
    const text = alter(fixture, rows => { rows.splice(3, 0, ["Definitions:"]); });
    await expect(load(text)).rejects.toThrow("tic_data_after_footer");
  });

  it("enforces the response byte and parsed row ceilings", async () => {
    await expect(throughTransport("x".repeat(CAPITAL_LIMITS.responseBytes + 1))).rejects.toThrow("response_byte_limit");
    const text = alter(fixture, rows => {
      const sample = rows[0]!;
      rows.splice(0, rows.length);
      for (let i = 0; i < CAPITAL_LIMITS.rows + 1; i++) rows.push(["A", String(10000 + i), sample[2]!, ...Array(18).fill("0")]);
    });
    await expect(load(text)).rejects.toThrow("csv_row_limit");
  });

  it("honors cancellation before fetching", async () => {
    const controller = new AbortController(); controller.abort();
    let fetched = false;
    await expect(createTicTransactionsAdapter().load({ signal: controller.signal, fetchText: async () => { fetched = true; throw new Error("unexpected"); }, consumeRows() {}, assertComplete() {} })).rejects.toThrow();
    expect(fetched).toBe(false);
  });
});

describe("TIC gross transaction sign contract", () => {
  const columns = fixture.split(/\r?\n/).find(line => line.startsWith(marker))!.split("\t").slice(3);

  it.each(columns)("rejects negative gross %s before normalization", async column => {
    const text = valueChanged(column, "-1");
    await expect(load(text)).rejects.toThrow("tic_negative_gross");
    await expect(throughTransport(text)).rejects.toThrow("tic_negative_gross");
  });

  it.each(["-0.01", "-000.010", "-0.000000000000000000000000000001", "-9007199254740993"])(
    "rejects exact negative nonzero token %s in either gross direction", async token => {
      for (const column of ["for_lt_treas_sale", "for_lt_treas_pur"]) {
        await expect(throughTransport(valueChanged(column, token))).rejects.toThrow("tic_negative_gross");
      }
    });

  it.each(["country", "region", "memo", "older Grand Total"])("rejects negative excluded-column values on a discarded %s row", async kind => {
    const text = alter(fixture, (rows, header) => {
      let row = rows.at(-1)!; // An older Grand Total month outside the selected 24 months.
      if (kind !== "older Grand Total") {
        const [country, code] = kind === "country" ? ["China, Mainland", "57006"]
          : kind === "region" ? ["Total Asia", "59998"] : ["Of Which: Foreign Official", "99990"];
        row = [country!, code!, ...rows[0]!.slice(2)]; rows.push(row);
      }
      row[header.indexOf("us_lt_eqty_pur")] = "-1"; // Not one of the six published gross columns.
    });
    await expect(load(text)).rejects.toThrow("tic_negative_gross");
    await expect(throughTransport(text)).rejects.toThrow("tic_negative_gross");
  });

  it.each(["-0", "-0.000", "-000.000"])("preserves zero lexeme %s in every gross column", async token => {
    const text = alter(fixture, rows => { for (const row of rows) row.fill(token, 3); });
    const batch = await throughTransport(text);
    expect(batch.observations).toHaveLength(216);
    for (const o of batch.observations) {
      expect(o.status).toBe("observed");
      expect(o.value).toMatchObject({ decimal: "0", currency: "USD", unitExponent: 6, unitMultiplier: "1000000" });
      if (o.receipt.method === "publisherReported") expect(o.value?.publisherLexeme).toBe(token);
    }
  });

  it("allows negative derived nets through transport while both published legs remain nonnegative", async () => {
    const text = alter(fixture, (rows, header) => {
      rows[0]![header.indexOf("for_lt_treas_sale")] = "1";
      rows[0]![header.indexOf("for_lt_treas_pur")] = "2";
    });
    const batch = await throughTransport(text);
    expect(find(batch, "treas", "purchases").value?.decimal).toBe("1");
    expect(find(batch, "treas", "sales").value?.decimal).toBe("2");
    expect(find(batch, "treas", "netAcquisition")).toMatchObject({ status: "observed", value: { decimal: "-1", unitExponent: 6 }, receipt: { method: "derivedCompatibleComponents" } });
  });

  it.each(["for_lt_treas_sale", "for_lt_treas_pur"])("retains prior histories and actual receipts when %s becomes negative", async column => {
    let now = Date.parse(fetchedAt), text = fixture;
    const cache = createCapitalFlowsCache([createTicTransactionsAdapter()], { now: () => now, fetch: async () => new Response(text), coldWaitMs: 0 });
    const refresh = async () => { await cache.read(); await cache.waitForIdle(); return (await cache.read()).snapshot; };
    try {
      const initial = await refresh();
      expect(initial.sources[0]?.retrievalState).toBe("current");
      expect(initial.series.find(s => s.definition.id === "us-tic-treas-netAcquisition")!.history.at(-1)!.value?.decimal).toBe("6778");
      now += 6 * 60 * 60 * 1000 + 1;
      text = valueChanged(column, "-1");
      const fallback = await refresh();
      expect(fallback.sources[0]?.retrievalState).toBe("fallback");
      expect(fallback.sources[0]?.failure).toBe("upstream_failed");
      expect(fallback.sources[0]?.lastSuccessAt).toBe(initial.sources[0]?.lastSuccessAt);
      expect(fallback.sources[0]?.receipts).toEqual(initial.sources[0]?.receipts);
      expect(fallback.series.map(s => s.history)).toEqual(initial.series.map(s => s.history));
    } finally { cache.dispose(); }
  });
});

describe("TIC latest-revised replacement through the core cache", () => {
  it("replaces revised values, clears prior latest nets on missing legs, and preserves last-good on malformed input", async () => {
    let now = Date.parse(fetchedAt), text = fixture;
    const cache = createCapitalFlowsCache([createTicTransactionsAdapter()], { now: () => now, fetch: async () => new Response(text), coldWaitMs: 0 });
    const refresh = async () => { await cache.read(); await cache.waitForIdle(); return (await cache.read()).snapshot; };
    const latest = (snapshot: Awaited<ReturnType<typeof refresh>>, id: string) => snapshot.series.find(s => s.definition.id === id)!.history.at(-1)!;
    try {
      const initial = await refresh();
      expect(latest(initial, "us-tic-treas-netAcquisition").value?.decimal).toBe("6778");
      now += 6 * 60 * 60 * 1000 + 1;
      text = valueChanged("for_lt_treas_sale", "3853610");
      const revised = await refresh();
      expect(latest(revised, "us-tic-treas-netAcquisition").value?.decimal).toBe("6779");
      expect(latest(revised, "us-tic-treas-purchases").revised).toBe(false); // No invented publisher flag.
      now += 6 * 60 * 60 * 1000 + 1;
      text = valueChanged("for_lt_treas_sale", "n.a.");
      const missing = await refresh();
      const net = latest(missing, "us-tic-treas-netAcquisition");
      expect(net).toMatchObject({ value: null, status: "missing", period: { label: "2026-06" } });
      expect(missing.sources[0]?.retrievalState).toBe("current");
      now += 6 * 60 * 60 * 1000 + 1;
      text = valueChanged("for_lt_treas_sale", "oops");
      const fallback = await refresh();
      expect(latest(fallback, "us-tic-treas-netAcquisition")).toEqual(net);
      expect(fallback.sources[0]?.retrievalState).toBe("fallback");
    } finally { cache.dispose(); }
  });
});

interface DtsPayload {
  data: Record<string, string>[];
  meta: { count: number; labels: Record<string, string>; dataTypes: Record<string, string>; dataFormats: Record<string, string>; "total-count": number; "total-pages": number };
  links: Record<string, string | null>;
}
const dtsTexts = ["issues", "redemptions"].map(leg => readFileSync(new URL(`./fixtures/us-dts-${leg}-rolling.native.json`, import.meta.url), "utf8"));
const dtsSavedReceipts = ["issues", "redemptions"].map(leg => JSON.parse(readFileSync(new URL(`./fixtures/us-dts-${leg}-rolling.receipt.json`, import.meta.url), "utf8")));
function alterDts(mutate: (pages: DtsPayload[]) => void): string[] {
  const pages = dtsTexts.map(text => JSON.parse(text) as DtsPayload);
  mutate(pages);
  return pages.map(page => JSON.stringify(page));
}
const dtsFind = (batch: SourceBatch, kind: string, date = "2026-09-08") => batch.observations.find(o => o.seriesId === `us-dts-${kind}` && o.period.label === date)!;
async function loadDts(texts = dtsTexts) {
  const adapter = createUsCashFinancingAdapter();
  const receipts = texts.map((text, i) => Object.freeze({ url: adapter.definition.resources[i]!,
    retrievedAt: new Date(Date.parse(fetchedAt) + i * 1000).toISOString(), etag: `"fixture-${i}"`,
    lastModified: "Wed, 09 Sep 2026 12:00:00 GMT", decodedBytes: Buffer.byteLength(text) }));
  let charged = 0;
  let complete: [number, number] | null = null;
  const calls: string[] = [];
  const batch = await adapter.load({
    signal: new AbortController().signal,
    async fetchText(url) {
      expect(url).toBe(adapter.definition.resources[calls.length]);
      const i = calls.length; calls.push(url); complete = null;
      return { text: texts[i]!, url, headers: {}, receipt: receipts[i]! };
    },
    consumeRows(count) { charged += count; complete = null; if (charged > CAPITAL_LIMITS.rows) throw new Error("row_limit"); },
    assertComplete(received, expected) {
      expect(calls).toHaveLength(2); expect(received).toBe(charged); expect(received).toBe(expected);
      complete = [received, expected];
    },
  });
  expect(complete).not.toBeNull();
  expect(batch.receipts[0]).toBe(receipts[0]); expect(batch.receipts[1]).toBe(receipts[1]);
  return { adapter, batch, charged, complete, calls, receipts };
}
async function dtsThroughTransport(texts = dtsTexts, delayFirst = false) {
  const adapter = createUsCashFinancingAdapter(), pool = createRequestPool();
  const events: string[] = [];
  let clock = Date.parse(fetchedAt);
  try {
    const transport = createAdapterTransport({ definition: adapter.definition, signal: new AbortController().signal, pool,
      now: () => clock++, rightsAllowed: () => true,
      fetch: async (url, init) => {
        const i = adapter.definition.resources.indexOf(url);
        expect(i).toBeGreaterThanOrEqual(0); expect(init.method).toBe("GET"); expect(init.redirect).toBe("manual");
        events.push(`start-${i}`);
        return new Response(new ReadableStream<Uint8Array>({ async start(controller) {
          if (delayFirst && i === 0) await new Promise(resolve => setTimeout(resolve, 15));
          controller.enqueue(new TextEncoder().encode(texts[i]!));
          events.push(`body-${i}`); controller.close();
        } }), { headers: { etag: `"fixture-${i}"`, "last-modified": "Wed, 09 Sep 2026 12:00:00 GMT" } });
      },
    });
    const raw = await adapter.load(transport.context);
    transport.validateBatchAccounting(raw.receipts, raw.observations.length);
    return { batch: validateSourceBatch(adapter, raw), raw, receipts: transport.receipts, events };
  } finally { pool.dispose(); }
}

// These mutations below are synthetic contract tests, not new publisher facts.
function shorterDts(page: DtsPayload, count: number) {
  page.data = page.data.slice(0, count);
  page.meta.count = count; page.meta["total-count"] = count; page.meta["total-pages"] = 1;
  page.links.next = null; page.links.last = page.links.first!;
}

describe("US DTS native paired latest-page cash financing", () => {
  it("retains a correctly labelled non-envelope excerpt with independently checkable cash legs", () => {
    const excerpt = JSON.parse(readFileSync(new URL("./fixtures/us-dts-cash-debt.excerpt.json", import.meta.url), "utf8"));
    expect(excerpt.representative_subset).toBe(true);
    expect(excerpt.meta).toBeUndefined();
    expect(excerpt.links).toBeUndefined();
    const unit = { currency: "USD", exponent: 6, label: "million USD" };
    for (const [date, expected] of [["2026-09-04", "-12501"], ["2026-09-08", "-26022"]]) {
      const rows = excerpt.data.filter((row: Record<string, string>) => row.record_date === date);
      expect(rows).toHaveLength(2);
      expect(rows.every((row: Record<string, string>) => row.table_nbr === "II")).toBe(true);
      const issue = rows.find((row: Record<string, string>) => row.transaction_catg === "Public Debt Cash Issues (Table IIIB)" && row.transaction_type === "Deposits");
      const redemption = rows.find((row: Record<string, string>) => row.transaction_catg === "Public Debt Cash Redemp. (Table IIIB)" && row.transaction_type === "Withdrawals");
      expect((BigInt(nativeValue(issue.transaction_today_amt, unit).raw) - BigInt(nativeValue(redemption.transaction_today_amt, unit).raw)).toString()).toBe(expected);
    }
  });

  it("uses the exact two verified URLs, retaining untouched native envelopes and separate transport evidence", () => {
    const adapter = createUsCashFinancingAdapter();
    expect(adapter.definition.resources).toEqual(dtsSavedReceipts.map(receipt => receipt.url));
    for (const [i, resource] of adapter.definition.resources.entries()) {
      const url = new URL(resource);
      expect(url.hash).toBe(""); expect(resource).not.toContain("+"); expect(resource).toContain("%20");
      expect(url.searchParams.get("filter")).toBe(`transaction_catg:eq:Public Debt Cash ${i ? "Redemp." : "Issues"} (Table IIIB),transaction_type:eq:${i ? "Withdrawals" : "Deposits"},table_nbr:eq:II`);
      expect(url.searchParams.get("sort")).toBe("-record_date");
      expect(url.searchParams.get("page[size]")).toBe("60");
      expect(url.searchParams.get("filter")).not.toMatch(/record_date|:in:/);
      const page = JSON.parse(dtsTexts[i]!);
      expect(Object.keys(page).sort()).toEqual(["data", "links", "meta"]);
      expect(page.meta).toMatchObject({ count: 60, "total-count": 1000, "total-pages": 17 });
      expect(Buffer.byteLength(dtsTexts[i]!)).toBe(dtsSavedReceipts[i].decodedBytes);
      expect(dtsSavedReceipts[i]).toMatchObject({ status: 200, etag: null, lastModified: null });
    }
  });

  it("publishes 180 compatible daily observations with exact cash signs, periods and USD scale", async () => {
    const { adapter, batch, charged, complete } = await loadDts();
    expect(charged).toBe(120); expect(complete).toEqual([120, 120]);
    expect(adapter.series).toHaveLength(3); expect(batch.observations).toHaveLength(180);
    for (const [date, issue, redemption, net] of [["2026-09-08", "265484", "291506", "-26022"], ["2026-09-04", "1376", "13877", "-12501"]]) {
      const a = dtsFind(batch, "issuance", date), b = dtsFind(batch, "redemptions", date), n = dtsFind(batch, "netIssuance", date);
      expect(a.value).toMatchObject({ publisherLexeme: issue, decimal: issue, currency: "USD", unitExponent: 6, unitMultiplier: "1000000", unit: "million USD" });
      expect(b.value?.publisherLexeme).toBe(redemption); expect(n.value?.decimal).toBe(net);
      expect(n.receipt.inputObservationIds).toEqual([a.id, b.id]); expect(n.receipt.method).toBe("derivedCompatibleComponents");
      expect(n.period).toEqual({ frequency: "daily", label: date, start: date, end: date });
      expect(n.period).toEqual(a.period); expect(n.period).toEqual(b.period);
    }
    expect(dtsFind(batch, "netIssuance", "2026-06-15").value?.decimal).toBe("76293");
    expect(batch.observations.every(o => o.period.label >= "2026-06-15" && o.period.label <= "2026-09-08")).toBe(true);
    for (const series of adapter.series) {
      for (const field of ["unit", "perspective", "geography", "instrument", "sector", "fundMandate", "valuation", "annualization", "seasonalAdjustment"] as const) {
        expect(series[field]).toEqual(adapter.series[0]![field]);
      }
      expect(series.geography).toMatchObject({ issuer: { code: "US" }, reporting: { code: "US" }, investor: null, fundDomicile: null });
    }
    expect(validateSourceBatch(adapter, batch).observations).toHaveLength(180);
  });

  it("returns transport receipts in sequential body-completion order without following any other page", async () => {
    const { batch, raw, receipts, events } = await dtsThroughTransport(dtsTexts, true);
    expect(events).toEqual(["start-0", "body-0", "start-1", "body-1"]);
    expect(receipts).toHaveLength(2); expect(raw.receipts[0]).toBe(receipts[0]); expect(raw.receipts[1]).toBe(receipts[1]);
    expect(batch.observations).toHaveLength(180);
    expect(receipts[0]!.retrievedAt).not.toBe(receipts[1]!.retrievedAt);
    expect(dtsFind(batch, "issuance").receipt.retrievedAt).toBe(receipts[0]!.retrievedAt);
    expect(dtsFind(batch, "redemptions").receipt.retrievedAt).toBe(receipts[1]!.retrievedAt);
    expect(dtsFind(batch, "netIssuance").receipt.retrievedAt).toBe(receipts[1]!.retrievedAt);
    for (const o of batch.observations) {
      expect(o.receipt.publicationAt).toBeNull(); expect(o.publisherStatus).toBeNull(); expect(o.publisherConfidentiality).toBeNull();
      expect(o.provisional).toBe(false); expect(o.revised).toBe(false); expect(o.estimated).toBe(false); expect(o.break).toBe(false);
      expect(o.receipt.limitations.join(" ")).toContain("selected 60 of 1000 matching publisher records, page 1 of 17");
      expect(o.receipt.limitations.join(" ")).toContain("not final or revision-free");
      expect(o.receipt.limitations.join(" ")).toContain("not full historical pagination");
    }
  });

  it("accepts fewer than 60 only when the publisher has fewer records and both full date sets match", async () => {
    const texts = alterDts(pages => pages.forEach(page => shorterDts(page, 2)));
    const { batch, complete } = await loadDts(texts);
    expect(batch.observations).toHaveLength(6); expect(complete).toEqual([4, 4]);
    expect(dtsFind(batch, "netIssuance").receipt.limitations.join(" ")).toContain("selected 2 of 2 matching publisher records, page 1 of 1");
    await dtsThroughTransport(texts);
  });

  it("retains arbitrary source-line numbers and uses neither cumulative totals nor rounded components", async () => {
    const texts = alterDts(pages => pages.forEach((page, i) => page.data.forEach(row => {
      row.src_line_nbr = String(700 + i); row.transaction_mtd_amt = "999999999001"; row.transaction_fytd_amt = "999999999002";
    })));
    const { batch } = await dtsThroughTransport(texts);
    expect(dtsFind(batch, "netIssuance").value?.decimal).toBe("-26022");
    const json = JSON.stringify(batch);
    expect(json).not.toContain("999999999001"); expect(json).not.toContain("999999999002");
    expect(json).not.toContain('"src_line_nbr"'); expect(json).not.toContain('"dataFormats"');
    expect(json).not.toContain('"inputValues"'); expect(json).not.toContain('"rawResponse"');
  });

  it("keeps exact decimal lexemes beyond Number and both positive and negative cash directions", async () => {
    const texts = alterDts(pages => {
      pages[0]!.data[0]!.transaction_today_amt = "9007199254740993.10";
      pages[1]!.data[0]!.transaction_today_amt = "9007199254740992.009";
      pages[0]!.data[1]!.transaction_today_amt = "1"; pages[1]!.data[1]!.transaction_today_amt = "2";
    });
    const { batch } = await dtsThroughTransport(texts);
    expect(dtsFind(batch, "issuance").value).toMatchObject({ publisherLexeme: "9007199254740993.10", raw: "900719925474099310", decimals: 2 });
    expect(dtsFind(batch, "netIssuance").value?.decimal).toBe("1.091");
    expect(dtsFind(batch, "netIssuance", "2026-09-04").value?.decimal).toBe("-1");
  });

  it.each([["null", "0", null], ["0", "null", null], ["null", "null", null], ["-0", "0", "0"], ["0", "0", "0"]])(
    "distinguishes source string tokens %s minus %s from observed zero", async (a, b, net) => {
      const texts = alterDts(pages => { pages[0]!.data[0]!.transaction_today_amt = a!; pages[1]!.data[0]!.transaction_today_amt = b!; });
      const { batch } = await dtsThroughTransport(texts);
      for (const [kind, token] of [["issuance", a], ["redemptions", b]]) {
        const o = dtsFind(batch, kind!);
        expect(o.status).toBe(token === "null" ? "missing" : "observed");
        expect(o.publisherStatus).toBe(token === "null" ? "null" : null);
        if (token === "null") expect(o.value).toBeNull(); else expect(o.value?.publisherLexeme).toBe(token);
      }
      const n = dtsFind(batch, "netIssuance");
      expect(n.value?.decimal ?? null).toBe(net); expect(n.status).toBe(net === null ? "missing" : "observed");
      expect(n.publisherStatus).toBeNull(); expect(n.receipt.inputObservationIds).toHaveLength(2);
    });

  it("accepts a complete window of explicit missing observations rather than substituting old values", async () => {
    const { batch } = await dtsThroughTransport(alterDts(pages => pages.forEach(page => page.data.forEach(row => { row.transaction_today_amt = "null"; }))));
    expect(batch.observations).toHaveLength(180);
    expect(batch.observations.every(o => o.value === null && o.status === "missing")).toBe(true);
  });
});

describe("US DTS fail-closed native contract", () => {
  it.each([
    ["today unit", (p: DtsPayload) => { p.meta.dataFormats.transaction_today_amt = "$1,000"; }],
    ["MTD unit", (p: DtsPayload) => { p.meta.dataFormats.transaction_mtd_amt = "$1"; }],
    ["FYTD unit", (p: DtsPayload) => { p.meta.dataFormats.transaction_fytd_amt = "$1,000,000,000"; }],
    ["date format", (p: DtsPayload) => { p.meta.dataFormats.record_date = "MM-DD-YYYY"; }],
    ["numeric metadata type", (p: DtsPayload) => { p.meta.dataTypes.transaction_today_amt = "NUMBER"; }],
    ["date metadata type", (p: DtsPayload) => { p.meta.dataTypes.record_date = "STRING"; }],
    ["line metadata type", (p: DtsPayload) => { p.meta.dataTypes.src_line_nbr = "STRING"; }],
    ["mislabelled today", (p: DtsPayload) => { p.meta.labels.transaction_today_amt = "Transactions Month to Date"; }],
    ["missing units", (p: DtsPayload) => { delete p.meta.dataFormats.transaction_today_amt; }],
    ["missing row field", (p: DtsPayload) => { delete p.data[0]!.transaction_today_amt; }],
    ["extra raw/noncash field", (p: DtsPayload) => { p.data[0]!.noncash_adjustment = "999"; }],
    ["wrong count", (p: DtsPayload) => { p.meta.count = 59; }],
    ["string count", (p: DtsPayload) => { p.meta.count = "60" as unknown as number; }],
    ["string total", (p: DtsPayload) => { p.meta["total-count"] = "1000" as unknown as number; }],
    ["unsafe total", (p: DtsPayload) => { p.meta["total-count"] = Number.MAX_SAFE_INTEGER + 1; }],
    ["fractional total", (p: DtsPayload) => { p.meta["total-count"] = 999.5; }],
    ["total less than count", (p: DtsPayload) => { p.meta["total-count"] = 59; p.meta["total-pages"] = 1; }],
    ["wrong pages", (p: DtsPayload) => { p.meta["total-pages"] = 16; }],
    ["missing next despite history", (p: DtsPayload) => { p.links.next = null; }],
    ["wrong last page", (p: DtsPayload) => { p.links.last = p.links.next!; }],
    ["not first page", (p: DtsPayload) => { p.links.self = p.links.next!; }],
    ["wrong first", (p: DtsPayload) => { p.links.first = p.links.next!; }],
    ["unexpected previous", (p: DtsPayload) => { p.links.prev = p.links.first!; }],
    ["wrong page size", (p: DtsPayload) => { p.links.self = p.links.self!.replace("60", "120"); }],
    ["external history link", (p: DtsPayload) => { p.links.next = "https://other.example/page2"; }],
    ["missing link", (p: DtsPayload) => { delete p.links.last; }],
    ["duplicate date", (p: DtsPayload) => { p.data[1]!.record_date = p.data[0]!.record_date!; }],
    ["unsorted dates", (p: DtsPayload) => { [p.data[0], p.data[1]] = [p.data[1]!, p.data[0]!]; }],
    ["invalid date", (p: DtsPayload) => { p.data[0]!.record_date = "2026-02-30"; }],
    ["current partial date", (p: DtsPayload) => { p.data[0]!.record_date = "2026-09-09"; }],
    ["future date", (p: DtsPayload) => { p.data[0]!.record_date = "2026-09-10"; }],
    ["numeric line", (p: DtsPayload) => { p.data[0]!.src_line_nbr = 79 as unknown as string; }],
    ["fractional line", (p: DtsPayload) => { p.data[0]!.src_line_nbr = "79.1"; }],
    ["Table IIIA accounting stock", (p: DtsPayload) => { p.data[0]!.table_nbr = "IIIA"; }],
    ["Table IIIB adjustment", (p: DtsPayload) => { p.data[0]!.table_nbr = "IIIB"; }],
    ["noncash category", (p: DtsPayload) => { p.data[0]!.transaction_catg = "Public Debt Issues (Table IIIA)"; }],
    ["wrong leg", (p: DtsPayload) => { p.data[0]!.transaction_type = "Withdrawals"; }],
    ["malformed unused MTD", (p: DtsPayload) => { p.data[0]!.transaction_mtd_amt = "bad"; }],
    ["malformed unused FYTD", (p: DtsPayload) => { p.data[0]!.transaction_fytd_amt = "bad"; }],
  ])("rejects %s atomically", async (_label, mutate) => {
    await expect(loadDts(alterDts(pages => mutate(pages[0]!)))).rejects.toThrow();
  });

  it.each(["", "n.a.", "NULL", "null ", "1,000", "1e6", "NaN", "1*", "1".repeat(129), null, 0])(
    "rejects invalid amount token/type %j rather than silently normalizing it", async token => {
      await expect(loadDts(alterDts(pages => { pages[0]!.data[0]!.transaction_today_amt = token as string; }))).rejects.toThrow();
    });

  it.each([0, 30, 59])("rejects %s rows when publisher metadata still reports more available", async count => {
    await expect(loadDts(alterDts(pages => pages.forEach(page => { page.data = page.data.slice(0, count); page.meta.count = count; })))).rejects.toThrow();
  });

  it("rejects truncated, empty, excerpt, malformed and oversized envelopes", async () => {
    const excerpt = readFileSync(new URL("./fixtures/us-dts-cash-debt.excerpt.json", import.meta.url), "utf8");
    for (const text of [dtsTexts[0]!.slice(0, -1), "{}", "null", "[]", excerpt, "x".repeat(CAPITAL_LIMITS.responseBytes + 1)]) {
      await expect(loadDts([text, dtsTexts[1]!])).rejects.toThrow();
    }
    await expect(dtsThroughTransport(["x".repeat(CAPITAL_LIMITS.responseBytes + 1), dtsTexts[1]!])).rejects.toThrow("response_byte_limit");
  });

  it("rejects an extra row, charging all parsed rows before any output", async () => {
    const adapter = createUsCashFinancingAdapter(); let charged = 0, asserted = false;
    const text = alterDts(pages => { pages[0]!.data.push({ ...pages[0]!.data[0]! }); pages[0]!.meta.count++; })[0]!;
    await expect(adapter.load({ signal: new AbortController().signal,
      async fetchText(url) { return { text, url, headers: {}, receipt: { url, retrievedAt: fetchedAt, decodedBytes: Buffer.byteLength(text), etag: null, lastModified: null } }; },
      consumeRows(count) { charged += count; }, assertComplete() { asserted = true; },
    })).rejects.toThrow();
    expect(charged).toBe(61); expect(asserted).toBe(false);
  });

  it.each([0, 15, 59])("rejects mismatched edge or interior date sets at row %s", async index => {
    const texts = alterDts(pages => {
      const date = pages[1]!.data[index]!.record_date!;
      pages[1]!.data[index]!.record_date = new Date(Date.parse(`${date}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
    });
    await expect(loadDts(texts)).rejects.toThrow();
  });

  it("rejects individually complete but unequal shorter selections and mismatched newest windows", async () => {
    await expect(loadDts(alterDts(pages => { shorterDts(pages[0]!, 2); shorterDts(pages[1]!, 3); }))).rejects.toThrow("dts_unpaired_dates");
    await expect(loadDts(alterDts(pages => {
      pages[1]!.data.shift(); shorterDts(pages[0]!, 2); shorterDts(pages[1]!, 2);
    }))).rejects.toThrow("dts_unpaired_dates");
  });

  it("validates redemptions just as strictly and does not accept swapped pages", async () => {
    await expect(loadDts(alterDts(pages => { pages[1]!.meta.dataFormats.transaction_today_amt = "$1"; }))).rejects.toThrow("dts_metadata");
    await expect(loadDts([dtsTexts[1]!, dtsTexts[0]!])).rejects.toThrow("dts_cash_scope");
  });

  it("honors cancellation before fetch and between legs without asserting a partial batch", async () => {
    for (const before of [true, false]) {
      const controller = new AbortController(); if (before) controller.abort();
      let calls = 0, asserted = false;
      await expect(createUsCashFinancingAdapter().load({ signal: controller.signal,
        async fetchText(url) { calls++; controller.abort(); return { text: dtsTexts[0]!, url, headers: {}, receipt: { url, retrievedAt: fetchedAt, decodedBytes: 0, etag: null, lastModified: null } }; },
        consumeRows() {}, assertComplete() { asserted = true; },
      })).rejects.toThrow();
      expect(calls).toBe(before ? 0 : 1); expect(asserted).toBe(false);
    }
  });
});

describe("US DTS replacement and rights through the real transport/cache", () => {
  it("normalizes 3 × 60 rows, replaces revisions/missing nets, preserves receipts on failure and advances without restart", async () => {
    const adapter = createUsCashFinancingAdapter(); let texts = dtsTexts, now = Date.parse(fetchedAt), calls = 0, failSecond = false;
    const cache = createCapitalFlowsCache([adapter], { now: () => now, coldWaitMs: 0,
      fetch: async url => { calls++; const i = adapter.definition.resources.indexOf(url); expect(i).toBeGreaterThanOrEqual(0);
        return failSecond && i === 1 ? new Response("unavailable", { status: 503 }) : new Response(texts[i]!); },
    });
    const refresh = async () => { await cache.read(); await cache.waitForIdle(); return (await cache.read()).snapshot; };
    const latest = (s: Awaited<ReturnType<typeof refresh>>, kind: string) => s.series.find(row => row.definition.id === `us-dts-${kind}`)!.history.at(-1)!;
    try {
      const initial = await refresh(); expect(calls).toBe(2);
      expect(initial.sources[0]?.retrievalState).toBe("current"); expect(initial.sources[0]?.receipts).toHaveLength(2);
      expect(initial.series.map(s => s.history.length)).toEqual([60, 60, 60]);
      expect(initial.historyPolicy).toBe("latestRevisedPublisherHistoryNotVintageArchive");
      expect(latest(initial, "netIssuance").value?.decimal).toBe("-26022");
      now += 3600001; texts = alterDts(pages => { pages[0]!.data[0]!.transaction_today_amt = "265485"; });
      const revised = await refresh(); expect(latest(revised, "netIssuance").value?.decimal).toBe("-26021");
      expect(latest(revised, "issuance").revised).toBe(false);
      now += 3600001; texts = alterDts(pages => { pages[0]!.data[0]!.transaction_today_amt = "null"; });
      const missing = await refresh(); const net = latest(missing, "netIssuance");
      expect(net).toMatchObject({ status: "missing", value: null, publisherStatus: null });
      expect(missing.sources[0]?.retrievalState).toBe("current");
      now += 3600001; texts = alterDts(pages => { pages[1]!.meta.count = 59; });
      const malformed = await refresh(); expect(latest(malformed, "netIssuance")).toEqual(net);
      expect(malformed.sources[0]?.retrievalState).toBe("fallback"); expect(malformed.sources[0]?.receipts).toEqual(missing.sources[0]?.receipts);
      now += 3600001; texts = dtsTexts; failSecond = true;
      const fallback = await refresh(); expect(latest(fallback, "netIssuance")).toEqual(net);
      expect(fallback.sources[0]?.receipts).toEqual(missing.sources[0]?.receipts); expect(fallback.sources[0]?.retrievalState).toBe("fallback");
      now += 3600001; failSecond = false;
      texts = alterDts(pages => pages.forEach(page => { page.data.unshift({ ...page.data[0]!, record_date: "2026-09-09", transaction_today_amt: "10" }); page.data.pop(); }));
      // A later retrieval date is required for this synthetic newly completed day.
      now = Date.parse("2026-09-10T22:45:00Z");
      const advanced = await refresh(); expect(advanced.sources[0]?.retrievalState).toBe("current");
      expect(latest(advanced, "netIssuance")).toMatchObject({ period: { label: "2026-09-09" }, value: { decimal: "0" } });
      expect(advanced.series[0]!.history[0]!.period.label).toBe("2026-06-16"); expect(calls).toBe(12);
    } finally { cache.dispose(); }
  });

  it("gates rights before fetching and removes values, derived IDs and receipts after withdrawal", async () => {
    const adapter = createUsCashFinancingAdapter(); let permitted = false, calls = 0;
    expect(adapter.definition.rights).toMatchObject({ status: "allowed", checkedAt: null, evidenceUrl: "https://fiscaldata.treasury.gov/api-documentation/" });
    expect(adapter.definition.rights.note).toContain("commercial and noncommercial");
    expect(adapter.definition.rights.attribution).toContain("Department of the Treasury");
    for (const url of [adapter.definition.sourceUrl, adapter.definition.methodologyUrl, adapter.definition.rights.evidenceUrl,
      ...adapter.definition.resources, ...adapter.series.flatMap(s => [s.sourceUrl, s.methodologyUrl])]) expect(new URL(url).hash).toBe("");
    const cache = createCapitalFlowsCache([adapter], { now: () => Date.parse(fetchedAt), coldWaitMs: 0,
      rights: definition => ({ ...definition.rights, status: permitted ? "allowed" : "restricted" }),
      fetch: async url => { calls++; return new Response(dtsTexts[adapter.definition.resources.indexOf(url)]!); },
    });
    try {
      const blocked = await cache.read(); await cache.waitForIdle(); expect(calls).toBe(0);
      expect(blocked.snapshot.sources[0]?.retrievalState).toBe("rightsWithheld");
      permitted = true; await cache.read(); await cache.waitForIdle();
      const good = await cache.read(); expect(calls).toBe(2); expect(good.snapshot.series[0]!.history).toHaveLength(60);
      permitted = false; const withheld = await cache.read(); expect(calls).toBe(2);
      expect(withheld.snapshot.series.every(s => s.history.length === 0)).toBe(true); expect(withheld.snapshot.sources[0]!.receipts).toEqual([]);
      expect(withheld.serialized).not.toContain("265484"); expect(withheld.serialized).not.toContain("291506");
      expect(withheld.serialized).not.toContain("-26022"); expect(withheld.serialized).not.toContain("inputObservationIds");
    } finally { cache.dispose(); }
  });
});
