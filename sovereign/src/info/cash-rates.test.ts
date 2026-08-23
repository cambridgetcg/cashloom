import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import {
  mountCashRatesDoor,
  NY_FED_REFERENCE_RATE_NOTICE,
  parseNyFedReferenceRatesCsv,
  readCashRates,
} from "./cash-rates.ts";

const CSV = `Effective Date,Rate Type,Rate (%),Revision Indicator (Y/N)
08/20/2026,SOFRAI,,
08/19/2026,EFFR,3.6300,
08/19/2026,OBFR,3.63,
08/19/2026,SOFR,3.6200,Y
`;

describe("New York Fed cash rates", () => {
  it("parses SOFR and EFFR as exact decimal strings with date-only time", () => {
    const batch = parseNyFedReferenceRatesCsv(CSV, {
      fetchedAt: "2026-08-20T15:00:00.000Z",
      sourceUrl: "https://example.test/rates.csv",
    });
    expect(batch.observations.map((rate) => [rate.code, rate.value])).toEqual([
      ["EFFR", "3.63"],
      ["SOFR", "3.62"],
    ]);
    expect(batch.observations[0].observed_at).toBe("2026-08-19");
    expect(batch.observations[0].temporal_precision).toBe("date");
    expect(batch.observations[1].revision_indicator).toBe("Y");
    expect(batch.source.required_notice).toBe(NY_FED_REFERENCE_RATE_NOTICE);
    expect(batch.source.attribution).toContain("© 2026");
  });

  it("refuses missing rates, malformed decimals, and impossible dates", () => {
    expect(() => parseNyFedReferenceRatesCsv(CSV.replace("SOFR,3.6200", "SOFR,"), { fetchedAt: "2026-08-20T00:00:00Z" })).toThrow("decimal");
    expect(() => parseNyFedReferenceRatesCsv(CSV.replace("08/19/2026,SOFR", "02/30/2026,SOFR"), { fetchedAt: "2026-08-20T00:00:00Z" })).toThrow("date");
    expect(() => parseNyFedReferenceRatesCsv(CSV.replace(/08\/19\/2026,SOFR.*\n/, ""), { fetchedAt: "2026-08-20T00:00:00Z" })).toThrow("both");
  });

  it("uses an injectable transport and carries the HTTP publication timestamp", async () => {
    const batch = await readCashRates({
      now: () => new Date("2026-08-20T15:00:00Z"),
      fetcher: async () => new Response(CSV, {
        status: 200,
        headers: { "last-modified": "Thu, 20 Aug 2026 12:00:00 GMT" },
      }),
    });
    expect(batch.source.published_at).toBe("2026-08-20T12:00:00.000Z");
  });
});

describe("/v1/rates/cash", () => {
  it("serves observations and teaches on source failure", async () => {
    const batch = parseNyFedReferenceRatesCsv(CSV, { fetchedAt: "2026-08-20T15:00:00Z" });
    const ok = new Hono();
    mountCashRatesDoor(ok, async () => batch);
    const response = await ok.request("/v1/rates/cash");
    expect(response.status).toBe(200);
    expect((await response.json()).count).toBe(2);
    expect(response.headers.get("cache-control")).toContain("stale-while-revalidate");

    const failed = new Hono();
    mountCashRatesDoor(failed, async () => { throw new Error("down"); });
    const refusal = await failed.request("/v1/rates/cash");
    expect(refusal.status).toBe(502);
    expect((await refusal.json()).next_actions).toHaveLength(2);
  });
});
