import type { FlowObservation, FlowSeries } from "./types";
import { flagsText, valueText, type ReceiptSelection } from "./presentation";

export function PeriodText({ observation: o }: { observation: FlowObservation }) {
  return <><strong>{o.period.label}</strong><span>{o.period.frequency} · {o.period.start} through {o.period.end}</span></>;
}
export function HistoryTable({ series, onReceipt }: { series: FlowSeries; onReceipt: (selection: ReceiptSelection) => void }) {
  const history = [...series.history].sort((a, b) => b.period.end.localeCompare(a.period.end));
  return <details className="capital-history">
    <summary>History — {history.length} reported {history.length === 1 ? "period" : "periods"} · {series.definition.label}</summary>
    <p>Latest-revised publisher history, not a vintage archive. Unlisted periods are gaps, not zero; daily reports need not include non-reporting days. Values retain native units.</p>
    {history.length ? <div className="capital-table-scroll" role="region" aria-label={`History for ${series.definition.label}`} tabIndex={0}>
      <table className="capital-table capital-history-table">
        <caption>{series.definition.label} — {series.definition.unit.label} · {series.definition.valuation}</caption>
        <thead><tr><th scope="col">Reporting period</th><th scope="col">Exact native amount</th><th scope="col">Publisher status &amp; receipt</th></tr></thead>
        <tbody>{history.map(o => <tr key={o.id}>
          <th scope="row"><PeriodText observation={o} /></th>
          <td className="capital-number">{valueText(o)}</td>
          <td><span>{flagsText(o)}</span><span>Publisher status: {o.publisherStatus ?? "not supplied"}; confidentiality: {o.publisherConfidentiality ?? "not supplied"}</span>
            <span>Retrieved: {o.receipt.retrievedAt}</span>
            <button type="button" className="capital-button" onClick={() => onReceipt({ seriesId: series.definition.id, observationId: o.id })} aria-label={`Receipt for ${series.definition.label}, ${o.period.label}`}>Receipt</button>
          </td>
        </tr>)}</tbody>
      </table>
    </div> : <p>No reported history is available. No zero values have been substituted.</p>}
  </details>;
}
