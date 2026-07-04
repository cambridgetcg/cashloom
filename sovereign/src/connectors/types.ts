// The connector seam. One RailConnector per provider ("stripe", "gocardless",
// "alchemy", "esplora", ...) turns that rail's API into the two normalized
// shapes below. Connectors are strictly READ-ONLY — CashLoom observes balances
// and transactions; nothing behind this interface can move money.

// A balance as a connector reports it. balanceMinor is integer MINOR units as
// a decimal STRING (a double cannot hold 18-decimal wei-scale amounts, so
// crypto balances never touch a float); decimals says how to read it (0 JPY,
// 2 GBP, 6 USDC, 18 ETH). Mirrors Account.balanceMinor/decimals exactly so a
// sync is a straight copy, no conversion.
export interface NormalizedBalance {
  balanceMinor: string;
  currency: string;
  decimals: number;
  asOf: Date;
}

// One rail transaction, normalized. externalId is the rail's own stable id
// (Stripe balance-txn id, bank transactionId, on-chain txhash) — dedupe keys
// on {account, externalId}, so it must survive re-syncs unchanged. amountMinor
// is a SIGNED integer minor-unit string: negative = money out. raw is the
// untouched provider payload, kept for reconciliation only — never rendered,
// never logged.
export interface NormalizedTransaction {
  externalId: string;
  title: string;
  amountMinor: string;
  currency: string;
  date: Date;
  raw?: unknown;
}

// Everything a connector needs to address one Account on its rail.
// credentialRef is the NAME of the env var holding the secret (resolve with
// resolveCredentialRef at call time) — NEVER a secret value. Null/absent for
// public rails (chain indexers) that need no credential. externalAccountId is
// the rail's own id for the account (Stripe account id, bank account id,
// on-chain address).
export interface ConnectorContext {
  credentialRef?: string | null;
  externalAccountId: string;
}

// The contract every rail connector implements. type matches
// Account.connectorType, free-form so a new connector needs no schema change.
// Both methods READ — a connector that could initiate movement does not
// belong behind this interface.
export interface RailConnector {
  type: string;
  // Current balance for the account in ctx, in the rail's own minor units.
  fetchBalance(ctx: ConnectorContext): Promise<NormalizedBalance>;
  // Transactions dated on or after `since`. Callers dedupe on externalId, so
  // returning an overlapping window is safe and expected.
  fetchTransactions(
    ctx: ConnectorContext,
    since: Date
  ): Promise<NormalizedTransaction[]>;
}
