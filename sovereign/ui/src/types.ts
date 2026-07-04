export interface Meta {
  name: string;
  mode: string;
  version: string;
  initialized: boolean;
  unlocked: boolean;
  db: string;
}

export type Rail =
  | "STRIPE"
  | "BANK"
  | "CRYPTO"
  | "CASH"
  | "PLATFORM_CREDIT"
  | "GIFT_CARD";

export const RAILS: Rail[] = [
  "CASH",
  "BANK",
  "CRYPTO",
  "STRIPE",
  "PLATFORM_CREDIT",
  "GIFT_CARD",
];

export interface VaultKey {
  id: string;
  label: string;
  kind: string;
  address: string;
  created_at: string;
}

export interface Account {
  id: string;
  rail: Rail;
  connector_type: string | null;
  display_name: string;
  currency: string;
  decimals: number;
  balance_minor: string;
  balance_as_of: string | null;
  external_account_id: string | null;
  credential_ref: string | null;
  vault_key_id: string | null;
  status: string;
  created_at: string;
}

export interface Tx {
  id: string;
  account_id: string;
  external_id: string | null;
  title: string;
  /** SIGNED minor-unit integer string */
  amount_minor: string;
  category: string | null;
  date: string;
  source: string;
  created_at: string;
}

export interface SummaryRow {
  id: string;
  display_name: string;
  currency: string;
  decimals: number;
  balance_minor: string;
  in_minor: string;
  out_minor: string;
  tx_count: number;
}

export interface Quote {
  paymentId: string;
  feeMinor: string;
  feeAsset: string;
  summary: string;
  expiresAt: string;
}

export interface ConfirmResult {
  paymentId: string;
  status: "broadcast" | "failed";
  txHash: string | null;
  error: string | null;
}

export interface SyncResult {
  accountId: string;
  balanceMinor: string;
  imported: number;
  skipped: number;
}
