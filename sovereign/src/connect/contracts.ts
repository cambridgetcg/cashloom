/** Shared read contracts. Monetary values are signed integer minor-unit strings.
 * Connection metadata never contains access tokens or credential values. */
export type ReadStatus = "active" | "reconnect_required" | "disconnected" | "error";
export type RecordStatus = "pending" | "posted" | "removed";
export type ReadEnvironment = "sandbox" | "live" | "local";

export interface ReadConnectionInput {
  id?: string;
  provider: string;
  environment: ReadEnvironment;
  displayName: string;
}
export interface ReadSyncState {
  id: string;
  provider: string;
  environment: ReadEnvironment;
  cursor: string | null;
  revision: number;
  status: ReadStatus;
}
export interface ReadAccountInput {
  /** Only trusted server code may bind an existing local account. */
  accountId?: string;
  externalAccountId: string;
  displayName: string;
  rail: string;
  currency: string;
  decimals: number;
  balanceMinor: string | null;
  availableMinor?: string | null;
  pendingMinor?: string | null;
  heldMinor?: string | null;
  balanceKind?: "current" | "total" | "observed";
  observedAt?: string;
  mask?: string | null;
  accountType?: string | null;
}
export interface ReadTransactionInput {
  externalAccountId: string;
  externalId: string;
  title: string;
  amountMinor: string;
  currency: string;
  date: string;
  status?: "pending" | "posted";
  pendingExternalId?: string | null;
  providerCategory?: string | null;
  grossMinor?: string | null;
  feeMinor?: string | null;
  netMinor?: string | null;
  /** Safe reconciliation payload only, never tokens or provider request objects. */
  raw?: unknown;
}
export interface ReadRemoval { externalAccountId?: string; externalId: string }
export interface ReadSyncBatch {
  connectionId: string;
  expectedRevision: number;
  expectedCursor: string | null;
  nextCursor: string | null;
  observedAt: string;
  /** Legacy readers may identify their test/live mode on the first observation. */
  environment?: ReadEnvironment;
  accounts: ReadAccountInput[];
  transactions: ReadTransactionInput[];
  removed?: ReadRemoval[];
}
export interface ReadSyncResult {
  imported: number;
  updated: number;
  removed: number;
  skipped: number;
  revision: number;
  accounts: Array<{ accountId: string; externalAccountId: string }>;
}
export interface ReadAccountView {
  id: string;
  display_name: string;
  currency: string;
  decimals: number;
  balance_minor: string;
  available_minor: string | null;
  pending_minor: string | null;
  held_minor: string | null;
  balance_as_of: string | null;
  read_observed_at: string | null;
  read_environment: ReadEnvironment;
  balance_kind: string;
  account_mask: string | null;
  account_type: string | null;
  status: string;
}
export interface ReadConnectionView {
  id: string;
  provider: string;
  environment: ReadEnvironment;
  display_name: string;
  status: ReadStatus;
  last_attempt_at: string | null;
  last_success_at: string | null;
  last_error_code: string | null;
  capabilities: { accounts: true; balances: true; transactions: true; payments: false };
  accounts: ReadAccountView[];
}
export interface TransferRecord {
  id: string;
  account_id: string;
  account_name: string;
  title: string;
  amount_minor: string;
  currency: string;
  decimals: number;
  date: string;
  read_environment: ReadEnvironment;
}
export interface TransferCandidate { outgoing: TransferRecord; incoming: TransferRecord; day_gap: number }
export interface TransferLink {
  id: string;
  outgoing_id: string;
  incoming_id: string;
  created_at: string;
  outgoing: TransferRecord;
  incoming: TransferRecord;
}
export interface ImportedRow {
  externalId: string;
  title: string;
  amountMinor: string;
  currency: string;
  date: Date;
  category?: string;
}
