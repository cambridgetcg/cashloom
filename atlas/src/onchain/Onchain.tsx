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
  fetchOnchain,
  loadPersistedOnchainSnapshot,
  persistOnchainSnapshot,
} from "./api";
import type {
  ExactValue,
  MetricReceipt,
  OnchainDeliveryMeta,
  OnchainLoadState,
  OnchainMetric,
  OnchainRecord,
  OnchainSnapshot,
  OnchainSource,
  ReceiptSelection,
} from "./types";
import "./onchain.css";

const REFRESH_INTERVAL = 3 * 60 * 1000;
const REFRESH_CHECK_INTERVAL = 60 * 1000;

const SECTION_LINKS = [
  ["pulse", "Pulse"],
  ["networks", "Networks"],
  ["stable-money", "Stable money"],
  ["credit", "Credit"],
  ["pools", "Pools"],
  ["bridges", "Bridges"],
  ["threads", "Threads"],
  ["sources", "Sources"],
] as const;

interface ExactView {
  text: string;
  unit?: string;
  present: boolean;
}

function isRecord(value: unknown): value is OnchainRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function records(value: unknown): OnchainRecord[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string" && Boolean(entry.trim()))
    : [];
}

function scopes(item: OnchainRecord): OnchainRecord[] {
  const nested = [item.receipt, item.reference_block, item.value, item.block_time, item.finality]
    .filter(isRecord);
  return [item, ...nested];
}

function pick(item: OnchainRecord | undefined, ...keys: string[]): unknown {
  if (!item) return undefined;
  for (const scope of scopes(item)) {
    for (const key of keys) {
      const value = scope[key];
      if (value !== undefined && value !== null && value !== "") return value;
    }
  }
  return undefined;
}

function pickText(item: OnchainRecord | undefined, ...keys: string[]): string | undefined {
  const value = pick(item, ...keys);
  if (typeof value === "string" && value.trim()) return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return undefined;
}

function pickRecord(item: OnchainRecord | undefined, ...keys: string[]): OnchainRecord | undefined {
  const value = pick(item, ...keys);
  return isRecord(value) ? value : undefined;
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

function titleFor(item: OnchainRecord, fallback = "Onchain observation"): string {
  return pickText(
    item,
    "title",
    "name",
    "label",
    "protocol",
    "chain_name",
    "chain",
    "id",
  ) ?? fallback;
}

function humanKey(value: string): string {
  return value
    .replaceAll("_", " ")
    .replaceAll("-", " ")
    .replace(/\b\w/g, (letter) => letter.toLocaleUpperCase());
}

function exactValue(value: unknown): ExactValue | undefined {
  if (!isRecord(value)) return undefined;
  if (
    typeof value.raw !== "string"
    || typeof value.decimal !== "string"
    || typeof value.decimals !== "number"
    || typeof value.unit !== "string"
    || typeof value.display !== "string"
  ) return undefined;
  return value as ExactValue;
}

/** Add visual grouping without parsing through IEEE-754 or changing precision. */
function groupExactDecimal(value: string): string {
  const match = /^([+-]?)(\d+)(\.\d+)?$/.exec(value.trim());
  if (!match) return value;
  const [, sign, whole, fraction = ""] = match;
  return `${sign}${whole.replace(/\B(?=(\d{3})+(?!\d))/g, "\u2009")}${fraction}`;
}

function exactView(value: unknown): ExactView {
  const exact = exactValue(value);
  if (!exact) return { text: "Awaiting observation", present: false };
  const decimal = exact.decimal.trim();
  const display = exact.display.trim();
  const prettyDecimal = groupExactDecimal(decimal);
  if (display.startsWith(decimal)) {
    return {
      text: `${prettyDecimal}${display.slice(decimal.length)}`,
      unit: exact.unit,
      present: true,
    };
  }
  return { text: display || `${prettyDecimal} ${exact.unit}`, unit: exact.unit, present: true };
}

function shortIdentity(value?: string): string | undefined {
  if (!value) return undefined;
  if (value.length <= 19) return value;
  return `${value.slice(0, 9)}…${value.slice(-7)}`;
}

function validDate(value: string | undefined): value is string {
  return Boolean(value && !Number.isNaN(new Date(value).valueOf()));
}

function dateTimeText(value: string | undefined, long = false): string | undefined {
  if (!validDate(value)) return undefined;
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: long ? "medium" : undefined,
    timeStyle: long ? "medium" : "short",
  }).format(new Date(value));
}

function ageText(timestamp: number, now: number): string {
  const seconds = Math.max(0, Math.floor((now - timestamp) / 1_000));
  if (seconds < 60) return "less than a minute ago";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"} ago`;
  const hours = Math.floor(minutes / 60);
  return `${hours} hour${hours === 1 ? "" : "s"} ago`;
}

function observationState(item: OnchainRecord | undefined): string | undefined {
  if (!item) return undefined;
  if (pick(item, "stale") === true) return "stale";
  return pickText(item, "status", "state")?.toLocaleLowerCase();
}

function stateTone(state?: string): "good" | "warn" | "bad" | "quiet" {
  const normalized = state?.toLocaleLowerCase() ?? "";
  if (["observed", "ready", "ok", "available", "reference"].includes(normalized)) return "good";
  if (["partial", "stale", "derived"].includes(normalized) || normalized.includes("saved")) return "warn";
  if (["unavailable", "error", "offline", "missing"].includes(normalized)) return "bad";
  return "quiet";
}

function StateBadge({ state }: { state?: string }) {
  if (!state) return null;
  return (
    <span className={`onchain-state onchain-state--${stateTone(state)}`}>
      <i aria-hidden="true" />{state.replaceAll("_", " ")}
    </span>
  );
}

function proofLabel(item: OnchainRecord): string | undefined {
  const receipt = pickRecord(item, "receipt") ?? inferredReceipt(item);
  return pickText(receipt, "proof_state")?.replaceAll("-", " ");
}

function sourceIdsFor(item: OnchainRecord, receipt?: OnchainRecord): string[] {
  const ids = [
    ...stringArray(item.source_ids),
    ...stringArray(receipt?.source_ids),
    ...(typeof item.source_id === "string" ? [item.source_id] : []),
  ];
  return [...new Set(ids)];
}

function sourceLabel(source: OnchainRecord): string {
  return pickText(source, "name", "title", "id") ?? "Source";
}

function sourceById(sources: OnchainSource[], id: string): OnchainSource | undefined {
  return sources.find((source) => pickText(source, "id") === id);
}

function inferredReceipt(item: OnchainRecord): MetricReceipt | undefined {
  if (isRecord(item.receipt)) return item.receipt as MetricReceipt;
  const firstMetric = records(item.metrics)[0];
  if (firstMetric && isRecord(firstMetric.receipt)) return firstMetric.receipt as MetricReceipt;
  return undefined;
}

function primaryExact(item: OnchainRecord): ExactValue | undefined {
  const directKeys = [
    "value",
    "supply",
    "total_supplied",
    "active_liquidity",
    "fee_tier_bps",
    "fast_burn_allowance",
  ];
  for (const key of directKeys) {
    const value = exactValue(item[key]);
    if (value) return value;
  }
  for (const metric of records(item.metrics)) {
    const value = exactValue(metric.value);
    if (value) return value;
  }
  return undefined;
}

function ReceiptButton({ onClick, label = "Receipt" }: { onClick: () => void; label?: string }) {
  return (
    <button className="onchain-receipt-button" type="button" onClick={onClick}>
      <svg viewBox="0 0 18 18" aria-hidden="true">
        <path d="M3.8 2.3h8.7a2 2 0 0 1 2 2v11.4l-2.3-1.35-2.05 1.35-2.05-1.35-2.05 1.35-2.25-1.35V2.3Z" />
        <path d="M6.1 6h6M6.1 8.8h6M6.1 11.6h3.8" />
      </svg>
      {label}
    </button>
  );
}

function ExactDatum({ value, quiet = false }: { value: unknown; quiet?: boolean }) {
  const view = exactView(value);
  return (
    <span className={`onchain-exact${quiet ? " onchain-exact--quiet" : ""}${view.present ? "" : " is-empty"}`}>
      {view.text}
    </span>
  );
}

function SectionHeading({
  eyebrow,
  title,
  note,
  honesty,
  count,
}: {
  eyebrow: string;
  title: string;
  note: string;
  honesty: string;
  count?: number;
}) {
  return (
    <header className="onchain-section__head">
      <div>
        <p className="onchain-kicker">{eyebrow}</p>
        <h2>{title}</h2>
        <p className="onchain-section__note">{note}</p>
      </div>
      <aside className="onchain-honesty">
        <span aria-hidden="true">◇</span>
        <p>{honesty}</p>
        {count !== undefined && <strong>{count} covered</strong>}
      </aside>
    </header>
  );
}

function EmptyState({ noun }: { noun: string }) {
  return (
    <div className="onchain-empty">
      <span aria-hidden="true"><i /><i /><i /></span>
      <div>
        <strong>No {noun} answered</strong>
        <p>CashLoom leaves this space open. It does not substitute an index, estimate, or cached market claim.</p>
      </div>
    </div>
  );
}

function SkeletonGrid({ count = 4 }: { count?: number }) {
  return (
    <div className="onchain-card-grid onchain-skeleton-grid" aria-hidden="true">
      {Array.from({ length: count }).map((_, index) => (
        <div className="onchain-skeleton" key={index}>
          <span /><span /><span /><span />
        </div>
      ))}
    </div>
  );
}

function OnchainNav({ sourceState }: { sourceState: string }) {
  return (
    <nav className="onchain-nav" aria-label="CashLoom Onchain">
      <a className="onchain-brand" href="/onchain" aria-label="CashLoom Onchain home">
        <svg viewBox="0 0 38 38" aria-hidden="true">
          <path d="M19 3.5 32.4 11v16L19 34.5 5.6 27V11L19 3.5Z" />
          <path d="m5.6 11 13.4 8 13.4-8M19 19v15.5" />
          <circle cx="19" cy="19" r="2.8" />
        </svg>
        <span>CashLoom</span>
        <em>Onchain</em>
      </a>
      <div className="onchain-nav__links">
        {SECTION_LINKS.map(([id, label]) => <a href={`#${id}`} key={id}>{label}</a>)}
      </div>
      <div className="onchain-nav__right">
        <span className={`onchain-nav__state onchain-nav__state--${stateTone(sourceState)}`}>
          <i />{sourceState.replaceAll("_", " ")}
        </span>
        <a href="/world">World <span aria-hidden="true">↗</span></a>
      </div>
    </nav>
  );
}

function Hero({
  data,
  delivery,
  displayNow,
  phase,
  sourceState,
  refreshing,
  onRefresh,
}: {
  data?: OnchainSnapshot;
  delivery?: OnchainDeliveryMeta;
  displayNow: number;
  phase: OnchainLoadState;
  sourceState: string;
  refreshing: boolean;
  onRefresh: () => void;
}) {
  const status = isRecord(data?.status) ? data.status : undefined;
  const available = pickText(status, "available_sources");
  const total = pickText(status, "total_sources");
  const saved = delivery?.kind === "saved";
  const revalidated = delivery?.kind === "revalidated";
  const serverStale = delivery?.serverCacheState === "stale";
  const headline = saved
    ? refreshing ? "Saved snapshot · updating" : "Saved snapshot"
    : serverStale
      ? "Server snapshot · stale"
      : sourceState.replaceAll("_", " ");
  const receiptLine = saved
    ? `Saved ${ageText(delivery.receivedAt, displayNow)} · received ${dateTimeText(new Date(delivery.receivedAt).toISOString(), true)}`
    : revalidated && delivery.checkedAt
      ? `Unchanged · checked ${dateTimeText(new Date(delivery.checkedAt).toISOString(), true)}`
      : available && total
        ? `${available}/${total} sources answering`
        : phase === "loading" ? "Reading pinned state" : "Coverage receipt pending";
  return (
    <header className="onchain-hero">
      <div className="onchain-hero__field" aria-hidden="true">
        <svg viewBox="0 0 1120 720" preserveAspectRatio="xMidYMid slice">
          <defs>
            <radialGradient id="onchain-node" cx="35%" cy="25%">
              <stop offset="0" stopColor="#fff2cf" />
              <stop offset=".35" stopColor="#d8a24a" />
              <stop offset="1" stopColor="#6f391f" />
            </radialGradient>
          </defs>
          {[
            "M80 158C270 70 345 245 522 208S810 72 1050 148",
            "M40 520C230 412 305 598 510 494S806 348 1082 462",
            "M154 620C290 480 376 370 538 354S794 416 1000 250",
            "M135 232C315 280 370 426 570 430S850 280 1025 596",
            "M320 58C300 242 490 278 648 324S860 506 874 675",
            "M90 365C250 360 378 270 554 300S798 604 1070 552",
          ].map((path, index) => <path key={path} className={`thread thread--${index}`} d={path} />)}
          {[[138, 232], [320, 378], [522, 208], [570, 430], [648, 324], [826, 393], [1000, 250], [1025, 596]].map(([x, y], index) => (
            <g key={`${x}-${y}`} className={`node node--${index}`}>
              <circle cx={x} cy={y} r="17" />
              <circle cx={x} cy={y} r="4.5" fill="url(#onchain-node)" />
            </g>
          ))}
        </svg>
      </div>
      <div className="onchain-hero__copy">
        <p className="onchain-hero__kicker"><span /> Settlement, liquidity &amp; trust boundaries</p>
        <h1>Liquidity moves<br />across <em>boundaries.</em></h1>
        <p className="onchain-hero__lede">
          A read-only map of major chains, native stable money, DeFi credit, concentrated-liquidity pools,
          and bridge routes—each observation pinned to the evidence that produced it.
        </p>
        <div className="onchain-hero__actions">
          <a href="#pulse">Read the latest state <span aria-hidden="true">↓</span></a>
          <span>No wallet · no execution · no rankings</span>
        </div>
      </div>
      <aside className="onchain-hero__scope">
        <p className="onchain-kicker">What this instrument sees</p>
        <dl>
          <div><dt>{data?.chains.length ?? "—"}</dt><dd>network references</dd></div>
          <div><dt>{data?.stablecoins.length ?? "—"}</dt><dd>native USDC supplies</dd></div>
          <div><dt>{data?.lending_markets.length ?? "—"}</dt><dd>credit markets</dd></div>
          <div><dt>{data?.bridge_routes.length ?? "—"}</dt><dd>bridge directions</dd></div>
        </dl>
        <p>Counts describe coverage, never quality, safety, or opportunity.</p>
      </aside>
      <div className="onchain-hero__status" role="status" aria-live="polite">
        <span className={`onchain-hero__light onchain-hero__light--${stateTone(saved || serverStale ? "saved" : sourceState)}`} />
        <div>
          <strong className={saved || serverStale ? "onchain-hero__saved" : undefined}>{headline}</strong>
          <span>{receiptLine}</span>
        </div>
        <span className="onchain-hero__time">
          {dateTimeText(data?.generated_at) ? `Assembled ${dateTimeText(data?.generated_at)}` : "Assembly time pending"}
        </span>
        <button type="button" onClick={onRefresh} disabled={refreshing || phase === "loading"}>
          {refreshing ? "Refreshing…" : phase === "loading" ? "Reading…" : "Refresh state"}
        </button>
      </div>
    </header>
  );
}

function BriefingSection({
  items,
  phase,
  onReceipt,
}: {
  items: OnchainRecord[];
  phase: OnchainLoadState;
  onReceipt: (item: OnchainRecord, kind: string) => void;
}) {
  return (
    <section className="onchain-section onchain-pulse" id="pulse">
      <SectionHeading
        eyebrow="The latest pinned state"
        title="Pulse, without prediction"
        note="A factual orientation assembled from the observations below. It describes what answered—not what to buy, bridge, lend, or expect next."
        honesty="Briefing language is bounded by the same sources and limitations as its underlying observations."
        count={items.length}
      />
      {phase === "loading" ? <SkeletonGrid count={3} /> : items.length ? (
        <div className="onchain-brief-grid">
          {items.map((item, index) => {
            const state = observationState(item);
            return (
              <article className="onchain-brief" key={pickText(item, "id") ?? index}>
                <div className="onchain-brief__top">
                  <span>{humanKey(pickText(item, "category") ?? "observation")}</span>
                  <StateBadge state={state} />
                </div>
                <h3>{titleFor(item)}</h3>
                <p>{pickText(item, "summary") ?? "The source supplied no narrative summary."}</p>
                <footer>
                  <span>{dateTimeText(pickText(item, "observed_at")) ?? "Observation time not supplied"}</span>
                  <ReceiptButton onClick={() => onReceipt(item, "briefing")} />
                </footer>
              </article>
            );
          })}
        </div>
      ) : <EmptyState noun="briefing observations" />}
    </section>
  );
}

function NetworkCard({
  item,
  sources,
  onReceipt,
}: {
  item: OnchainRecord;
  sources: OnchainSource[];
  onReceipt: (item: OnchainRecord, kind: string) => void;
}) {
  const reference = isRecord(item.reference_block) ? item.reference_block : undefined;
  const blockTime = reference && isRecord(reference.block_time) ? reference.block_time : undefined;
  const finality = reference && isRecord(reference.finality) ? reference.finality : undefined;
  const metrics = records(item.metrics) as OnchainMetric[];
  const source = typeof item.source_id === "string" ? sourceById(sources, item.source_id) : undefined;
  const state = observationState(item);
  return (
    <article className={`onchain-network onchain-card--${stateTone(state)}`}>
      <header>
        <div className="onchain-network__sigil" aria-hidden="true"><span /><i /></div>
        <div>
          <p>{pickText(item, "family") ?? "network"} · {pickText(item, "native_symbol") ?? "native asset"}</p>
          <h3>{pickText(item, "name") ?? pickText(item, "chain") ?? "Network"}</h3>
        </div>
        <StateBadge state={state} />
      </header>
      <div className="onchain-network__reference">
        <span>{humanKey(pickText(reference, "height_kind") ?? "reference block")}</span>
        <strong>{groupExactDecimal(pickText(reference, "height") ?? "Awaiting reference")}</strong>
        <code>{shortIdentity(pickText(reference, "hash")) ?? "hash pending"}</code>
      </div>
      <dl className="onchain-metric-grid">
        {metrics.length ? metrics.map((metric, index) => (
          <div key={pickText(metric, "id") ?? index}>
            <dt>{pickText(metric, "label") ?? "Metric"}</dt>
            <dd><ExactDatum value={metric.value} /></dd>
            <span>{proofLabel(metric) ?? pickText(metric, "status") ?? "receipt pending"}</span>
          </div>
        )) : <div className="is-empty"><dt>Network metrics</dt><dd>Awaiting observation</dd></div>}
      </dl>
      <footer className="onchain-card-foot">
        <div>
          <span>{pickText(finality, "claim")?.replaceAll("-", " ") ?? "Finality claim pending"}</span>
          <span>{dateTimeText(pickText(blockTime, "iso")) ?? dateTimeText(pickText(reference, "fetched_at")) ?? "Time pending"}</span>
          {source && <span>{sourceLabel(source)}</span>}
        </div>
        <ReceiptButton onClick={() => onReceipt(item, "network")} />
      </footer>
    </article>
  );
}

function NetworksSection({
  items,
  sources,
  phase,
  onReceipt,
}: {
  items: OnchainRecord[];
  sources: OnchainSource[];
  phase: OnchainLoadState;
  onReceipt: (item: OnchainRecord, kind: string) => void;
}) {
  return (
    <section className="onchain-section" id="networks">
      <SectionHeading
        eyebrow="Settlement references"
        title="Major networks"
        note="Block, slot, fee, and utilization observations from fixed mainnet registries. Each EVM read shares its network's pinned reference block."
        honesty="Finality labels report the upstream tag or commitment selected. They are not an independent CashLoom guarantee."
        count={items.length}
      />
      {phase === "loading" ? <SkeletonGrid /> : items.length ? (
        <div className="onchain-network-grid">
          {items.map((item, index) => <NetworkCard item={item} sources={sources} onReceipt={onReceipt} key={pickText(item, "id") ?? index} />)}
        </div>
      ) : <EmptyState noun="network references" />}
    </section>
  );
}

function StablecoinSection({
  items,
  sources,
  phase,
  onReceipt,
}: {
  items: OnchainRecord[];
  sources: OnchainSource[];
  phase: OnchainLoadState;
  onReceipt: (item: OnchainRecord, kind: string) => void;
}) {
  return (
    <section className="onchain-section onchain-stable" id="stable-money">
      <SectionHeading
        eyebrow="Native stable money"
        title="USDC issued onchain"
        note="Direct total-supply reads for Circle's native-issued USDC contracts and mint. Wrapped and legacy bridged variants are not silently combined."
        honesty="Issued supply is not reserve value, peg health, circulating float, or a claim that every token is immediately redeemable."
        count={items.length}
      />
      {phase === "loading" ? <SkeletonGrid /> : items.length ? (
        <div className="onchain-stable-grid">
          {items.map((item, index) => {
            const receipt = inferredReceipt(item);
            const sourceIds = sourceIdsFor(item, receipt);
            const source = sourceIds.length ? sourceById(sources, sourceIds[0]) : undefined;
            const state = observationState(item);
            return (
              <article className={`onchain-stable-card onchain-card--${stateTone(state)}`} key={pickText(item, "id") ?? index}>
                <header>
                  <div><span>USDC</span><i aria-hidden="true" /></div>
                  <StateBadge state={state} />
                </header>
                <p>{pickText(item, "chain_name") ?? pickText(item, "chain") ?? "Network"}</p>
                <h3><ExactDatum value={item.supply} /></h3>
                <dl>
                  <div><dt>Representation</dt><dd>{pickText(item, "representation")?.replaceAll("_", " ") ?? "not supplied"}</dd></div>
                  <div><dt>Token / mint</dt><dd title={pickText(item, "token_address")}>{shortIdentity(pickText(item, "token_address")) ?? "pending"}</dd></div>
                  <div><dt>Proof</dt><dd>{pickText(receipt, "proof_state")?.replaceAll("-", " ") ?? "pending"}</dd></div>
                </dl>
                <footer className="onchain-card-foot">
                  <div><span>{dateTimeText(pickText(receipt, "observed_at", "fetched_at")) ?? "Time pending"}</span>{source && <span>{sourceLabel(source)}</span>}</div>
                  <ReceiptButton onClick={() => onReceipt(item, "stable money")} />
                </footer>
              </article>
            );
          })}
        </div>
      ) : <EmptyState noun="native stablecoin supplies" />}
    </section>
  );
}

const LENDING_METRICS = [
  ["total_supplied", "Total supplied"],
  ["stable_debt", "Stable debt"],
  ["variable_debt", "Variable debt"],
  ["utilization", "Utilization"],
  ["current_supply_rate", "Current supply rate"],
  ["current_variable_borrow_rate", "Current variable borrow rate"],
] as const;

function LendingSection({
  items,
  sources,
  phase,
  onReceipt,
}: {
  items: OnchainRecord[];
  sources: OnchainSource[];
  phase: OnchainLoadState;
  onReceipt: (item: OnchainRecord, kind: string) => void;
}) {
  return (
    <section className="onchain-section" id="credit">
      <SectionHeading
        eyebrow="Protocols & credit"
        title="USDC lending state"
        note="Aave V3 reserve data read directly from the configured market at one pinned block per chain. Utilization is shown only with its derivation receipt."
        honesty="Contract rates are current onchain rate fields—not reward yield, projected return, executable terms, or a recommendation."
        count={items.length}
      />
      {phase === "loading" ? <SkeletonGrid /> : items.length ? (
        <div className="onchain-credit-grid">
          {items.map((item, index) => {
            const receipt = inferredReceipt(item);
            const ids = sourceIdsFor(item, receipt);
            const source = ids.length ? sourceById(sources, ids[0]) : undefined;
            const state = observationState(item);
            return (
              <article className={`onchain-credit-card onchain-card--${stateTone(state)}`} key={pickText(item, "id") ?? index}>
                <header>
                  <div>
                    <p>{pickText(item, "protocol") ?? "Protocol"} · {pickText(item, "asset") ?? "Asset"}</p>
                    <h3>{pickText(item, "chain_name") ?? titleFor(item)}</h3>
                  </div>
                  <StateBadge state={state} />
                </header>
                <dl className="onchain-credit-metrics">
                  {LENDING_METRICS.map(([key, label]) => (
                    <div key={key}>
                      <dt>{label}</dt>
                      <dd><ExactDatum value={item[key]} quiet={key.includes("rate")} /></dd>
                    </div>
                  ))}
                </dl>
                <p className="onchain-card-note">{pickText(item, "note") ?? "No additional market note was supplied."}</p>
                <footer className="onchain-card-foot">
                  <div>
                    <span title={pickText(item, "data_provider_address")}>Data provider {shortIdentity(pickText(item, "data_provider_address")) ?? "pending"}</span>
                    {source && <span>{sourceLabel(source)}</span>}
                  </div>
                  <ReceiptButton onClick={() => onReceipt(item, "credit market")} />
                </footer>
              </article>
            );
          })}
        </div>
      ) : <EmptyState noun="credit-market observations" />}
    </section>
  );
}

function PoolsSection({
  items,
  sources,
  phase,
  onReceipt,
}: {
  items: OnchainRecord[];
  sources: OnchainSource[];
  phase: OnchainLoadState;
  onReceipt: (item: OnchainRecord, kind: string) => void;
}) {
  return (
    <section className="onchain-section onchain-pools" id="pools">
      <SectionHeading
        eyebrow="Concentrated liquidity"
        title="Curated USDC / WETH pools"
        note="A narrow view of the canonical Uniswap V3 0.05% pool on supported chains: active liquidity units, current tick, and balances held by the pool contract."
        honesty="Contract-held balances are not TVL, market depth, volume, LP return, or a promise that all balances are available at the current price."
        count={items.length}
      />
      {phase === "loading" ? <SkeletonGrid /> : items.length ? (
        <div className="onchain-pool-list">
          {items.map((item, index) => {
            const tokens = records(item.tokens);
            const receipt = inferredReceipt(item);
            const ids = sourceIdsFor(item, receipt);
            const source = ids.length ? sourceById(sources, ids[0]) : undefined;
            const state = observationState(item);
            return (
              <article className={`onchain-pool-row onchain-card--${stateTone(state)}`} key={pickText(item, "id") ?? index}>
                <div className="onchain-pool-row__identity">
                  <span>{pickText(item, "protocol") ?? "Protocol"}</span>
                  <h3>{pickText(item, "name") ?? "USDC / WETH"}</h3>
                  <p>{pickText(item, "chain_name") ?? pickText(item, "chain") ?? "Network"}</p>
                </div>
                <dl>
                  <div><dt>Fee tier</dt><dd><ExactDatum value={item.fee_tier_bps} /></dd></div>
                  <div><dt>Active liquidity units</dt><dd><ExactDatum value={item.active_liquidity} quiet /></dd></div>
                  {tokens.map((token, tokenIndex) => (
                    <div key={pickText(token, "address") ?? tokenIndex}>
                      <dt>Contract-held {pickText(token, "symbol") ?? "token"}</dt>
                      <dd><ExactDatum value={token.contract_balance} /></dd>
                    </div>
                  ))}
                  <div><dt>Current tick</dt><dd><ExactDatum value={item.current_tick} quiet /></dd></div>
                </dl>
                <div className="onchain-pool-row__receipt">
                  <StateBadge state={state} />
                  <span title={pickText(item, "pool_address")}>{shortIdentity(pickText(item, "pool_address")) ?? "Pool pending"}</span>
                  {source && <span>{sourceLabel(source)}</span>}
                  <ReceiptButton onClick={() => onReceipt(item, "liquidity pool")} />
                </div>
              </article>
            );
          })}
        </div>
      ) : <EmptyState noun="curated pool observations" />}
    </section>
  );
}

function BridgesSection({
  items,
  sources,
  phase,
  onReceipt,
}: {
  items: OnchainRecord[];
  sources: OnchainSource[];
  phase: OnchainLoadState;
  onReceipt: (item: OnchainRecord, kind: string) => void;
}) {
  return (
    <section className="onchain-section" id="bridges">
      <SectionHeading
        eyebrow="Movement across domains"
        title="CCTP bridge routes"
        note="Official Circle CCTP V2 route references for native USDC burn-and-mint movement, including available standard and fast protocol fee modes."
        honesty="A route reference is not an executable quote. Fees exclude gas and changing destination conditions; timestamps are not observed delivery times."
        count={items.length}
      />
      {phase === "loading" ? <SkeletonGrid /> : items.length ? (
        <div className="onchain-bridge-grid">
          {items.map((item, index) => {
            const fees = records(item.fees);
            const receipt = inferredReceipt(item);
            const ids = sourceIdsFor(item, receipt);
            const source = ids.length ? sourceById(sources, ids[0]) : undefined;
            const state = observationState(item);
            return (
              <article className={`onchain-bridge-card onchain-card--${stateTone(state)}`} key={pickText(item, "id") ?? index}>
                <header>
                  <span>{pickText(item, "protocol") ?? "Bridge"}</span>
                  <StateBadge state={state} />
                </header>
                <div className="onchain-route" aria-label={`${pickText(item, "source_chain_name") ?? "Source"} to ${pickText(item, "destination_chain_name") ?? "destination"}`}>
                  <div><i /><strong>{pickText(item, "source_chain_name") ?? "Source"}</strong><span>burn</span></div>
                  <svg viewBox="0 0 120 22" preserveAspectRatio="none" aria-hidden="true"><path d="M2 11h110" /><path d="m106 4 10 7-10 7" /></svg>
                  <div><i /><strong>{pickText(item, "destination_chain_name") ?? "Destination"}</strong><span>mint</span></div>
                </div>
                <dl className="onchain-bridge-fees">
                  {fees.length ? fees.map((fee, feeIndex) => (
                    <div key={pickText(fee, "mode") ?? feeIndex}>
                      <dt>{humanKey(pickText(fee, "mode") ?? "fee")} protocol fee</dt>
                      <dd><ExactDatum value={fee.fee_bps} /></dd>
                      <span>Finality threshold {pickText(fee, "finality_threshold") ?? "not supplied"}</span>
                    </div>
                  )) : <div><dt>Protocol fees</dt><dd>Awaiting reference</dd></div>}
                  {exactValue(item.fast_burn_allowance) && (
                    <div><dt>Fast-burn allowance</dt><dd><ExactDatum value={item.fast_burn_allowance} /></dd><span>Shared protocol allowance reference</span></div>
                  )}
                </dl>
                <footer className="onchain-card-foot">
                  <div><span>{dateTimeText(pickText(item, "observed_at", "fetched_at")) ?? "Time pending"}</span>{source && <span>{sourceLabel(source)}</span>}</div>
                  <ReceiptButton onClick={() => onReceipt(item, "bridge route")} />
                </footer>
              </article>
            );
          })}
        </div>
      ) : <EmptyState noun="bridge-route references" />}
    </section>
  );
}

function ThreadsSection({
  items,
  phase,
  onReceipt,
}: {
  items: OnchainRecord[];
  phase: OnchainLoadState;
  onReceipt: (item: OnchainRecord, kind: string) => void;
}) {
  return (
    <section className="onchain-section onchain-threads" id="threads">
      <SectionHeading
        eyebrow="Documented relationships"
        title="How the state connects"
        note="Threads separate observed facts from possible transmission channels, then state what the evidence cannot establish."
        honesty="A plausible channel is not causation. These threads do not infer trade direction, intent, safety, or future price."
        count={items.length}
      />
      {phase === "loading" ? <SkeletonGrid count={3} /> : items.length ? (
        <div className="onchain-thread-list">
          {items.map((item, index) => {
            const observed = stringArray(item.observed);
            const channels = stringArray(item.possible_channels);
            const limits = stringArray(item.limits);
            return (
              <article className="onchain-thread" key={pickText(item, "id") ?? index}>
                <div className="onchain-thread__rail" aria-hidden="true"><span /><i /><span /></div>
                <div>
                  <header><span>{String(index + 1).padStart(2, "0")}</span><h3>{titleFor(item)}</h3><ReceiptButton onClick={() => onReceipt(item, "evidence thread")} /></header>
                  <div className="onchain-thread__columns">
                    <section><h4>Observed</h4>{observed.length ? <ul>{observed.map((entry) => <li key={entry}>{entry}</li>)}</ul> : <p>No observations listed.</p>}</section>
                    <section><h4>Possible channels</h4>{channels.length ? <ul>{channels.map((entry) => <li key={entry}>{entry}</li>)}</ul> : <p>No channel claimed.</p>}</section>
                    <section><h4>Limits</h4>{limits.length ? <ul>{limits.map((entry) => <li key={entry}>{entry}</li>)}</ul> : <p>No additional limit supplied.</p>}</section>
                  </div>
                </div>
              </article>
            );
          })}
        </div>
      ) : <EmptyState noun="documented evidence threads" />}
    </section>
  );
}

function SourcesSection({
  data,
  phase,
  onReceipt,
}: {
  data?: OnchainSnapshot;
  phase: OnchainLoadState;
  onReceipt: (item: OnchainRecord, kind: string) => void;
}) {
  const sources = (data?.sources ?? []) as OnchainSource[];
  const status = isRecord(data?.status) ? data.status : undefined;
  const gaps = records(status?.unavailable);
  const sections = isRecord(status?.sections) ? Object.entries(status.sections) : [];
  return (
    <section className="onchain-section onchain-sources" id="sources">
      <SectionHeading
        eyebrow="Receipts before confidence"
        title="Sources & coverage"
        note="The source register names the official documentation, public chain reads, cadence, and current availability behind this snapshot."
        honesty="Public RPC availability can change. A missing read remains a named gap; credentials and configured endpoint URLs are never exposed."
        count={sources.length}
      />
      {phase === "loading" ? <SkeletonGrid count={3} /> : (
        <>
          <div className="onchain-coverage">
            <div className="onchain-coverage__score">
              <span>Source response</span>
              <strong>{pickText(status, "available_sources") ?? "—"}<small> / {pickText(status, "total_sources") ?? "—"}</small></strong>
              <p>{pickText(status, "stale_count") ?? "0"} stale observations disclosed</p>
            </div>
            <dl>
              {sections.map(([name, value]) => {
                const section = isRecord(value) ? value : undefined;
                return (
                  <div key={name}>
                    <dt>{humanKey(name)}</dt>
                    <dd>{pickText(section, "available") ?? "—"} / {pickText(section, "expected") ?? "—"}</dd>
                    <StateBadge state={pickText(section, "state")} />
                  </div>
                );
              })}
            </dl>
          </div>
          {gaps.length > 0 && (
            <div className="onchain-gaps">
              <p className="onchain-kicker">Named gaps</p>
              <div>{gaps.map((gap, index) => (
                <article key={pickText(gap, "id") ?? index}>
                  <span>{humanKey(pickText(gap, "section") ?? "coverage")}</span>
                  <strong>{titleFor(gap)}</strong>
                  <p>{pickText(gap, "detail") ?? "No detail supplied."}</p>
                </article>
              ))}</div>
            </div>
          )}
          {sources.length ? (
            <div className="onchain-source-list">
              {sources.map((source, index) => {
                const url = safeUrl(source.url);
                return (
                  <article className="onchain-source" key={pickText(source, "id") ?? index}>
                    <span className="onchain-source__index">{String(index + 1).padStart(2, "0")}</span>
                    <div><h3>{sourceLabel(source)}</h3><p>{pickText(source, "note") ?? "No source note supplied."}</p></div>
                    <dl><div><dt>Cadence</dt><dd>{pickText(source, "cadence") ?? "not supplied"}</dd></div><div><dt>Retrieval</dt><dd>{pickText(source, "retrieval")?.replaceAll("_", " ") ?? "not supplied"}</dd></div><div><dt>Rights</dt><dd>{pickText(source, "license")?.replaceAll("-", " ") ?? "not supplied"}</dd></div></dl>
                    <StateBadge state={pickText(source, "status")} />
                    <div className="onchain-source__actions">
                      {url && <a href={url} target="_blank" rel="noreferrer">Official source ↗</a>}
                      <ReceiptButton onClick={() => onReceipt(source, "source")} />
                    </div>
                  </article>
                );
              })}
            </div>
          ) : <EmptyState noun="source receipts" />}
        </>
      )}
    </section>
  );
}

function metadataRows(item: OnchainRecord, receipt?: OnchainRecord): Array<[string, string]> {
  const reference = pickRecord(receipt, "reference_block") ?? pickRecord(item, "reference_block");
  const rows: Array<[string, unknown]> = [
    ["Status", pick(item, "status", "state")],
    ["Method", pick(receipt, "method")],
    ["Proof state", pick(receipt, "proof_state")],
    ["Pinning", pick(receipt, "pinning")],
    ["Observed", pick(receipt, "observed_at") ?? pick(item, "observed_at")],
    ["Fetched", pick(receipt, "fetched_at") ?? pick(item, "fetched_at")],
    ["Verified", pick(item, "verified_at")],
    ["Chain", pick(reference, "chain") ?? pick(item, "chain", "chain_name")],
    ["Reference height", pick(reference, "height")],
    ["Reference hash", pick(reference, "hash")],
    ["Contract", pick(receipt, "contract_address") ?? pick(item, "token_address", "data_provider_address", "pool_address")],
    ["Method / event", pick(receipt, "method_or_event")],
    ["Formula", pick(receipt, "formula")],
  ];
  return rows.flatMap(([label, value]) => {
    if (value === undefined || value === null || value === "") return [];
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      const text = String(value);
      return [[label, ["Observed", "Fetched", "Verified"].includes(label) ? dateTimeText(text, true) ?? text : text]];
    }
    return [];
  });
}

function ReceiptDrawer({
  selection,
  sources,
  onClose,
}: {
  selection: ReceiptSelection;
  sources: OnchainSource[];
  onClose: () => void;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  const previousFocus = useRef<HTMLElement | null>(null);
  const item = selection.item;
  const receipt = inferredReceipt(item);
  const ids = sourceIdsFor(item, receipt);
  const linkedSources = selection.kind === "source"
    ? [item as OnchainSource]
    : ids.map((id) => sourceById(sources, id)).filter((source): source is OnchainSource => Boolean(source));
  const value = primaryExact(item);
  const limitations = [
    ...stringArray(receipt?.limitations),
    ...stringArray(item.limits),
  ];
  const inputs = stringArray(receipt?.inputs);
  const rows = metadataRows(item, receipt);
  useBodyLock(true);

  useEffect(() => {
    const background = Array.from(document.querySelectorAll<HTMLElement>(
      ".onchain-shell > .onchain-skip, .onchain-nav, .onchain-main, .onchain-footer",
    ));
    const hidden = background.map((element) => element.getAttribute("aria-hidden"));
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
      const focusable = Array.from(panel.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), summary, [tabindex]:not([tabindex="-1"])',
      )).filter((element) => element.offsetParent !== null);
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
        if (hidden[index] === null) element.removeAttribute("aria-hidden");
        else element.setAttribute("aria-hidden", hidden[index]);
      });
      previousFocus.current?.focus();
    };
  }, [onClose]);

  return (
    <div className="onchain-drawer" role="dialog" aria-modal="true" aria-labelledby="onchain-receipt-title">
      <button className="onchain-drawer__scrim" type="button" onClick={onClose} aria-label="Close receipt" />
      <div className="onchain-drawer__panel" ref={panelRef} tabIndex={-1}>
        <div className="onchain-drawer__rail" aria-hidden="true" />
        <header>
          <div><p className="onchain-kicker">Evidence receipt · {selection.kind}</p><h2 id="onchain-receipt-title">{titleFor(item)}</h2></div>
          <button type="button" onClick={onClose} aria-label="Close receipt">×</button>
        </header>
        <section className="onchain-drawer__reported">
          <span>{selection.kind === "source" ? "Source state" : "Exact reported value"}</span>
          <strong>{selection.kind === "source" ? pickText(item, "status") ?? "Metadata supplied" : value ? exactView(value).text : "See machine-readable record"}</strong>
          <div><StateBadge state={observationState(item)} />{receipt && <span>{pickText(receipt, "method")?.replaceAll("_", " ")}</span>}{receipt && <span>{pickText(receipt, "proof_state")?.replaceAll("-", " ")}</span>}</div>
        </section>
        {linkedSources.map((source) => {
          const url = safeUrl(source.url);
          const methodology = safeUrl(source.methodology_url);
          const terms = safeUrl(source.terms_url);
          return (
            <section className="onchain-drawer__source" key={pickText(source, "id") ?? sourceLabel(source)}>
              <span>Source</span><h3>{sourceLabel(source)}</h3><p>{pickText(source, "note")}</p>
              <div>{url && <a href={url} target="_blank" rel="noreferrer">Official source ↗</a>}{methodology && <a href={methodology} target="_blank" rel="noreferrer">Methodology ↗</a>}{terms && <a href={terms} target="_blank" rel="noreferrer">Terms ↗</a>}</div>
            </section>
          );
        })}
        <dl className="onchain-drawer__metadata">
          {rows.length ? rows.map(([label, rowValue]) => <div key={label}><dt>{label}</dt><dd>{rowValue}</dd></div>) : <div><dt>Metadata</dt><dd>No additional receipt fields were supplied.</dd></div>}
        </dl>
        {inputs.length > 0 && <section className="onchain-drawer__box"><h3>Derivation inputs</h3><ul>{inputs.map((input) => <li key={input}>{input}</li>)}</ul></section>}
        {limitations.length > 0 && <section className="onchain-drawer__box onchain-drawer__box--limits"><h3>Limitations</h3><ul>{limitations.map((limit) => <li key={limit}>{limit}</li>)}</ul></section>}
        <details className="onchain-drawer__machine"><summary>Machine-readable record</summary><pre>{JSON.stringify(item, null, 2)}</pre></details>
        <p className="onchain-drawer__truth">A pinned receipt makes a read inspectable. It does not make a protocol, asset, pool, route, or transaction safe.</p>
      </div>
    </div>
  );
}

function Alert({ children, kind = "warning", action }: { children: ReactNode; kind?: "warning" | "error"; action?: ReactNode }) {
  return <section className={`onchain-alert onchain-alert--${kind}`} role={kind === "error" ? "alert" : "status"}><span aria-hidden="true">{kind === "error" ? "×" : "◌"}</span><div>{children}</div>{action}</section>;
}

function Footer({ generatedAt }: { generatedAt?: string }) {
  return (
    <footer className="onchain-footer">
      <div aria-hidden="true"><span /><i /><span /></div>
      <p>State moves. Receipts hold the reference.</p>
      <span>{dateTimeText(generatedAt, true) ? `Onchain snapshot assembled ${dateTimeText(generatedAt, true)}` : "Snapshot assembly time unavailable"}</span>
      <nav aria-label="Onchain footer"><a href="#pulse">Back to pulse ↑</a><a href="/world">CashLoom World ↗</a><a href="/atlas">Read the Atlas ↗</a></nav>
    </footer>
  );
}

export default function Onchain() {
  const [initialSaved] = useState(() => loadPersistedOnchainSnapshot());
  const [data, setData] = useState<OnchainSnapshot | undefined>(initialSaved?.snapshot);
  const [phase, setPhase] = useState<OnchainLoadState>(initialSaved ? "ready" : "loading");
  const [delivery, setDelivery] = useState<OnchainDeliveryMeta | undefined>(() => initialSaved
    ? {
      kind: "saved",
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
  const lastAttemptAt = useRef(0);

  useEffect(() => {
    document.title = "Onchain — CashLoom";
    document.querySelector<HTMLMetaElement>('meta[name="description"]')?.setAttribute(
      "content",
      "CashLoom Onchain maps major networks, native stable money, DeFi credit, curated liquidity pools, and bridge routes with pinned evidence receipts.",
    );
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    const hasSnapshot = Boolean(data);
    lastAttemptAt.current = Date.now();
    if (hasSnapshot) {
      setPhase("ready");
      setRefreshing(true);
    } else {
      setPhase("loading");
    }
    setError(undefined);
    setRefreshError(undefined);

    fetchOnchain({ signal: controller.signal, etag: delivery?.etag })
      .then((result) => {
        if (result.kind === "modified") {
          persistOnchainSnapshot(result.snapshot, result.etag, result.receivedAt);
          setData(result.snapshot);
          setDelivery({
            kind: "network",
            receivedAt: result.receivedAt,
            ...(result.etag ? { etag: result.etag } : {}),
            ...(result.serverCacheState ? { serverCacheState: result.serverCacheState } : {}),
            ...(result.serverSnapshotAgeSeconds !== undefined
              ? { serverSnapshotAgeSeconds: result.serverSnapshotAgeSeconds }
              : {}),
          });
        } else {
          if (!hasSnapshot) throw new Error("The onchain feed confirmed an entity that is not available in this browser.");
          setDelivery((current) => current ? {
            ...current,
            kind: "revalidated",
            checkedAt: result.receivedAt,
            ...(result.etag ? { etag: result.etag } : {}),
            ...(result.serverCacheState ? { serverCacheState: result.serverCacheState } : {}),
            ...(result.serverSnapshotAgeSeconds !== undefined
              ? { serverSnapshotAgeSeconds: result.serverSnapshotAgeSeconds }
              : {}),
          } : current);
        }
        setPhase("ready");
        setError(undefined);
      })
      .catch((cause: unknown) => {
        if (cause instanceof DOMException && cause.name === "AbortError") return;
        const message = cause instanceof Error ? cause.message : "The onchain feed could not be read.";
        if (hasSnapshot) setRefreshError(message);
        else {
          setError(message);
          setPhase("error");
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setRefreshing(false);
      });
    return () => controller.abort();
    // Data and delivery are intentionally excluded: a successful read must not
    // trigger another read. A refresh token captures their latest render values.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshToken]);

  useEffect(() => {
    const requestIfOld = (force = false) => {
      if (document.visibilityState === "hidden" || navigator.onLine === false) return;
      const now = Date.now();
      setDisplayNow(now);
      if (!force && now - lastAttemptAt.current < REFRESH_INTERVAL) return;
      lastAttemptAt.current = now;
      setRefreshToken((value) => value + 1);
    };
    const onVisibility = () => {
      if (document.visibilityState === "visible") requestIfOld();
    };
    const onFocus = () => requestIfOld();
    const onOnline = () => requestIfOld(true);
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
    lastAttemptAt.current = Date.now();
    setRefreshToken((value) => value + 1);
  }, []);

  const sources = (data?.sources ?? []) as OnchainSource[];
  const status = isRecord(data?.status) ? data.status : undefined;
  const unavailable = records(status?.unavailable);
  const staleCount = pickText(status, "stale_count");
  const apiState = pickText(status, "state")?.toLocaleLowerCase();
  const sourceState = phase === "loading"
    ? "reading"
    : phase === "error"
      ? "offline"
      : apiState ?? (unavailable.length || (staleCount && staleCount !== "0") ? "partial" : "ready");
  const navigationState = delivery?.kind === "saved"
    ? "saved snapshot"
    : delivery?.serverCacheState === "stale"
      ? "stale snapshot"
      : sourceState;
  const openReceipt = useCallback((item: OnchainRecord, kind: string) => setReceipt({ item, kind }), []);
  const closeReceipt = useCallback(() => setReceipt(undefined), []);

  const arrays = useMemo(() => ({
    briefing: (data?.briefing ?? []) as OnchainRecord[],
    chains: (data?.chains ?? []) as OnchainRecord[],
    stablecoins: (data?.stablecoins ?? []) as OnchainRecord[],
    lending: (data?.lending_markets ?? []) as OnchainRecord[],
    pools: (data?.pools ?? []) as OnchainRecord[],
    bridges: (data?.bridge_routes ?? []) as OnchainRecord[],
    threads: (data?.threads ?? []) as OnchainRecord[],
  }), [data]);

  return (
    <div className="onchain-shell" aria-busy={phase === "loading"}>
      <a className="onchain-skip" href="#pulse">Skip to the onchain pulse</a>
      <OnchainNav sourceState={navigationState} />
      <main className="onchain-main">
        <Hero data={data} delivery={delivery} displayNow={displayNow} phase={phase} sourceState={sourceState} refreshing={refreshing} onRefresh={requestRefresh} />
        {phase === "error" && <Alert kind="error" action={<button type="button" onClick={requestRefresh}>Try the source network again</button>}><strong>The instrument is here. The chain reads are not.</strong><p>{error} No values have been substituted.</p></Alert>}
        {refreshError && <Alert><strong>Refresh missed</strong><p>{refreshError} The last received snapshot remains visible with its pinned timestamps.</p></Alert>}
        {phase === "ready" && sourceState !== "ready" && <Alert action={<a href="#sources">Inspect the gaps</a>}><strong>This is a partial chain weave</strong><p>Some sources or reads are stale or unavailable. Every affected section keeps its own state and receipt.</p></Alert>}
        <BriefingSection items={arrays.briefing} phase={phase} onReceipt={openReceipt} />
        <NetworksSection items={arrays.chains} sources={sources} phase={phase} onReceipt={openReceipt} />
        <StablecoinSection items={arrays.stablecoins} sources={sources} phase={phase} onReceipt={openReceipt} />
        <LendingSection items={arrays.lending} sources={sources} phase={phase} onReceipt={openReceipt} />
        <PoolsSection items={arrays.pools} sources={sources} phase={phase} onReceipt={openReceipt} />
        <BridgesSection items={arrays.bridges} sources={sources} phase={phase} onReceipt={openReceipt} />
        <ThreadsSection items={arrays.threads} phase={phase} onReceipt={openReceipt} />
        <SourcesSection data={data} phase={phase} onReceipt={openReceipt} />
      </main>
      <Footer generatedAt={data?.generated_at} />
      {receipt && <ReceiptDrawer selection={receipt} sources={sources} onClose={closeReceipt} />}
    </div>
  );
}
