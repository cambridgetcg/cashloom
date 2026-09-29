import type { AssetCategory, CapitalFlowsSnapshot, FlowObservation, FlowSeries, MetricKind, SeriesDefinition, SourceRetrievalState } from "./types";

export const CATEGORY_LABELS: Record<AssetCategory, string> = {
  sovereignDebt: "Sovereign debt", equities: "Equities", bonds: "Bonds", preciousMetals: "Precious metals",
  crypto: "Crypto", privateEquity: "Private equity", realEstate: "Real estate",
};
export const CATEGORY_LIMITS: Record<AssetCategory, string> = {
  sovereignDebt: "Selected issuer financing and cross-border securities trades, not a worldwide issuer census.",
  equities: "Scoped securities trades and equity-fund shares, not all equity-market flows.",
  bonds: "Scoped securities trades and bond-fund shares; do not add wrappers to underlying assets.",
  preciousMetals: "No verified broad precious-metals investment-flow coverage.",
  crypto: "No verified broad crypto investment-flow coverage. Supply, prices and bridges are not investment flows.",
  privateEquity: "Fund-share transactions, not worldwide deals, commitments or capital calls/distributions.",
  realEstate: "Real-estate fund-share transactions, not direct property-market investment.",
};
export const METRIC_LABELS: Record<MetricKind, string> = {
  issuance: "Issuance", redemptions: "Redemptions", netIssuance: "Net issuance", auctionAllotment: "Auction allotment",
  purchases: "Purchases", sales: "Sales", netAcquisition: "Net acquisition", subscriptions: "Subscriptions",
  fundRedemptions: "Fund redemptions", netSubscriptions: "Net fund-share transactions",
  portfolioTransactions: "Portfolio transactions", turnover: "Turnover",
};
export const RETRIEVAL_LABELS: Record<SourceRetrievalState, string> = {
  empty: "Not retrieved", refreshing: "Retrieval in progress", current: "Retrieved",
  fallback: "Retained after delayed or failed retrieval", unavailable: "Retrieval unavailable", rightsWithheld: "Values withheld — reuse rights",
};
export const GEOGRAPHY_LABELS = { issuer: "Issuer", investor: "Investor", reporting: "Reporting", custodial: "Custodial", fundDomicile: "Fund domicile" } as const;
export type GeographyDimension = keyof typeof GEOGRAPHY_LABELS;
export interface FlowFilters { category: AssetCategory | "all"; measure: MetricKind | "all"; dimension: GeographyDimension; geography: string }
export const DEFAULT_FILTERS: FlowFilters = { category: "all", measure: "all", dimension: "issuer", geography: "all" };
export function filterSeries(series: FlowSeries[], filters: FlowFilters): FlowSeries[] {
  return series.filter(({ definition: d }) => (filters.category === "all" || d.category === filters.category)
    && (filters.measure === "all" || d.metricKind === filters.measure)
    && (filters.geography === "all" || d.geography[filters.dimension]?.code === filters.geography));
}
export function latestObservation(series: FlowSeries): FlowObservation | undefined {
  // Latest period includes missing/withdrawn values: never silently select the last non-null value.
  return [...series.history].sort((a, b) => b.period.end.localeCompare(a.period.end) || b.period.start.localeCompare(a.period.start))[0];
}
export function valueText(observation: FlowObservation): string {
  if (observation.value === null) return ({ missing: "Missing", suppressed: "Suppressed", notYetReported: "Not yet reported", withdrawn: "Withdrawn", observed: "Value unavailable" })[observation.status];
  const [whole, fraction] = observation.value.decimal.split(".");
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  // Native decimal is the publisher amount, NOT currency already multiplied by 10^unitExponent.
  return `${grouped}${fraction === undefined ? "" : `.${fraction}`} ${observation.value.unit}`;
}
export function flagsText(o: FlowObservation): string {
  return [o.status === "notYetReported" ? "not yet reported" : o.status,
    o.provisional && "provisional", o.revised && "revised", o.estimated && "estimated", o.break && "series break",
    `completeness: ${o.completeness}`].filter(Boolean).join(" · ");
}
export function geographyText(d: SeriesDefinition): string {
  return Object.entries(GEOGRAPHY_LABELS).map(([key, label]) => {
    const g = d.geography[key as GeographyDimension];
    return `${label}: ${g ? `${g.label} (${g.code})` : "not specified"}`;
  }).join(" · ");
}
export type FlowSection = "sovereign-financing" | "cross-border-transactions" | "fund-share-transactions";
export function sectionFor(d: SeriesDefinition): FlowSection {
  if (d.geography.fundDomicile) return "fund-share-transactions";
  return ["issuance", "redemptions", "netIssuance", "auctionAllotment"].includes(d.metricKind)
    ? "sovereign-financing" : "cross-border-transactions";
}
export function groupSeries(series: FlowSeries[]): Array<{ key: string; label: string; series: FlowSeries[] }> {
  const groups = new Map<string, { key: string; label: string; series: FlowSeries[] }>();
  for (const s of series) {
    const d = s.definition, fund = d.geography.fundDomicile;
    const dimension = fund ? "Fund domicile" : "Issuer";
    const place = fund ?? d.geography.issuer;
    const label = `${METRIC_LABELS[d.metricKind]} · ${dimension}: ${place?.label ?? "not specified"} · ${d.unit.label} · ${d.valuation}`;
    const key = JSON.stringify([d.metricKind, dimension, place?.code, d.unit, d.valuation]);
    if (!groups.has(key)) groups.set(key, { key, label, series: [] });
    groups.get(key)!.series.push(s);
  }
  return [...groups.values()];
}
export type ReceiptSelection = { seriesId: string; observationId: string };
export function resolveReceipt(snapshot: CapitalFlowsSnapshot | undefined, selection: ReceiptSelection) {
  const series = snapshot?.series.find(s => s.definition.id === selection.seriesId);
  const source = snapshot?.sources.find(s => s.definition.id === series?.definition.sourceId);
  if (!series || !source || source.definition.rights.status !== "allowed" || source.retrievalState === "rightsWithheld") return undefined;
  const observation = series.history.find(o => o.id === selection.observationId);
  if (!observation) return undefined;
  const transport = source.receipts.find(r => r.url === observation.receipt.resourceUrl && r.retrievedAt === observation.receipt.retrievedAt);
  if (!transport) return undefined;
  return { series, source, observation, transport };
}
