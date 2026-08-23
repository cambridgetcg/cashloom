import { describe, expect, test } from "bun:test";
import {
  baseReconciliationNotice,
  isLegacyMappedBitcoinAccount,
  isLiveSendingAccount,
  type Asset,
} from "../src/views/Pay";
import {
  LIVE_CRYPTO_IDENTITIES,
  type Account,
  type Caip10AccountId,
  type Caip19AssetId,
  type VaultKey,
} from "../src/types";

const EVM_ADDRESS = `0x${"a".repeat(40)}`;
const BTC_ADDRESS = "bc1q50rtrmj2f8vl9tem8qpfw36ylw5jg9j29e5za5";
const BASE_ETH = LIVE_CRYPTO_IDENTITIES.BASE_ETH;
const BASE_USDC = LIVE_CRYPTO_IDENTITIES.BASE_USDC;
const BITCOIN = LIVE_CRYPTO_IDENTITIES.BITCOIN_BTC;

const EVM_KEY: VaultKey = {
  id: "key-evm",
  label: "EVM",
  kind: "evm",
  address: EVM_ADDRESS,
  created_at: "2026-08-21T00:00:00.000Z",
};

const BTC_KEY: VaultKey = {
  id: "key-btc",
  label: "Bitcoin",
  kind: "btc",
  address: BTC_ADDRESS,
  created_at: "2026-08-21T00:00:00.000Z",
};

const account = (overrides: Partial<Account> = {}): Account => ({
  id: "account-1",
  rail: "CRYPTO",
  connector_type: null,
  display_name: "Position",
  currency: "ETH",
  decimals: 18,
  balance_minor: "0",
  balance_as_of: null,
  external_account_id: null,
  chain_id: BASE_ETH.chain_id,
  asset_id: BASE_ETH.asset_id,
  account_ref: `${BASE_ETH.chain_id}:${EVM_ADDRESS}`,
  credential_ref: null,
  vault_key_id: EVM_KEY.id,
  status: "ACTIVE",
  created_at: "2026-08-21T00:00:00.000Z",
  ...overrides,
});

const keyMap = (...keys: VaultKey[]): Map<string, VaultKey> =>
  new Map(keys.map((key) => [key.id, key]));

interface EligibilityFixture {
  name: string;
  asset: Asset;
  position: Account;
  keys: VaultKey[];
  expected: boolean;
}

const fixtures: EligibilityFixture[] = [
  {
    name: "accepts exact Base ETH identity",
    asset: "ETH",
    position: account(),
    keys: [EVM_KEY],
    expected: true,
  },
  {
    name: "normalizes currency and EVM asset/account casing like the kernel",
    asset: "USDC",
    position: account({
      currency: " usdc ",
      decimals: BASE_USDC.decimals,
      asset_id: BASE_USDC.asset_id.replace("erc20:0x", "ERC20:0X").toUpperCase() as Caip19AssetId,
      account_ref: `${BASE_USDC.chain_id}:0X${"A".repeat(40)}` as Caip10AccountId,
    }),
    keys: [EVM_KEY],
    expected: true,
  },
  {
    name: "ignores a connector-specific agenttool external wallet id",
    asset: "ETH",
    position: account({
      connector_type: "agenttool",
      external_account_id: "wallet-uuid-not-an-address",
    }),
    keys: [EVM_KEY],
    expected: true,
  },
  {
    name: "requires an Esplora external id to match the key address",
    asset: "ETH",
    position: account({
      connector_type: "esplora",
      external_account_id: BTC_ADDRESS,
    }),
    keys: [EVM_KEY],
    expected: false,
  },
  {
    name: "refuses legacy Alchemy Ethereum-mainnet read positions for Base",
    asset: "ETH",
    position: account({ connector_type: "ALCHEMY" }),
    keys: [EVM_KEY],
    expected: false,
  },
  {
    name: "accepts exact Bitcoin identity without interpreting an agenttool id as an address",
    asset: "BTC",
    position: account({
      currency: " btc ",
      decimals: BITCOIN.decimals,
      connector_type: "agenttool",
      external_account_id: "wallet-uuid-not-an-address",
      chain_id: BITCOIN.chain_id,
      asset_id: BITCOIN.asset_id,
      account_ref: `${BITCOIN.chain_id}:${BTC_ADDRESS}`,
      vault_key_id: BTC_KEY.id,
    }),
    keys: [BTC_KEY],
    expected: true,
  },
  {
    name: "accepts a complete legacy Bitcoin Esplora mapping",
    asset: "BTC",
    position: account({
      currency: "BTC",
      decimals: 8,
      connector_type: "ESPLORA",
      external_account_id: BTC_ADDRESS,
      chain_id: null,
      asset_id: null,
      account_ref: null,
      vault_key_id: BTC_KEY.id,
    }),
    keys: [BTC_KEY],
    expected: true,
  },
  {
    name: "refuses a partial legacy Bitcoin identity",
    asset: "BTC",
    position: account({
      currency: "BTC",
      decimals: 8,
      connector_type: "esplora",
      external_account_id: BTC_ADDRESS,
      chain_id: BITCOIN.chain_id,
      asset_id: null,
      account_ref: null,
      vault_key_id: BTC_KEY.id,
    }),
    keys: [BTC_KEY],
    expected: false,
  },
  {
    name: "refuses legacy Bitcoin without the Esplora connector",
    asset: "BTC",
    position: account({
      currency: "BTC",
      decimals: 8,
      connector_type: null,
      external_account_id: BTC_ADDRESS,
      chain_id: null,
      asset_id: null,
      account_ref: null,
      vault_key_id: BTC_KEY.id,
    }),
    keys: [BTC_KEY],
    expected: false,
  },
  {
    name: "refuses legacy Bitcoin when Esplora watches a different address",
    asset: "BTC",
    position: account({
      currency: "BTC",
      decimals: 8,
      connector_type: "esplora",
      external_account_id: "bc1qvux25709r4uw6rzc8wyl7wwecjdhrx085hm5ty",
      chain_id: null,
      asset_id: null,
      account_ref: null,
      vault_key_id: BTC_KEY.id,
    }),
    keys: [BTC_KEY],
    expected: false,
  },
  {
    name: "keeps Bitcoin CAIP identity comparison case-sensitive",
    asset: "BTC",
    position: account({
      currency: "BTC",
      decimals: 8,
      chain_id: BITCOIN.chain_id,
      asset_id: BITCOIN.asset_id.toUpperCase() as Caip19AssetId,
      account_ref: `${BITCOIN.chain_id}:${BTC_ADDRESS}`,
      vault_key_id: BTC_KEY.id,
    }),
    keys: [BTC_KEY],
    expected: false,
  },
  {
    name: "refuses a position backed by the wrong key kind",
    asset: "BTC",
    position: account({
      currency: "BTC",
      decimals: 8,
      chain_id: BITCOIN.chain_id,
      asset_id: BITCOIN.asset_id,
      account_ref: `${BITCOIN.chain_id}:${BTC_ADDRESS}`,
      vault_key_id: EVM_KEY.id,
    }),
    keys: [EVM_KEY],
    expected: false,
  },
  {
    name: "refuses a watch-only position",
    asset: "ETH",
    position: account({ vault_key_id: null }),
    keys: [EVM_KEY],
    expected: false,
  },
  {
    name: "refuses an inactive position",
    asset: "ETH",
    position: account({ status: "ARCHIVED" }),
    keys: [EVM_KEY],
    expected: false,
  },
  {
    name: "refuses the wrong asset on the same EVM key",
    asset: "USDC",
    position: account(),
    keys: [EVM_KEY],
    expected: false,
  },
];

describe("Wallet Kernel Pay account eligibility", () => {
  for (const fixture of fixtures) {
    test(fixture.name, () => {
      expect(
        isLiveSendingAccount(
          fixture.position,
          fixture.asset,
          keyMap(...fixture.keys),
        ),
      ).toBe(fixture.expected);
    });
  }

  test("identifies only the all-null Esplora legacy shape for labelling", () => {
    const legacy = fixtures.find((fixture) =>
      fixture.name.startsWith("accepts a complete legacy"),
    )!.position;
    expect(isLegacyMappedBitcoinAccount(legacy)).toBe(true);
    expect(
      isLegacyMappedBitcoinAccount(
        account({ chain_id: BITCOIN.chain_id, asset_id: null, account_ref: null }),
      ),
    ).toBe(false);
  });

  test("does not describe a total Base provider outage as recorded evidence", () => {
    expect(baseReconciliationNotice(
      { visibility: "not_checked" },
      { state: "partial", available_providers: "0", unavailable_providers: "2" },
    )).toEqual({
      kind: "alert",
      text: "Base check reached no evidence provider. Prior local truth is unchanged; try again later.",
    });
    expect(baseReconciliationNotice(
      {
        security_level: "finalized",
        canonicality: "canonical",
        evidence: { provider_ids: ["base-a", "base-b"], quorum: "2" },
      },
      { state: "settled", available_providers: "2", unavailable_providers: "0" },
    )).toMatchObject({ kind: "status", text: expect.stringContaining("Finalized evidence") });
    expect(baseReconciliationNotice(
      {
        visibility: "included",
        security_level: "finalized",
        canonicality: "unknown",
        evidence: { provider_ids: ["base-a"], quorum: null },
      },
      { state: "partial", available_providers: "1", unavailable_providers: "1" },
    )).toMatchObject({
      kind: "status",
      text: expect.stringContaining("has not reached finalized consensus"),
    });
  });
});
