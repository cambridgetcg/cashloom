// The rails CashLoom aggregates — mirrors RailEnum on the backend Account model.
export const RAIL_ENUM = {
  STRIPE: "STRIPE",
  BANK: "BANK",
  CRYPTO: "CRYPTO",
  CASH: "CASH",
  PLATFORM_CREDIT: "PLATFORM_CREDIT",
  GIFT_CARD: "GIFT_CARD",
} as const;

export type RailType = (typeof RAIL_ENUM)[keyof typeof RAIL_ENUM];

export const ACCOUNT_STATUS_ENUM = {
  ACTIVE: "ACTIVE",
  ARCHIVED: "ARCHIVED",
} as const;

export type AccountStatusType =
  (typeof ACCOUNT_STATUS_ENUM)[keyof typeof ACCOUNT_STATUS_ENUM];

export interface AccountType {
  _id: string;
  rail: RailType;
  // Which connector populates this account ("stripe", "gocardless", "manual"...).
  // Set => the Sync button applies; unset => purely manual account.
  connectorType?: string | null;
  displayName: string;
  currency: string;
  // Minor-unit scale (2 for GBP/USD, 8 for BTC, 18 for ETH, 6 for USDC).
  decimals: number;
  // Integer minor units as a decimal STRING — wei-safe, never parseFloat this.
  balanceMinor: string;
  balanceAsOf?: string | null;
  externalAccountId?: string | null;
  status: AccountStatusType;
  createdAt: string;
  updatedAt: string;
  id?: string;
}

export interface GetAllAccountsResponse {
  message: string;
  accounts: AccountType[];
}

export interface CreateAccountBody {
  rail: RailType;
  displayName: string;
  currency: string;
  decimals?: number;
  connectorType?: string;
  externalAccountId?: string;
  // A pointer (env var / secret-store name), never a secret value.
  credentialRef?: string;
}

export interface CreateAccountResponse {
  message: string;
  account: AccountType;
}

export interface UpdateAccountPayload {
  id: string;
  account: Partial<CreateAccountBody> & { status?: AccountStatusType };
}

export interface UpdateAccountResponse {
  message: string;
  account: AccountType;
}

export interface SyncAccountResponse {
  message: string;
  result: {
    accountId: string;
    imported: number;
    skipped: number;
    balanceMinor: string;
    balanceAsOf: string | null;
    // Money-correctness warnings ("balance not written: ...", precision
    // skips). Present only when something was withheld — a sync carrying
    // warnings is NOT a clean sync and must not toast as one.
    warnings?: string[];
  };
}

export interface SyncAllResultItem {
  accountId: string;
  displayName: string;
  ok: boolean;
  imported?: number;
  skipped?: number;
  // Per-account money-correctness warnings — same channel as a single sync.
  warnings?: string[];
  // A safe message, never a credential.
  error?: string;
}

export interface SyncAllAccountsResponse {
  message: string;
  results: SyncAllResultItem[];
}
