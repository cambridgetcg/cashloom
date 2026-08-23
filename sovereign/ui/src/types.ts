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

/** Wallet Kernel v2 chain/account/asset identities. */
export type Caip2ChainId = `${string}:${string}`;
export type Caip10AccountId = `${Caip2ChainId}:${string}`;
export type Caip19AssetId = `${Caip2ChainId}/${string}:${string}`;

export type VaultKeyKind = "evm" | "btc";

export type LiveCryptoAsset = "BASE_ETH" | "BASE_USDC" | "BITCOIN_BTC";

export interface LiveCryptoIdentity {
  label: string;
  networkLabel: string;
  currency: "ETH" | "USDC" | "BTC";
  decimals: 18 | 6 | 8;
  keyKind: VaultKeyKind;
  chain_id: Caip2ChainId;
  asset_id: Caip19AssetId;
}

/**
 * The only crypto positions the local node can currently sign and broadcast.
 * Keep these exact: choosing an EVM address alone must never imply a chain.
 */
export const LIVE_CRYPTO_IDENTITIES = {
  BASE_ETH: {
    label: "Ether on Base",
    networkLabel: "Base",
    currency: "ETH",
    decimals: 18,
    keyKind: "evm",
    chain_id: "eip155:8453",
    asset_id: "eip155:8453/slip44:60",
  },
  BASE_USDC: {
    label: "USD Coin on Base",
    networkLabel: "Base",
    currency: "USDC",
    decimals: 6,
    keyKind: "evm",
    chain_id: "eip155:8453",
    asset_id:
      "eip155:8453/erc20:0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
  },
  BITCOIN_BTC: {
    label: "Bitcoin on mainnet",
    networkLabel: "Bitcoin",
    currency: "BTC",
    decimals: 8,
    keyKind: "btc",
    chain_id: "bip122:000000000019d6689c085ae165831e93",
    asset_id: "bip122:000000000019d6689c085ae165831e93/slip44:0",
  },
} as const satisfies Record<LiveCryptoAsset, LiveCryptoIdentity>;

export interface VaultKey {
  id: string;
  label: string;
  kind: VaultKeyKind | (string & {});
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
  chain_id: Caip2ChainId | null;
  asset_id: Caip19AssetId | null;
  account_ref: Caip10AccountId | null;
  credential_ref: string | null;
  vault_key_id: string | null;
  status: string;
  created_at: string;
}

interface CreateAccountCommon {
  display_name: string;
  currency: string;
  decimals: number;
  connector_type?: string;
  external_account_id?: string;
  credential_ref?: string;
  vault_key_id?: string;
}

export type CreateAccountInput =
  | (CreateAccountCommon & {
      rail: "CRYPTO";
      chain_id: Caip2ChainId;
      asset_id: Caip19AssetId;
      account_ref: Caip10AccountId;
    })
  | (CreateAccountCommon & {
      rail: Exclude<Rail, "CRYPTO">;
      chain_id?: never;
      asset_id?: never;
      account_ref?: never;
    });

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
  /** Present for Base, whose protocol fee has one hard-capped transaction
   * term plus block-pinned terms that can still change before inclusion. */
  feeTerms?: QuoteFeeTerms;
}

export type QuoteFeeComponentKind =
  | "l2_execution"
  | "l1_data_security"
  | "operator";

export interface QuoteFeeComponent {
  kind: QuoteFeeComponentKind;
  amount_atomic: string;
  classification: "hard_cap" | "estimated_upper_bound";
  method: string;
  source_block?: string;
}

export interface QuoteFeeTerms {
  schema_version: "cashloom.payment-fee-terms/1";
  hard_execution_cap_atomic: string;
  estimated_l1_upper_bound_atomic: string;
  estimated_operator_upper_bound_atomic: string;
  estimated_total_atomic: string;
  total_is_hard_cap: false;
  components: readonly QuoteFeeComponent[];
}

export interface ConfirmResult {
  paymentId: string;
  /** 'confirmed' = signed but the broadcast went unanswered — the tx MAY be
   *  on the wire; verify the txHash on-chain before quoting again. */
  status: "broadcast" | "failed" | "confirmed";
  txHash: string | null;
  error: string | null;
}

/**
 * Additive chain-truth projection for an outbound payment. Every quantity that
 * can exceed JavaScript's safe integer range stays a decimal string. Fields
 * are optional so an older local node can still hydrate the activity screen.
 */
export type PaymentTruthVisibility =
  | "not_checked"
  | "not_found"
  | "mempool"
  | "included"
  | (string & {});

export type PaymentTruthResult = "success" | "reverted" | (string & {});
export type PaymentTruthSecurity =
  | "unsafe"
  | "safe"
  | "finalized"
  | (string & {});
export type PaymentTruthCanonicality =
  | "unknown"
  | "canonical"
  | "reorged"
  | "conflicted"
  | (string & {});

export interface PaymentTruthFee {
  asset?: string | null;
  asset_id?: string | null;
  decimals?: number | null;
  l2_execution_atomic?: string | null;
  l1_data_security_atomic?: string | null;
  operator_atomic?: string | null;
  total_atomic?: string | null;
  completeness?: "unknown" | "estimated" | "exact" | (string & {});
  budget_atomic?: string | null;
  budget_exceeded?: boolean | null;
}

export interface PaymentTruth {
  schema_version?: "cashloom.payment-truth/1" | (string & {});
  intent_id?: string;
  lifecycle_state?: string | null;
  legacy_status?: string | null;
  rail?: string | null;
  chain_id?: Caip2ChainId | (string & {}) | null;
  network_tx_id?: string | null;
  visibility?: PaymentTruthVisibility | null;
  execution_result?: PaymentTruthResult | null;
  canonicality?: PaymentTruthCanonicality | null;
  security_level?: PaymentTruthSecurity | null;
  block?: {
    number?: string | null;
    hash?: string | null;
  } | null;
  fee?: PaymentTruthFee | null;
  checked_at?: string | null;
  observed_at?: string | null;
  evidence?: {
    receipt_id?: string | null;
    evidence_hash?: string | null;
    provider_ids?: string[];
    quorum?: string | number | null;
  } | null;
  actions?: {
    reconcile?: boolean;
    exact_rebroadcast?: boolean;
    safe_to_create_new_payment?: boolean;
  };
}

export interface PaymentListItem {
  id: string;
  account_id: string;
  rail: string;
  to_addr: string;
  asset: string;
  amount_minor: string;
  fee_minor: string | null;
  status: string;
  tx_hash: string | null;
  error: string | null;
  created_at: string;
  intent_hash?: string | null;
  intent_state?: string | null;
  truth?: PaymentTruth | null;
}

export interface PaymentReconcileResult {
  truth: PaymentTruth;
  check?: {
    state?: "pending" | "partial" | "settled" | (string & {});
    checked_at?: string;
    available_providers?: string;
    unavailable_providers?: string;
  };
}

/** Human/agent audit response. Evidence arrays deliberately remain open: the
 * activity screen only consumes the stable `truth` projection, while callers
 * can inspect every append-only record without the UI narrowing it. */
export interface WalletIntentAudit extends Record<string, unknown> {
  truth?: PaymentTruth | null;
  receipts?: readonly Record<string, unknown>[];
  chain_sightings?: readonly Record<string, unknown>[];
  chain_consensus?: readonly Record<string, unknown>[];
  journals?: readonly Record<string, unknown>[];
  reconciliation_links?: readonly Record<string, unknown>[];
}

export interface SyncResult {
  accountId: string;
  balanceMinor: string;
  imported: number;
  skipped: number;
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
