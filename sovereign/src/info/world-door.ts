/**
 * CashLoom World — one cited, partial-safe snapshot for the public dashboard.
 *
 * The source adapters remain useful as narrow doors; this module is the reading
 * layer that composes them. Every section can fail independently. A source
 * outage removes that observation and creates an explicit unavailable receipt;
 * it never turns into zero, an old number stamped "now", or a 500 for the whole
 * world.
 */

import { createHash } from "node:crypto";
import type { Context, Hono } from "hono";
import { divHalfEven } from "../utils/minor-units.ts";
import { fxReferenceIsStale, getFxRate, type FxFact } from "./fx.ts";
import { readFees } from "./fees.ts";
import {
  NY_FED_RATES_PAGE,
  NY_FED_REFERENCE_RATE_NOTICE,
  NY_FED_TERMS_URL,
  readCashRates,
  type CashRateBatch,
  type CashRateObservation,
  type CashRateSource,
} from "./cash-rates.ts";
import { formatMinor, type MoneyFact, type Source } from "./money-fact.ts";
import {
  MACRO_SOURCE_DEFINITIONS,
  CALENDAR_VERIFICATION_MAX_AGE_DAYS,
  fetchMacroSnapshot,
  type MacroEvent,
  type MacroObservation,
  type MacroSnapshot,
  type MacroSource,
  type MacroSourceStatus,
} from "./macro-sources.ts";
import {
  PRICE_FEEDS,
  PRICE_FAILURE,
  readPrice,
  type OracleResult,
  type PriceFeed,
} from "./price.ts";
import {
  FED_MONETARY_RSS_URL,
  FED_RSS_DIRECTORY_URL,
  readFedAnnouncements,
  type FedAnnouncement,
  type FedAnnouncementBatch,
  type FedAnnouncementSource,
} from "./fed-announcements.ts";

export const WORLD_MEDIA_TYPE = "application/vnd.cashloom.world.v1+json";

export const WORLD_BASE_CURRENCIES = [
  "USD",
  "EUR",
  "GBP",
  "JPY",
  "CHF",
  "CAD",
  "AUD",
  "CNY",
] as const;
export type WorldBaseCurrency = (typeof WORLD_BASE_CURRENCIES)[number];

export interface WorldSource {
  id: string;
  name: string;
  title: string;
  url: string;
  status: "ok" | "partial" | "unavailable" | "withheld";
  cadence: string;
  license: string;
  terms_url?: string;
  fetched_at?: string;
  updated_at?: string;
  stale?: boolean;
  note?: string;
  description?: string;
  retrieval?: "live_fetch" | "verified_transcription";
  verified_at?: string;
}

export interface WorldUnavailable {
  id: string;
  section: "briefing" | "policy" | "sovereigns" | "fx" | "crypto" | "fees" | "energy" | "calendar";
  title: string;
  code: string;
  detail: string;
  retryable: boolean;
}

export const WORLD_FAILURE = Object.freeze({
  macro: {
    code: "macro_upstream_unavailable",
    message: "The official macro source did not return a usable observation.",
  },
  macroGroup: {
    code: "macro_source_group_unavailable",
    message: "The official macro source group did not answer with usable observations.",
  },
  macroSeries: {
    code: "macro_series_unavailable",
    message: "A requested official macro series did not return a usable observation.",
  },
  announcements: {
    code: "fed_announcements_upstream_unavailable",
    message: "The official Federal Reserve announcement source did not return a usable release.",
  },
  cash: {
    code: "cash_rates_upstream_unavailable",
    message: "The official cash-rate source did not return usable observations.",
  },
  fx: {
    code: "fx_upstream_unavailable",
    message: "The ECB reference-rate source did not answer with a usable observation.",
  },
  fxPair: {
    code: "fx_pair_unavailable",
    message: "The ECB reference-rate source did not contain the requested currency pair.",
  },
  fees: {
    code: "fee_upstream_unavailable",
    message: "The public fee source did not answer with a usable observation.",
  },
} as const);

export interface WorldCard {
  id: string;
  key: string;
  title: string;
  label: string;
  value?: string;
  display_value?: string;
  unit?: string;
  symbol?: string;
  change?: string;
  status: "observed" | "derived" | "scheduled" | "unavailable";
  stale: boolean;
  observed_at?: string;
  published_at?: string;
  fetched_at?: string;
  cadence?: string;
  source_id?: string;
  source?: WorldSource;
  method?: string;
  proof_state?: string;
  note?: string;
  receipt?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface WorldThread extends WorldCard {
  observed: string[];
  possible_channels: string[];
  possible_channel: string[];
  limits: string[];
}

export interface WorldSnapshot {
  "@type": "WorldSnapshot";
  schema: "cashloom.world/1";
  generated_at: string;
  base_currency: WorldBaseCurrency;
  status: {
    state: "ready" | "partial" | "unavailable";
    complete: boolean;
    available_sources: number;
    total_sources: number;
    stale_count: number;
    unavailable: WorldUnavailable[];
  };
  briefing: WorldCard[];
  policy: WorldCard[];
  sovereigns: WorldCard[];
  fx: WorldCard[];
  crypto: WorldCard[];
  fees: WorldCard[];
  energy: WorldCard[];
  calendar: WorldCard[];
  threads: WorldThread[];
  sources: WorldSource[];
}

export interface WorldDeps {
  macro: () => Promise<MacroSnapshot>;
  announcements: () => Promise<FedAnnouncementBatch>;
  cash: () => Promise<CashRateBatch>;
  fxRate: typeof getFxRate;
  fees: typeof readFees;
  price: (feed: PriceFeed) => Promise<OracleResult>;
  now: () => Date;
}

const MACRO_OK_CACHE_MS = 15 * 60_000;
const MACRO_PARTIAL_CACHE_MS = 30_000;
const MACRO_UNAVAILABLE_CACHE_MS = 10_000;
let macroCache: { expiresAt: number; snapshot: MacroSnapshot } | null = null;
let macroInflight: Promise<MacroSnapshot> | null = null;

async function cachedMacroSnapshot(): Promise<MacroSnapshot> {
  if (macroCache && Date.now() < macroCache.expiresAt) return macroCache.snapshot;
  macroInflight ??= fetchMacroSnapshot().then((snapshot) => {
    const ttl = snapshot.status === "ok"
      ? MACRO_OK_CACHE_MS
      : snapshot.status === "partial"
        ? MACRO_PARTIAL_CACHE_MS
        : MACRO_UNAVAILABLE_CACHE_MS;
    macroCache = { expiresAt: Date.now() + ttl, snapshot };
    return snapshot;
  }).finally(() => { macroInflight = null; });
  return macroInflight;
}

const defaultDeps: WorldDeps = {
  macro: cachedMacroSnapshot,
  announcements: readFedAnnouncements,
  cash: readCashRates,
  fxRate: getFxRate,
  fees: readFees,
  price: readPrice,
  now: () => new Date(),
};

const ECB_FX_SOURCE_ID = "ecb-fx-reference-rates";
const ENERGY_SOURCE_ID = "licensed-energy-benchmarks";
const UK_YIELD_SOURCE_ID = "boe-uk-yield-curve-rights";
const FX_QUOTES = WORLD_BASE_CURRENCIES;

const asRecord = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};

const KNOWN_MACRO_SOURCE_IDS = new Set(Object.keys(MACRO_SOURCE_DEFINITIONS));

function safeMacroSourceId(value: unknown, fallback: string): string {
  return typeof value === "string" && KNOWN_MACRO_SOURCE_IDS.has(value) ? value : fallback;
}

function ageDays(instant: string | null | undefined, now: Date): number | null {
  if (!instant) return null;
  const time = Date.parse(instant.length === 10 ? `${instant}T23:59:59Z` : instant);
  if (!Number.isFinite(time)) return null;
  return Math.max(0, (now.getTime() - time) / 86_400_000);
}

/** Weekdays elapsed after a date-only observation through the current UTC
 * calendar date. A two-business-day allowance absorbs normal next-morning
 * publication plus a single market holiday without treating a week-old rate
 * as current. */
export function businessDaysSinceDate(date: string, now: Date): number | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  const start = new Date(`${date}T00:00:00.000Z`);
  if (Number.isNaN(start.getTime()) || start.toISOString().slice(0, 10) !== date) return null;
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  if (start >= end) return 0;
  let count = 0;
  for (const cursor = new Date(start.getTime() + 86_400_000); cursor <= end; cursor.setUTCDate(cursor.getUTCDate() + 1)) {
    const day = cursor.getUTCDay();
    if (day !== 0 && day !== 6) count += 1;
  }
  return count;
}

function macroIsStale(observation: MacroObservation, now: Date): boolean {
  const days = ageDays(observation.observed_at, now);
  if (days === null) return true;
  return days > (observation.indicator === "central_bank_policy_rate" ? 14 : 7);
}

function worldSourceFromMacro(source: MacroSource, status: WorldSource["status"] = "ok"): WorldSource {
  return {
    id: source.id,
    name: source.publisher,
    title: source.title,
    url: source.landing_page_url || source.url,
    status,
    cadence: "official release",
    license: source.licence.class,
    terms_url: source.licence.terms_url,
    fetched_at: source.fetched_at,
    ...(source.published_at ? { updated_at: source.published_at } : {}),
    note: source.licence.attribution,
    description: source.licence.redistribution_note,
    ...(source.retrieval ? { retrieval: source.retrieval } : {}),
    ...(source.verified_at ? { verified_at: source.verified_at } : {}),
  };
}

function worldSourceFromMacroStatus(status: MacroSourceStatus, now: Date): WorldSource {
  const sourceId = safeMacroSourceId(status.source_id, "macro-source");
  const definition = Object.values(MACRO_SOURCE_DEFINITIONS).find((source) => source.id === sourceId);
  const verificationStale = status.retrieval === "verified_transcription"
    && (ageDays(status.verified_at, now) ?? Infinity) > CALENDAR_VERIFICATION_MAX_AGE_DAYS;
  const resolvedStatus: WorldSource["status"] = status.status === "failed"
    ? "unavailable"
    : status.status === "degraded" || verificationStale
      ? "partial"
      : "ok";
  return {
    id: sourceId,
    name: definition?.publisher ?? "Official macro source",
    title: definition?.title ?? "Official macro observations",
    url: resolvedStatus === "unavailable"
      ? definition?.landing_page_url ?? "https://cashloom.io/v1/world"
      : status.url || definition?.landing_page_url || "https://cashloom.io/v1/world",
    status: resolvedStatus,
    cadence: status.source_id === "bis_policy_rates"
      ? "daily values, weekly dataset release"
      : status.source_id.endsWith("meeting_calendar")
        ? "official calendar"
        : "business daily",
    license: definition?.licence.class ?? "official-terms",
    ...(definition?.licence.terms_url ? { terms_url: definition.licence.terms_url } : {}),
    ...(status.fetched_at ? { fetched_at: status.fetched_at } : {}),
    ...(status.published_at ? { updated_at: status.published_at } : {}),
    stale: resolvedStatus === "partial",
    note: verificationStale
      ? `Calendar verification is older than ${CALENDAR_VERIFICATION_MAX_AGE_DAYS} days. Re-check the official authority page before relying on future dates.`
      : status.status === "failed"
        ? WORLD_FAILURE.macro.message
        : status.status === "degraded"
          ? "The official source returned only partial usable coverage."
          : definition?.licence.attribution,
    description: definition?.licence.redistribution_note,
    ...(status.retrieval ? { retrieval: status.retrieval } : {}),
    ...(status.verified_at ? { verified_at: status.verified_at } : {}),
  };
}

function macroCard(observation: MacroObservation, now: Date): WorldCard {
  const stale = macroIsStale(observation, now);
  const source = worldSourceFromMacro(observation.source, stale ? "partial" : "ok");
  const maturity = observation.maturity ? ` · ${observation.maturity}` : "";
  return {
    id: observation.id,
    key: observation.series_key,
    title: observation.label,
    label: `${observation.jurisdiction_name}${maturity}`,
    symbol: observation.jurisdiction,
    value: observation.value,
    display_value: `${observation.value}%`,
    unit: "%",
    status: observation.method === "official_model" ? "derived" : "observed",
    stale,
    observed_at: observation.observed_at,
    ...(observation.published_at ? { published_at: observation.published_at } : {}),
    fetched_at: observation.fetched_at,
    cadence: observation.reference.frequency,
    source_id: source.id,
    source,
    method: observation.method,
    proof_state: "asserted",
    note: observation.reference.note,
    receipt: {
      reference: observation.reference,
      jurisdiction: observation.jurisdiction,
      institution: observation.institution,
      maturity: observation.maturity,
      temporal_precision: observation.temporal_precision,
      is_live: false,
      source_resource_url: observation.source.url,
      source_methodology_url: observation.source.methodology_url,
      source_licence: observation.source.licence,
    },
    name: observation.institution,
    rate_name: observation.label,
    jurisdiction: observation.jurisdiction,
    effective_at: observation.observed_at,
  };
}

function worldSourceFromCash(source?: CashRateSource, status: WorldSource["status"] = "ok"): WorldSource {
  const notice = source
    ? `${source.attribution} ${source.required_notice} ${source.affiliation_notice}`
    : NY_FED_REFERENCE_RATE_NOTICE;
  return {
    id: "ny_fed_reference_rates",
    name: "Federal Reserve Bank of New York",
    title: "SOFR and EFFR reference rates",
    url: source?.landing_page_url ?? NY_FED_RATES_PAGE,
    status,
    cadence: "business daily, normally next-business-morning publication",
    license: source?.licence ?? "attribution_required_with_reference_rate_notice",
    terms_url: source?.terms_url ?? NY_FED_TERMS_URL,
    ...(source?.fetched_at ? { fetched_at: source.fetched_at } : {}),
    ...(source?.published_at ? { updated_at: source.published_at } : {}),
    stale: status === "partial",
    note: notice,
    description: notice,
  };
}

function cashCard(observation: CashRateObservation, now: Date): WorldCard {
  const stale = (businessDaysSinceDate(observation.observed_at, now) ?? Infinity) > 2;
  const source = worldSourceFromCash(observation.source, stale ? "partial" : "ok");
  return {
    id: observation.id,
    key: observation.code,
    title: observation.name,
    name: observation.institution,
    rate_name: observation.name,
    label: "United States · overnight cash rate",
    jurisdiction: observation.jurisdiction,
    symbol: observation.code,
    value: observation.value,
    display_value: `${observation.value}%`,
    unit: "%",
    status: "observed",
    stale,
    observed_at: observation.observed_at,
    effective_at: observation.observed_at,
    ...(observation.published_at ? { published_at: observation.published_at } : {}),
    fetched_at: observation.fetched_at,
    cadence: observation.cadence,
    source_id: source.id,
    source,
    method: observation.method,
    proof_state: "asserted",
    note: observation.reference.note,
    receipt: {
      reference: observation.reference,
      temporal_precision: observation.temporal_precision,
      revision_indicator: observation.revision_indicator,
      source_notice: observation.source.required_notice,
      affiliation_notice: observation.source.affiliation_notice,
      source_attribution: observation.source.attribution,
      source_resource_url: observation.source.url,
      source_landing_page_url: observation.source.landing_page_url,
      is_live: false,
    },
  };
}

function sovereignCards(observations: MacroObservation[], now: Date): WorldCard[] {
  const grouped = new Map<string, MacroObservation[]>();
  for (const observation of observations) {
    const rows = grouped.get(observation.jurisdiction) ?? [];
    rows.push(observation);
    grouped.set(observation.jurisdiction, rows);
  }
  const maturityOrder = new Map<string, number>([["2Y", 2], ["10Y", 10]]);
  return [...grouped.values()].map((rows) => {
    rows.sort((a, b) => (maturityOrder.get(a.maturity ?? "") ?? 999) - (maturityOrder.get(b.maturity ?? "") ?? 999));
    const first = rows[0];
    const stale = rows.some((row) => macroIsStale(row, now));
    const source = worldSourceFromMacro(first.source, stale ? "partial" : "ok");
    const observedAt = rows.map((row) => row.observed_at).sort()[0];
    const published = rows.flatMap((row) => row.published_at ? [row.published_at] : []).sort()[0];
    const tenYear = rows.find((row) => row.maturity === "10Y") ?? rows.at(-1)!;
    const status: WorldCard["status"] = rows.some((row) => row.method === "official_model")
      ? "derived"
      : "observed";
    const curve = rows.map((row) => ({
      tenor: row.maturity ?? row.label,
      label: row.maturity ?? row.label,
      value: row.value,
      unit: "%",
      observed_at: row.observed_at,
      series_key: row.series_key,
    }));
    const maturities = rows.map((row) => row.maturity ?? row.label).join(" and ");
    const sameDate = rows.every((row) => row.observed_at === observedAt);
    return {
      id: `sovereign-${first.jurisdiction.toLowerCase()}`,
      key: `sovereign-curve-${first.jurisdiction.toLowerCase()}`,
      title: `${first.jurisdiction_name} curve`,
      name: `${first.jurisdiction_name} sovereign curve`,
      label: first.institution,
      jurisdiction: first.jurisdiction,
      symbol: first.jurisdiction,
      value: tenYear.value,
      display_value: `${tenYear.value}%`,
      unit: "%",
      curve,
      status,
      stale,
      observed_at: observedAt,
      ...(published ? { published_at: published } : {}),
      fetched_at: first.fetched_at,
      cadence: first.reference.frequency,
      source_id: source.id,
      source,
      method: first.method,
      proof_state: "asserted",
      note: rows.length === 1
        ? `Only the official ${maturities} reference observation is available; another requested tenor is missing.`
        : sameDate
          ? `Official ${maturities} reference observations from the same date.`
          : `${maturities} curve points have different observation dates; each point keeps its own timestamp in the receipt.`,
      receipt: {
        jurisdiction: first.jurisdiction,
        institution: first.institution,
        is_live: false,
        observations: rows,
      },
    };
  }).sort((a, b) => a.title.localeCompare(b.title));
}

function calendarCard(event: MacroEvent, now: Date): WorldCard {
  const source = worldSourceFromMacro(event.source);
  const today = now.toISOString().slice(0, 10);
  return {
    id: event.id,
    key: event.id,
    title: event.title,
    label: event.institution,
    symbol: event.institution_code,
    value: event.decision_on,
    display_value: event.decision_on,
    unit: "date",
    status: "scheduled",
    stale: event.ends_on < today,
    observed_at: event.starts_on,
    ...(event.published_at ? { published_at: event.published_at } : {}),
    fetched_at: event.fetched_at,
    cadence: "official calendar",
    source_id: source.id,
    source,
    method: "official_schedule",
    proof_state: "asserted",
    note: event.projection_release
      ? "A projection release is scheduled with this meeting. Exact decision time has not been announced."
      : "Exact decision time has not been announced.",
    receipt: {
      starts_on: event.starts_on,
      ends_on: event.ends_on,
      decision_on: event.decision_on,
      time_status: event.time_status,
      schedule_status: event.schedule_status,
      projection_release: event.projection_release,
      jurisdiction: event.jurisdiction,
      retrieval: event.retrieval,
      verified_at: event.verified_at,
    },
    scheduled_at: event.decision_on,
    jurisdiction: event.jurisdiction,
    region: event.jurisdiction,
    category: event.category,
  };
}

function worldSourceFromFed(source: FedAnnouncementSource, status: WorldSource["status"] = "ok"): WorldSource {
  return {
    id: source.id,
    name: source.publisher,
    title: source.title,
    url: source.landing_page_url,
    status,
    cadence: "official RSS, checked every five minutes",
    license: source.licence,
    terms_url: source.terms_url,
    fetched_at: source.fetched_at,
    ...(source.published_at ? { updated_at: source.published_at } : {}),
    stale: status === "partial",
    note: source.note,
    description: source.note,
    retrieval: "live_fetch",
  };
}

function fedAnnouncementCard(announcement: FedAnnouncement, now: Date): WorldCard {
  const stale = (ageDays(announcement.published_at, now) ?? Infinity) > 60;
  const source = {
    ...worldSourceFromFed(announcement.source, stale ? "partial" : "ok"),
    // For a release card, "Open original source" should open that release,
    // while the receipt separately preserves the RSS resource URL.
    url: announcement.url,
  };
  return {
    id: `briefing-${announcement.id}`,
    key: announcement.id,
    title: "Latest Fed monetary-policy release",
    label: announcement.title,
    name: announcement.institution,
    jurisdiction: announcement.jurisdiction,
    value: announcement.title,
    display_value: announcement.title,
    unit: "official release",
    status: "observed",
    stale,
    observed_at: announcement.published_at,
    published_at: announcement.published_at,
    fetched_at: announcement.fetched_at,
    cadence: source.cadence,
    source_id: source.id,
    source,
    method: "official_release_feed",
    proof_state: "asserted",
    summary: announcement.title,
    category: announcement.category,
    note: "Official title and source link only; no inferred market impact.",
    receipt: {
      announcement_url: announcement.url,
      source_resource_url: announcement.source.url,
      category: announcement.category,
    },
  };
}

function ecbSource(fact: FxFact, stale: boolean): WorldSource {
  return {
    id: ECB_FX_SOURCE_ID,
    name: "European Central Bank",
    title: "Euro foreign-exchange reference rates",
    url: fact.sourceUrl,
    status: stale ? "partial" : "ok",
    cadence: "TARGET business days, normally around 16:00 CET",
    license: "attribution-required",
    terms_url: "https://www.ecb.europa.eu/stats/ecb_statistics/governance_and_quality_framework/html/usage_policy.en.html",
    fetched_at: fact.fetchedAt,
    updated_at: fact.refDate,
    stale,
    note: "Reference rate, not a tradeable or intraday quote. Source: ECB.",
    description: "ECB daily foreign-exchange reference rates.",
  };
}

function fxCard(fact: FxFact, now: Date): WorldCard {
  const stale = fxReferenceIsStale(fact.refDate, now);
  const source = ecbSource(fact, stale);
  const value = formatMinor(fact.valueScaled, fact.decimals);
  return {
    id: `fx-${fact.base.toLowerCase()}-${fact.quote.toLowerCase()}`,
    key: `${fact.base}/${fact.quote}`,
    title: `${fact.base} → ${fact.quote}`,
    label: `${fact.quote} per ${fact.base}`,
    symbol: fact.quote,
    value,
    display_value: value,
    unit: `${fact.quote}/${fact.base}`,
    status: fact.method === "derived" ? "derived" : "observed",
    stale,
    observed_at: fact.refDate,
    fetched_at: fact.fetchedAt,
    cadence: source.cadence,
    source_id: source.id,
    source,
    method: fact.method,
    proof_state: fact.proof_state,
    note: "ECB daily reference rate; delayed and non-tradeable.",
    receipt: {
      value_scaled: fact.valueScaled,
      decimals: fact.decimals,
      recompute: fact.recompute,
      is_reference: true,
      is_live: false,
    },
  };
}

function sourceFromMoneyFact(id: string, fact: MoneyFact, status: WorldSource["status"] = "ok"): WorldSource {
  const first = fact.sources[0];
  return {
    id,
    name: first?.name ?? id,
    title: first?.name ?? id,
    url: first?.url ?? "",
    status,
    cadence: `stale after ${fact.stale_after_s}s`,
    license: fact.redistribution,
    fetched_at: first?.fetched_at,
    updated_at: fact.observed_at,
    stale: status === "partial",
  };
}

function priceCard(
  feed: PriceFeed,
  result: Extract<OracleResult, { kind: "price" }>,
  base: WorldBaseCurrency,
  usdToBase: FxFact | null,
  now: Date,
): WorldCard {
  const fact = result.fact;
  let valueScaled = fact.value;
  let decimals = fact.decimals;
  let method = fact.method;
  let sources: Source[] = fact.sources;
  const underlyingSources: WorldSource[] = [];
  let recompute = fact.recompute?.how ?? "read the cited on-chain oracle round";
  let redistribution = fact.redistribution;
  let stale = result.age_s >= result.heartbeat_s;
  let observedAt = fact.observed_at;
  const chainlinkSource = sourceFromMoneyFact(
    `chainlink-${feed.symbol.toLowerCase()}-usd`,
    fact,
    stale ? "partial" : "ok",
  );
  underlyingSources.push(chainlinkSource);
  let source = chainlinkSource;
  if (base !== "USD" && usdToBase) {
    valueScaled = divHalfEven(
      BigInt(fact.value) * BigInt(usdToBase.valueScaled),
      10n ** BigInt(usdToBase.decimals),
    ).toString();
    method = "derived";
    sources = [
      ...sources,
      {
        name: "European Central Bank — euro foreign-exchange reference rates",
        url: usdToBase.sourceUrl,
        fetched_at: usdToBase.fetchedAt,
      },
    ];
    const fxStale = fxReferenceIsStale(usdToBase.refDate, now);
    stale ||= fxStale;
    observedAt = usdToBase.refDate <= fact.observed_at.slice(0, 10)
      ? usdToBase.refDate
      : fact.observed_at;
    const ecb = ecbSource(usdToBase, fxStale);
    underlyingSources.push(ecb);
    redistribution = "attribution-required";
    source = {
      ...chainlinkSource,
      name: `${chainlinkSource.name} + European Central Bank`,
      title: `${feed.symbol}/${base} derived from Chainlink + ECB`,
      license: "attribution-required",
      status: stale ? "partial" : "ok",
      stale,
      terms_url: ecb.terms_url,
      note: "The on-chain USD observation is combined with an ECB reference-rate cross; ECB attribution and reuse conditions apply to the result.",
      description: "Derived cross-source reference value; see both underlying source receipts.",
    };
    recompute = `${recompute}; multiply by ECB USD→${base} (${usdToBase.valueScaled} × 10^-${usdToBase.decimals}), half-even at ${decimals} dp`;
  }
  const value = formatMinor(valueScaled, decimals);
  const composedFetchedAt = sources
    .map((candidate) => candidate.fetched_at)
    .filter(Boolean)
    .sort()[0];
  return {
    id: `crypto-${feed.symbol.toLowerCase()}-${base.toLowerCase()}`,
    key: `${feed.symbol}/${base}`,
    title: `${feed.symbol} / ${base}`,
    label: `On-chain oracle · ${base} reference value`,
    symbol: feed.symbol,
    value,
    display_value: value,
    unit: base,
    status: method === "derived" ? "derived" : "observed",
    stale,
    observed_at: observedAt,
    fetched_at: composedFetchedAt,
    cadence: `oracle heartbeat ${feed.heartbeat_s}s`,
    source_id: source.id,
    source,
    method,
    proof_state: fact.proof_state,
    note: "On-chain reference answer, not an executable exchange quote.",
    redistribution,
    sources: underlyingSources,
    receipt: {
      value_scaled: valueScaled,
      decimals,
      age_s: result.age_s,
      heartbeat_s: result.heartbeat_s,
      sources,
      source_receipts: underlyingSources,
      redistribution,
      recompute: { how: recompute },
    },
  };
}

function moneyFactIsStale(fact: MoneyFact, now: Date, deliveryBufferS = 10): boolean {
  const observed = Date.parse(fact.observed_at);
  if (!Number.isFinite(observed)) return true;
  return observed + (fact.stale_after_s - deliveryBufferS) * 1000 <= now.getTime();
}

function feeCard(fact: MoneyFact, now: Date): WorldCard {
  const isBitcoin = fact.predicate === "fee_per_vbyte_sat";
  const value = isBitcoin ? formatMinor(fact.value, 2) : formatMinor(fact.value, 9);
  const unit = isBitcoin ? "sat/vB" : "gwei/gas";
  const stale = moneyFactIsStale(fact, now);
  const source = sourceFromMoneyFact(
    `fees-${isBitcoin ? "bitcoin" : "base"}`,
    fact,
    stale ? "partial" : "ok",
  );
  return {
    id: `fee-${isBitcoin ? "bitcoin" : "base"}`,
    key: fact.subject,
    title: isBitcoin ? "Bitcoin fee estimate" : "Base gas price",
    label: isBitcoin ? "3-block target" : "Current eth_gasPrice",
    symbol: isBitcoin ? "BTC" : "BASE",
    value,
    display_value: `${value} ${unit}`,
    unit,
    status: fact.method === "derived" ? "derived" : "observed",
    stale,
    observed_at: fact.observed_at,
    fetched_at: fact.sources[0]?.fetched_at,
    cadence: source.cadence,
    source_id: source.id,
    source,
    method: fact.method,
    proof_state: fact.proof_state,
    note: isBitcoin
      ? "Estimate for confirmation within roughly three blocks; not a guarantee."
      : "Gas price per unit; total transaction cost also depends on gas used.",
    receipt: { money_fact: fact },
  };
}

function sourceFailureDetail(): string {
  // Adapter failures may contain URLs or provider diagnostics with embedded
  // credentials. World publishes only this stable contract, never the caught
  // text supplied by an upstream.
  return WORLD_FAILURE.macro.message;
}

function sourceFailureId(value: unknown, fallback: string): string {
  const row = asRecord(value);
  for (const key of ["source_id", "id", "source"]) {
    const safe = safeMacroSourceId(row[key], "");
    if (safe) return safe;
  }
  return fallback;
}

function publicPriceFailure(result: Exclude<OracleResult, { kind: "price" }>): {
  code: string;
  detail: string;
  retryable: boolean;
} {
  if (result.kind === "stale") {
    return { code: PRICE_FAILURE.stale.code, detail: PRICE_FAILURE.stale.message, retryable: true };
  }
  if (result.kind === "unreachable") {
    return { code: PRICE_FAILURE.upstream.code, detail: PRICE_FAILURE.upstream.message, retryable: true };
  }
  if (result.code === PRICE_FAILURE.answer.code) {
    return { code: PRICE_FAILURE.answer.code, detail: PRICE_FAILURE.answer.message, retryable: false };
  }
  if (result.code === PRICE_FAILURE.decimals.code) {
    return { code: PRICE_FAILURE.decimals.code, detail: PRICE_FAILURE.decimals.message, retryable: false };
  }
  if (result.code === PRICE_FAILURE.description.code) {
    return { code: PRICE_FAILURE.description.code, detail: PRICE_FAILURE.description.message, retryable: false };
  }
  return {
    code: "price_oracle_invalid",
    detail: "The on-chain price source failed a configured integrity check.",
    retryable: false,
  };
}

function macroSection(sourceId: string): WorldUnavailable["section"] {
  if (sourceId === "bis_policy_rates") return "policy";
  if (sourceId.endsWith("_meeting_calendar")) return "calendar";
  return "sovereigns";
}

function policyCurveThread(sovereigns: WorldCard[]): WorldThread {
  const us = sovereigns.find((card) => card.receipt?.jurisdiction === "US");
  const us2 = curvePoint(us, "2Y");
  const us10 = curvePoint(us, "10Y");
  let observed = "The US 2Y/10Y pair is unavailable, so CashLoom is not inferring a curve shape.";
  if (us2 && us10) {
    const spread = percentSpreadBps(us10, us2);
    observed = `The latest official US 10Y minus 2Y reference spread is ${spread} bp.`;
  }
  return {
    id: "thread-policy-curve",
    key: "policy-to-sovereign-curve",
    title: "Policy → sovereign curve",
    label: "Transmission thread",
    status: "derived",
    stale: Boolean(us?.stale),
    observed: [observed],
    possible_channels: [
      "Expected short-rate paths can move front-end yields.",
      "Growth, inflation, term premium, and sovereign supply also move longer maturities.",
    ],
    limits: [
      "A curve spread is co-movement context, not proof that one policy decision caused a yield move.",
      "Official daily reference observations are delayed, not live executable prices.",
    ],
    note: "Mechanism, evidence, and limits are kept separate.",
    possible_channel: [
      "Expected short-rate paths can move front-end yields.",
      "Growth, inflation, term premium, and sovereign supply also move longer maturities.",
    ],
  };
}

function curvePoint(card: WorldCard | undefined, tenor: string): string | undefined {
  const curve = card?.curve;
  if (!Array.isArray(curve)) return undefined;
  for (const raw of curve) {
    const point = asRecord(raw);
    if ((point.tenor === tenor || point.label === tenor) && typeof point.value === "string") return point.value;
  }
  return undefined;
}

function parsePercent(value: string): { coefficient: bigint; decimals: number } {
  const match = value.trim().match(/^(-?)(\d+)(?:\.(\d+))?$/);
  if (!match) throw new Error(`invalid decimal '${value}'`);
  const fraction = match[3] ?? "";
  const coefficient = BigInt(`${match[2]}${fraction}`);
  return {
    coefficient: match[1] ? -coefficient : coefficient,
    decimals: fraction.length,
  };
}

/** Exact percent-point difference rendered as integer basis points, half-even. */
export function percentSpreadBps(leftPercent: string, rightPercent: string): string {
  const left = parsePercent(leftPercent);
  const right = parsePercent(rightPercent);
  const scale = Math.max(left.decimals, right.decimals);
  const leftScaled = left.coefficient * 10n ** BigInt(scale - left.decimals);
  const rightScaled = right.coefficient * 10n ** BigInt(scale - right.decimals);
  const delta = leftScaled - rightScaled;
  return divHalfEven(delta * 100n, 10n ** BigInt(scale)).toString();
}

function energyCoverage(): { card: WorldCard; source: WorldSource; unavailable: WorldUnavailable } {
  const source: WorldSource = {
    id: ENERGY_SOURCE_ID,
    name: "CashLoom source review",
    title: "Crude-oil benchmark display rights",
    url: "https://www.eia.gov/opendata/documentation.php",
    status: "withheld",
    cadence: "coverage review",
    license: "third-party-restricted",
    note: "EIA supply data can be integrated with an API key, but common EIA spot-price series identify third-party price inputs. A live Brent/WTI display needs cleared redistribution rights.",
  };
  return {
    source,
    card: {
      id: "energy-crude-benchmarks",
      key: "brent-wti",
      title: "Brent & WTI",
      label: "Benchmark coverage",
      value: "Withheld",
      display_value: "Source rights pending",
      status: "unavailable",
      stale: false,
      source_id: source.id,
      source,
      note: "CashLoom will not relabel delayed or redistribution-restricted prices as live market data.",
      receipt: { is_live: false, reason: "commercial display rights not yet cleared" },
    },
    unavailable: {
      id: "energy-benchmark-rights",
      section: "energy",
      title: "Crude-oil benchmark prices withheld",
      code: "energy_benchmark_rights_withheld",
      detail: "Commercial display and redistribution rights are not yet cleared; no substitute proxy is shown.",
      retryable: false,
    },
  };
}

function ukYieldCoverage(): { source: WorldSource; unavailable: WorldUnavailable } {
  return {
    source: {
      id: UK_YIELD_SOURCE_ID,
      name: "Bank of England",
      title: "UK government liability yield curves",
      url: "https://www.bankofengland.co.uk/statistics/yield-curves",
      status: "withheld",
      cadence: "business daily, normally next-business-day publication",
      license: "third-party-restricted",
      note: "The Bank's published curve uses third-party market inputs. Public display and downstream redistribution rights need confirmation before CashLoom serves the values.",
      description: "Known launch gap: UK sovereign curve values are withheld pending rights review.",
    },
    unavailable: {
      id: UK_YIELD_SOURCE_ID,
      section: "sovereigns",
      title: "UK sovereign curve withheld",
      code: "uk_yield_rights_withheld",
      detail: "The official curve relies on third-party market inputs; CashLoom is waiting for clear public-display and redistribution rights.",
      retryable: false,
    },
  };
}

function boundedThreads(sovereigns: WorldCard[]): WorldThread[] {
  return [
    policyCurveThread(sovereigns),
    {
      id: "thread-oil-currencies",
      key: "oil-currency-sensitivity",
      title: "Oil ↔ currencies",
      label: "Research thread · coverage pending",
      status: "unavailable",
      stale: false,
      observed: ["No oil/currency coefficient is published until a redistributable daily oil series is cleared."],
      possible_channels: [
        "Trade balances and fiscal receipts can make some currencies sensitive to oil returns.",
        "Risk sentiment and broad US-dollar moves can affect both series at once.",
      ],
      possible_channel: [
        "Trade balances and fiscal receipts can make some currencies sensitive to oil returns.",
        "Risk sentiment and broad US-dollar moves can affect both series at once.",
      ],
      limits: [
        "Sensitivity is not a currency peg.",
        "Any eventual card must state the return window, sample count, quote convention, beta formula, and timestamps.",
      ],
      note: "Planned measures: 30/90/252-day rolling correlation and beta from daily returns.",
    },
    {
      id: "thread-conflict-oil",
      key: "conflict-energy-event-study",
      title: "Conflict → energy",
      label: "Event-study thread · coverage pending",
      status: "unavailable",
      stale: false,
      observed: ["No automated headline is being presented as a verified cause of an oil move."],
      possible_channels: [
        "Physical supply disruption, sanctions, shipping risk, and inventory responses can change energy pricing.",
        "Markets can also reverse as disruption probabilities or spare-capacity estimates change.",
      ],
      possible_channel: [
        "Physical supply disruption, sanctions, shipping risk, and inventory responses can change energy pricing.",
        "Markets can also reverse as disruption probabilities or spare-capacity estimates change.",
      ],
      limits: [
        "News co-occurrence does not establish impact or causality.",
        "Machine-extracted events require source links, deduplication, and a bounded pre/post return window.",
      ],
      note: "The eventual layer will label association and uncertainty, never manufacture a causal score.",
    },
  ];
}

function briefings(
  latestAnnouncement: WorldCard | null,
  macro: MacroSnapshot | null,
  policy: WorldCard[],
  sovereigns: WorldCard[],
  calendar: WorldCard[],
  unavailable: WorldUnavailable[],
): WorldCard[] {
  const cards: WorldCard[] = [];
  if (latestAnnouncement) cards.push(latestAnnouncement);
  const next = calendar.find((card) => !card.stale);
  if (next) {
    cards.push({
      ...next,
      id: "briefing-next-policy-event",
      key: "next-policy-event",
      title: "Next policy event",
      label: next.title,
      note: `${next.label} · date from its official calendar; exact time may remain unannounced.`,
      summary: `${next.label} · date from its official calendar; exact time may remain unannounced.`,
      category: "calendar",
    });
  }
  if (policy.length) {
    cards.push({
      id: "briefing-policy-coverage",
      key: "policy-coverage",
      title: "Policy board",
      label: "Current official observations",
      value: String(policy.length),
      display_value: `${policy.length} official rates`,
      unit: "official rates",
      status: "observed",
      stale: policy.some((card) => card.stale),
      note: "Policy rates are not directly comparable measures of financial conditions; each receipt names its convention and delay.",
      summary: "Current official policy and overnight cash-rate observations.",
      category: "policy",
    });
  }
  const us = sovereigns.find((card) => card.receipt?.jurisdiction === "US");
  const us2 = curvePoint(us, "2Y");
  const us10 = curvePoint(us, "10Y");
  if (us && us2 && us10) {
    const spread = percentSpreadBps(us10, us2);
    cards.push({
      id: "briefing-us-curve",
      key: "us-2s10s",
      title: "US 2s10s reference spread",
      label: "10Y minus 2Y",
      value: spread,
      display_value: `${spread} bp`,
      unit: "basis points",
      status: "derived",
      stale: us.stale,
      observed_at: us.observed_at,
      source_id: us.source_id,
      source: us.source,
      method: "derived",
      proof_state: "tested",
      note: "Shape context only; not a recession forecast or a causal policy claim.",
      receipt: {
        recompute: `${us10}% − ${us2}%, multiplied by 100 and rounded half-even to whole bp`,
        inputs: [`${us.id}:10Y`, `${us.id}:2Y`],
      },
      summary: "The latest official US 10Y yield minus the 2Y yield, shown as curve-shape context.",
      category: "sovereigns",
    });
  }
  if (unavailable.length || macro?.status === "partial") {
    cards.push({
      id: "briefing-coverage",
      key: "coverage-status",
      title: "Coverage is partial",
      label: "Missing data is named, never zero-filled",
      value: String(unavailable.length),
      display_value: `${unavailable.length} disclosed gap${unavailable.length === 1 ? "" : "s"}`,
      unit: "gaps",
      status: "unavailable",
      stale: false,
      note: "Open each receipt to see whether a source is retryable or intentionally withheld.",
      summary: "Missing coverage is disclosed rather than silently filled or presented as zero.",
      category: "coverage",
    });
  }
  return cards.slice(0, 4);
}

function dedupeSources(sources: WorldSource[]): WorldSource[] {
  const byId = new Map<string, WorldSource>();
  const rank: Record<WorldSource["status"], number> = { ok: 0, partial: 1, unavailable: 2, withheld: 3 };
  for (const source of sources) {
    const previous = byId.get(source.id);
    if (!previous || rank[source.status] > rank[previous.status]) byId.set(source.id, source);
  }
  return [...byId.values()].sort((a, b) => a.name.localeCompare(b.name));
}

async function loadFx(
  base: WorldBaseCurrency,
  deps: WorldDeps,
  now: Date,
): Promise<{ cards: WorldCard[]; failures: WorldUnavailable[]; usdToBase: FxFact | null }> {
  const cards: WorldCard[] = [];
  const failures: WorldUnavailable[] = [];
  let usdToBase: FxFact | null = null;
  let feedUnavailable = false;
  for (const quote of FX_QUOTES) {
    if (quote === base) continue;
    if (feedUnavailable) {
      failures.push({
        id: `fx-${base.toLowerCase()}-${quote.toLowerCase()}`,
        section: "fx",
        title: `${base}/${quote} reference rate unavailable`,
        code: WORLD_FAILURE.fx.code,
        detail: WORLD_FAILURE.fx.message,
        retryable: true,
      });
      continue;
    }
    try {
      const result = await deps.fxRate(base, quote);
      if ("error" in result) {
        failures.push({
          id: `fx-${base.toLowerCase()}-${quote.toLowerCase()}`,
          section: "fx",
          title: `${base}/${quote} reference rate unavailable`,
          code: WORLD_FAILURE.fxPair.code,
          detail: WORLD_FAILURE.fxPair.message,
          retryable: false,
        });
      } else {
        cards.push(fxCard(result, now));
      }
    } catch {
      feedUnavailable = true;
      failures.push({
        id: `fx-${base.toLowerCase()}-${quote.toLowerCase()}`,
        section: "fx",
        title: `${base}/${quote} reference rate unavailable`,
        code: WORLD_FAILURE.fx.code,
        detail: WORLD_FAILURE.fx.message,
        retryable: true,
      });
    }
  }
  if (base !== "USD" && !feedUnavailable) {
    try {
      const cross = await deps.fxRate("USD", base);
      if (!("error" in cross)) usdToBase = cross;
    } catch {
      // Crypto remains honestly denominated in USD below when this leg fails.
    }
  }
  return { cards, failures, usdToBase };
}

/** Build one World snapshot. Exported so tests and self-hosted nodes can inject
 * deterministic readers without touching a network. */
export async function buildWorldSnapshot(
  base: WorldBaseCurrency = "USD",
  overrides: Partial<WorldDeps> = {},
): Promise<WorldSnapshot> {
  const deps: WorldDeps = { ...defaultDeps, ...overrides };
  const now = deps.now();
  const generatedAt = now.toISOString();
  const unavailable: WorldUnavailable[] = [];
  const sources: WorldSource[] = [];

  const [macroResult, announcementResult, cashResult, fxResult, feeResult, priceResults] = await Promise.all([
    deps.macro().then((value) => ({ ok: true as const, value })).catch(() => ({ ok: false as const })),
    deps.announcements().then((value) => ({ ok: true as const, value })).catch(() => ({ ok: false as const })),
    deps.cash().then((value) => ({ ok: true as const, value })).catch(() => ({ ok: false as const })),
    loadFx(base, deps, now),
    deps.fees().then((value) => ({ ok: true as const, value })).catch(() => ({ ok: false as const })),
    Promise.all(PRICE_FEEDS.map(async (feed) => ({
      feed,
      result: await deps.price(feed).catch((): OracleResult => ({
        kind: "unreachable",
        pair: `${feed.symbol}/USD`,
        code: PRICE_FAILURE.upstream.code,
        detail: PRICE_FAILURE.upstream.message,
      })),
    }))),
  ]);

  let macro: MacroSnapshot | null = null;
  let policy: WorldCard[] = [];
  let sovereigns: WorldCard[] = [];
  let calendar: WorldCard[] = [];
  let latestAnnouncement: WorldCard | null = null;
  if (announcementResult.ok && announcementResult.value.announcements.length) {
    latestAnnouncement = fedAnnouncementCard(announcementResult.value.announcements[0], now);
    sources.push(latestAnnouncement.source!);
  } else {
    sources.push({
      id: "federal_reserve_monetary_policy_rss",
      name: "Board of Governors of the Federal Reserve System",
      title: "Monetary Policy press releases",
      url: FED_RSS_DIRECTORY_URL,
      status: "unavailable",
      cadence: "official RSS, checked every five minutes",
      license: "official_public_information",
      retrieval: "live_fetch",
      note: `Official feed unavailable at ${FED_MONETARY_RSS_URL}.`,
    });
    unavailable.push({
      id: "federal_reserve_monetary_policy_rss",
      section: "briefing",
      title: "Latest Federal Reserve release unavailable",
      code: WORLD_FAILURE.announcements.code,
      detail: WORLD_FAILURE.announcements.message,
      retryable: true,
    });
  }
  if (macroResult.ok) {
    macro = macroResult.value;
    for (const status of macro.sources) sources.push(worldSourceFromMacroStatus(status, now));
    policy = macro.policy.map((observation) => macroCard(observation, now));
    sovereigns = sovereignCards(macro.sovereigns, now);
    calendar = macro.calendar
      .map((event) => calendarCard(event, now))
      .sort((a, b) => String(a.value).localeCompare(String(b.value)))
      .filter((card) => !card.stale)
      .slice(0, 24);
    for (const observation of [...macro.policy, ...macro.sovereigns]) {
      sources.push(worldSourceFromMacro(observation.source, macroIsStale(observation, now) ? "partial" : "ok"));
    }
    for (const event of macro.calendar) sources.push(worldSourceFromMacro(event.source));
    for (const failure of macro.failures) {
      const id = sourceFailureId(failure, `macro-${unavailable.length + 1}`);
      unavailable.push({
        id,
        section: macroSection(id),
        title: `${id} unavailable`,
        code: WORLD_FAILURE.macro.code,
        detail: sourceFailureDetail(),
        retryable: failure.retryable,
      });
    }
    for (const [index, warning] of macro.warnings.entries()) {
      if (warning.code !== "series_missing" && warning.code !== "value_missing") continue;
      const sourceId = safeMacroSourceId(warning.source_id, `macro-warning-${index + 1}`);
      unavailable.push({
        id: `${sourceId}:${warning.code}:${index + 1}`,
        section: macroSection(sourceId),
        title: `${sourceId} ${warning.code.replace("_", " ")}`,
        code: WORLD_FAILURE.macroSeries.code,
        detail: WORLD_FAILURE.macroSeries.message,
        retryable: true,
      });
    }
  } else {
    unavailable.push(
      { id: "macro-policy", section: "policy", title: "Policy rates unavailable", code: WORLD_FAILURE.macroGroup.code, detail: WORLD_FAILURE.macroGroup.message, retryable: true },
      { id: "macro-sovereigns", section: "sovereigns", title: "Sovereign yields unavailable", code: WORLD_FAILURE.macroGroup.code, detail: WORLD_FAILURE.macroGroup.message, retryable: true },
      { id: "macro-calendar", section: "calendar", title: "Policy calendar unavailable", code: WORLD_FAILURE.macroGroup.code, detail: WORLD_FAILURE.macroGroup.message, retryable: true },
    );
  }

  if (cashResult.ok) {
    const cashCards = cashResult.value.observations.map((observation) => cashCard(observation, now));
    policy.push(...cashCards);
    sources.push(worldSourceFromCash(
      cashResult.value.source,
      cashCards.some((card) => card.stale) ? "partial" : "ok",
    ));
  } else {
    sources.push(worldSourceFromCash(undefined, "unavailable"));
    unavailable.push({
      id: "ny_fed_reference_rates",
      section: "policy",
      title: "SOFR and EFFR unavailable",
      code: WORLD_FAILURE.cash.code,
      detail: WORLD_FAILURE.cash.message,
      retryable: true,
    });
  }

  unavailable.push(...fxResult.failures);
  const fx = fxResult.cards;
  for (const card of fx) if (card.source) sources.push(card.source);

  const crypto: WorldCard[] = [];
  for (const { feed, result } of priceResults) {
    if (result.kind === "price") {
      const useBase = base === "USD" || fxResult.usdToBase ? base : "USD";
      const card = priceCard(feed, result, useBase, fxResult.usdToBase, now);
      crypto.push(card);
      if (card.source) sources.push(card.source);
      if (useBase !== base) {
        unavailable.push({
          id: `crypto-${feed.symbol.toLowerCase()}-${base.toLowerCase()}`,
          section: "crypto",
          title: `${feed.symbol}/${base} conversion unavailable`,
          code: WORLD_FAILURE.fx.code,
          detail: "The on-chain USD price is present, but the required ECB reference-rate leg is unavailable; USD is shown instead.",
          retryable: true,
        });
      }
    } else {
      const failure = publicPriceFailure(result);
      unavailable.push({
        id: `crypto-${feed.symbol.toLowerCase()}`,
        section: "crypto",
        title: `${feed.symbol} price unavailable`,
        code: failure.code,
        detail: failure.detail,
        retryable: failure.retryable,
      });
    }
  }

  const fees: WorldCard[] = [];
  if (feeResult.ok) {
    fees.push(...feeResult.value.facts.map((fact) => feeCard(fact, now)));
    for (const card of fees) if (card.source) sources.push(card.source);
    for (const failure of feeResult.value.failed) {
      unavailable.push({
        id: `fees-${failure.chain}`,
        section: "fees",
        title: `${failure.label} fee unavailable`,
        code: WORLD_FAILURE.fees.code,
        detail: WORLD_FAILURE.fees.message,
        retryable: true,
      });
    }
  } else {
    unavailable.push({
      id: "fees-all",
      section: "fees",
      title: "Network fees unavailable",
      code: WORLD_FAILURE.fees.code,
      detail: WORLD_FAILURE.fees.message,
      retryable: true,
    });
  }

  const energyCoverageState = energyCoverage();
  const energy = [energyCoverageState.card];
  sources.push(energyCoverageState.source);
  unavailable.push(energyCoverageState.unavailable);
  const ukCoverageState = ukYieldCoverage();
  sources.push(ukCoverageState.source);
  unavailable.push(ukCoverageState.unavailable);

  const threads = boundedThreads(sovereigns);
  const allSources = dedupeSources(sources);
  const staleCount = [...policy, ...sovereigns, ...fx, ...crypto, ...fees].filter((card) => card.stale).length;
  const availableSources = allSources.filter((source) => source.status === "ok" || source.status === "partial").length;
  const state: WorldSnapshot["status"]["state"] = availableSources === 0 ? "unavailable" : unavailable.length || staleCount ? "partial" : "ready";

  return {
    "@type": "WorldSnapshot",
    schema: "cashloom.world/1",
    generated_at: generatedAt,
    base_currency: base,
    status: {
      state,
      complete: state === "ready",
      available_sources: availableSources,
      total_sources: allSources.length,
      stale_count: staleCount,
      unavailable,
    },
    briefing: briefings(latestAnnouncement, macro, policy, sovereigns, calendar, unavailable),
    policy,
    sovereigns,
    fx,
    crypto,
    fees,
    energy,
    calendar,
    threads,
    sources: allSources,
  };
}

export type WorldBuilder = (base: WorldBaseCurrency) => Promise<WorldSnapshot>;
export type WorldCacheState = "miss" | "fresh" | "stale";

interface CachedWorldSnapshot {
  snapshot: WorldSnapshot;
  serialized: string;
  etag: string;
  storedAt: number;
  freshUntil: number;
  staleUntil: number;
}

interface BuiltWorldSnapshot {
  document: CachedWorldSnapshot;
  stored: boolean;
}

export interface WorldSnapshotDelivery extends CachedWorldSnapshot {
  cacheState: WorldCacheState;
  buildDurationMs: number;
  deliveredAt: number;
}

export interface WorldSnapshotCacheOptions {
  now?: () => number;
  freshMs?: number;
  unavailableMs?: number;
  staleWindowMs?: number;
  failureBackoffMs?: number;
}

export interface WorldSnapshotCache {
  read(base: WorldBaseCurrency): Promise<WorldSnapshotDelivery>;
  /** Await active builds. Primarily useful for orderly shutdown and tests. */
  waitForIdle(base?: WorldBaseCurrency): Promise<void>;
}

export const WORLD_CACHE_FRESH_MS = 10_000;
export const WORLD_CACHE_UNAVAILABLE_MS = 10_000;
export const WORLD_CACHE_STALE_WINDOW_MS = 5 * 60_000;
export const WORLD_CACHE_FAILURE_BACKOFF_MS = 30_000;

function worldSnapshotEtag(serialized: string): string {
  const digest = createHash("sha256").update(serialized).digest("base64url");
  // The semantic snapshot is stable while transfer codings may differ.
  return `W/"sha256-${digest}"`;
}

function isSafeWorldSnapshot(snapshot: WorldSnapshot): boolean {
  return snapshot.status.state === "ready" || snapshot.status.state === "partial";
}

/**
 * Retain one exact, last-known truthful World document per currency lens. A
 * stale document remains immediately available for a bounded window while one
 * background build runs. Total-outage snapshots never replace a last-good or
 * honestly degraded snapshot, and no cached generated_at is rewritten.
 */
export function createWorldSnapshotCache(
  builder: WorldBuilder,
  options: WorldSnapshotCacheOptions = {},
): WorldSnapshotCache {
  const now = options.now ?? Date.now;
  const freshMs = options.freshMs ?? WORLD_CACHE_FRESH_MS;
  const unavailableMs = options.unavailableMs ?? WORLD_CACHE_UNAVAILABLE_MS;
  const staleWindowMs = options.staleWindowMs ?? WORLD_CACHE_STALE_WINDOW_MS;
  const failureBackoffMs = options.failureBackoffMs ?? WORLD_CACHE_FAILURE_BACKOFF_MS;
  const cached = new Map<WorldBaseCurrency, CachedWorldSnapshot>();
  const unavailable = new Map<WorldBaseCurrency, CachedWorldSnapshot>();
  const inflight = new Map<WorldBaseCurrency, Promise<BuiltWorldSnapshot>>();
  const retryAt = new Map<WorldBaseCurrency, number>();
  const lastFailure = new Map<WorldBaseCurrency, unknown>();

  const beginBuild = (base: WorldBaseCurrency): Promise<BuiltWorldSnapshot> => {
    const active = inflight.get(base);
    if (active) return active;
    const build = Promise.resolve()
      .then(() => builder(base))
      .then((snapshot): BuiltWorldSnapshot => {
        const storedAt = now();
        const serialized = JSON.stringify(snapshot);
        const safe = isSafeWorldSnapshot(snapshot);
        const document: CachedWorldSnapshot = {
          snapshot,
          serialized,
          etag: worldSnapshotEtag(serialized),
          storedAt,
          freshUntil: storedAt + (safe ? freshMs : unavailableMs),
          staleUntil: storedAt + (safe ? freshMs + staleWindowMs : unavailableMs),
        };
        if (safe) {
          cached.set(base, document);
          unavailable.delete(base);
          retryAt.delete(base);
          lastFailure.delete(base);
          return { document, stored: true };
        }
        // An all-unavailable build is a truthful direct response when there is
        // no safe history, but it must not evict one that can still be labelled
        // stale. Back off before trying the failed source fan-out again.
        if (cached.has(base)) {
          retryAt.set(base, storedAt + failureBackoffMs);
          lastFailure.set(base, new Error("World refresh produced no available sources"));
        } else {
          // With no safe history, briefly reuse this exact outage receipt to
          // prevent a source fan-out storm. It has its own generated_at and is
          // never promoted into the last-safe stale window.
          unavailable.set(base, document);
          retryAt.delete(base);
          lastFailure.delete(base);
        }
        return { document, stored: false };
      })
      .catch((error: unknown) => {
        retryAt.set(base, now() + failureBackoffMs);
        lastFailure.set(base, error);
        throw error;
      });
    inflight.set(base, build);
    void build.then(
      () => { if (inflight.get(base) === build) inflight.delete(base); },
      () => { if (inflight.get(base) === build) inflight.delete(base); },
    );
    return build;
  };

  const deliver = (
    document: CachedWorldSnapshot,
    cacheState: WorldCacheState,
    buildDurationMs = 0,
  ): WorldSnapshotDelivery => ({
    ...document,
    cacheState,
    buildDurationMs,
    deliveredAt: now(),
  });

  return {
    async read(base) {
      const requestedAt = now();
      const entry = cached.get(base);
      if (entry && requestedAt < entry.freshUntil) return deliver(entry, "fresh");

      if (entry && requestedAt < entry.staleUntil) {
        if (!inflight.has(base) && requestedAt >= (retryAt.get(base) ?? 0)) {
          // The caller receives the timestamped document immediately. Refresh
          // completion is deliberately decoupled from this response.
          void beginBuild(base).catch(() => undefined);
        }
        return deliver(entry, "stale");
      }

      if (!entry) {
        const outage = unavailable.get(base);
        if (outage && requestedAt < outage.freshUntil) return deliver(outage, "fresh");
        if (outage) unavailable.delete(base);
      }

      // Beyond the bounded serve window there is no safe cached response. A
      // cold request and every base-currency miss therefore wait for truth.
      if (!inflight.has(base) && requestedAt < (retryAt.get(base) ?? 0)) {
        const failure = lastFailure.get(base);
        throw failure instanceof Error
          ? failure
          : new Error("World snapshot refresh is backing off after an upstream failure");
      }
      const built = await beginBuild(base);
      return deliver(
        built.document,
        "miss",
        Math.max(0, now() - requestedAt),
      );
    },
    async waitForIdle(base) {
      const active = base ? [inflight.get(base)] : [...inflight.values()];
      await Promise.all(active.filter((value): value is Promise<BuiltWorldSnapshot> => Boolean(value)).map(
        (value) => value.then(() => undefined, () => undefined),
      ));
    },
  };
}

function ifNoneMatch(requestValue: string | undefined, etag: string): boolean {
  if (!requestValue) return false;
  const normalizedEtag = etag.replace(/^W\//, "");
  return requestValue.split(",").some((candidate) => {
    const normalized = candidate.trim().replace(/^W\//, "");
    return normalized === "*" || normalized === normalizedEtag;
  });
}

function snapshotAgeSeconds(snapshot: WorldSnapshot, now: number): number {
  const generatedAt = Date.parse(snapshot.generated_at);
  if (!Number.isFinite(generatedAt)) return 0;
  return Math.max(0, Math.floor((now - generatedAt) / 1_000));
}

function worldResponse(c: Context, delivery: WorldSnapshotDelivery) {
  const residentAge = Math.max(0, Math.floor((delivery.deliveredAt - delivery.storedAt) / 1_000));
  c.header("Content-Type", WORLD_MEDIA_TYPE);
  c.header(
    "Cache-Control",
    delivery.cacheState === "stale"
      ? "public, max-age=0, must-revalidate, stale-while-revalidate=300, stale-if-error=300"
      : "public, max-age=5, stale-while-revalidate=300, stale-if-error=300",
  );
  c.header("ETag", delivery.etag);
  c.header("Age", String(residentAge));
  c.header("X-CashLoom-Cache", delivery.cacheState);
  c.header("X-CashLoom-Snapshot-Age", String(snapshotAgeSeconds(delivery.snapshot, delivery.deliveredAt)));
  c.header("Server-Timing", `world;dur=${delivery.buildDurationMs.toFixed(1)};desc="${delivery.cacheState}"`);
  if (delivery.cacheState === "stale") {
    c.header("Warning", '110 cashloom.io "Response is stale"');
  }
  if (ifNoneMatch(c.req.header("If-None-Match"), delivery.etag)) return c.body(null, 304);
  return c.body(delivery.serialized);
}

export function mountWorldDoor(
  app: Hono,
  overrides?: Partial<WorldDeps>,
  cacheOptions?: WorldSnapshotCacheOptions,
) {
  const snapshotCache = createWorldSnapshotCache(
    (base) => buildWorldSnapshot(base, overrides),
    cacheOptions,
  );
  app.get("/v1/world", async (c) => {
    const requested = (c.req.query("base") ?? "USD").toUpperCase();
    if (!WORLD_BASE_CURRENCIES.includes(requested as WorldBaseCurrency)) {
      return c.json(
        {
          type: "about:blank",
          title: "unsupported base currency",
          status: 422,
          detail: `'${requested}' is not a supported World display base`,
          next_actions: [`choose one of ${WORLD_BASE_CURRENCIES.join(", ")}`],
        },
        422,
      );
    }
    const base = requested as WorldBaseCurrency;
    try {
      return worldResponse(c, await snapshotCache.read(base));
    } catch {
      return c.json({
        type: "about:blank",
        title: "World snapshot unavailable",
        status: 503,
        code: "world_snapshot_unavailable",
        detail: "Snapshot assembly failed before a complete or honestly degraded response could be produced inside the bounded cache window.",
        next_actions: ["retry shortly", `choose one of ${WORLD_BASE_CURRENCIES.join(", ")}`],
      }, 503);
    }
  });
}
