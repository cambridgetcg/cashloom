/**
 * Exact legacy-account -> Wallet Kernel projection for Base observations.
 *
 * An EVM address never implies a chain or asset. This seam accepts only an
 * explicitly CAIP-qualified Base ETH or native Circle USDC account and makes
 * the two observable Base assets available to the position snapshot store.
 * It does not quote, reserve, authorize, sign, or broadcast anything.
 */

import type { Database } from "bun:sqlite";
import { isAddress } from "viem";
import type { WalletKernelStore } from "./infrastructure/sqlite/index.ts";

export const BASE_CHAIN_ID = "eip155:8453" as const;
export const BASE_ETH_ASSET_ID = `${BASE_CHAIN_ID}/slip44:60` as const;
export const BASE_USDC_ADDRESS =
  "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913" as const;
export const BASE_USDC_ASSET_ID =
  `${BASE_CHAIN_ID}/erc20:${BASE_USDC_ADDRESS}` as const;
export const LOCAL_WALLET_ID = "wallet.local-default" as const;

interface LegacyBaseAccountRow {
  readonly id: string;
  readonly rail: string;
  readonly display_name: string;
  readonly currency: string;
  readonly decimals: number;
  readonly balance_minor: string;
  readonly chain_id: string | null;
  readonly asset_id: string | null;
  readonly account_ref: string | null;
  readonly vault_key_id: string | null;
  readonly status: string;
}

export interface ResolvedBaseAccount {
  readonly id: string;
  readonly label: string;
  readonly address: `0x${string}`;
  readonly accountRef: `${typeof BASE_CHAIN_ID}:0x${string}`;
  readonly legacyAssetId: typeof BASE_ETH_ASSET_ID | typeof BASE_USDC_ASSET_ID;
  readonly legacyBalanceAtomic: string;
  readonly custodyMode: "watch_only" | "local_self_custody";
}

export interface BaseAccountProjectionDependencies {
  readonly db: Database;
  readonly store: WalletKernelStore;
}

interface StableBaseKernelIdentity {
  readonly address: `0x${string}`;
  readonly accountRef: `${typeof BASE_CHAIN_ID}:0x${string}`;
}

/** Preserve an existing semantically identical Base identity byte-for-byte.
 * Early payment projections stored the checksummed vault address while the
 * observer's canonical CAIP form is lowercase. The immutable identity guard
 * should reject a different address, not a harmless casing difference. */
export const stableBaseKernelIdentity = (
  db: Database,
  accountId: string,
  address: string,
  accountRef: string,
): StableBaseKernelIdentity => {
  const canonicalAddress = address.toLowerCase() as `0x${string}`;
  const canonicalAccountRef = accountRef.toLowerCase() as StableBaseKernelIdentity["accountRef"];
  const existing = db.query(
    "SELECT chain_id,account_ref,address FROM wk_accounts WHERE id=?",
  ).get(accountId) as {
    chain_id: string | null;
    account_ref: string | null;
    address: string | null;
  } | null;
  if (
    existing?.chain_id === BASE_CHAIN_ID &&
    existing.address?.toLowerCase() === canonicalAddress &&
    existing.account_ref?.toLowerCase() === canonicalAccountRef
  ) {
    return {
      address: existing.address as `0x${string}`,
      accountRef: existing.account_ref as StableBaseKernelIdentity["accountRef"],
    };
  }
  return { address: canonicalAddress, accountRef: canonicalAccountRef };
};

const canonicalInteger = (value: string): boolean =>
  value === "0" || /^[1-9][0-9]*$/.test(value) || /^-[1-9][0-9]*$/.test(value);

export const resolveBaseAccount = (
  db: Database,
  accountId: string,
): ResolvedBaseAccount => {
  const row = db.query(
    `SELECT id, rail, display_name, currency, decimals, balance_minor,
            chain_id, asset_id, account_ref, vault_key_id, status
     FROM accounts WHERE id=?`,
  ).get(accountId) as LegacyBaseAccountRow | null;
  if (!row || row.status !== "ACTIVE") {
    throw new Error("No active Base account with that id.");
  }
  if (row.rail !== "CRYPTO" || row.chain_id !== BASE_CHAIN_ID) {
    throw new Error("Base position observation requires an explicit eip155:8453 crypto account.");
  }
  const assetId = row.asset_id?.toLowerCase();
  const isEth = assetId === BASE_ETH_ASSET_ID;
  const isUsdc = assetId === BASE_USDC_ASSET_ID;
  if (!isEth && !isUsdc) {
    throw new Error("Base position observation supports only Base ETH and native Circle USDC accounts.");
  }
  const expectedCurrency = isEth ? "ETH" : "USDC";
  const expectedDecimals = isEth ? 18 : 6;
  if (row.currency.trim().toUpperCase() !== expectedCurrency || row.decimals !== expectedDecimals) {
    throw new Error(`The Base account identity does not match its ${expectedCurrency}/${expectedDecimals} asset precision.`);
  }
  const prefix = `${BASE_CHAIN_ID}:`;
  if (!row.account_ref?.startsWith(prefix)) {
    throw new Error("Base position observation requires an explicit CAIP-10 account reference.");
  }
  const address = row.account_ref.slice(prefix.length);
  if (!isAddress(address, { strict: false })) {
    throw new Error("The Base CAIP-10 account contains an invalid EVM address.");
  }
  const normalizedAddress = address.toLowerCase() as `0x${string}`;
  const normalizedAccountRef = `${BASE_CHAIN_ID}:${normalizedAddress}` as
    ResolvedBaseAccount["accountRef"];
  if (!canonicalInteger(row.balance_minor)) {
    throw new Error("The legacy Base balance is not a canonical atomic-unit string.");
  }

  let custodyMode: ResolvedBaseAccount["custodyMode"] = "watch_only";
  if (row.vault_key_id) {
    const key = db.query("SELECT kind, address FROM vault_keys WHERE id=?")
      .get(row.vault_key_id) as { kind: string; address: string | null } | null;
    if (
      !key ||
      key.kind !== "evm" ||
      !key.address ||
      !isAddress(key.address, { strict: false }) ||
      key.address.toLowerCase() !== normalizedAddress
    ) {
      throw new Error("The Base account's local vault key does not match its explicit CAIP-10 address.");
    }
    custodyMode = "local_self_custody";
  }

  return Object.freeze({
    id: row.id,
    label: row.display_name,
    address: normalizedAddress,
    accountRef: normalizedAccountRef,
    legacyAssetId: isEth ? BASE_ETH_ASSET_ID : BASE_USDC_ASSET_ID,
    legacyBalanceAtomic: row.balance_minor,
    custodyMode,
  });
};

/** Mutating projection used only by explicit refresh/payment workflows. */
export const ensureBaseAccountProjection = (
  dependencies: BaseAccountProjectionDependencies,
  accountId: string,
  options: { readonly seedLegacyPosition?: boolean } = {},
): ResolvedBaseAccount => {
  const account = resolveBaseAccount(dependencies.db, accountId);
  const { store } = dependencies;
  store.putWallet({
    id: LOCAL_WALLET_ID,
    label: "Local CashLoom wallet",
    ownerRef: "local-owner",
  });
  store.putAsset({
    id: BASE_ETH_ASSET_ID,
    instrumentId: "ETH",
    kind: "NATIVE",
    symbol: "ETH",
    name: "Ether",
    decimals: 18,
    chainId: BASE_CHAIN_ID,
  });
  store.putAsset({
    id: BASE_USDC_ASSET_ID,
    instrumentId: "USDC",
    kind: "TOKEN",
    symbol: "USDC",
    name: "USD Coin",
    decimals: 6,
    chainId: BASE_CHAIN_ID,
    contractAddress: BASE_USDC_ADDRESS,
  });
  const stableIdentity = stableBaseKernelIdentity(
    dependencies.db,
    account.id,
    account.address,
    account.accountRef,
  );
  store.putAccount({
    id: account.id,
    walletId: LOCAL_WALLET_ID,
    label: account.label,
    kind: "CHAIN_ACCOUNT",
    rail: "evm-base",
    chainId: BASE_CHAIN_ID,
    accountRef: stableIdentity.accountRef,
    address: stableIdentity.address,
    custodyMode: account.custodyMode,
    metadata: {
      legacy_account_id: account.id,
      migration_status: "mapped_exactly",
      observation_assets: [BASE_ETH_ASSET_ID, BASE_USDC_ASSET_ID],
    },
  });
  if (
    options.seedLegacyPosition &&
    !dependencies.db.query(
      "SELECT 1 FROM wk_positions WHERE account_id=? AND asset_id=?",
    ).get(account.id, account.legacyAssetId)
  ) {
    store.setPosition({
      accountId: account.id,
      assetId: account.legacyAssetId,
      observedAtomic: account.legacyBalanceAtomic,
      source: "legacy-account-projection",
    });
  }
  return account;
};
