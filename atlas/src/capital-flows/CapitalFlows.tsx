import { useCallback, useEffect, useRef, useState } from "react";
import { PublicHeader } from "../components/PublicHeader";
import { CapitalFlowsApiError, readCapitalFlowsWindow, type CapitalFlowsMemory } from "./api";
import type { AssetCategory, CapitalFlowsSnapshot, FlowSeries, MetricKind } from "./types";
import { CATEGORY_LABELS, CATEGORY_LIMITS, DEFAULT_FILTERS, filterSeries, flagsText, GEOGRAPHY_LABELS, geographyText, groupSeries, latestObservation, METRIC_LABELS, RETRIEVAL_LABELS, sectionFor, valueText, type FlowFilters, type FlowSection, type GeographyDimension, type ReceiptSelection } from "./presentation";
import { HistoryTable, PeriodText } from "./History";
import { CapitalReceipt, SourceDetails } from "./Receipt";
import "./capital-flows.css";

const SECTIONS: Array<{ id: FlowSection; title: string; note: string }> = [
  { id: "sovereign-financing", title: "Sovereign financing", note: "US financing is reported on a cash basis. Spain and Germany issuance and redemptions are face-value amounts, not cash proceeds. These are not like-for-like cash flows; no currency conversion or combined total is made. Positive redemptions are a magnitude, not an inflow." },
  { id: "cross-border-transactions", title: "Cross-border transactions", note: "TIC measures selected US long-term securities transactions with foreign residents. It includes primary issuance/redemptions AND secondary trades, not pure secondary-market turnover. Foreign purchases and sales follow the stated perspective; reporting or custodial geography does not establish the ultimate owner's location." },
  { id: "fund-share-transactions", title: "Fund-share transactions", note: "Euro-area domiciled funds, grouped by investment policy. These are transactions in fund shares/units, not the funds' underlying asset purchases and not cash-only subscriptions. Fund domicile is not investor residence or investment destination. Real-estate and private-equity fund shares are narrower than direct property investment or global private-equity calls/distributions." },
];
function Filters({ series, filters, onChange }: { series: FlowSeries[]; filters: FlowFilters; onChange: (filters: FlowFilters) => void }) {
  const measures = [...new Set(series.map(s => s.definition.metricKind))];
  const geographies = [...new Map(series.flatMap(s => {
    const g = s.definition.geography[filters.dimension]; return g ? [[g.code, g] as const] : [];
  })).values()].sort((a, b) => a.label.localeCompare(b.label));
  return <fieldset className="capital-filters" aria-describedby="capital-filter-help">
    <legend>Explore selected reports</legend>
    <label>Asset / instrument category<select value={filters.category} onChange={e => onChange({ ...filters, category: e.target.value as AssetCategory | "all" })}>
      <option value="all">All asset categories</option>{Object.entries(CATEGORY_LABELS).map(([key, label]) => <option key={key} value={key}>{label}</option>)}
    </select></label>
    <label>Reported measure<select value={filters.measure} onChange={e => onChange({ ...filters, measure: e.target.value as MetricKind | "all" })}>
      <option value="all">All measures</option>{measures.map(key => <option key={key} value={key}>{METRIC_LABELS[key]}</option>)}
    </select></label>
    <label>Geography dimension<select value={filters.dimension} onChange={e => onChange({ ...filters, dimension: e.target.value as GeographyDimension, geography: "all" })}>
      {Object.entries(GEOGRAPHY_LABELS).map(([key, label]) => <option key={key} value={key}>{label}</option>)}
    </select></label>
    <label>{GEOGRAPHY_LABELS[filters.dimension]} geography<select value={filters.geography} onChange={e => onChange({ ...filters, geography: e.target.value })}>
      <option value="all">All / not specified</option>{geographies.map(g => <option key={g.code} value={g.code}>{g.label} ({g.code})</option>)}
    </select></label>
    <p id="capital-filter-help">Filters apply only to the report tables, not coverage disclosures. Local to this page; no account, saved preferences or currency conversion.</p>
    <button type="button" className="capital-button" onClick={() => onChange(DEFAULT_FILTERS)}>Reset filters</button>
  </fieldset>;
}
export function FlowTables({ series, snapshot, onReceipt }: { series: FlowSeries[]; snapshot?: CapitalFlowsSnapshot; onReceipt: (selection: ReceiptSelection) => void }) {
  return <>{SECTIONS.map(section => {
    const selected = series.filter(s => sectionFor(s.definition) === section.id);
    return <section className="capital-section" id={section.id} key={section.id} aria-labelledby={`${section.id}-title`}>
      <header><p className="capital-kicker">Selected publisher reports</p><h2 id={`${section.id}-title`}>{section.title}</h2><p>{section.note}</p></header>
      {!selected.length && <p className="capital-empty">{snapshot ? "No registered series match these filters in this section." : "No source reports loaded yet."} This is not a reported zero.</p>}
      {groupSeries(selected).map(group => <div className="capital-table-scroll" role="region" aria-label={group.label} tabIndex={0} key={group.key}>
        <table className="capital-table">
          <caption>{group.label}</caption>
          <thead><tr><th scope="col">Measure &amp; scope</th><th scope="col">Latest reporting period / native amount</th><th scope="col">Basis &amp; direction</th><th scope="col">Retrieval &amp; reporting status</th></tr></thead>
          {group.series.map(s => {
            const d = s.definition, o = latestObservation(s);
            const source = snapshot?.sources.find(source => source.definition.id === d.sourceId);
            return <tbody key={d.id}>
              <tr>
                <th scope="row"><strong>{d.label}</strong><span>{METRIC_LABELS[d.metricKind]} · {CATEGORY_LABELS[d.category]}</span><span>{geographyText(d)}</span><span>{source?.definition.name ?? d.sourceId}</span></th>
                <td>{o ? <><PeriodText observation={o} /><strong className="capital-number">{valueText(o)}</strong></> : <><strong>No observation</strong><span>Reporting period unavailable · {d.frequency}</span><span>Native unit: {d.unit.label}</span></>}
                  {o && <button className="capital-button" type="button" onClick={() => onReceipt({ seriesId: d.id, observationId: o.id })} aria-label={`Latest receipt for ${d.label}, ${o.period.label}`}>Receipt</button>}
                </td>
                <td><strong>{d.valuation}</strong><span>{d.perspective}</span><span>{d.signConvention}</span><span>Adjustment: {d.seasonalAdjustment === "unadjusted" ? "not seasonally adjusted" : d.seasonalAdjustment === "seasonallyAdjusted" ? "seasonally adjusted" : "unknown"}</span><span>{d.annualization === "notAnnualized" ? "Not annualized" : d.annualization === "annualizedRate" ? "Annualized rate" : "Annualization unknown"}</span></td>
                <td><strong className="capital-state">{RETRIEVAL_LABELS[s.state]}</strong><span>Reporting recency: expectation unknown</span>{o && <><span>{flagsText(o)}</span><span>Observation retrieved: {o.receipt.retrievedAt}</span></>}
                  {!o && <span>No value substituted</span>}
                  {source?.failure && <span>Source retrieval failure: {source.failure}. Original observation timestamps retained.</span>}
                </td>
              </tr>
              <tr className="capital-history-row"><td colSpan={4}><HistoryTable series={s} onReceipt={onReceipt} /></td></tr>
            </tbody>;
          })}
        </table>
      </div>)}
    </section>;
  })}</>;
}
function Coverage({ snapshot }: { snapshot?: CapitalFlowsSnapshot }) {
  return <section className="capital-section" id="sources-coverage" aria-labelledby="capital-coverage-title">
    <header><p className="capital-kicker">Receipts before confidence</p><h2 id="capital-coverage-title">Sources / coverage</h2><p>All seven requested categories remain visible, regardless of the table filters. Selected coverage is not a global money-flow total.</p></header>
    <div className="capital-table-scroll" role="region" aria-label="All requested asset categories" tabIndex={0}><table className="capital-table capital-coverage-table">
      <caption>Asset coverage — never inferred from prices, holdings or token supply</caption>
      <thead><tr><th scope="col">Category</th><th scope="col">Available scope</th></tr></thead>
      <tbody>{Object.entries(CATEGORY_LABELS).map(([key, label]) => {
        const c = snapshot?.coverage.find(c => c.dimension === "assetCategory" && c.id === key);
        return <tr key={key}><th scope="row">{label}</th><td><strong>{c?.state === "scopedData" ? "Scoped reported data" : snapshot ? "Coverage gap — no available amount" : "Coverage not loaded"}</strong><span>{CATEGORY_LIMITS[key as AssetCategory]}</span>{c && <span>{c.limitation}</span>}{key === "crypto" && <a href="/onchain">Onchain — latest-state context, NOT investment flows</a>}</td></tr>;
      })}</tbody>
    </table></div>
    <aside className="capital-notice" aria-label="Uncovered markets">
      <h3>Important gaps, not silently dropped</h3>
      <p>Japanese government bonds (JGBs), UK and China sovereign issuer markets, and broader BIS issuer coverage are not covered here. Neither are comprehensive global transaction volumes, direct property transactions or worldwide private-equity capital calls/distributions. Precious-metals and crypto investment flows remain explicit gaps.</p>
    </aside>
    {snapshot && <ul className="capital-limits">{snapshot.coverage.filter(c => c.dimension !== "assetCategory").map(c => <li key={`${c.dimension}:${c.id}`}><strong>{c.label}</strong> · {c.dimension === "issuerMarket" ? "Issuer market" : "Market scope"} · {c.state === "scopedData" ? "Scoped data" : "Unavailable"}. {c.limitation}</li>)}</ul>}
    {snapshot?.sources.length ? <div className="capital-sources">{snapshot.sources.map(s => <article key={s.definition.id}>
      <h3>{s.definition.name}</h3><p>{RETRIEVAL_LABELS[s.retrievalState]}</p><SourceDetails source={s} />
    </article>)}</div> : <p className="capital-empty">No sources loaded. Publisher amounts, publication times and retrieval receipts are unavailable, not zero.</p>}
    {snapshot && <ul className="capital-limits">{snapshot.limitations.map((limit, i) => <li key={i}>{limit}</li>)}</ul>}
    <p className="capital-notice">“Retrieved” means the source was retrieved, not that its reporting period is current. Publication expectations remain unknown. Publication times may be unknown; transport Last-Modified is a separate fact. Backend launch readiness is not assessed, not a marketing status.</p>
  </section>;
}
export interface CapitalFlowsViewProps {
  snapshot?: CapitalFlowsSnapshot; busy?: boolean; error?: string; checksStopped?: boolean; feedUnavailable?: boolean;
  onRefresh?: () => void; initialFilters?: FlowFilters;
}
/** Presentational export supports synthetic SSR tests without starting network work. */
export function CapitalFlowsView({ snapshot, busy = false, error, checksStopped = false, feedUnavailable = false, onRefresh, initialFilters = DEFAULT_FILTERS }: CapitalFlowsViewProps) {
  const [filters, setFilters] = useState(initialFilters);
  const [selection, setSelection] = useState<ReceiptSelection>();
  const closeReceipt = useCallback(() => setSelection(undefined), []);
  const visible = filterSeries(snapshot?.series ?? [], filters);
  return <div className="capital-shell">
    <a className="skip-link" href="#capital-title">Skip to capital-flow reports</a>
    <PublicHeader current="capital-flows" />
    <main className="capital-main">
      <header className="capital-hero"><p className="capital-kicker">The reported movement of capital</p><h1 id="capital-title" tabIndex={-1}>Capital flows</h1>
        <p className="capital-lede">See how selected governments raise money and how reported investment flows change over time. Delayed, selected coverage—not a global money-flow total.</p>
        <p>Native amounts, explicit perspectives, and a receipt for every observation. Read-only. No account or wallet required.</p>
        <div className="capital-links">{SECTIONS.map(s => <a href={`#${s.id}`} key={s.id}>{s.title}</a>)}<a href="#sources-coverage">Sources / coverage</a></div>
      </header>
      <div className="capital-delivery">
        <div role="status" aria-live="polite"><strong>{busy ? snapshot ? "Checking reported data…" : "Loading reported data…" : error ? snapshot ? "Last trusted snapshot — update unavailable" : "Source reports unavailable" : snapshot?.refresh.health === "empty" ? "No source reports loaded" : snapshot ? `Source retrieval: ${snapshot.refresh.health}` : "No source reports loaded"}</strong>
          <p>{snapshot ? `Snapshot assembled ${snapshot.generatedAt}. This is not a publication time.` : "No financial values have been substituted."}</p>
          {checksStopped && <p>Automatic completion checks have stopped. Sources may still be finishing; this page will not poll indefinitely.</p>}
        </div>
        {!feedUnavailable && <button className="capital-button" type="button" onClick={onRefresh} disabled={busy}>{busy ? "Checking…" : "Refresh reports"}</button>}
        <p className="capital-refresh-help">{feedUnavailable ? "Further checks have stopped. Reports need this feed to be enabled on the server." : "One read, then at most four completion checks within 30 seconds while the server refreshes. Refresh respects publisher cadence and backend retry limits; it does not force an upstream fetch."}</p>
      </div>
      {error && <p className="capital-notice" role="alert">{error} {snapshot ? "The last trusted snapshot remains visible with its original observations and timestamps; it has not been newly validated." : "No source amounts are available."}{feedUnavailable && <> <a href="/world">Explore available money insights →</a></>}</p>}
      <Filters series={snapshot?.series ?? []} filters={filters} onChange={setFilters} />
      <p className="capital-filter-result" role="status">{visible.length} registered series match the filters. Coverage disclosures remain unfiltered.</p>
      <FlowTables series={visible} snapshot={snapshot} onReceipt={setSelection} />
      <Coverage snapshot={snapshot} />
    </main>
    <footer className="capital-footer"><p>CashLoom · reported observations with receipts, not advice.</p><a href="/world">Back to money insights</a></footer>
    {selection && <CapitalReceipt snapshot={snapshot} selection={selection} onClose={closeReceipt} deliveryWarning={error} />}
  </div>;
}
export function CapitalFlowsPage() {
  const memory = useRef<CapitalFlowsMemory>();
  const [snapshot, setSnapshot] = useState<CapitalFlowsSnapshot>();
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState<string>();
  const [checksStopped, setChecksStopped] = useState(false);
  const [feedUnavailable, setFeedUnavailable] = useState(false);
  const [refreshToken, setRefreshToken] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setBusy(true); setError(undefined); setChecksStopped(false); setFeedUnavailable(false);
    // A microtask lets StrictMode's rehearsal cleanup stop before its first network request.
    void Promise.resolve().then(() => {
      if (controller.signal.aborted) return;
      return readCapitalFlowsWindow({ signal: controller.signal, cached: memory.current, onSnapshot: result => {
        if (controller.signal.aborted) return;
        memory.current = result; setSnapshot(result.snapshot);
      } });
    }).then(result => {
      if (!controller.signal.aborted && result) setChecksStopped(result.checksStopped);
    }).catch(error => {
      if (!controller.signal.aborted) {
        setError(error instanceof Error ? error.message : "The capital-flows response could not be read.");
        setFeedUnavailable(error instanceof CapitalFlowsApiError && error.status === 404);
      }
    }).finally(() => { if (!controller.signal.aborted) setBusy(false); });
    return () => controller.abort();
  }, [refreshToken]);
  return <CapitalFlowsView snapshot={snapshot} busy={busy} error={error} checksStopped={checksStopped} feedUnavailable={feedUnavailable} onRefresh={() => setRefreshToken(token => token + 1)} />;
}
export default CapitalFlowsPage;
