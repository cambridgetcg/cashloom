export type OnchainRecord = Record<string, unknown>;

export interface ExactValue extends OnchainRecord {
  raw: string;
  decimal: string;
  decimals: number;
  unit: string;
  display: string;
}

export interface MetricReceipt extends OnchainRecord {
  id?: string;
  method?: string;
  proof_state?: string;
  pinning?: string;
  observed_at?: string | null;
  fetched_at?: string;
  reference_block?: OnchainRecord;
  source_ids?: string[];
  contract_address?: string;
  method_or_event?: string;
  formula?: string;
  inputs?: string[];
  limitations?: string[];
}

export interface OnchainMetric extends OnchainRecord {
  id?: string;
  label?: string;
  value?: ExactValue;
  status?: string;
  receipt?: MetricReceipt;
}

export interface OnchainSource extends OnchainRecord {
  id?: string;
  name?: string;
  title?: string;
  url?: string;
  status?: string;
  fetched_at?: string;
  retrieval?: "live_fetch" | "verified_transcription";
  verified_at?: string;
  stale?: boolean;
}

export interface OnchainStatus extends OnchainRecord {
  state?: string;
  complete?: boolean;
  available_sources?: number;
  total_sources?: number;
  stale_count?: number;
  unavailable?: Array<string | OnchainRecord>;
  sections?: Record<string, unknown>;
}

/**
 * The public snapshot keeps section rows deliberately open to extension while
 * the document envelope is versioned and validated at the network boundary.
 * Monetary, rate, balance, height, and other chain quantities are expected to
 * arrive as exact decimal strings inside these records.
 */
export interface OnchainSnapshot extends OnchainRecord {
  "@type"?: "OnchainSnapshot";
  schema: "cashloom.onchain/1";
  generated_at?: string;
  request?: OnchainRecord;
  status?: OnchainStatus;
  scope?: string;
  briefing: OnchainRecord[];
  chains: OnchainRecord[];
  stablecoins: OnchainRecord[];
  lending_markets: OnchainRecord[];
  pools: OnchainRecord[];
  bridge_routes: OnchainRecord[];
  threads: OnchainRecord[];
  sources: OnchainSource[];
}

export type OnchainLoadState = "loading" | "ready" | "error";

export type OnchainDeliveryKind = "saved" | "network" | "revalidated";

export interface OnchainDeliveryMeta {
  kind: OnchainDeliveryKind;
  /** Time this exact response body was received by this browser. */
  receivedAt: number;
  /** Time a conditional request last confirmed that the body was unchanged. */
  checkedAt?: number;
  etag?: string;
  serverCacheState?: string;
  serverSnapshotAgeSeconds?: number;
}

export interface ReceiptSelection {
  item: OnchainRecord;
  kind: string;
}
