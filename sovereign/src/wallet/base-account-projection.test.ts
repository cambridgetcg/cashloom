import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { getAddress } from "viem";
import { installWalletKernelSchema } from "./infrastructure/sqlite/schema.ts";
import { WalletKernelStore } from "./infrastructure/sqlite/store.ts";
import {
  BASE_CHAIN_ID,
  BASE_ETH_ASSET_ID,
  BASE_USDC_ASSET_ID,
  ensureBaseAccountProjection,
  resolveBaseAccount,
  stableBaseKernelIdentity,
} from "./base-account-projection.ts";

const ADDRESS = `0x${"1".repeat(40)}`;

const databases: Database[] = [];
afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

const fixture = () => {
  const database = new Database(":memory:");
  databases.push(database);
  database.exec(`
    PRAGMA foreign_keys=ON;
    CREATE TABLE accounts (
      id TEXT PRIMARY KEY, rail TEXT NOT NULL, display_name TEXT NOT NULL,
      currency TEXT NOT NULL, decimals INTEGER NOT NULL, balance_minor TEXT NOT NULL,
      chain_id TEXT, asset_id TEXT, account_ref TEXT, vault_key_id TEXT, status TEXT NOT NULL
    );
    CREATE TABLE vault_keys (
      id TEXT PRIMARY KEY, kind TEXT NOT NULL, address TEXT, enc_blob BLOB NOT NULL
    );
  `);
  installWalletKernelSchema(database);
  const store = new WalletKernelStore(database, {
    now: () => new Date("2026-08-23T20:00:00.000Z"),
  });
  return { database, store };
};

const insertAccount = (
  database: Database,
  overrides: Partial<{
    id: string;
    rail: string;
    currency: string;
    decimals: number;
    balance: string;
    chainId: string;
    assetId: string;
    accountRef: string;
    vaultKeyId: string | null;
  }> = {},
) => {
  const row = {
    id: "base-account",
    rail: "CRYPTO",
    currency: "USDC",
    decimals: 6,
    balance: "900719925474099312345678",
    chainId: BASE_CHAIN_ID,
    assetId: BASE_USDC_ASSET_ID,
    accountRef: `${BASE_CHAIN_ID}:${ADDRESS}`,
    vaultKeyId: null,
    ...overrides,
  };
  database.query(
    `INSERT INTO accounts
      (id,rail,display_name,currency,decimals,balance_minor,chain_id,asset_id,
       account_ref,vault_key_id,status)
     VALUES (?,?,?, ?,?,?,?,?,?,?, 'ACTIVE')`,
  ).run(
    row.id,
    row.rail,
    "Observed Base wallet",
    row.currency,
    row.decimals,
    row.balance,
    row.chainId,
    row.assetId,
    row.accountRef,
    row.vaultKeyId,
  );
};

describe("Base account projection", () => {
  test("projects an explicit watch-only identity and both observable assets without inventing balances", () => {
    const { database, store } = fixture();
    insertAccount(database);

    const account = ensureBaseAccountProjection({ db: database, store }, "base-account");
    expect(account).toMatchObject({
      address: ADDRESS,
      accountRef: `${BASE_CHAIN_ID}:${ADDRESS}`,
      legacyAssetId: BASE_USDC_ASSET_ID,
      custodyMode: "watch_only",
    });
    expect(database.query("SELECT id FROM wk_assets ORDER BY id").all()).toEqual([
      { id: BASE_USDC_ASSET_ID },
      { id: BASE_ETH_ASSET_ID },
    ].sort((left, right) => left.id.localeCompare(right.id)));
    expect(database.query("SELECT custody_mode FROM wk_accounts WHERE id='base-account'").get())
      .toEqual({ custody_mode: "watch_only" });
    expect(database.query("SELECT COUNT(*) AS n FROM wk_positions").get()).toEqual({ n: 0 });

    ensureBaseAccountProjection(
      { db: database, store },
      "base-account",
      { seedLegacyPosition: true },
    );
    expect(database.query(
      "SELECT observed_atomic,source FROM wk_positions WHERE account_id='base-account' AND asset_id=?",
    ).get(BASE_USDC_ASSET_ID)).toEqual({
      observed_atomic: "900719925474099312345678",
      source: "legacy-account-projection",
    });
  });

  test("requires the exact CAIP chain, asset precision, and matching local key", () => {
    const wrongChain = fixture();
    insertAccount(wrongChain.database, { chainId: "eip155:1" });
    expect(() => resolveBaseAccount(wrongChain.database, "base-account"))
      .toThrow("explicit eip155:8453");

    const wrongPrecision = fixture();
    insertAccount(wrongPrecision.database, { decimals: 18 });
    expect(() => resolveBaseAccount(wrongPrecision.database, "base-account"))
      .toThrow("USDC/6");

    const wrongKey = fixture();
    wrongKey.database.query(
      "INSERT INTO vault_keys (id,kind,address,enc_blob) VALUES ('key','evm',?,x'00')",
    ).run(`0x${"2".repeat(40)}`);
    insertAccount(wrongKey.database, { vaultKeyId: "key" });
    expect(() => resolveBaseAccount(wrongKey.database, "base-account"))
      .toThrow("does not match");
  });

  test("preserves a payment-projected checksummed Base address across position refresh", () => {
    const { database, store } = fixture();
    const lowerAddress = "0x19e7e376e7c213b7e7e7e46cc70a5dd086daff2a";
    const checksummedAddress = getAddress(lowerAddress);
    database.query(
      "INSERT INTO vault_keys (id,kind,address,enc_blob) VALUES ('key','evm',?,x'00')",
    ).run(checksummedAddress);
    insertAccount(database, {
      accountRef: `${BASE_CHAIN_ID}:${lowerAddress}`,
      vaultKeyId: "key",
    });
    store.putWallet({ id: "wallet.local-default", label: "Local", ownerRef: "local-owner" });
    store.putAccount({
      id: "base-account",
      walletId: "wallet.local-default",
      label: "Payment projection",
      kind: "CHAIN_ACCOUNT",
      rail: "evm-base",
      chainId: BASE_CHAIN_ID,
      accountRef: `${BASE_CHAIN_ID}:${lowerAddress}`,
      address: checksummedAddress,
      custodyMode: "local_self_custody",
    });

    expect(() => ensureBaseAccountProjection({ db: database, store }, "base-account"))
      .not.toThrow();
    expect(database.query(
      "SELECT account_ref,address FROM wk_accounts WHERE id='base-account'",
    ).get()).toEqual({
      account_ref: `${BASE_CHAIN_ID}:${lowerAddress}`,
      address: checksummedAddress,
    });
    expect(stableBaseKernelIdentity(
      database,
      "base-account",
      lowerAddress,
      `${BASE_CHAIN_ID}:${lowerAddress}`,
    )).toEqual({
      accountRef: `${BASE_CHAIN_ID}:${lowerAddress}`,
      address: checksummedAddress,
    });

    const inverse = fixture();
    inverse.database.query(
      "INSERT INTO vault_keys (id,kind,address,enc_blob) VALUES ('key','evm',?,x'00')",
    ).run(checksummedAddress);
    insertAccount(inverse.database, {
      accountRef: `${BASE_CHAIN_ID}:${lowerAddress}`,
      vaultKeyId: "key",
    });
    ensureBaseAccountProjection(
      { db: inverse.database, store: inverse.store },
      "base-account",
    );
    expect(stableBaseKernelIdentity(
      inverse.database,
      "base-account",
      checksummedAddress,
      `${BASE_CHAIN_ID}:${lowerAddress}`,
    )).toEqual({
      accountRef: `${BASE_CHAIN_ID}:${lowerAddress}`,
      address: lowerAddress,
    });
  });
});
