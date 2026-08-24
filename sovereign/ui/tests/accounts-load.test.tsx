import { describe, expect, test } from "bun:test";
import {
  beginAccountsLoad,
  updateRefreshingAccounts,
} from "../src/views/Accounts";
import type {
  Account,
  BaseAccountPositionView,
  WalletPositionsResponse,
} from "../src/types";

const ACCOUNT: Account = {
  id: "account-a",
  rail: "CASH",
  connector_type: null,
  display_name: "Pocket",
  currency: "USD",
  decimals: 2,
  balance_minor: "1200",
  balance_as_of: null,
  external_account_id: null,
  chain_id: null,
  asset_id: null,
  account_ref: null,
  credential_ref: null,
  vault_key_id: null,
  status: "ACTIVE",
  created_at: "2026-08-23T20:00:00.000Z",
};

describe("account page hydration", () => {
  test("required accounts and keys render without waiting for optional positions", async () => {
    let rejectPositions!: (reason: unknown) => void;
    const delayedPositions = new Promise<WalletPositionsResponse>((_resolve, reject) => {
      rejectPositions = reject;
    });
    const events: string[] = [];
    let loadedAccounts: Account[] = [];

    const cycle = beginAccountsLoad(
      {
        accounts: async () => ({ accounts: [ACCOUNT] }),
        keys: async () => ({ keys: [] }),
        walletPositions: () => delayedPositions,
      },
      {
        essentialsLoaded(accounts) {
          loadedAccounts = accounts;
          events.push("essentials-loaded");
        },
        essentialsFailed() {
          events.push("essentials-failed");
        },
        positionsLoaded(_positions: BaseAccountPositionView[]) {
          events.push("positions-loaded");
        },
        positionsFailed(message) {
          events.push(`positions-failed:${message}`);
        },
      },
    );

    await cycle.essentials;
    expect(loadedAccounts).toEqual([ACCOUNT]);
    expect(events).toEqual(["essentials-loaded"]);

    rejectPositions(new Error("observer projection unavailable"));
    await cycle.positions;
    expect(events).toEqual([
      "essentials-loaded",
      "positions-failed:observer projection unavailable",
    ]);
  });

  test("busy tracking preserves other concurrent account refreshes", () => {
    let refreshing: ReadonlySet<string> = new Set();
    refreshing = updateRefreshingAccounts(refreshing, "account-a", true);
    refreshing = updateRefreshingAccounts(refreshing, "account-b", true);
    refreshing = updateRefreshingAccounts(refreshing, "account-a", false);

    expect([...refreshing]).toEqual(["account-b"]);
  });
});
