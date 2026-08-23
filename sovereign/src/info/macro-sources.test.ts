import { describe, expect, it } from "vitest";
import {
  CALENDAR_VERIFIED_AT,
  CENTRAL_BANK_MEETINGS,
  fetchBisPolicyRates,
  fetchMacroSnapshot,
  fetchTreasuryParYields,
  getCentralBankMeetings,
  parseBisPolicyRatesCsv,
  parseBisPolicyRatesXml,
  parseEcbYieldCurveCsv,
  parseMacroCsv,
  parseMofJgbYieldCsv,
  parseTreasuryParYieldXml,
  treasuryMonthUrl,
  type MacroFetch,
} from "./macro-sources.ts";

const NOW = new Date("2026-08-20T17:30:00.000Z");
const now = () => new Date(NOW);
const context = {
  fetchedAt: NOW.toISOString(),
  publishedAt: "2026-08-20T10:00:00.000Z",
  sourceUrl: "https://fixture.test/data",
} as const;

const BIS_CSV = `FREQ,REF_AREA,TIME_PERIOD,OBS_VALUE\r
D,GB,2026-08-17,3.750\r
D,JP,2026-08-18,1.00\r
D,US,2026-08-17,3.7500\r
D,US,2026-08-18,3.6250\r
D,XM,2026-08-18,2.25\r
`;

const BIS_XML = `<?xml version="1.0"?>
<message:StructureSpecificData xmlns:message="urn:message">
  <message:Header><message:Prepared>2026-08-20T10:00:00Z</message:Prepared></message:Header>
  <message:DataSet>
    <Series FREQ="D" REF_AREA="US">
      <Obs TIME_PERIOD="2026-08-18" OBS_VALUE="3.625" />
    </Series>
  </message:DataSet>
</message:StructureSpecificData>`;

const TREASURY_XML = `<?xml version="1.0"?>
<feed xmlns="http://www.w3.org/2005/Atom"
      xmlns:d="http://schemas.microsoft.com/ado/2007/08/dataservices"
      xmlns:m="http://schemas.microsoft.com/ado/2007/08/dataservices/metadata">
  <entry>
    <updated>2026-08-19T15:52:00Z</updated>
    <content><m:properties>
      <d:NEW_DATE m:type="Edm.DateTime">2026-08-19T00:00:00</d:NEW_DATE>
      <d:BC_2YEAR m:type="Edm.Double">4.20</d:BC_2YEAR>
      <d:BC_10YEAR m:type="Edm.Double">4.650</d:BC_10YEAR>
    </m:properties></content>
  </entry>
  <entry>
    <updated>2026-08-18T15:52:00Z</updated>
    <content><m:properties>
      <d:NEW_DATE m:type="Edm.DateTime">2026-08-18T00:00:00</d:NEW_DATE>
      <d:BC_2YEAR m:type="Edm.Double">4.19</d:BC_2YEAR>
      <d:BC_10YEAR m:type="Edm.Double">4.71</d:BC_10YEAR>
    </m:properties></content>
  </entry>
</feed>`;

const ECB_CSV = `KEY,FREQ,REF_AREA,CURRENCY,PROVIDER_FM,INSTRUMENT_FM,PROVIDER_FM_ID,DATA_TYPE_FM,TIME_PERIOD,OBS_VALUE
YC.B.U2.EUR.4F.G_N_A.SV_C_YM.SR_10Y,B,U2,EUR,4F,G_N_A,SV_C_YM,SR_10Y,2026-08-18,3.3000000000
YC.B.U2.EUR.4F.G_N_A.SV_C_YM.SR_10Y,B,U2,EUR,4F,G_N_A,SV_C_YM,SR_10Y,2026-08-19,3.2782344774
YC.B.U2.EUR.4F.G_N_A.SV_C_YM.SR_2Y,B,U2,EUR,4F,G_N_A,SV_C_YM,SR_2Y,2026-08-19,2.7807523845
`;

const MOF_CSV = `Interest Rate (August 2026),,,,,(Unit : %)
Date,1Y,2Y,3Y,5Y,10Y,30Y
2026/8/18,1.431,1.691,1.844,2.177,2.934,4.096
2026/8/19,1.423,1.680,1.823,2.146,2.890,4.054
,,,,,,
"If you cannot download the latest csv data, clear the cache.",,,,,,
`;

describe("macro CSV and exact decimal handling", () => {
  it("parses BOM, quoted commas, escaped quotes and CRLF deterministically", () => {
    expect(parseMacroCsv('\uFEFFA,B\r\n"x,y","said ""yes"""\r\n')).toEqual([
      ["A", "B"],
      ["x,y", 'said "yes"'],
    ]);
  });

  it("keeps BIS values as exact source decimals and chooses the latest row", () => {
    const batch = parseBisPolicyRatesCsv(BIS_CSV, context);
    expect(batch.observations.map((item) => item.jurisdiction)).toEqual(["US", "XM", "GB", "JP"]);
    expect(batch.observations.map((item) => item.value)).toEqual(["3.6250", "2.25", "3.750", "1.00"]);
    expect(batch.observations[0].observed_at).toBe("2026-08-18");
    expect(batch.observations[0].value).not.toContain("e");
    expect(batch.observations[0].reference.is_live).toBe(false);
    expect(batch.observations[0].source.licence).toMatchObject({
      class: "attribution-required-commercial-conditions",
      terms_url: "https://www.bis.org/terms_statistics.htm",
    });
    expect(batch.observations[0].source.licence.redistribution_note).toContain("must not itself impose an additional charge");
  });

  it("retains valid BIS jurisdictions and warns when one series is absent", () => {
    const batch = parseBisPolicyRatesCsv(
      "FREQ,REF_AREA,TIME_PERIOD,OBS_VALUE\nD,US,2026-08-18,3.625\nD,XM,2026-08-18,not-a-number\n",
      context,
    );
    expect(batch.observations).toHaveLength(1);
    expect(batch.observations[0].jurisdiction).toBe("US");
    expect(batch.warnings.some((warning) => warning.code === "row_skipped")).toBe(true);
    expect(batch.warnings.some((warning) => warning.detail.includes("D.JP"))).toBe(true);
  });

  it("supports cached BIS structure-specific XML without treating Prepared as publication time", () => {
    const batch = parseBisPolicyRatesXml(BIS_XML, {
      fetchedAt: NOW.toISOString(),
      sourceUrl: "https://fixture.test/legacy.xml",
    });
    expect(batch.observations[0].value).toBe("3.625");
    expect(batch.source.published_at).toBeNull();
    expect(batch.source.published_at_status).toBe("not_exposed");
  });
});

describe("official sovereign curve parsers", () => {
  it("selects the newest Treasury Atom entry and preserves displayed precision", () => {
    const batch = parseTreasuryParYieldXml(TREASURY_XML, {
      fetchedAt: NOW.toISOString(),
      sourceUrl: "https://fixture.test/treasury.xml",
    }, ["2Y", "10Y", "40Y"]);
    expect(batch.observations.map((item) => [item.maturity, item.value])).toEqual([
      ["2Y", "4.20"],
      ["10Y", "4.650"],
    ]);
    expect(batch.observations.every((item) => item.observed_at === "2026-08-19")).toBe(true);
    expect(batch.source.published_at).toBe("2026-08-19T15:52:00.000Z");
    expect(batch.source.published_at_status).toBe("source_timestamp");
    expect(batch.warnings[0].detail).toContain("40Y");
  });

  it("parses ECB modelled spot rates without rounding long decimal strings", () => {
    const batch = parseEcbYieldCurveCsv(ECB_CSV, context);
    expect(batch.observations.map((item) => [item.maturity, item.value])).toEqual([
      ["2Y", "2.7807523845"],
      ["10Y", "3.2782344774"],
    ]);
    expect(batch.observations[0].method).toBe("official_model");
    expect(batch.observations[0].reference.kind).toBe("modelled_spot_yield");
    expect(batch.observations[0].label).toContain("AAA");
  });

  it("finds the MOF header after its title row and ignores the footer note", () => {
    const batch = parseMofJgbYieldCsv(MOF_CSV, context);
    expect(batch.observations.map((item) => [item.maturity, item.value])).toEqual([
      ["2Y", "1.680"],
      ["10Y", "2.890"],
    ]);
    expect(batch.observations[0].observed_at).toBe("2026-08-19");
    expect(batch.observations[0].reference.kind).toBe("constant_maturity_yield");
  });

  it("throws instead of silently returning an empty successful curve", () => {
    expect(() => parseEcbYieldCurveCsv("DATA_TYPE_FM,TIME_PERIOD,OBS_VALUE\n", context)).toThrow(/no data rows/);
    expect(() => parseTreasuryParYieldXml("<feed/>", context)).toThrow(/no Atom entries/);
    expect(() => parseMofJgbYieldCsv("not,a,curve", context)).toThrow(/Date header/);
  });
});

describe("deterministic central-bank calendar", () => {
  it("contains reviewable 2026 and 2027 schedules for all four institutions", () => {
    expect(CENTRAL_BANK_MEETINGS).toHaveLength(64);
    expect(new Set(CENTRAL_BANK_MEETINGS.map((meeting) => meeting.institution_code))).toEqual(
      new Set(["FED", "ECB", "BOE", "BOJ"]),
    );
  });

  it("filters by decision window, remains sorted, and never invents a clock time", () => {
    const events = getCentralBankMeetings({
      from: "2026-09-01",
      to: "2026-09-30",
      now,
    });
    expect(events.map((event) => event.institution_code)).toEqual(["ECB", "FED", "BOE", "BOJ"]);
    expect(events.map((event) => event.decision_on)).toEqual([
      "2026-09-10",
      "2026-09-16",
      "2026-09-17",
      "2026-09-18",
    ]);
    expect(events.every((event) => event.time_status === "not_announced")).toBe(true);
    expect(events.every((event) => event.fetched_at === CALENDAR_VERIFIED_AT)).toBe(true);
    expect(events.every((event) => event.retrieval === "verified_transcription")).toBe(true);
    expect(events.every((event) => event.verified_at === CALENDAR_VERIFIED_AT)).toBe(true);
    expect(events.every((event) => event.source.retrieval === "verified_transcription")).toBe(true);
    expect(events.every((event) => event.source.url.startsWith("https://"))).toBe(true);
  });

  it("does not make checked-in calendars look freshly fetched when the request clock changes", () => {
    const filter = { from: "2026-09-01", to: "2026-09-30" } as const;
    const first = getCentralBankMeetings({
      ...filter,
      now: () => new Date("2026-08-20T01:00:00.000Z"),
    });
    const muchLater = getCentralBankMeetings({
      ...filter,
      now: () => new Date("2027-06-01T23:59:59.000Z"),
    });
    expect(first.map((event) => event.fetched_at)).toEqual(
      muchLater.map((event) => event.fetched_at),
    );
    expect(new Set(first.map((event) => event.fetched_at))).toEqual(
      new Set([CALENDAR_VERIFIED_AT]),
    );
  });

  it("discloses provisional/tentative future calendars", () => {
    const events = getCentralBankMeetings({
      from: "2027-01-01",
      to: "2027-12-31",
      now,
    });
    expect(events.filter((event) => event.institution_code === "FED").every((event) => event.schedule_status === "tentative")).toBe(true);
    expect(events.filter((event) => event.institution_code === "BOE").every((event) => event.schedule_status === "provisional")).toBe(true);
  });
});

describe("injectable, bounded adapters", () => {
  it("uses BIS v2 CSV with lastNObservations and attaches HTTP Last-Modified", async () => {
    let requestedUrl = "";
    let requestedSignal: AbortSignal | null | undefined;
    const fetcher: MacroFetch = async (input, init) => {
      requestedUrl = String(input);
      requestedSignal = init?.signal;
      return new Response(BIS_CSV, {
        status: 200,
        headers: { "content-type": "text/csv", "last-modified": "Thu, 20 Aug 2026 10:00:00 GMT" },
      });
    };
    const batch = await fetchBisPolicyRates({ fetcher, now, timeoutMs: 50 });
    expect(requestedUrl).toContain("/api/v2/data/");
    expect(requestedUrl).toContain("format=csvfile");
    expect(requestedUrl).toContain("lastNObservations=1");
    expect(requestedSignal).toBeInstanceOf(AbortSignal);
    expect(batch.source.fetched_at).toBe(NOW.toISOString());
    expect(batch.source.published_at).toBe("2026-08-20T10:00:00.000Z");
    expect(batch.source.published_at_status).toBe("http_last_modified");
  });

  it("classifies an injected timeout as retryable", async () => {
    const fetcher: MacroFetch = async () => {
      throw new DOMException("fixture timeout", "TimeoutError");
    };
    await expect(fetchBisPolicyRates({ fetcher, now, timeoutMs: 5 })).rejects.toMatchObject({
      kind: "timeout",
      retryable: true,
    });
  });

  it("enforces its own deadline when an injected transport ignores AbortSignal", async () => {
    const fetcher: MacroFetch = () => new Promise<Response>(() => undefined);
    await expect(fetchBisPolicyRates({ fetcher, now, timeoutMs: 5 })).rejects.toMatchObject({
      kind: "timeout",
      retryable: true,
      message: expect.stringContaining("waiting for response headers"),
    });
  });

  it("requests Treasury's month-filtered official feed instead of the large annual feed", async () => {
    const urls: string[] = [];
    const fetcher: MacroFetch = async (input) => {
      urls.push(String(input));
      return new Response(TREASURY_XML);
    };
    const batch = await fetchTreasuryParYields({ fetcher, now });
    expect(urls).toEqual([treasuryMonthUrl(NOW)]);
    expect(urls[0]).toContain("field_tdr_date_value_month=202608");
    expect(urls[0]).not.toMatch(/field_tdr_date_value=2026(?:&|$)/);
    expect(batch.source.url).toBe(urls[0]);
  });

  it("falls back to the previous UTC month only when the current month has no Atom entries", async () => {
    const urls: string[] = [];
    const fetcher: MacroFetch = async (input) => {
      const url = String(input);
      urls.push(url);
      return new Response(url.includes("202608") ? "<feed/>" : TREASURY_XML);
    };
    const batch = await fetchTreasuryParYields({ fetcher, now });
    expect(urls.map((url) => new URL(url).searchParams.get("field_tdr_date_value_month"))).toEqual([
      "202608",
      "202607",
    ]);
    expect(batch.source.url).toBe(urls[1]);
  });

  it("does not hide malformed current-month Treasury entries behind a previous-month fallback", async () => {
    const urls: string[] = [];
    const fetcher: MacroFetch = async (input) => {
      urls.push(String(input));
      return new Response("<feed><entry><content/></entry></feed>");
    };
    await expect(fetchTreasuryParYields({ fetcher, now })).rejects.toMatchObject({
      kind: "parse",
      message: "Treasury XML entries have no NEW_DATE values",
    });
    expect(urls).toHaveLength(1);
  });
});

function routedFetch(failing: "ecb" | "all" | null = null): MacroFetch {
  return async (input) => {
    const url = String(input);
    if (failing === "all") throw new TypeError("fixture network offline");
    if (url.includes("stats.bis.org")) return new Response(BIS_CSV);
    if (url.includes("home.treasury.gov")) {
      return new Response(TREASURY_XML, { headers: { "last-modified": "Wed, 19 Aug 2026 15:52:00 GMT" } });
    }
    if (url.includes("data-api.ecb.europa.eu")) {
      if (failing === "ecb") return new Response("maintenance", { status: 503 });
      return new Response(ECB_CSV, { headers: { "last-modified": "Thu, 20 Aug 2026 10:00:00 GMT" } });
    }
    if (url.includes("mof.go.jp")) {
      return new Response(MOF_CSV, { headers: { "last-modified": "Wed, 19 Aug 2026 23:30:17 GMT" } });
    }
    return new Response("fixture has no route", { status: 404 });
  };
}

describe("partial-failure macro snapshot", () => {
  it("keeps three successful official sources when ECB is unavailable", async () => {
    const snapshot = await fetchMacroSnapshot({ fetcher: routedFetch("ecb"), now });
    expect(snapshot.status).toBe("partial");
    expect(snapshot.complete).toBe(false);
    expect(snapshot.policy).toHaveLength(4);
    expect(snapshot.sovereigns.map((item) => `${item.jurisdiction}:${item.maturity}`)).toEqual([
      "US:2Y",
      "US:10Y",
      "JP:2Y",
      "JP:10Y",
    ]);
    expect(snapshot.calendar.length).toBeGreaterThan(0);
    expect(snapshot.failures).toEqual([
      expect.objectContaining({
        source_id: "ecb_euro_area_yield_curve",
        kind: "http",
        status_code: 503,
        retryable: true,
      }),
    ]);
    expect(snapshot.sources.find((source) => source.source_id === "ecb_euro_area_yield_curve")?.status).toBe("failed");
  });

  it("reports unavailable scalar data while still retaining the deterministic calendar", async () => {
    const snapshot = await fetchMacroSnapshot({ fetcher: routedFetch("all"), now });
    expect(snapshot.status).toBe("unavailable");
    expect(snapshot.policy).toEqual([]);
    expect(snapshot.sovereigns).toEqual([]);
    expect(snapshot.failures).toHaveLength(4);
    expect(snapshot.calendar.length).toBeGreaterThan(0);
    expect(snapshot.sources.filter((source) => source.status === "failed")).toHaveLength(4);
    expect(snapshot.sources.find((source) => source.source_id === "fed_meeting_calendar")).toMatchObject({
      retrieval: "verified_transcription",
      verified_at: CALENDAR_VERIFIED_AT,
      fetched_at: CALENDAR_VERIFIED_AT,
    });
    expect(snapshot.failures.find((failure) => failure.source_id === "us_treasury_par_yields")?.url)
      .toContain("field_tdr_date_value_month=202608");
  });

  it("is complete only when every requested series and source succeeds", async () => {
    const snapshot = await fetchMacroSnapshot({ fetcher: routedFetch(), now });
    expect(snapshot.status).toBe("ok");
    expect(snapshot.complete).toBe(true);
    expect(snapshot.policy).toHaveLength(4);
    expect(snapshot.sovereigns).toHaveLength(6);
    expect(snapshot.failures).toEqual([]);
    expect(snapshot.warnings).toEqual([]);
  });

  it("degrades checked-in calendars after their verification window expires", async () => {
    const future = () => new Date("2026-11-20T12:00:00.000Z");
    const snapshot = await fetchMacroSnapshot({ fetcher: routedFetch(), now: future });
    expect(snapshot.status).toBe("partial");
    expect(snapshot.complete).toBe(false);
    expect(snapshot.sources.filter((source) => source.retrieval === "verified_transcription"))
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ status: "degraded", detail: expect.stringContaining("older than 45 days") }),
      ]));
  });
});
