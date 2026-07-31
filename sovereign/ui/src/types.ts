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
  /** 'confirmed' = signed but the broadcast went unanswered — the tx MAY be
   *  on the wire; verify the txHash on-chain before quoting again. */
  status: "broadcast" | "failed" | "confirmed";
  txHash: string | null;
  error: string | null;
}

export interface SyncResult {
  accountId: string;
  balanceMinor: string;
  imported: number;
  skipped: number;
}

export type PayLinkIdentityAssurance = "first-contact-key" | "matched-key";

export interface PayLinkRequestProjection {
  kind: "request";
  bundle_id: string;
  request_record_id: string;
  merchant_key_id: string;
  identity_assurance: PayLinkIdentityAssurance;
  rail: string;
  asset_id: string;
  amount_atomic: string;
  destination: string;
  note: string | null;
  issued_at: string;
  expires_at: string;
  usable_until: string;
  signature_valid: true;
  asset_policy_accepted: true;
  no_money_moved: true;
}

export interface PayLinkAcceptanceProjection {
  kind: "acceptance";
  acceptance_id: string;
  pay_link_id: string;
  intent_record_id: string;
  request_record_id: string;
  merchant_key_id: string;
  payer_key_id: string;
  rail: string;
  asset_id: string;
  amount_atomic: string;
  destination: string;
  source_account: string;
  fee_asset_id: string;
  max_fee_atomic: string;
  note: string | null;
  issued_at: string;
  expires_at: string;
  intent_active_at_verification: boolean;
  no_money_moved: true;
  confidentiality: "sensitive-plaintext";
}

export type PayLinkProjection =
  | PayLinkRequestProjection
  | PayLinkAcceptanceProjection;

/**
 * Exact, server-derived review of one locally bound Bitcoin execution.
 * Preparing this review may reserve coins, but it never signs or broadcasts.
 */
export interface PayLinkExecutionReview {
  review_id: string;
  payment_id: string;
  intent_record_id: string;
  request_record_id: string;
  merchant_key_id: string;
  network: "Bitcoin mainnet";
  account_id: string;
  account_label: string;
  source_address: string;
  destination: string;
  asset: "BTC";
  amount_sats: string;
  fee_sats: string;
  total_sats: string;
  max_fee_sats: string;
  quote_expires_at: string;
  intent_expires_at: string;
  confirm_before: string;
  fee_is_exact: true;
  cashloom_fee_sats: "0";
  no_money_moved: true;
  transaction_not_signed: true;
}

export interface PayLinkExecutionResult {
  payment_id: string;
  review_id: string;
  status: "broadcast" | "broadcast_unknown" | "failed";
  tx_hash: string | null;
  error: string | null;
}

export interface PayLinkExecutionSnapshot {
  payment_id: string;
  review_id: string;
  intent_record_id: string;
  status:
    | PayLinkExecutionResult["status"]
    | "awaiting_confirmation"
    | "not_sent";
  can_confirm: boolean;
  tx_hash: string | null;
  error: string | null;
}

// zerone — the truth chain front (public, read-only).
export interface ZeroneNetworkStatus {
  id: string;
  label: string;
  kind: "mainnet" | "testnet";
  reachable: boolean;
  height: string | null;
  catching_up?: boolean | null;
  supply_zrn: number | null;
  hard_cap_zrn: number;
  minted_pct_of_cap?: number;
  rpc: string;
  rest: string;
}
export interface ZeroneStatus {
  mainnet: ZeroneNetworkStatus;
  testnet: ZeroneNetworkStatus;
}
export interface ZeroneNetworkInfo {
  id: string;
  label: string;
  rpc: string;
  rest: string;
  p2pSeed: string;
  what: string;
}
export interface ZeroneGuide {
  what_is_zerone: string;
  honest_status: string;
  for_humans: string[];
  for_agents: string[];
  exit: string;
  onboarding: {
    marketplace: string;
    mainnet_passport_listing: string;
    testnet_passport_listing: string;
    free_guide_listing: string;
    witness_adapter: string;
    witness_reward_zrn: number;
    challenge_window_blocks: number;
  };
  networks: { mainnet: ZeroneNetworkInfo; testnet: ZeroneNetworkInfo };
  links: Record<string, string>;
  denom: { symbol: string; base: string; micro: number; hard_cap_zrn: number };
}
