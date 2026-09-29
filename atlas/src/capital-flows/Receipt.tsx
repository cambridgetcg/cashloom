import { useEffect, useRef, type ReactNode } from "react";
import type { CapitalFlowsSnapshot, SourceState, TransportReceipt } from "./types";
import { flagsText, geographyText, METRIC_LABELS, resolveReceipt, RETRIEVAL_LABELS, valueText, type ReceiptSelection } from "./presentation";
import { safeHttpsUrl } from "./validation";

export function SourceLink({ url, children }: { url: string; children: ReactNode }) {
  const href = safeHttpsUrl(url);
  return href ? <a href={href} target="_blank" rel="noopener noreferrer">{children}</a> : <span>{children} — link unavailable</span>;
}
function Metadata({ rows }: { rows: Array<[string, ReactNode]> }) {
  return <dl className="capital-metadata">{rows.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>;
}
function TransportDetails({ receipt: t }: { receipt: TransportReceipt }) {
  return <Metadata rows={[
    ["Retrieved", t.retrievedAt], ["Transport Last-Modified", t.lastModified ?? "Not supplied (not a publication timestamp)"],
    ["Transport ETag", t.etag ?? "Not supplied"], ["Decoded bytes", String(t.decodedBytes)],
    ["Resource", <SourceLink url={t.url}>{t.url}</SourceLink>],
  ]} />;
}
export function SourceDetails({ source: s }: { source: SourceState }) {
  const d = s.definition;
  const ecb = [d.sourceUrl, d.methodologyUrl].some(url => {
    const safe = safeHttpsUrl(url); return safe ? new URL(safe).hostname.endsWith(".ecb.europa.eu") || new URL(safe).hostname === "ecb.europa.eu" : false;
  });
  return <>
    <p className="capital-notice">{d.rights.attribution || "Attribution not supplied."} {d.rights.note}</p>
    {ecb && <p className="capital-notice">ECB source data are available free of charge from the ECB. CashLoom selects and reformats series; any derived amount is identified with its recipe and inputs. This is not an ECB publication or endorsement.</p>}
    <div className="capital-links"><SourceLink url={d.sourceUrl}>Publisher source</SourceLink><SourceLink url={d.methodologyUrl}>Methodology</SourceLink><SourceLink url={d.rights.evidenceUrl}>Reuse terms &amp; evidence</SourceLink></div>
    <Metadata rows={[
      ["Source ID", d.id], ["Retrieval", RETRIEVAL_LABELS[s.retrievalState]], ["Publisher cadence", d.cadence],
      ["Rights", d.rights.status], ["Rights checked", d.rights.checkedAt ?? "Unknown"],
      ["Last attempt", s.lastAttemptAt ?? "Not attempted"], ["Last successful validation", s.lastSuccessAt ?? "No source loaded"],
      ["Next permitted attempt", s.nextAttemptAt ?? "Not scheduled"], ["Fallback expires", s.fallbackExpiresAt ?? "No retained fallback"],
      ["Retrieval failure", s.failure ?? "None reported"],
    ]} />
    {d.limitations.length > 0 && <ul className="capital-limits">{d.limitations.map((limit, i) => <li key={i}>{limit}</li>)}</ul>}
    <details className="capital-source-transports"><summary>Actual transport receipts ({s.receipts.length})</summary>
      {s.receipts.length ? s.receipts.map((t, i) => <TransportDetails key={`${t.url}:${i}`} receipt={t} />) : <p>No transport receipt is available.</p>}
    </details>
  </>;
}
export function ReceiptContent({ snapshot, selection }: { snapshot?: CapitalFlowsSnapshot; selection: ReceiptSelection }) {
  const current = resolveReceipt(snapshot, selection);
  if (!current) return <p role="status">This observation or its reuse permission is no longer available in the current snapshot. No previous value is retained in this receipt.</p>;
  const { series, source, observation: o, transport } = current;
  const d = series.definition;
  return <>
    <h3>{d.label}</h3>
    <p className="capital-receipt-value">{valueText(o)}</p>
    <p>{o.period.label} · {o.period.frequency} · {o.period.start} through {o.period.end}</p>
    <p>{flagsText(o)}</p>
    <Metadata rows={[
      ["Observation ID", o.id], ["Series / dataset", `${d.sourceSeriesId} / ${d.datasetId}`],
      ["Measure", METRIC_LABELS[d.metricKind]], ["Native units", `${d.unit.label}; currency ${d.unit.currency}; exponent ${d.unit.exponent}`],
      ["Exact native decimal", o.value?.decimal ?? "No value"], ["Publisher lexeme", o.value?.publisherLexeme ?? "No value"],
      ["Exact integer / decimal scale", o.value ? `${o.value.raw} / ${o.value.decimals}` : "No value"],
      ["Publisher unit multiplier", o.value?.unitMultiplier ?? `10^${d.unit.exponent}`],
      ["Scale meaning", "The native decimal is the publisher amount. The multiplier is not already applied; millions are not unscaled currency."],
      ["Perspective", d.perspective], ["Sign convention", d.signConvention], ["Geography dimensions", geographyText(d)],
      ["Instrument / sector", `${d.instrument} / ${d.sector}`], ["Fund mandate", d.fundMandate ?? "Not applicable / not supplied"],
      ["Valuation basis", d.valuation], ["Seasonal adjustment", d.seasonalAdjustment], ["Annualization", d.annualization],
      ["Reporting recency", "Expectation unknown — retrieval does not establish whether a release is overdue"],
      ["Publisher status", o.publisherStatus ?? "Not supplied"], ["Publisher confidentiality", o.publisherConfidentiality ?? "Not supplied"],
      ["Publication time", o.receipt.publicationAt ?? "Unknown — not supplied by publisher"],
      ["Observation retrieved", o.receipt.retrievedAt], ["Receipt method", o.receipt.method === "publisherReported" ? "Publisher reported" : "Derived from compatible components"],
      ["Recipe / modifications", o.receipt.recipe],
    ]} />
    <div className="capital-links"><SourceLink url={d.sourceUrl}>Series source</SourceLink><SourceLink url={d.methodologyUrl}>Series methodology</SourceLink></div>
    <h3>Derivation inputs</h3>
    {o.receipt.inputObservationIds.length ? <ul className="capital-limits">{o.receipt.inputObservationIds.map(id => {
      // Resolve every input against this same snapshot, not a captured observation or new transport.
      const inputSeries = snapshot?.series.find(s => s.history.some(item => item.id === id));
      const input = inputSeries && resolveReceipt(snapshot, { seriesId: inputSeries.definition.id, observationId: id });
      return <li key={id}>{input ? <>{input.series.definition.label} — {valueText(input.observation)}; {input.observation.period.label}; retrieved {input.observation.receipt.retrievedAt}; ID {id}</> : <>Input {id} is no longer available.</>}</li>;
    })}</ul> : <p>No derived inputs. This is a publisher-reported observation.</p>}
    <h3>Observation transport</h3><TransportDetails receipt={transport} />
    <p>Last-Modified above is a transport fact, never a substitute for publication time.</p>
    <h3>Publisher &amp; reuse rights</h3><SourceDetails source={source} />
    <h3>Limits</h3><ul className="capital-limits">{[...d.limitations, ...o.receipt.limitations].map((limit, i) => <li key={i}>{limit}</li>)}</ul>
  </>;
}
export function CapitalReceipt({ snapshot, selection, onClose, deliveryWarning }: { snapshot?: CapitalFlowsSnapshot; selection: ReceiptSelection; onClose: () => void; deliveryWarning?: string }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const close = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const node = dialog.current;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    node?.showModal();
    close.current?.focus();
    return () => {
      node?.close();
      document.body.style.overflow = overflow;
      if (previous?.isConnected) previous.focus();
      else document.getElementById("capital-title")?.focus();
    };
  }, []);
  return <dialog className="capital-receipt" ref={dialog} aria-labelledby="capital-receipt-title" aria-modal="true" onCancel={event => { event.preventDefault(); onClose(); }} onClose={() => { if (!dialog.current?.open) onClose(); }}>
    <header><div><p className="capital-kicker">Source receipt</p><h2 id="capital-receipt-title">Reported amount &amp; provenance</h2></div>
      <button type="button" className="capital-button" ref={close} onClick={onClose}>Close receipt</button>
    </header>
    {deliveryWarning && <p role="status" className="capital-notice">{deliveryWarning} This receipt belongs to the last trusted snapshot, not a newly validated response.</p>}
    <ReceiptContent snapshot={snapshot} selection={selection} />
    <p className="capital-notice">Receipts document reported amounts and their limits. They are not investment advice.</p>
  </dialog>;
}
