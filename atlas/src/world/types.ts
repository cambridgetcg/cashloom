export type WorldRecord = Record<string, unknown>;

export interface WorldSource extends WorldRecord {
  id?: string;
  name?: string;
  title?: string;
  url?: string;
  status?: string;
  cadence?: string;
  license?: string;
  fetched_at?: string;
  updated_at?: string;
  stale?: boolean;
}

export interface WorldFact extends WorldRecord {
  id?: string;
  key?: string;
  name?: string;
  title?: string;
  label?: string;
  symbol?: string;
  code?: string;
  value?: unknown;
  unit?: string;
  change?: unknown;
  status?: string;
  stale?: boolean;
  observed_at?: string;
  published_at?: string;
  fetched_at?: string;
  source?: WorldSource | string;
  source_id?: string;
  fact?: WorldRecord;
}

export interface WorldStatus extends WorldRecord {
  state?: string;
  available_sources?: number;
  total_sources?: number;
  stale_count?: number;
  unavailable?: Array<string | WorldRecord>;
}

export interface WorldResponse extends WorldRecord {
  schema?: string;
  base_currency?: string;
  generated_at?: string;
  status?: WorldStatus;
  briefing?: WorldFact[];
  policy?: WorldFact[];
  sovereigns?: WorldFact[];
  fx?: WorldFact[];
  crypto?: WorldFact[];
  fees?: WorldFact[];
  energy?: WorldFact[];
  calendar?: WorldFact[];
  threads?: WorldFact[];
  sources?: WorldSource[];
}

export type WorldSectionKey =
  | "policy"
  | "sovereigns"
  | "fx"
  | "energy"
  | "crypto"
  | "fees";

export type LoadState = "loading" | "ready" | "error";

export interface WorldDeliveryMeta {
  kind: "saved" | "network" | "revalidated";
  baseCurrency: string;
  receivedAt: number;
  checkedAt?: number;
  etag?: string;
  serverCacheState?: string;
  serverSnapshotAgeSeconds?: number;
}
