import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useBodyLock } from "../lib/hooks";
import {
  fetchWorld,
  loadPersistedWorldSnapshot,
  persistWorldSnapshot,
} from "./api";
import type {
  LoadState,
  WorldDeliveryMeta,
  WorldFact,
  WorldRecord,
  WorldResponse,
  WorldSectionKey,
  WorldSource,
} from "./types";
import {
  BASE_CURRENCIES,
  useWorldPreferences,
  type BaseCurrency,
} from "./useWorldPreferences";
import "./world.css";

const REFRESH_INTERVAL = 5 * 60 * 1000;
const REFRESH_CHECK_INTERVAL = 30 * 1000;
const RESUME_REVALIDATE_AFTER = 60 * 1000;

const SECTION_LINKS = [
  ["today", "Today"],
  ["rates", "Rates"],
  ["sovereigns", "Sovereigns"],
  ["currencies", "Currencies"],
  ["energy", "Energy"],
  ["crypto", "Crypto + rails"],
  ["threads", "Threads"],
  ["calendar", "Calendar"],
  ["coverage", "Sources"],
] as const;

const REGION_NAMES: Record<string, string> = {
  US: "United States",
  GB: "United Kingdom",
  UK: "United Kingdom",
  JP: "Japan",
  EA: "Euro area",
  XM: "Euro area",
};

interface ReceiptSelection {
  item: WorldRecord;
  kind: string;
}

interface CardProps {
  item: WorldFact;
  section: WorldSectionKey;
  index: number;
  watched: boolean;
  onWatch: (id: string) => void;
  onReceipt: (item: WorldRecord, kind: string) => void;
}

function isRecord(value: unknown): value is WorldRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function scopes(item: WorldRecord): WorldRecord[] {
  return [
    item,
    isRecord(item.fact) ? item.fact : undefined,
    isRecord(item.observation) ? item.observation : undefined,
    isRecord(item.metric) ? item.metric : undefined,
    isRecord(item.receipt) ? item.receipt : undefined,
  ].filter((value): value is WorldRecord => Boolean(value));
}

function pick(item: WorldRecord | undefined, ...keys: string[]): unknown {
  if (!item) return undefined;
  for (const scope of scopes(item)) {
    for (const key of keys) {
      const value = scope[key];
      if (value !== undefined && value !== null && value !== "") return value;
    }
  }
  return undefined;
}

function pickText(item: WorldRecord | undefined, ...keys: string[]): string | undefined {
  const value = pick(item, ...keys);
  if (typeof value === "string" && value.trim()) return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return undefined;
}

function pickJoined(item: WorldRecord | undefined, ...keys: string[]): string | undefined {
  const value = pick(item, ...keys);
  if (Array.isArray(value)) {
    const parts = value.filter((entry): entry is string => typeof entry === "string" && Boolean(entry.trim()));
    return parts.length ? parts.join(" · ") : undefined;
  }
  if (typeof value === "string" && value.trim()) return value.trim();
  return undefined;
}

function pickNumber(item: WorldRecord | undefined, ...keys: string[]): number | undefined {
  const value = pick(item, ...keys);
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) {
    return Number(value);
  }
  return undefined;
}

function toFacts(value: unknown): WorldFact[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

function sourceName(source: unknown): string | undefined {
  if (typeof source === "string") return source;
  if (!isRecord(source)) return undefined;
  return pickText(source, "name", "title", "publisher", "id");
}

function sourceFor(item: WorldRecord, allSources: WorldSource[]): WorldRecord | undefined {
  const direct = pick(item, "source");
  if (isRecord(direct)) return direct;
  const directName = sourceName(direct);
  const sourceId = pickText(item, "source_id", "sourceId", "provider_id", "provider");
  if (sourceId || directName) {
    return allSources.find((source) => {
      const id = pickText(source, "id", "key", "slug");
      const name = sourceName(source);
      return id === sourceId || id === directName || name === directName || name === sourceId;
    });
  }
  return undefined;
}

function safeUrl(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" ? url.href : undefined;
  } catch {
    return undefined;
  }
}

function titleFor(item: WorldRecord, fallback = "Untitled observation"): string {
  return (
    pickText(
      item,
      "title",
      "label",
      "name",
      "central_bank",
      "centralBank",
      "jurisdiction",
      "instrument",
      "pair",
      "symbol",
      "code",
    ) ?? fallback
  );
}

function contextFor(item: WorldRecord): string | undefined {
  return pickText(
    item,
    "subtitle",
    "label",
    "rate_name",
    "rateName",
    "note",
    "description",
    "summary",
    "instrument",
    "tenor",
    "jurisdiction",
    "region",
    "category",
  );
}

function itemId(section: string, item: WorldRecord, index: number): string {
  if (section === "fx") {
    const quote = pickText(item, "symbol", "quote");
    if (quote) return `fx:${quote}`.toLocaleLowerCase();
  }
  if (section === "crypto") {
    const rawId = pickText(item, "id", "key") ?? "";
    const symbol = pickText(item, "symbol");
    if (rawId.toLocaleLowerCase().startsWith("crypto-") && symbol) {
      return `crypto:${symbol}`.toLocaleLowerCase();
    }
  }
  const identity = pickText(item, "id", "key", "symbol", "code", "pair", "name", "title");
  return `${section}:${identity ?? index}`.toLocaleLowerCase().replace(/\s+/g, "-");
}

function regionFor(item: WorldRecord): string | undefined {
  const region = pickText(item, "region", "jurisdiction");
  return region ? REGION_NAMES[region.toLocaleUpperCase()] ?? region : undefined;
}

function numberText(value: number): string {
  const magnitude = Math.abs(value);
  const maximumFractionDigits = magnitude >= 1000 ? 1 : magnitude >= 100 ? 2 : magnitude >= 1 ? 3 : 6;
  return new Intl.NumberFormat(undefined, { maximumFractionDigits }).format(value);
}

function unitSuffix(unit?: string): string {
  if (!unit) return "";
  const normalized = unit.toLocaleLowerCase();
  if (["percent", "percentage", "%"].includes(normalized)) return "%";
  if (["basis_points", "basis points", "bps", "bp"].includes(normalized)) return " bp";
  if (["usd", "eur", "gbp", "jpy", "chf", "cad", "aud", "cny"].includes(normalized)) {
    return ` ${unit.toLocaleUpperCase()}`;
  }
  return ` ${unit}`;
}

function formatValue(item: WorldRecord): { text: string; present: boolean } {
  const unit = pickText(item, "unit", "units", "value_unit", "currency");
  const displayValue = pickText(item, "display_value", "displayValue", "formatted_value");
  if (displayValue) {
    const suffix = unitSuffix(unit);
    const normalizedUnit = unit?.toLocaleLowerCase();
    const alreadyIncludesUnit = !suffix
      || normalizedUnit === "date"
      || displayValue.toLocaleLowerCase().includes(normalizedUnit ?? "")
      || displayValue.toLocaleLowerCase().includes(suffix.trim().toLocaleLowerCase())
      || (suffix === "%" && displayValue.includes("%"));
    return { text: `${displayValue}${alreadyIncludesUnit ? "" : suffix}`, present: true };
  }
  const lower = pickNumber(item, "lower", "lower_bound", "range_low", "target_low");
  const upper = pickNumber(item, "upper", "upper_bound", "range_high", "target_high");
  if (lower !== undefined && upper !== undefined) {
    return { text: `${numberText(lower)}–${numberText(upper)}${unitSuffix(unit)}`, present: true };
  }

  const raw = pick(item, "value", "rate", "yield", "price", "level", "amount", "latest");
  if (isRecord(raw)) {
    const nestedLower = pickNumber(raw, "lower", "low", "min");
    const nestedUpper = pickNumber(raw, "upper", "high", "max");
    const nestedUnit = pickText(raw, "unit", "currency") ?? unit;
    if (nestedLower !== undefined && nestedUpper !== undefined) {
      return {
        text: `${numberText(nestedLower)}–${numberText(nestedUpper)}${unitSuffix(nestedUnit)}`,
        present: true,
      };
    }
    const nestedValue = pick(raw, "value", "amount", "number");
    if (typeof nestedValue === "number" && Number.isFinite(nestedValue)) {
      return { text: `${numberText(nestedValue)}${unitSuffix(nestedUnit)}`, present: true };
    }
    if (typeof nestedValue === "string" && nestedValue.trim()) {
      return { text: `${nestedValue.trim()}${unitSuffix(nestedUnit)}`, present: true };
    }
  }
  if (typeof raw === "number" && Number.isFinite(raw)) {
    return { text: `${numberText(raw)}${unitSuffix(unit)}`, present: true };
  }
  if (typeof raw === "string" && raw.trim()) {
    return { text: `${raw.trim()}${unitSuffix(unit)}`, present: true };
  }
  return { text: "Awaiting observation", present: false };
}

function formatDelta(item: WorldRecord): string | undefined {
  const displayDelta = pickText(item, "display_change", "display_delta");
  if (displayDelta) return displayDelta;
  const bps = pickNumber(item, "change_bps", "delta_bps", "bps_change");
  if (bps !== undefined) return `${bps > 0 ? "+" : ""}${numberText(bps)} bp`;
  const percent = pickNumber(item, "change_pct", "percent_change", "change_percent");
  if (percent !== undefined) return `${percent > 0 ? "+" : ""}${numberText(percent)}%`;
  const delta = pick(item, "change", "delta", "movement");
  if (typeof delta === "number" && Number.isFinite(delta)) {
    return `${delta > 0 ? "+" : ""}${numberText(delta)}`;
  }
  if (typeof delta === "string" && delta.trim()) return delta.trim();
  return undefined;
}

function statusFor(item: WorldRecord): "fresh" | "stale" | "unavailable" | undefined {
  if (pick(item, "stale", "is_stale") === true) return "stale";
  const status = pickText(item, "status", "freshness", "state")?.toLocaleLowerCase();
  if (!status) return undefined;
  if (["stale", "delayed", "expired", "partial"].some((word) => status.includes(word))) return "stale";
  if (["unavailable", "withheld", "missing", "error", "not_covered"].some((word) => status.includes(word))) {
    return "unavailable";
  }
  if (["fresh", "ok", "healthy", "available", "current"].some((word) => status.includes(word))) {
    return "fresh";
  }
  return undefined;
}

function methodFor(item: WorldRecord): "observed" | "derived" | "scheduled" | undefined {
  const status = pickText(item, "status")?.toLocaleLowerCase();
  if (status === "observed" || status === "derived" || status === "scheduled") return status;
  const method = pickText(item, "method")?.toLocaleLowerCase();
  if (!method) return undefined;
  if (method.includes("derived") || method.includes("model") || method.includes("calculated")) return "derived";
  if (method.includes("schedule") || method.includes("calendar")) return "scheduled";
  if (method.includes("observ")) return "observed";
  return undefined;
}

function dateValue(item: WorldRecord): string | undefined {
  return pickText(
    item,
    "scheduled_at",
    "starts_at",
    "effective_at",
    "observed_at",
    "published_at",
    "date",
    "time",
    "timestamp",
  );
}

interface CalendarDateParts {
  year: number;
  month: number;
  day: number;
}

function calendarDateParts(value: string | undefined): CalendarDateParts | undefined {
  const match = value?.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return undefined;
  return { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) };
}

function calendarOrdinal(parts: CalendarDateParts): number {
  return Date.UTC(parts.year, parts.month - 1, parts.day) / 86_400_000;
}

function localCalendarParts(date = new Date()): CalendarDateParts {
  return { year: date.getFullYear(), month: date.getMonth() + 1, day: date.getDate() };
}

function validDate(value: string | undefined): Date | undefined {
  if (!value) return undefined;
  const dateOnly = calendarDateParts(value);
  const date = dateOnly
    ? new Date(dateOnly.year, dateOnly.month - 1, dateOnly.day)
    : new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

function dateSortValue(value: string | undefined): number | undefined {
  const parts = calendarDateParts(value);
  if (parts) return calendarOrdinal(parts) * 86_400_000;
  return validDate(value)?.getTime();
}

function isUpcoming(value: string | undefined, now = new Date()): boolean {
  const parts = calendarDateParts(value);
  if (parts) return calendarOrdinal(parts) >= calendarOrdinal(localCalendarParts(now));
  const instant = validDate(value)?.getTime();
  return instant !== undefined && instant >= now.getTime();
}

function dateTimeText(value: string | undefined, mode: "short" | "full" = "short"): string | undefined {
  const date = validDate(value);
  if (!date) return value;
  if (value && /^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return new Intl.DateTimeFormat(undefined, {
      month: "short",
      day: "numeric",
      ...(mode === "full" ? { year: "numeric" as const } : {}),
    }).format(date);
  }
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    ...(mode === "full" ? { year: "numeric" as const } : {}),
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  }).format(date);
}

function relativeTime(value: string | undefined): string | undefined {
  const parts = calendarDateParts(value);
  const formatter = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
  if (parts) {
    const days = calendarOrdinal(parts) - calendarOrdinal(localCalendarParts());
    return formatter.format(days, "day");
  }
  const date = validDate(value);
  if (!date) return undefined;
  const minutes = Math.round((date.getTime() - Date.now()) / 60_000);
  if (Math.abs(minutes) < 60) return formatter.format(minutes, "minute");
  const hours = Math.round(minutes / 60);
  if (Math.abs(hours) < 48) return formatter.format(hours, "hour");
  return formatter.format(Math.round(hours / 24), "day");
}

function snapshotAgeText(receivedAt: number, now: number): string {
  const elapsed = Math.max(0, now - receivedAt);
  if (elapsed < 60_000) return "just now";
  if (elapsed < 60 * 60_000) return `${Math.floor(elapsed / 60_000)} min ago`;
  if (elapsed < 24 * 60 * 60_000) return `${Math.floor(elapsed / (60 * 60_000))} hr ago`;
  return `${Math.floor(elapsed / (24 * 60 * 60_000))} d ago`;
}

function observedText(item: WorldRecord): string | undefined {
  const value = pickText(item, "observed_at", "effective_at", "published_at", "fetched_at");
  return dateTimeText(value);
}

function StateBadge({ state }: { state: ReturnType<typeof statusFor> }) {
  if (!state) return null;
  return <span className={`world-state world-state--${state}`}>{state.replace("_", " ")}</span>;
}

function MethodBadge({ method }: { method: ReturnType<typeof methodFor> }) {
  if (!method) return null;
  return <span className={`world-method world-method--${method}`}>{method}</span>;
}

function ReceiptButton({ onClick, label = "Receipt" }: { onClick: () => void; label?: string }) {
  return (
    <button className="receipt-button" type="button" onClick={onClick}>
      <svg viewBox="0 0 16 16" aria-hidden="true">
        <path d="M3.25 1.75h7.5a2 2 0 0 1 2 2v10.5l-2-1.25-1.75 1.25L7.25 13 5.5 14.25 3.25 13V1.75Z" />
        <path d="M5.5 5h5M5.5 7.5h5M5.5 10h3" />
      </svg>
      {label}
    </button>
  );
}

function WatchButton({ watched, onClick, label }: { watched: boolean; onClick: () => void; label: string }) {
  return (
    <button
      type="button"
      className={`watch-button${watched ? " is-watched" : ""}`}
      onClick={onClick}
      aria-label={`${watched ? "Remove" : "Add"} ${label} ${watched ? "from" : "to"} local watchlist`}
      aria-pressed={watched}
    >
      <svg viewBox="0 0 20 20" aria-hidden="true">
        <path d="m10 2.2 2.35 4.76 5.25.76-3.8 3.7.9 5.23L10 14.18l-4.7 2.47.9-5.23-3.8-3.7 5.25-.76L10 2.2Z" />
      </svg>
    </button>
  );
}

function SkeletonCards({ count = 3 }: { count?: number }) {
  return (
    <div className="data-grid" aria-hidden="true">
      {Array.from({ length: count }).map((_, index) => (
        <div className="datum-card datum-card--skeleton" key={index}>
          <span className="skeleton-line skeleton-line--short" />
          <span className="skeleton-line skeleton-line--value" />
          <span className="skeleton-line" />
          <span className="skeleton-line skeleton-line--half" />
        </div>
      ))}
    </div>
  );
}

function EmptyField({ watchOnly, noun }: { watchOnly: boolean; noun: string }) {
  return (
    <div className="empty-field">
      <span className="empty-field__orb" aria-hidden="true" />
      <div>
        <p>{watchOnly ? `No watched ${noun}` : `No ${noun} are covered yet`}</p>
        <span>
          {watchOnly
            ? "Star an observation in the full view to keep it here."
            : "The source returned no observations. CashLoom will not fill the gap with estimates."}
        </span>
      </div>
    </div>
  );
}

function SectionHeading({
  kicker,
  title,
  note,
  aside,
}: {
  kicker: string;
  title: string;
  note: string;
  aside?: ReactNode;
}) {
  return (
    <header className="world-section__head">
      <div>
        <p className="world-kicker">{kicker}</p>
        <h2>{title}</h2>
        <p className="world-section__note">{note}</p>
      </div>
      {aside}
    </header>
  );
}

function DatumCard({ item, section, index, watched, onWatch, onReceipt }: CardProps) {
  const title = titleFor(item);
  const context = contextFor(item);
  const formatted = formatValue(item);
  const delta = formatDelta(item);
  const comparison = pickText(item, "comparison", "comparison_window", "period", "change_period");
  const state = statusFor(item);
  const method = methodFor(item);
  const source = sourceName(pick(item, "source")) ?? pickText(item, "source_name", "provider");
  const id = itemId(section, item, index);

  return (
    <article className={`datum-card${state ? ` datum-card--${state}` : ""}`}>
      <div className="datum-card__top">
        <div>
          <p className="datum-card__label">{title}</p>
          {context && context !== title && <p className="datum-card__context">{context}</p>}
        </div>
        <WatchButton watched={watched} onClick={() => onWatch(id)} label={title} />
      </div>
      <p className={`datum-card__value${formatted.present ? "" : " is-empty"}`}>{formatted.text}</p>
      <div className="datum-card__movement">
        {delta ? <span className={delta.trim().startsWith("-") ? "is-down" : "is-up"}>{delta}</span> : <span>No comparison</span>}
        {comparison && <span>{comparison}</span>}
      </div>
      <div className="datum-card__foot">
        <div className="datum-card__provenance">
          <MethodBadge method={method} />
          <StateBadge state={state} />
          <span>{observedText(item) ?? "Observation time pending"}</span>
          {source && <span>{source}</span>}
        </div>
        <ReceiptButton onClick={() => onReceipt(item, section)} />
      </div>
    </article>
  );
}

interface CurvePoint {
  label: string;
  value: number;
  unit: string | undefined;
}

function curvePoints(item: WorldRecord): CurvePoint[] {
  const candidate = pick(item, "curve", "points", "tenors", "maturities", "yields");
  if (Array.isArray(candidate)) {
    return candidate
      .map((point, index) => {
        if (!isRecord(point)) return undefined;
        const value = pickNumber(point, "value", "yield", "rate", "level");
        if (value === undefined) return undefined;
        return {
          label: pickText(point, "label", "tenor", "maturity", "name") ?? String(index + 1),
          value,
          unit: pickText(point, "unit", "units"),
        };
      })
      .filter((point): point is CurvePoint => Boolean(point));
  }
  if (isRecord(candidate)) {
    return Object.entries(candidate)
      .filter((entry): entry is [string, number] => typeof entry[1] === "number" && Number.isFinite(entry[1]))
      .map(([label, value]) => ({ label, value, unit: undefined }));
  }
  return [];
}

function CurveGraphic({ points }: { points: CurvePoint[] }) {
  if (points.length < 2) return null;
  const values = points.map((point) => point.value);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const coordinates = points.map((point, index) => {
    const x = 8 + (index / (points.length - 1)) * 224;
    const y = 54 - ((point.value - min) / span) * 42;
    return { ...point, x, y };
  });
  const path = coordinates.map((point, index) => `${index === 0 ? "M" : "L"}${point.x},${point.y}`).join(" ");
  return (
    <div className="curve" aria-label={`Yield curve from ${points[0].label} to ${points.at(-1)?.label}`}>
      <svg viewBox="0 0 240 64" preserveAspectRatio="none" aria-hidden="true">
        <path className="curve__grid" d="M8 12H232M8 33H232M8 54H232" />
        <path className="curve__area" d={`${path} L232,60 L8,60 Z`} />
        <path className="curve__line" d={path} />
        {coordinates.map((point) => <circle key={`${point.label}-${point.x}`} cx={point.x} cy={point.y} r="2.5" />)}
      </svg>
      <div className="curve__labels">
        <span>{points[0].label}</span>
        <span>{points.at(-1)?.label}</span>
      </div>
    </div>
  );
}

function SovereignCard(props: CardProps) {
  const { item, index, watched, onWatch, onReceipt } = props;
  const title = titleFor(item, "Sovereign curve");
  const context = contextFor(item);
  const id = itemId("sovereigns", item, index);
  const points = curvePoints(item);
  const value = formatValue(item);
  const state = statusFor(item);
  const method = methodFor(item);
  return (
    <article className={`datum-card sovereign-card${state ? ` datum-card--${state}` : ""}`}>
      <div className="datum-card__top">
        <div>
          <p className="datum-card__label">{title}</p>
          {context && context !== title && <p className="datum-card__context">{context}</p>}
        </div>
        <WatchButton watched={watched} onClick={() => onWatch(id)} label={title} />
      </div>
      {points.length >= 2 ? (
        <CurveGraphic points={points} />
      ) : (
        <p className={`datum-card__value${value.present ? "" : " is-empty"}`}>{value.text}</p>
      )}
      {points.length > 0 && (
        <div className="curve__readings">
          {points.slice(0, 5).map((point) => (
            <span key={point.label}><small>{point.label}</small>{numberText(point.value)}{unitSuffix(point.unit ?? pickText(item, "unit", "units"))}</span>
          ))}
        </div>
      )}
      <div className="datum-card__foot">
        <div className="datum-card__provenance">
          <MethodBadge method={method} />
          <StateBadge state={state} />
          <span>{observedText(item) ?? "Curve time pending"}</span>
        </div>
        <ReceiptButton onClick={() => onReceipt(item, "sovereign curve")} />
      </div>
    </article>
  );
}

function BriefingPanel({
  items,
  phase,
  onReceipt,
}: {
  items: WorldFact[];
  phase: LoadState;
  onReceipt: (item: WorldRecord, kind: string) => void;
}) {
  if (phase === "loading") {
    return (
      <div className="briefing-grid" aria-label="Loading today's briefing">
        {[0, 1, 2].map((item) => (
          <div className="brief-card brief-card--skeleton" key={item} aria-hidden="true">
            <span className="skeleton-line skeleton-line--short" />
            <span className="skeleton-line" />
            <span className="skeleton-line skeleton-line--half" />
          </div>
        ))}
      </div>
    );
  }
  if (!items.length) return <EmptyField watchOnly={false} noun="briefing notes" />;
  return (
    <div className="briefing-grid">
      {items.slice(0, 6).map((item, index) => {
        const title = titleFor(item, "Money-world update");
        const body = pickText(item, "summary", "description", "body", "what_changed", "detail");
        const tag = pickText(item, "category", "kind", "region", "importance") ?? `Thread ${String(index + 1).padStart(2, "0")}`;
        const state = statusFor(item);
        const method = methodFor(item);
        return (
          <article className="brief-card" key={itemId("briefing", item, index)}>
            <div className="brief-card__meta"><span>{tag}</span><span className="brief-card__badges"><MethodBadge method={method} /><StateBadge state={state} /></span></div>
            <h3>{title}</h3>
            <p>{body ?? "The source supplied a headline without an accompanying interpretation."}</p>
            <div className="brief-card__foot">
              <span>{observedText(item) ?? "Time pending"}</span>
              <ReceiptButton onClick={() => onReceipt(item, "briefing")} />
            </div>
          </article>
        );
      })}
    </div>
  );
}

function NextOnClock({ item, loading, onReceipt }: { item?: WorldFact; loading: boolean; onReceipt: (item: WorldRecord, kind: string) => void }) {
  if (loading) {
    return (
      <aside className="next-clock next-clock--loading" aria-label="Loading the next scheduled event">
        <span className="skeleton-line skeleton-line--short" />
        <span className="skeleton-line skeleton-line--value" />
        <span className="skeleton-line" />
      </aside>
    );
  }
  if (!item) {
    return (
      <aside className="next-clock">
        <p className="next-clock__eyebrow">Next on the clock</p>
        <p className="next-clock__empty">No upcoming event is available.</p>
        <span className="next-clock__note">The calendar source may be between updates.</span>
      </aside>
    );
  }
  const date = dateValue(item);
  return (
    <aside className="next-clock">
      <div className="next-clock__orbit" aria-hidden="true"><span /></div>
      <p className="next-clock__eyebrow">Next on the clock</p>
      <p className="next-clock__when">{relativeTime(date) ?? "Schedule pending"}</p>
      <h2>{titleFor(item, "Scheduled money event")}</h2>
      <p className="next-clock__date">{dateTimeText(date, "full") ?? "Time not supplied"}</p>
      <div className="next-clock__foot">
        <span>{regionFor(item) ?? pickText(item, "category", "kind") ?? "Calendar"}</span>
        <ReceiptButton onClick={() => onReceipt(item, "calendar event")} />
      </div>
    </aside>
  );
}

function DataSection({
  id,
  kicker,
  title,
  note,
  noun,
  items,
  section,
  phase,
  watchOnly,
  watched,
  onWatch,
  onReceipt,
  notice,
  sovereign = false,
}: {
  id: string;
  kicker: string;
  title: string;
  note: string;
  noun: string;
  items: WorldFact[];
  section: WorldSectionKey;
  phase: LoadState;
  watchOnly: boolean;
  watched: string[];
  onWatch: (id: string) => void;
  onReceipt: (item: WorldRecord, kind: string) => void;
  notice?: ReactNode;
  sovereign?: boolean;
}) {
  const visible = watchOnly
    ? items.filter((item, index) => watched.includes(itemId(section, item, index)))
    : items;
  return (
    <section className="world-section" id={id}>
      <SectionHeading kicker={kicker} title={title} note={note} aside={<span className="section-count mono">{phase === "loading" ? "··" : String(visible.length).padStart(2, "0")}</span>} />
      {notice}
      {phase === "loading" ? <SkeletonCards /> : visible.length ? (
        <div className="data-grid">
          {visible.map((item) => {
            const originalIndex = items.indexOf(item);
            const idForItem = itemId(section, item, originalIndex);
            const props: CardProps = {
              item,
              index: originalIndex,
              section,
              watched: watched.includes(idForItem),
              onWatch,
              onReceipt,
            };
            return sovereign
              ? <SovereignCard key={idForItem} {...props} />
              : <DatumCard key={idForItem} {...props} />;
          })}
        </div>
      ) : <EmptyField watchOnly={watchOnly} noun={noun} />}
    </section>
  );
}

function PolicyNotices({ policy }: { policy: WorldFact[] }) {
  const notices = policy.flatMap((item) => {
    const source = pick(item, "source");
    if (!isRecord(source)) return [];
    const identity = `${pickText(source, "id", "name", "title") ?? ""}`.toLocaleLowerCase();
    if (!identity.includes("ny_fed") && !identity.includes("new york")) return [];
    const note = pickText(source, "note", "description");
    if (!note) return [];
    return [{
      note,
      url: safeUrl(pick(source, "url")),
      termsUrl: safeUrl(pick(source, "terms_url")),
    }];
  }).filter((notice, index, all) => all.findIndex((candidate) => candidate.note === notice.note) === index);

  if (!notices.length) return null;
  return (
    <aside className="policy-notice" aria-label="New York Fed reference-rate notice">
      <div className="policy-notice__mark" aria-hidden="true">§</div>
      <div>
        <strong>New York Fed reference-rate notice</strong>
        {notices.map((notice) => <p key={notice.note}>{notice.note}</p>)}
        <span className="policy-notice__links">
          {notices[0].url && <a href={notices[0].url} target="_blank" rel="noreferrer">Reference rates ↗</a>}
          {notices[0].termsUrl && <a href={notices[0].termsUrl} target="_blank" rel="noreferrer">Terms ↗</a>}
        </span>
      </div>
    </aside>
  );
}

function ThreadsSection({ items, phase, onReceipt }: { items: WorldFact[]; phase: LoadState; onReceipt: (item: WorldRecord, kind: string) => void }) {
  return (
    <section className="world-section threads-section" id="threads">
      <SectionHeading
        kicker="Relationships, carefully held"
        title="Threads"
        note="Events and markets can move together without one proving the other. Every thread separates observation, possible channel, and limits."
      />
      {phase === "loading" ? <SkeletonCards count={2} /> : items.length ? (
        <div className="thread-list">
          {items.map((item, index) => {
            const observed = pickJoined(item, "observed", "observations", "observation", "what_happened", "summary");
            const channel = pickJoined(item, "possible_channels", "possible_channel", "channels", "channel", "mechanism", "interpretation");
            const limits = pickJoined(item, "limits", "limitations", "caveats", "caveat", "alternatives");
            const method = methodFor(item);
            const state = statusFor(item);
            return (
              <article className="world-thread" key={itemId("thread", item, index)}>
                <div className="world-thread__rail" aria-hidden="true"><span /><i /><span /></div>
                <div className="world-thread__head">
                  <div>
                    <p className="world-thread__number mono">THREAD {String(index + 1).padStart(2, "0")}</p>
                    <h3>{titleFor(item, "An unsettled relationship")}</h3>
                  </div>
                  <div className="world-thread__actions"><MethodBadge method={method} /><StateBadge state={state} /><ReceiptButton onClick={() => onReceipt(item, "thread")} /></div>
                </div>
                <div className="world-thread__claims">
                  <div><span>Observed</span><p>{observed ?? "No sourced observation was supplied."}</p></div>
                  <div><span>Possible channel</span><p>{channel ?? "No causal channel is asserted."}</p></div>
                  <div><span>Limits</span><p>{limits ?? "Relationship limits have not yet been documented."}</p></div>
                </div>
              </article>
            );
          })}
        </div>
      ) : <EmptyField watchOnly={false} noun="relationship threads" />}
    </section>
  );
}

function CalendarSection({ items, phase, onReceipt }: { items: WorldFact[]; phase: LoadState; onReceipt: (item: WorldRecord, kind: string) => void }) {
  const sorted = useMemo(() => [...items].sort((a, b) => {
    const aTime = dateSortValue(dateValue(a)) ?? Number.MAX_SAFE_INTEGER;
    const bTime = dateSortValue(dateValue(b)) ?? Number.MAX_SAFE_INTEGER;
    return aTime - bTime;
  }), [items]);
  return (
    <section className="world-section" id="calendar">
      <SectionHeading kicker="Known unknowns" title="Policy meeting calendar" note="Scheduled central-bank meetings only. When an exact decision time is not announced, CashLoom preserves the official date without inventing a clock time." />
      {phase === "loading" ? <SkeletonCards count={4} /> : sorted.length ? (
        <ol className="world-calendar">
          {sorted.map((item, index) => {
            const date = dateValue(item);
            const parsed = validDate(date);
            const state = statusFor(item);
            const method = methodFor(item);
            return (
              <li key={itemId("calendar", item, index)}>
                <div className="world-calendar__date mono">
                  <strong>{parsed ? new Intl.DateTimeFormat(undefined, { day: "2-digit" }).format(parsed) : "—"}</strong>
                  <span>{parsed ? new Intl.DateTimeFormat(undefined, { month: "short" }).format(parsed).toLocaleUpperCase() : "TBD"}</span>
                </div>
                <div className="world-calendar__body">
                  <span className="world-calendar__meta">{regionFor(item) ?? pickText(item, "category", "kind") ?? "Money event"}</span>
                  <h3>{titleFor(item, "Scheduled event")}</h3>
                  <p>{dateTimeText(date, "full") ?? "Time not supplied"}</p>
                </div>
                <span className="world-calendar__badges"><MethodBadge method={method} /><StateBadge state={state} /></span>
                <ReceiptButton onClick={() => onReceipt(item, "calendar event")} />
              </li>
            );
          })}
        </ol>
      ) : <EmptyField watchOnly={false} noun="calendar events" />}
    </section>
  );
}

function sourceStatus(source: WorldRecord): ReturnType<typeof statusFor> {
  return statusFor(source);
}

function CoverageSection({
  data,
  phase,
  onReceipt,
}: {
  data?: WorldResponse;
  phase: LoadState;
  onReceipt: (item: WorldRecord, kind: string) => void;
}) {
  const sources = toFacts(data?.sources) as WorldSource[];
  const status = isRecord(data?.status) ? data?.status : undefined;
  const available = pickNumber(status, "available_sources", "availableSources") ?? 0;
  const total = pickNumber(status, "total_sources", "totalSources") ?? 0;
  const stale = pickNumber(status, "stale_count", "staleCount") ?? 0;
  const unavailableRaw = pick(status, "unavailable");
  const unavailable = Array.isArray(unavailableRaw) ? unavailableRaw : [];
  const coverage = total > 0 ? Math.max(0, Math.min(100, (available / total) * 100)) : 0;
  return (
    <section className="world-section coverage-section" id="coverage">
      <SectionHeading kicker="Receipts before confidence" title="Coverage & freshness" note="A view of what answered, what is late, and what CashLoom cannot presently cover." />
      <div className="coverage-overview">
        <div className="coverage-score">
          <div className="coverage-score__ring" style={{ ["--coverage" as string]: `${coverage * 3.6}deg` }}>
            <span>{total > 0 ? `${Math.round(coverage)}%` : "—"}</span>
          </div>
          <div><strong>{total > 0 ? `${available} of ${total}` : "Not scored"}</strong><span>sources answered</span></div>
        </div>
        <div className="coverage-stat"><strong>{stale}</strong><span>stale observations</span></div>
        <div className="coverage-stat"><strong>{unavailable.length}</strong><span>declared unavailable</span></div>
        <div className="coverage-stat"><strong>{pickText(data, "schema") ?? "—"}</strong><span>world schema</span></div>
      </div>
      {unavailable.length > 0 && (
        <div className="coverage-gaps">
          <p>Known gaps</p>
          <ul>
            {unavailable.map((item, index) => (
              <li key={index}>{typeof item === "string" ? item : titleFor(item, "Unnamed source gap")}</li>
            ))}
          </ul>
        </div>
      )}
      {phase === "loading" ? <SkeletonCards count={3} /> : sources.length ? (
        <div className="source-ledger">
          {sources.map((source, index) => {
            const state = sourceStatus(source);
            return (
              <article className="source-row" key={itemId("source", source, index)}>
                <span className={`source-row__light${state ? ` is-${state}` : ""}`} aria-hidden="true" />
                <div>
                  <h3>{titleFor(source, "Unnamed source")}</h3>
                  <p>{pickText(source, "description", "publisher", "methodology") ?? "Source metadata"}</p>
                </div>
                <div className="source-row__cadence"><span>Cadence</span><strong>{pickText(source, "cadence", "frequency") ?? "Not supplied"}</strong></div>
                <div className="source-row__time"><span>Fetched</span><strong>{dateTimeText(pickText(source, "fetched_at", "updated_at")) ?? "Pending"}</strong></div>
                <StateBadge state={state} />
                <ReceiptButton onClick={() => onReceipt(source, "source")} />
              </article>
            );
          })}
        </div>
      ) : <EmptyField watchOnly={false} noun="source receipts" />}
    </section>
  );
}

function metadataRows(item: WorldRecord, source?: WorldRecord): Array<[string, string]> {
  const entries: Array<[string, unknown]> = [
    ["Fact ID", pick(item, "id", "key", "fact_id")],
    ["Observed", pick(item, "observed_at", "effective_at", "date")],
    ["Published", pick(item, "published_at")],
    ["Fetched", pick(item, "fetched_at") ?? pick(source, "fetched_at", "updated_at")],
    ["Comparison", pick(item, "comparison", "comparison_window", "period")],
    ["Method", pick(item, "method", "methodology", "calculation")],
    ["Proof", pick(item, "proof_state", "proofState")],
    ["Temporal precision", pick(item, "temporal_precision", "time_status")],
    ["Reference", pick(item, "reference")],
    ["Formula", pick(item, "formula", "recompute")],
    ["Note", pick(item, "note", "description")],
    ["Cadence", pick(item, "cadence") ?? pick(source, "cadence", "frequency")],
    ["License", pick(item, "license") ?? pick(source, "license", "licence")],
    ["Status", pick(item, "status", "freshness", "state")],
  ];
  return entries.flatMap(([label, value]) => {
    if (value === undefined || value === null || value === "") return [];
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      return [[label, String(value)] as [string, string]];
    }
    return [[label, JSON.stringify(value)] as [string, string]];
  });
}

function ReceiptDrawer({
  selection,
  sources,
  onClose,
}: {
  selection: ReceiptSelection;
  sources: WorldSource[];
  onClose: () => void;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  const previousFocus = useRef<HTMLElement | null>(null);
  const item = selection.item;
  const source = sourceFor(item, sources) ?? (selection.kind === "source" ? item : undefined);
  const sourceLabel = sourceName(source) ?? sourceName(pick(item, "source")) ?? pickText(item, "source_name", "provider");
  const url = safeUrl(
    pick(item, "announcement_url", "source_resource_url")
      ?? pick(source, "url", "source_url", "source_resource_url", "homepage")
      ?? pick(item, "source_url", "url"),
  );
  const termsUrl = safeUrl(pick(source, "terms_url", "termsUrl"));
  const sourceNote = pickText(source, "note");
  const rows = metadataRows(item, source);
  const inputs = pick(item, "inputs", "derivation_inputs");
  const reported = selection.kind === "source"
    ? { text: pickText(item, "status", "state") ?? "Metadata supplied", present: true }
    : formatValue(item);
  useBodyLock(true);

  useEffect(() => {
    const background = Array.from(
      document.querySelectorAll<HTMLElement>(".world-shell > .skip-link, .world-nav, .world-main, .world-footer"),
    );
    const previousHidden = background.map((element) => element.getAttribute("aria-hidden"));
    background.forEach((element) => {
      element.setAttribute("inert", "");
      element.setAttribute("aria-hidden", "true");
    });
    previousFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    panelRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
      if (event.key !== "Tab") return;
      const panel = panelRef.current;
      if (!panel) return;
      const focusable = Array.from(
        panel.querySelectorAll<HTMLElement>('a[href], button:not([disabled]), summary, [tabindex]:not([tabindex="-1"])'),
      ).filter((element) => element.offsetParent !== null);
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && (document.activeElement === first || document.activeElement === panel)) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      background.forEach((element, index) => {
        element.removeAttribute("inert");
        const hidden = previousHidden[index];
        if (hidden === null) element.removeAttribute("aria-hidden");
        else element.setAttribute("aria-hidden", hidden);
      });
      previousFocus.current?.focus();
    };
  }, [onClose]);

  return (
    <div className="receipt-drawer" role="dialog" aria-modal="true" aria-labelledby="receipt-title">
      <button className="receipt-drawer__scrim" type="button" onClick={onClose} aria-label="Close receipt" />
      <div className="receipt-drawer__panel" ref={panelRef} tabIndex={-1}>
        <div className="receipt-drawer__rail" aria-hidden="true" />
        <header className="receipt-drawer__head">
          <div><p className="world-kicker">Source receipt · {selection.kind}</p><h2 id="receipt-title">{titleFor(item)}</h2></div>
          <button className="receipt-drawer__close" type="button" onClick={onClose} aria-label="Close receipt">×</button>
        </header>
        <div className="receipt-drawer__value">
          <span>{selection.kind === "source" ? "Source state" : "Reported value"}</span>
          <strong>{reported.text}</strong>
          <span className="receipt-drawer__badges"><MethodBadge method={methodFor(item)} /><StateBadge state={statusFor(item)} /></span>
        </div>
        {sourceLabel && (
          <section className="receipt-source">
            <span>Published by</span>
            <h3>{sourceLabel}</h3>
            <div className="receipt-source__links">
              {url && <a href={url} target="_blank" rel="noreferrer">Open original source <span aria-hidden="true">↗</span></a>}
              {termsUrl && <a href={termsUrl} target="_blank" rel="noreferrer">Usage terms <span aria-hidden="true">↗</span></a>}
            </div>
            {sourceNote && <p className="receipt-source__note">{sourceNote}</p>}
          </section>
        )}
        <dl className="receipt-metadata">
          {rows.length ? rows.map(([label, value]) => (
            <div key={label}><dt>{label}</dt><dd>{["Observed", "Published", "Fetched"].includes(label) && validDate(value) ? dateTimeText(value, "full") : value}</dd></div>
          )) : <div><dt>Metadata</dt><dd>No additional metadata was supplied.</dd></div>}
        </dl>
        {inputs !== undefined && (
          <section className="receipt-inputs"><h3>Derivation inputs</h3><pre>{JSON.stringify(inputs, null, 2)}</pre></section>
        )}
        <details className="receipt-machine">
          <summary>Machine-readable observation</summary>
          <pre>{JSON.stringify(item, null, 2)}</pre>
        </details>
        <p className="receipt-drawer__truth">A receipt shows where a number came from. It does not turn an observation into advice.</p>
      </div>
    </div>
  );
}

function WorldNav({ sourceState }: { sourceState: string }) {
  return (
    <nav className="world-nav" aria-label="CashLoom World">
      <a className="world-brand" href="/world" aria-label="CashLoom World home">
        <svg className="world-brand__mark" viewBox="0 0 30 30" aria-hidden="true">
          <circle cx="15" cy="15" r="12" />
          <path d="M3 15h24M15 3c5 5 5 19 0 24M15 3c-5 5-5 19 0 24" />
          <circle cx="22.5" cy="9" r="2.4" />
        </svg>
        <span className="world-brand__word">CashLoom</span>
        <span className="world-brand__place">World</span>
      </a>
      <div className="world-nav__sections">
        {SECTION_LINKS.map(([id, label]) => <a href={`#${id}`} key={id}>{label}</a>)}
      </div>
      <div className="world-nav__right">
        <span className={`world-nav__pulse is-${sourceState}`}><i />{sourceState}</span>
        <a className="world-nav__atlas" href="/onchain">Onchain <span aria-hidden="true">↗</span></a>
        <a className="world-nav__atlas" href="/atlas">The Atlas <span aria-hidden="true">↗</span></a>
      </div>
    </nav>
  );
}

function WorldFooter({ generatedAt }: { generatedAt?: string }) {
  return (
    <footer className="world-footer">
      <div className="world-footer__mark" aria-hidden="true"><span /><i /><span /></div>
      <p>Money moves in threads. CashLoom keeps the receipts.</p>
      <span>{generatedAt ? `World assembled ${dateTimeText(generatedAt, "full")}` : "World assembly time unavailable"}</span>
      <div><a href="#today">Back to today ↑</a><a href="/onchain">Open Onchain ↗</a><a href="/atlas">Read the Atlas ↗</a></div>
    </footer>
  );
}

export default function World() {
  const preferences = useWorldPreferences();
  const [initialSaved] = useState(() => loadPersistedWorldSnapshot(preferences.baseCurrency));
  const [data, setData] = useState<WorldResponse | undefined>(initialSaved?.snapshot);
  const [phase, setPhase] = useState<LoadState>(initialSaved ? "ready" : "loading");
  const [delivery, setDelivery] = useState<WorldDeliveryMeta | undefined>(() => initialSaved
    ? {
      kind: "saved",
      baseCurrency: preferences.baseCurrency,
      receivedAt: initialSaved.receivedAt,
      ...(initialSaved.etag ? { etag: initialSaved.etag } : {}),
    }
    : undefined);
  const [error, setError] = useState<string>();
  const [refreshError, setRefreshError] = useState<string>();
  const [refreshing, setRefreshing] = useState(Boolean(initialSaved));
  const [refreshToken, setRefreshToken] = useState(0);
  const [displayNow, setDisplayNow] = useState(Date.now);
  const [receipt, setReceipt] = useState<ReceiptSelection>();
  const lastAttemptByBase = useRef(new Map<string, number>());
  const activeBase = useRef(preferences.baseCurrency);
  const activeBaseHasSnapshot = useRef(Boolean(initialSaved));
  const requestInFlight = useRef(false);
  activeBase.current = preferences.baseCurrency;
  activeBaseHasSnapshot.current = data?.base_currency?.toLocaleUpperCase() === preferences.baseCurrency;

  useEffect(() => {
    document.title = "World — CashLoom";
    const description = document.querySelector<HTMLMetaElement>('meta[name="description"]');
    description?.setAttribute("content", "CashLoom World follows policy rates, sovereign yields, currencies, disclosed energy coverage, crypto rails, and the threads between them—with source receipts.");
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    const requestedBase = preferences.baseCurrency;
    const memoryMatches = data?.base_currency?.toLocaleUpperCase() === requestedBase;
    const saved = memoryMatches ? undefined : loadPersistedWorldSnapshot(requestedBase);
    const activeSnapshot = memoryMatches ? data : saved?.snapshot;
    const activeDelivery = memoryMatches && delivery?.baseCurrency === requestedBase
      ? delivery
      : saved
        ? {
          kind: "saved" as const,
          baseCurrency: requestedBase,
          receivedAt: saved.receivedAt,
          ...(saved.etag ? { etag: saved.etag } : {}),
        }
        : undefined;
    activeBaseHasSnapshot.current = Boolean(activeSnapshot);

    if (activeSnapshot) {
      if (!memoryMatches) {
        setData(activeSnapshot);
        setDelivery(activeDelivery);
        setReceipt(undefined);
      }
      setRefreshing(true);
      setPhase("ready");
    } else {
      if (!memoryMatches) {
        setData(undefined);
        setDelivery(undefined);
        setReceipt(undefined);
      }
      setRefreshing(false);
      setPhase("loading");
    }
    setError(undefined);
    setRefreshError(undefined);

    const offline = typeof navigator !== "undefined" && !navigator.onLine;
    const hidden = document.visibilityState === "hidden";
    if (offline || hidden) {
      requestInFlight.current = false;
      setRefreshing(false);
      if (offline) {
        const message = "This browser appears to be offline.";
        if (activeSnapshot) setRefreshError(message);
        else {
          setError(message);
          setPhase("error");
        }
      }
      return () => controller.abort();
    }

    requestInFlight.current = true;
    const attemptedAt = Date.now();
    lastAttemptByBase.current.set(requestedBase, attemptedAt);
    setDisplayNow(attemptedAt);
    fetchWorld(requestedBase, { signal: controller.signal, etag: activeDelivery?.etag })
      .then((result) => {
        if (controller.signal.aborted) return;
        if (result.kind === "modified") {
          persistWorldSnapshot(result.snapshot, result.etag, result.receivedAt);
          setData(result.snapshot);
          activeBaseHasSnapshot.current = true;
          setDelivery({
            kind: "network",
            baseCurrency: requestedBase,
            receivedAt: result.receivedAt,
            ...(result.etag ? { etag: result.etag } : {}),
            ...(result.serverCacheState ? { serverCacheState: result.serverCacheState } : {}),
            ...(result.serverSnapshotAgeSeconds !== undefined
              ? { serverSnapshotAgeSeconds: result.serverSnapshotAgeSeconds }
              : {}),
          });
        } else {
          if (!activeSnapshot || !activeDelivery) {
            throw new Error("The World feed confirmed a snapshot that is not available in this browser.");
          }
          // A 304 is a fresh validation receipt for the same exact public body.
          // Persisting it renews the bounded local retention without changing
          // the snapshot's own generated_at.
          persistWorldSnapshot(activeSnapshot, result.etag ?? activeDelivery.etag, result.receivedAt);
          setData(activeSnapshot);
          activeBaseHasSnapshot.current = true;
          setDelivery({
            ...activeDelivery,
            kind: "revalidated",
            checkedAt: result.receivedAt,
            ...(result.etag ? { etag: result.etag } : {}),
            ...(result.serverCacheState ? { serverCacheState: result.serverCacheState } : {}),
            ...(result.serverSnapshotAgeSeconds !== undefined
              ? { serverSnapshotAgeSeconds: result.serverSnapshotAgeSeconds }
              : {}),
          });
        }
        setPhase("ready");
        setError(undefined);
      })
      .catch((cause: unknown) => {
        if (cause instanceof DOMException && cause.name === "AbortError") return;
        const message = cause instanceof Error ? cause.message : "The World feed could not be read.";
        if (activeSnapshot) {
          setData(activeSnapshot);
          setDelivery(activeDelivery);
          setRefreshError(message);
          setPhase("ready");
        }
        else {
          activeBaseHasSnapshot.current = false;
          setError(message);
          setPhase("error");
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) {
          requestInFlight.current = false;
          setRefreshing(false);
          setDisplayNow(Date.now());
        }
      });

    return () => controller.abort();
    // Data and delivery are intentionally excluded: a successful read must not
    // trigger another read. A refresh token captures their latest render values.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshToken, preferences.baseCurrency]);

  useEffect(() => {
    const requestIfOld = (minimumAge = REFRESH_INTERVAL) => {
      if (document.visibilityState === "hidden" || !navigator.onLine || requestInFlight.current) return;
      const now = Date.now();
      setDisplayNow(now);
      const base = activeBase.current;
      const requiredAge = activeBaseHasSnapshot.current ? minimumAge : 0;
      if (now - (lastAttemptByBase.current.get(base) ?? 0) < requiredAge) return;
      lastAttemptByBase.current.set(base, now);
      setRefreshToken((value) => value + 1);
    };
    const onVisibility = () => {
      if (document.visibilityState === "visible") requestIfOld(RESUME_REVALIDATE_AFTER);
    };
    const onFocus = () => requestIfOld(RESUME_REVALIDATE_AFTER);
    const onOnline = () => requestIfOld(0);
    const timer = window.setInterval(() => requestIfOld(), REFRESH_CHECK_INTERVAL);
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("focus", onFocus);
    window.addEventListener("online", onOnline);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("focus", onFocus);
      window.removeEventListener("online", onOnline);
    };
  }, []);

  const requestRefresh = useCallback(() => {
    const now = Date.now();
    lastAttemptByBase.current.set(activeBase.current, now);
    setDisplayNow(now);
    setRefreshToken((value) => value + 1);
  }, []);

  const dataMatchesBase = data?.base_currency?.toLocaleUpperCase() === preferences.baseCurrency;
  const viewData = dataMatchesBase ? data : undefined;
  const viewDelivery = delivery?.baseCurrency === preferences.baseCurrency ? delivery : undefined;
  const viewPhase: LoadState = phase === "error" ? "error" : data && !dataMatchesBase ? "loading" : phase;
  const briefing = toFacts(viewData?.briefing);
  const policy = toFacts(viewData?.policy);
  const sovereigns = toFacts(viewData?.sovereigns);
  const fx = useMemo(() => {
    const facts = toFacts(viewData?.fx);
    const base = preferences.baseCurrency.toLocaleLowerCase();
    return facts
      .map((item, index) => ({ item, index, relevant: `${pickText(item, "pair", "symbol", "code", "name") ?? ""}`.toLocaleLowerCase().includes(base) }))
      .sort((a, b) => Number(b.relevant) - Number(a.relevant) || a.index - b.index)
      .map(({ item }) => item);
  }, [viewData?.fx, preferences.baseCurrency]);
  const energy = toFacts(viewData?.energy);
  const crypto = toFacts(viewData?.crypto);
  const fees = toFacts(viewData?.fees);
  const calendar = toFacts(viewData?.calendar);
  const threads = toFacts(viewData?.threads);
  const sources = toFacts(viewData?.sources) as WorldSource[];
  const upcoming = useMemo(() => {
    const now = new Date();
    return [...calendar]
      .map((item) => ({ item, value: dateValue(item), time: dateSortValue(dateValue(item)) }))
      .filter((entry): entry is { item: WorldFact; value: string; time: number } => entry.value !== undefined && entry.time !== undefined && isUpcoming(entry.value, now))
      .sort((a, b) => a.time - b.time)[0]?.item;
  }, [calendar]);

  const statusRecord = isRecord(viewData?.status) ? viewData.status : undefined;
  const apiState = pickText(statusRecord, "state")?.toLocaleLowerCase();
  const staleCount = pickNumber(statusRecord, "stale_count", "staleCount") ?? 0;
  const unavailable = pick(statusRecord, "unavailable");
  const sourceState = viewPhase === "loading"
    ? "loading"
    : viewPhase === "error"
      ? "offline"
      : ["ready", "healthy", "ok", "available"].includes(apiState ?? "")
        ? staleCount > 0 || (Array.isArray(unavailable) && unavailable.length > 0) ? "partial" : "available"
        : apiState ?? (staleCount > 0 || (Array.isArray(unavailable) && unavailable.length > 0) ? "partial" : "available");
  const availableSources = pickNumber(statusRecord, "available_sources", "availableSources");
  const totalSources = pickNumber(statusRecord, "total_sources", "totalSources");
  const savedSnapshot = viewDelivery?.kind === "saved";
  const serverStale = viewDelivery?.serverCacheState === "stale";
  const navigationState = savedSnapshot ? "saved" : serverStale ? "stale" : sourceState;
  const deliveryHeadline = savedSnapshot
    ? refreshing ? "Saved snapshot · updating" : "Saved snapshot"
    : serverStale
      ? "Server snapshot · stale"
      : sourceState.replaceAll("_", " ");
  const deliveryDetail = savedSnapshot
    ? `Received ${snapshotAgeText(viewDelivery.receivedAt, displayNow)} · ${dateTimeText(new Date(viewDelivery.receivedAt).toISOString(), "full")}`
    : viewDelivery?.kind === "revalidated" && viewDelivery.checkedAt
      ? `Unchanged · checked ${dateTimeText(new Date(viewDelivery.checkedAt).toISOString(), "full")}`
      : availableSources !== undefined && totalSources !== undefined
        ? `${availableSources}/${totalSources} sources answering`
        : viewPhase === "loading" ? `Loading ${preferences.baseCurrency} observations` : "Coverage score pending";

  const openReceipt = useCallback((item: WorldRecord, kind: string) => setReceipt({ item, kind }), []);
  const closeReceipt = useCallback(() => setReceipt(undefined), []);

  return (
    <div className="world-shell" aria-busy={viewPhase === "loading"}>
      <a className="skip-link" href="#today">Skip to today's briefing</a>
      <WorldNav sourceState={navigationState} />
      <main className="world-main">
        <header className="world-hero">
          <div className="world-hero__mesh" aria-hidden="true">
            <svg viewBox="0 0 900 520" preserveAspectRatio="xMidYMid slice">
              {Array.from({ length: 15 }).map((_, index) => (
                <path key={index} style={{ ["--thread" as string]: index }} d={`M-80 ${36 + index * 30} C170 ${15 + index * 27}, 410 ${95 + index * 16}, 980 ${18 + index * 34}`} />
              ))}
              <circle cx="644" cy="196" r="5" /><circle cx="480" cy="286" r="3" /><circle cx="720" cy="354" r="4" />
            </svg>
          </div>
          <div className="world-hero__content">
            <p className="world-hero__kicker"><span /> The money world, with receipts</p>
            <h1>Money moves<br />in <em>threads.</em></h1>
            <p className="world-hero__lede">Policy decisions can reach borrowing costs. Conflict can reach barrels, barrels can touch currencies, and currencies touch daily life. See what is reported—and how carefully it is sourced.</p>
            <div className="world-hero__controls">
              <label className="currency-control">
                <span>Your currency lens</span>
                <select value={preferences.baseCurrency} onChange={(event) => preferences.setBaseCurrency(event.target.value as BaseCurrency)}>
                  {BASE_CURRENCIES.map((currency) => <option value={currency} key={currency}>{currency}</option>)}
                </select>
              </label>
              <button
                type="button"
                className={`watch-filter${preferences.watchOnly ? " is-active" : ""}`}
                onClick={preferences.toggleWatchOnly}
                aria-pressed={preferences.watchOnly}
              >
                <svg viewBox="0 0 20 20" aria-hidden="true"><path d="m10 2.2 2.35 4.76 5.25.76-3.8 3.7.9 5.23L10 14.18l-4.7 2.47.9-5.23-3.8-3.7 5.25-.76L10 2.2Z" /></svg>
                {preferences.watchOnly ? "Watching" : "Watchlist"}
                <span>{preferences.watched.length}</span>
              </button>
            </div>
          </div>
          <NextOnClock item={upcoming} loading={viewPhase === "loading"} onReceipt={openReceipt} />
          <div className="world-hero__status" role="status" aria-live="polite">
            <span className={`world-hero__status-light is-${navigationState}`} />
            <div><strong>{deliveryHeadline}</strong><span>{deliveryDetail}</span></div>
            <span className="world-hero__generated">{viewData?.generated_at ? `Assembled ${dateTimeText(viewData.generated_at)}` : "Assembly time pending"}</span>
            <button type="button" onClick={requestRefresh} disabled={refreshing || viewPhase === "loading"}>{refreshing ? "Refreshing…" : viewPhase === "loading" ? "Loading…" : "Refresh"}</button>
          </div>
        </header>

        {viewPhase === "error" && (
          <section className="world-alert world-alert--error" role="alert">
            <div><span aria-hidden="true">◇</span><div><strong>The dashboard is here. The feed is not.</strong><p>{error} No market values have been substituted.</p></div></div>
            <button type="button" onClick={requestRefresh}>Try the source network again</button>
          </section>
        )}
        {refreshError && (
          <section className="world-alert world-alert--warning" role="status">
            <div><span aria-hidden="true">◌</span><div><strong>Refresh missed</strong><p>{refreshError} The last received observations remain visible with their timestamps.</p></div></div>
          </section>
        )}
        {viewPhase === "ready" && sourceState !== "available" && (
          <section className="world-alert world-alert--warning" role="status">
            <div><span aria-hidden="true">◌</span><div><strong>This is a partial weave</strong><p>Some sources are stale or unavailable. Each affected observation keeps its own state and receipt.</p></div></div>
            <a href="#coverage">See the gaps</a>
          </section>
        )}

        <section className="world-section today-section" id="today">
          <SectionHeading kicker="A factual orientation" title="What the sources report" note="A short, sourced view of current observations and scheduled policy events—not a claim that every item changed today." />
          <BriefingPanel items={briefing} phase={viewPhase} onReceipt={openReceipt} />
        </section>

        <DataSection id="rates" kicker="The price of cash" title="Policy & cash rates" note="Official policy observations and overnight reference rates, each labelled observed or derived." noun="rate observations" items={policy} section="policy" phase={viewPhase} watchOnly={preferences.watchOnly} watched={preferences.watched} onWatch={preferences.toggleWatched} onReceipt={openReceipt} notice={<PolicyNotices policy={policy} />} />
        <DataSection id="sovereigns" kicker="The public cost of time" title="Sovereign curves" note="Official government borrowing references across available maturities. Curves are shown only when the source supplies their points." noun="sovereign observations" items={sovereigns} section="sovereigns" phase={viewPhase} watchOnly={preferences.watchOnly} watched={preferences.watched} onWatch={preferences.toggleWatched} onReceipt={openReceipt} sovereign />
        <DataSection id="currencies" kicker={`${preferences.baseCurrency} lens`} title="Currencies" note={`Official reference-rate pairs for the ${preferences.baseCurrency} snapshot. No silent conversion and no claim of live executable pricing.`} noun="currency observations" items={fx} section="fx" phase={viewPhase} watchOnly={preferences.watchOnly} watched={preferences.watched} onWatch={preferences.toggleWatched} onReceipt={openReceipt} />
        <DataSection id="energy" kicker="Rights before prices" title="Energy coverage" note="At launch, Brent and WTI benchmark values remain withheld until public display rights are cleared. CashLoom shows the gap instead of a proxy." noun="energy coverage cards" items={energy} section="energy" phase={viewPhase} watchOnly={preferences.watchOnly} watched={preferences.watched} onWatch={preferences.toggleWatched} onReceipt={openReceipt} />
        <DataSection id="crypto" kicker="Open monetary rails" title="Crypto & settlement" note={`BTC and ETH reference values in ${preferences.baseCurrency}, plus available Bitcoin and Base fee observations. No stablecoin peg-health coverage is claimed.`} noun="crypto observations" items={[...crypto, ...fees]} section="crypto" phase={viewPhase} watchOnly={preferences.watchOnly} watched={preferences.watched} onWatch={preferences.toggleWatched} onReceipt={openReceipt} />
        <section className="world-onchain-gateway" aria-labelledby="world-onchain-title">
          <div>
            <p className="world-kicker">A dedicated chain-state instrument</p>
            <h2 id="world-onchain-title">Follow money onto the rails.</h2>
            <p>Move from reference prices into pinned network state, native stablecoin supply, selected credit markets, contract-level pool liquidity, and canonical bridge routes. Every observation keeps its method, source, limitation, and—where applicable—its reference block.</p>
          </div>
          <ul aria-label="Onchain coverage">
            <li><span>Networks</span><strong>8 chain contexts</strong></li>
            <li><span>Credit + pools</span><strong>Aave V3 · Uniswap V3</strong></li>
            <li><span>Bridges</span><strong>CCTP burn + mint routes</strong></li>
          </ul>
          <a href="/onchain">Open CashLoom Onchain <span aria-hidden="true">↗</span></a>
          <p className="world-onchain-gateway__limit">Latest state, not a ranking. No wallet connection, execution, TVL fiction, or safety score.</p>
        </section>
        <ThreadsSection items={threads} phase={viewPhase} onReceipt={openReceipt} />
        <CalendarSection items={calendar} phase={viewPhase} onReceipt={openReceipt} />
        <CoverageSection data={viewData} phase={viewPhase} onReceipt={openReceipt} />
      </main>
      <WorldFooter generatedAt={viewData?.generated_at} />
      {receipt && <ReceiptDrawer selection={receipt} sources={sources} onClose={closeReceipt} />}
    </div>
  );
}
