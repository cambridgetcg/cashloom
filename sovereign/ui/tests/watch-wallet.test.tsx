import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { api, ApiError, currentSessionGuard, setToken } from "../src/api";
import { BasePositionPanel } from "../src/components/BasePositionPanel";
import { mergeSavedBasePositions } from "../src/views/Accounts";
import { SavedMoneySource } from "../src/views/Connections";
import { isLiveSendingAccount } from "../src/views/Pay";
import { WatchWallet, WatchedWalletDetails, watchedBaseAddress, watchWalletInput, watchResultMatches, watchResultMessage, watchOutcomeUncertain } from "../src/views/WatchWallet";
import type { Account, BaseAccountPositionView } from "../src/types";

const address = `0x${"a".repeat(40)}`;
const account = (overrides: Partial<Account> = {}): Account => ({
  id: "watch-fixture", rail: "CRYPTO", connector_type: null, display_name: "A wallet to follow", currency: "ETH", decimals: 18,
  balance_minor: "0", balance_as_of: null, external_account_id: null, chain_id: "eip155:8453", asset_id: "eip155:8453/slip44:60",
  account_ref: `eip155:8453:${address}`, credential_ref: null, vault_key_id: null, status: "ACTIVE", created_at: "2026-09-29T12:00:00.000Z", ...overrides,
});

describe("watch wallet input and outcome boundaries", () => {
  test("trims input while preserving address case for the node's checksum validation", () => {
    const mixed = "0x52908400098527886E0F7030069857D2E4169EE7";
    expect(watchWalletInput(`  ${mixed}  `, "  Watch this wallet  ")).toEqual({ network: "base", address: mixed, display_name: "Watch this wallet" });
    expect(watchWalletInput(`0x${"0".repeat(40)}`, "Public address").network).toBe("base");
  });
  test("rejects key-sized input, addresses from other syntaxes and unsafe or empty labels", () => {
    for (const invalid of ["", "word ".repeat(12), `0x${"a".repeat(64)}`, `0x${"a".repeat(39)}`, `0x${"g".repeat(40)}`, `ethereum:${address}`, `eip155:8453:${address}`]) {
      expect(() => watchWalletInput(invalid, "A label")).toThrow();
    }
    for (const label of ["", " ", "a".repeat(121), "first\nsecond", "bad\u0000label"]) expect(() => watchWalletInput(address, label)).toThrow();
  });
  test("distinguishes definitive refusals from outcomes needing an exact retry", () => {
    for (const status of [400, 401, 403, 409, 413]) expect(watchOutcomeUncertain(new ApiError("Refused", "fixed", status))).toBe(false);
    for (const error of [new TypeError("Failed to fetch"), new ApiError("Unreadable", undefined, 201), new ApiError("Failure", "crypto_watch_failed", 500), new ApiError("Timeout", undefined, 408)]) expect(watchOutcomeUncertain(error)).toBe(true);
  });
  test("accepts only the matching active Base account and preserves reused custody and label", () => {
    const input = watchWalletInput(address, "New proposed label");
    expect(watchResultMatches({ account: account(), created: true }, input)).toBe(true);
    for (const overrides of [{ account_ref: `eip155:8453:0x${"b".repeat(40)}` }, { status: "ARCHIVED" }, { chain_id: "eip155:1" as const }, { vault_key_id: "local-key" }]) {
      expect(watchResultMatches({ account: account(overrides), created: true }, input)).toBe(false);
    }
    const reused = { account: account({ display_name: "Original label", vault_key_id: "local-key" }), created: false };
    expect(watchResultMatches(reused, input)).toBe(true);
    expect(watchResultMessage(reused)).toContain("Already tracked as Original label");
    expect(watchResultMessage(reused)).toContain("existing label and wallet settings were kept");
    expect(watchResultMessage(reused)).not.toContain(input.display_name);
  });
});

describe("watch-only presentation", () => {
  test("starts empty with explicit network/address/name fields and owner controls", () => {
    const html = renderToStaticMarkup(<WatchWallet canManage onSaved={() => undefined} onCancel={() => undefined} />);
    expect(html).toContain('aria-label="Watch a wallet"');
    for (const label of ["Network", "Public wallet address", "Wallet label", "Add watched wallet", "Cancel"]) expect(html).toContain(label);
    expect(html).toContain("Adding it does not contact a blockchain provider");
    expect(html).toContain("configured RPC providers");
    expect(html).toContain("does not import Base transaction history");
    expect(html).not.toContain('type="password"');
    expect(html).not.toContain(address);
    const readOnly = renderToStaticMarkup(<WatchWallet canManage={false} onSaved={() => undefined} onCancel={() => undefined} />);
    expect(readOnly).toContain("The workspace owner can add watched wallets");
    expect(readOnly).toContain('disabled="">Add watched wallet');
  });
  test("discloses the full public identity and RPC effect without an ownership or zero-balance claim", () => {
    const html = renderToStaticMarkup(<WatchedWalletDetails account={account()} />);
    expect(html).toContain(address); expect(html).toContain("Watch only"); expect(html).toContain("Base · public address");
    expect(html).toContain("does not establish who owns it");
    expect(html).toContain("sends this address to the node’s configured RPC providers");
    expect(html).toContain("Opening this page reads saved data locally");
    expect(html).not.toContain('href="http'); expect(html).not.toContain("0.00");
    expect(isLiveSendingAccount(account(), "ETH", new Map())).toBe(false);
    expect(watchedBaseAddress(account({ vault_key_id: "local-key" }))).toBeNull();
    expect(watchedBaseAddress(account({ chain_id: "eip155:1" }))).toBeNull();
  });
  test("uses the watch-specific connection path without offering activity import or payments", () => {
    const html = renderToStaticMarkup(<SavedMoneySource account={account()} onGoto={() => undefined} />);
    expect(html).toContain("Watch only · Base"); expect(html).toContain("View watched wallet");
    expect(html).toContain("Base transaction history is not imported");
    expect(html).not.toContain("Activity / import"); expect(html).not.toContain("Send money"); expect(html).not.toContain("Receive money");
  });
  test("watched checks have their own explicit label and stay disabled without owner authority", () => {
    const watched = renderToStaticMarkup(<BasePositionPanel view={null} refreshing={false} refreshLabel="Check balances" actionDisabled onRefresh={() => undefined} />);
    expect(watched).toContain('disabled="">Check balances'); expect(watched).toContain("Not checked on Base yet");
    expect(watched).not.toContain("0.00");
    const existing = renderToStaticMarkup(<BasePositionPanel view={null} refreshing={false} onRefresh={() => undefined} />);
    expect(existing).toContain("Refresh finalized balances");
  });
});

test("watch creation performs one exact local mutation; no balance-read or key route is invoked", async () => {
  const original = globalThis.fetch;
  const calls: Array<{ path: string; method: string; body: unknown }> = [];
  globalThis.fetch = (async (path, init) => {
    calls.push({ path: String(path), method: init?.method ?? "GET", body: JSON.parse(String(init?.body)) });
    return Response.json({ account: account(), created: true }, { status: 201 });
  }) as typeof fetch;
  try {
    const input = watchWalletInput(address, "A wallet to follow");
    expect(await api.watchWallet(input)).toEqual({ account: account(), created: true });
    expect(calls).toEqual([{ path: "/api/connections/crypto/watch", method: "POST", body: input }]);
  } finally { globalThis.fetch = original; }
});

test("a late create response cannot survive a lock/unlock or reuse its former session", async () => {
  const original = globalThis.fetch;
  let finish: (response: Response) => void = () => undefined;
  globalThis.fetch = (() => new Promise<Response>(resolve => { finish = resolve; })) as typeof fetch;
  try {
    setToken("synthetic-owner-a");
    const current = currentSessionGuard();
    const pending = api.watchWallet(watchWalletInput(address, "Watch fixture"));
    setToken(null); setToken("synthetic-owner-b");
    finish(Response.json({ account: account(), created: true }));
    await expect(pending).rejects.toMatchObject({ code: "session_changed" });
    expect(current()).toBe(false);
  } finally { setToken(null); globalThis.fetch = original; }
});

test("late saved-position reads retain a newly checked wallet while loading untouched accounts", () => {
  const before = { account_id: "a", label: "old observation" } as BaseAccountPositionView;
  const checked = { account_id: "a", label: "new finalized evidence" } as BaseAccountPositionView;
  const other = { account_id: "b", label: "other saved wallet" } as BaseAccountPositionView;
  expect(mergeSavedBasePositions([checked], [before, other], new Map(), new Map([["a", 1]]))).toEqual([other, checked]);
  expect(mergeSavedBasePositions([before], [checked, other], new Map([["a", 1]]), new Map([["a", 1]]))).toEqual([checked, other]);
});
