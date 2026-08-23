/** Latest official Federal Reserve monetary-policy releases.
 *
 * This adapter intentionally republishes only the feed's title, link and
 * publication timestamp. It does not copy release bodies or infer market
 * impact. The linked official document remains the source of record.
 */

import type { Hono } from "hono";
import type { MacroFetch } from "./macro-sources.ts";

export const FED_MONETARY_RSS_URL = "https://www.federalreserve.gov/feeds/press_monetary.xml";
export const FED_RSS_DIRECTORY_URL = "https://www.federalreserve.gov/feeds/feeds.htm";

export type FedAnnouncementCategory =
  | "fomc_statement"
  | "fomc_minutes"
  | "economic_projections"
  | "monetary_policy_release";

export interface FedAnnouncementSource {
  id: "federal_reserve_monetary_policy_rss";
  publisher: "Board of Governors of the Federal Reserve System";
  title: "Monetary Policy press releases";
  url: string;
  landing_page_url: string;
  terms_url: string;
  licence: "official_public_information";
  fetched_at: string;
  published_at: string | null;
  note: string;
}

export interface FedAnnouncement {
  "@type": "MonetaryPolicyAnnouncement";
  schema: "cashloom.monetary-policy-announcement/1";
  id: string;
  jurisdiction: "US";
  institution: "Federal Reserve Board";
  category: FedAnnouncementCategory;
  title: string;
  url: string;
  published_at: string;
  fetched_at: string;
  source: FedAnnouncementSource;
}

export interface FedAnnouncementBatch {
  announcements: FedAnnouncement[];
  source: FedAnnouncementSource;
}

export interface FedAnnouncementOptions {
  fetcher?: MacroFetch;
  now?: () => Date;
  timeoutMs?: number;
  limit?: number;
}

function decodeXml(value: string): string {
  return value
    .replace(/^<!\[CDATA\[([\s\S]*)\]\]>$/, "$1")
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code: string) => String.fromCodePoint(Number.parseInt(code, 16)))
    .replace(/&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&gt;/g, ">")
    .replace(/&lt;/g, "<")
    .replace(/&amp;/g, "&")
    .trim();
}

function element(xml: string, name: string): string | null {
  const match = xml.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${name}>`, "i"));
  return match ? decodeXml(match[1].trim()) : null;
}

function categoryFor(title: string): FedAnnouncementCategory {
  const lower = title.toLowerCase();
  if (lower.includes("economic projections")) return "economic_projections";
  if (lower.includes("minutes") && lower.includes("federal open market committee")) return "fomc_minutes";
  if (lower.includes("fomc statement")) return "fomc_statement";
  return "monetary_policy_release";
}

function officialReleaseUrl(raw: string): string {
  const parsed = new URL(raw);
  if (parsed.protocol !== "https:" || parsed.hostname !== "www.federalreserve.gov") {
    throw new Error("Federal Reserve feed item points outside the official HTTPS host");
  }
  return parsed.toString();
}

export function parseFedMonetaryPolicyRss(
  xml: string,
  context: { fetchedAt: string; publishedAt?: string | null; sourceUrl?: string; limit?: number },
): FedAnnouncementBatch {
  const fetchedAt = new Date(context.fetchedAt).toISOString();
  const items = [...xml.replace(/^\uFEFF/, "").matchAll(/<item(?:\s[^>]*)?>([\s\S]*?)<\/item>/gi)];
  if (!items.length) throw new Error("Federal Reserve monetary-policy RSS contains no items");
  const parsed = items.flatMap((match) => {
    const title = element(match[1], "title");
    const link = element(match[1], "link");
    const pubDate = element(match[1], "pubDate");
    if (!title || !link || !pubDate) return [];
    const publishedMs = Date.parse(pubDate);
    if (!Number.isFinite(publishedMs)) return [];
    const url = officialReleaseUrl(link);
    const id = new URL(url).pathname.split("/").at(-1)?.replace(/\.htm$/i, "") ?? url;
    return [{ id, title: title.slice(0, 300), url, publishedAt: new Date(publishedMs).toISOString() }];
  }).sort((a, b) => b.publishedAt.localeCompare(a.publishedAt));
  if (!parsed.length) throw new Error("Federal Reserve monetary-policy RSS contains no usable official items");
  const source: FedAnnouncementSource = {
    id: "federal_reserve_monetary_policy_rss",
    publisher: "Board of Governors of the Federal Reserve System",
    title: "Monetary Policy press releases",
    url: context.sourceUrl ?? FED_MONETARY_RSS_URL,
    landing_page_url: FED_RSS_DIRECTORY_URL,
    terms_url: "https://www.federalreserve.gov/aboutthefed/website-linking-policies.htm",
    licence: "official_public_information",
    fetched_at: fetchedAt,
    published_at: context.publishedAt ?? parsed[0].publishedAt,
    note: "Official release titles and links only; CashLoom does not reproduce the release body or infer market impact.",
  };
  const limit = Math.max(1, Math.min(context.limit ?? 5, 20));
  return {
    source,
    announcements: parsed.slice(0, limit).map((item) => ({
      "@type": "MonetaryPolicyAnnouncement",
      schema: "cashloom.monetary-policy-announcement/1",
      id: `fed_announcement:${item.id}`,
      jurisdiction: "US",
      institution: "Federal Reserve Board",
      category: categoryFor(item.title),
      title: item.title,
      url: item.url,
      published_at: item.publishedAt,
      fetched_at: fetchedAt,
      source,
    })),
  };
}

export async function fetchFedAnnouncements(options: FedAnnouncementOptions = {}): Promise<FedAnnouncementBatch> {
  const fetcher = options.fetcher ?? fetch;
  const timeoutMs = options.timeoutMs ?? 8_000;
  const response = await fetcher(FED_MONETARY_RSS_URL, {
    headers: { Accept: "application/rss+xml, application/xml;q=0.9, text/xml;q=0.8" },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw new Error(`Federal Reserve monetary-policy RSS answered HTTP ${response.status}`);
  const length = Number(response.headers.get("content-length") ?? "0");
  if (Number.isFinite(length) && length > 250_000) throw new Error("Federal Reserve RSS exceeds the response-size bound");
  const xml = await response.text();
  if (xml.length > 250_000) throw new Error("Federal Reserve RSS exceeds the response-size bound");
  const modified = response.headers.get("last-modified");
  const modifiedMs = modified ? Date.parse(modified) : NaN;
  return parseFedMonetaryPolicyRss(xml, {
    fetchedAt: (options.now ?? (() => new Date()))().toISOString(),
    publishedAt: Number.isFinite(modifiedMs) ? new Date(modifiedMs).toISOString() : null,
    sourceUrl: FED_MONETARY_RSS_URL,
    limit: options.limit,
  });
}

let cache: { expiresAt: number; value: FedAnnouncementBatch } | null = null;
let inflight: Promise<FedAnnouncementBatch> | null = null;

export async function readFedAnnouncements(): Promise<FedAnnouncementBatch> {
  if (cache && Date.now() < cache.expiresAt) return cache.value;
  inflight ??= fetchFedAnnouncements().then((value) => {
    cache = { expiresAt: Date.now() + 5 * 60_000, value };
    return value;
  }).finally(() => { inflight = null; });
  return inflight;
}

export function mountFedAnnouncementsDoor(
  app: Hono,
  reader: () => Promise<FedAnnouncementBatch> = readFedAnnouncements,
): void {
  app.get("/v1/announcements/fed", async (c) => {
    try {
      const batch = await reader();
      c.header("Content-Type", "application/vnd.cashloom.monetary-policy-announcements.v1+json");
      c.header("Cache-Control", "public, max-age=60, stale-while-revalidate=300");
      return c.body(JSON.stringify(batch));
    } catch (error) {
      return c.json({
        type: "about:blank",
        title: "Federal Reserve announcements unavailable",
        status: 502,
        detail: error instanceof Error ? error.message : "The official RSS feed did not answer.",
        next_actions: ["retry shortly", `read the official feed directory at ${FED_RSS_DIRECTORY_URL}`],
      }, 502);
    }
  });
}
