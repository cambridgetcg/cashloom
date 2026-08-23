import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import {
  BasePositionPanel,
  isObservableBaseAccount,
} from "../src/components/BasePositionPanel";
import type { Account, BaseAccountPositionView } from "../src/types";

const account = (overrides: Partial<Account> = {}): Account => ({
  id: "account-1",
  rail: "CRYPTO",
  connector_type: null,
  display_name: "Base wallet",
  currency: "USDC",
  decimals: 6,
  balance_minor: "0",
  balance_as_of: null,
  external_account_id: null,
  chain_id: "eip155:8453",
  asset_id: "eip155:8453/erc20:0x833589FCD6EDB6E08F4C7C32D4F71B54BDA02913",
  account_ref: `eip155:8453:0x${"a".repeat(40)}`,
  credential_ref: null,
  vault_key_id: null,
  status: "ACTIVE",
  created_at: "2026-08-23T20:00:00.000Z",
  ...overrides,
});

const view = (overrides: Partial<BaseAccountPositionView> = {}): BaseAccountPositionView => ({
  account_id: "account-1",
  label: "Base wallet",
  chain_id: "eip155:8453",
  account_ref: `eip155:8453:0x${"a".repeat(40)}`,
  address: `0x${"a".repeat(40)}`,
  custody_mode: "watch_only",
  status: "finalized",
  snapshot: {
    snapshot_id: "base-position-snapshot-1",
    block: {
      number: "9007199254740993123",
      hash: `0x${"b".repeat(64)}`,
      timestamp: "2026-08-23T20:01:00.000Z",
    },
    evidence_hash: `sha256:${"c".repeat(64)}`,
    provider_ids: ["base-a", "base-b"],
    quorum: "2",
    observed_at: "2026-08-23T20:01:02.000Z",
    applied_at: "2026-08-23T20:01:03.000Z",
  },
  positions: [
    {
      account_id: "account-1",
      asset_id: "eip155:8453/slip44:60",
      observed_atomic: "900719925474099312345678",
      pending_atomic: "0",
      source: "base-finalized-quorum",
      source_cursor: "9007199254740993123",
      as_of: "2026-08-23T20:01:00.000Z",
      version: 1,
      symbol: "ETH",
      name: "Ether",
      decimals: 18,
    },
    {
      account_id: "account-1",
      asset_id: "eip155:8453/erc20:0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
      observed_atomic: "123456789012345678901234",
      pending_atomic: "7",
      source: "base-finalized-quorum",
      source_cursor: "9007199254740993123",
      as_of: "2026-08-23T20:01:00.000Z",
      version: 1,
      symbol: "USDC",
      name: "USD Coin",
      decimals: 6,
    },
  ],
  identity_group: {
    canonical_account_ref: `eip155:8453:0x${"a".repeat(40)}`,
    canonical_account_id: "account-1",
    account_ids: ["account-1"],
    duplicate: false,
  },
  last_refresh: null,
  actions: { refresh: true },
  ...overrides,
});

describe("Base position panel", () => {
  test("recognizes only explicit Base ETH/native-USDC identities", () => {
    expect(isObservableBaseAccount(account())).toBe(true);
    expect(isObservableBaseAccount(account({ chain_id: "eip155:1" }))).toBe(false);
    expect(isObservableBaseAccount(account({ asset_id: "eip155:8453/erc20:0x1234" }))).toBe(false);
    expect(isObservableBaseAccount(account({ account_ref: null }))).toBe(false);
  });

  test("renders an honest not-checked state and an explicit read-only action", () => {
    const html = renderToStaticMarkup(
      <BasePositionPanel
        view={null}
        refreshing={false}
        onRefresh={() => undefined}
      />,
    );
    expect(html).toContain("Not checked on Base yet");
    expect(html).toContain("No missing response is treated as a zero balance");
    expect(html).toContain("Refresh finalized balances");
    expect(html).toContain("never signs, submits, or retries");
  });

  test("renders exact large balances and two-provider block evidence", () => {
    const html = renderToStaticMarkup(
      <BasePositionPanel
        view={view()}
        refreshing={false}
        onRefresh={() => undefined}
      />,
    );
    expect(html).toContain("2-provider finalized");
    expect(html).toContain("9007199254740993123");
    expect(html).toContain("900719");
    expect(html).toContain("USD Coin");
    expect(html).toContain("pending ledger delta 7 atomic");
    expect(html).toContain("Block age");
    expect(html).toContain("Snapshot age");
    expect(html).toContain("Observed");
    expect(html).toContain("Applied");
    expect(html).toContain("Provider IDs");
    expect(html).toContain("base-a · base-b · quorum 2");
    expect(html.toLowerCase()).not.toContain("independent");
  });

  test("freezes the refresh action when same-height evidence conflicts", () => {
    const html = renderToStaticMarkup(
      <BasePositionPanel
        view={view({ status: "conflicted" })}
        refreshing={false}
        onRefresh={() => undefined}
      />,
    );
    expect(html).toContain("evidence conflict");
    expect(html.toLowerCase()).toContain("no balance was overwritten");
    expect(html).toContain("USD Coin");
    expect(html).toContain("9007199254740993123");
    expect(html).toContain("Retained snapshot age");
    expect(html).toContain("base-a · base-b · quorum 2");
    expect(html).toContain("disabled=\"\"");
  });

  test("renders an identity refusal and disables network refresh", () => {
    const html = renderToStaticMarkup(
      <BasePositionPanel
        view={view({
          status: "identity_invalid",
          snapshot: null,
          positions: [],
          actions: { refresh: false },
          refusal: {
            code: "base_account_identity_invalid",
            message: "This account identity is not safe to observe.",
          },
        })}
        refreshing={false}
        onRefresh={() => undefined}
      />,
    );
    expect(html).toContain("identity invalid");
    expect(html).toContain("not safe to observe");
    expect(html).toContain("disabled=\"\"");
  });

  test("distinguishes a saved unavailable check from never checked", () => {
    const html = renderToStaticMarkup(
      <BasePositionPanel
        view={view({
          status: "not_checked",
          snapshot: null,
          positions: [],
          last_refresh: {
            attempt_id: "attempt-1",
            attempted_at: "2026-08-23T20:02:00.000Z",
            outcome: "partial",
            reason_code: "provider_unavailable",
            provider_count: "2",
            available_provider_count: "0",
            agreeing_provider_count: "0",
            retained_head: null,
            error_code: null,
          },
        })}
        refreshing={false}
        onRefresh={() => undefined}
      />,
    );
    expect(html).toContain("last Base check did not settle");
    expect(html).toContain("0/2 available");
    expect(html).toContain("provider_unavailable");
  });

  test("does not call two conflicting provider sightings an agreement", () => {
    const html = renderToStaticMarkup(
      <BasePositionPanel
        view={view({
          status: "not_checked",
          snapshot: null,
          positions: [],
          last_refresh: {
            attempt_id: "attempt-disagreement",
            attempted_at: "2026-08-23T20:02:00.000Z",
            outcome: "partial",
            reason_code: "provider_disagreement",
            provider_count: "2",
            available_provider_count: "2",
            agreeing_provider_count: "1",
            retained_head: null,
            error_code: null,
          },
        })}
        refreshing={false}
        onRefresh={() => undefined}
      />,
    );
    expect(html).toContain("1 agreeing");
    expect(html).toContain("2/2 available");
    expect(html).not.toContain("2 agreeing");
  });

  test("warns agents not to double-count duplicate local records for one CAIP-10 identity", () => {
    const html = renderToStaticMarkup(
      <BasePositionPanel
        view={view({
          identity_group: {
            canonical_account_ref: `eip155:8453:0x${"a".repeat(40)}`,
            canonical_account_id: "account-1",
            account_ids: ["account-1", "account-2"],
            duplicate: true,
          },
        })}
        refreshing={false}
        onRefresh={() => undefined}
      />,
    );
    expect(html).toContain("appears in 2 local account");
    expect(html).toContain("do not sum these cards");
  });
});
