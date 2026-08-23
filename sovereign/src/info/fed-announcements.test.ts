import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import { mountFedAnnouncementsDoor, parseFedMonetaryPolicyRss } from "./fed-announcements.ts";

const RSS = `<?xml version="1.0"?><rss><channel>
<item><title>Minutes of the Federal Open Market Committee, July 28–29, 2026</title><link><![CDATA[https://www.federalreserve.gov/newsevents/pressreleases/monetary20260819a.htm]]></link><pubDate>Wed, 19 Aug 2026 18:00:00 GMT</pubDate></item>
<item><title>Federal Reserve issues FOMC statement</title><link>https://www.federalreserve.gov/newsevents/pressreleases/monetary20260729a.htm</link><pubDate>Wed, 29 Jul 2026 18:00:00 GMT</pubDate></item>
</channel></rss>`;

describe("Federal Reserve monetary-policy RSS", () => {
  it("keeps only official titles, links and publisher timestamps", () => {
    const batch = parseFedMonetaryPolicyRss(RSS, { fetchedAt: "2026-08-20T12:00:00Z" });
    expect(batch.announcements).toHaveLength(2);
    expect(batch.announcements[0]).toMatchObject({
      category: "fomc_minutes",
      published_at: "2026-08-19T18:00:00.000Z",
      fetched_at: "2026-08-20T12:00:00.000Z",
    });
    expect(batch.announcements[1].category).toBe("fomc_statement");
    expect(batch.source.note).toContain("does not reproduce");
  });

  it("rejects a feed item that points outside the official host", () => {
    expect(() => parseFedMonetaryPolicyRss(
      RSS.replace("https://www.federalreserve.gov/newsevents", "https://attacker.example/newsevents"),
      { fetchedAt: "2026-08-20T12:00:00Z" },
    )).toThrow(/outside the official/);
  });

  it("serves a typed batch and a legible upstream failure", async () => {
    const batch = parseFedMonetaryPolicyRss(RSS, { fetchedAt: "2026-08-20T12:00:00Z" });
    const app = new Hono();
    mountFedAnnouncementsDoor(app, async () => batch);
    const response = await app.request("/v1/announcements/fed");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("monetary-policy-announcements");
    expect((await response.json()).announcements[0].category).toBe("fomc_minutes");

    const failed = new Hono();
    mountFedAnnouncementsDoor(failed, async () => { throw new Error("upstream timeout"); });
    const refusal = await failed.request("/v1/announcements/fed");
    expect(refusal.status).toBe(502);
    expect((await refusal.json()).detail).toContain("upstream timeout");
  });
});
