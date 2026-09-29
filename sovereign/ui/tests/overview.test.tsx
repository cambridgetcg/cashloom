import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactElement, ReactNode } from "react";
import { beginOverviewLoad, buildOverview } from "../src/overview";
import { OverviewContent } from "../src/views/Dashboard";
import { LIVE_CRYPTO_IDENTITIES } from "../src/types";
import type { Account, BaseAccountPositionView, SummaryRow, WalletPositionsResponse } from "../src/types";

const WHEN = "2026-09-23T12:00:00.000Z";
const REF = `eip155:8453:0x${"a".repeat(40)}` as const;
const ETH = LIVE_CRYPTO_IDENTITIES.BASE_ETH;
const USDC = LIVE_CRYPTO_IDENTITIES.BASE_USDC;
const account = (overrides: Partial<Account> = {}): Account => ({
  id: "base-eth", rail: "CRYPTO", connector_type: null,
  display_name: "Base spending", currency: "ETH", decimals: 18,
  balance_minor: "999", balance_as_of: WHEN, external_account_id: null,
  chain_id: ETH.chain_id, asset_id: ETH.asset_id, account_ref: REF,
  credential_ref: null, vault_key_id: null, status: "ACTIVE", created_at: WHEN,
  ...overrides,
});
const cash = (overrides: Partial<Account> = {}): Account => account({
  id: "cash", rail: "CASH", display_name: "Cash", currency: "GBP", decimals: 2,
  balance_minor: "0", balance_as_of: null, chain_id: null, asset_id: null, account_ref: null,
  ...overrides,
});
const view = (overrides: Partial<BaseAccountPositionView> = {}): BaseAccountPositionView => ({
  account_id: "base-eth", label: "Base spending", chain_id: ETH.chain_id,
  account_ref: REF, address: REF.slice("eip155:8453:".length), custody_mode: "watch_only",
  status: "finalized",
  snapshot: {
    snapshot_id: "snapshot-a", block: { number: "9007199254740993000", hash: `0x${"b".repeat(64)}`, timestamp: WHEN },
    evidence_hash: `sha256:${"c".repeat(64)}`, provider_ids: ["base-a", "base-b"], quorum: "2",
    observed_at: WHEN, applied_at: WHEN,
  },
  positions: [ETH, USDC].map((asset) => ({
    account_id: "base-eth", asset_id: asset.asset_id,
    observed_atomic: asset.currency === "ETH" ? "900719925474099312345678" : "123456789012345678901234",
    pending_atomic: "0", source: "base-finalized-quorum", source_cursor: "9007199254740993000",
    as_of: WHEN, version: 1, symbol: asset.currency, name: asset.label, decimals: asset.decimals,
  })),
  identity_group: { canonical_account_ref: REF, canonical_account_id: "base-eth", account_ids: ["base-eth"], duplicate: false },
  last_refresh: null, actions: { refresh: true }, ...overrides,
});
const render = (accounts: Account[], positions: BaseAccountPositionView[] | null = [], extra = {}) =>
  renderToStaticMarkup(<OverviewContent accounts={accounts} positions={positions} summary={[]} onGoto={() => undefined} {...extra} />);

describe("saved Overview balances", () => {
  test("uses finalized exact positions once for ETH/USDC and duplicate records", () => {
    const aliases = [account(), account({ id: "base-usdc", currency: "USDC", decimals: 6, asset_id: USDC.asset_id }), account({ id: "duplicate" })];
    const result = buildOverview(aliases, [], [view(), view({ account_id: "base-usdc" }), view({ account_id: "duplicate" })]);
    expect(result.accounts).toHaveLength(0);
    expect(result.baseWallets).toHaveLength(1);
    expect(result.baseWallets[0].accounts).toHaveLength(3);
    expect(result.baseWallets[0].view?.positions[0].observed_atomic).toBe("900719925474099312345678");
    const html = render(aliases, [view()]);
    expect(html).toContain("One wallet · 3 account records");
    expect(html.match(/900,719/g)).toHaveLength(1);
    expect(html).toContain(".925474099312345678");
    expect(html).toContain("123,456,789,012,345,678");
    expect(html).toContain("9007199254740993000");
    expect(html).toContain(`dateTime="${WHEN}"`);
    expect(html).not.toContain("Net position");
  });

  test("uses the newest finalized block across aliases with BigInt precision", () => {
    const newer = view({ account_id: "alias" });
    newer.snapshot = { ...newer.snapshot!, block: { ...newer.snapshot!.block, number: "9007199254740993001" } };
    const result = buildOverview([account(), account({ id: "alias" })], [], [view(), newer]);
    expect(result.baseWallets[0].state).toBe("finalized");
    expect(result.baseWallets[0].view?.account_id).toBe("alias");
    expect(result.baseWallets[0].message).toContain("newest saved finalized block");
  });

  test("missing evidence never falls back to a legacy balance or default zero", () => {
    const result = buildOverview([account()]);
    expect(result.baseWallets[0].state).toBe("not_checked");
    expect(result.baseWallets[0].view).toBeNull();
    const html = render([account()]);
    expect(html).toContain("Balance not established");
    expect(html).not.toContain("amt-whole");
  });

  test("frozen aliases and same-height disagreement hide financial amounts", () => {
    const aliases = [account(), account({ id: "alias" })];
    const conflicted = view({ account_id: "alias", status: "conflicted" });
    expect(buildOverview(aliases, [], [view(), conflicted]).baseWallets[0].state).toBe("conflicted");
    const disagreement = view({ account_id: "alias" });
    disagreement.positions[0].observed_atomic = "1";
    expect(buildOverview(aliases, [], [view(), disagreement]).baseWallets[0].state).toBe("conflicted");
    const html = render(aliases, [view(), conflicted]);
    expect(html).toContain("Review in Accounts");
    expect(html).not.toContain("amt-whole");
  });

  test("wrong chain identity, asset precision and incomplete evidence stay unknown", () => {
    expect(buildOverview([account({ decimals: 6 })], [], [view()]).baseWallets[0].state).toBe("identity_invalid");
    const wrongIdentity = view({ account_ref: `eip155:8453:0x${"d".repeat(40)}` });
    expect(buildOverview([account()], [], [wrongIdentity]).baseWallets[0].state).toBe("identity_invalid");
    const incomplete = view();
    incomplete.positions.pop();
    expect(buildOverview([account()], [], [incomplete]).baseWallets[0].view).toBeNull();
    const wrongPrecision = view();
    wrongPrecision.positions[0].decimals = 6;
    expect(buildOverview([account()], [], [wrongPrecision]).baseWallets[0].view).toBeNull();
  });

  test("labels a retained snapshot after an unavailable later check", () => {
    const retained = view({ last_refresh: {
      attempt_id: "attempt-a", attempted_at: "2026-09-23T13:00:00.000Z", outcome: "partial",
      reason_code: "provider_unavailable", provider_count: "2", available_provider_count: "1",
      agreeing_provider_count: "0", retained_head: null, error_code: null,
    } });
    const html = render([account()], [retained]);
    expect(html).toContain("retained finalized snapshot");
    expect(html).toContain("900,719");
    expect(html).toContain(`dateTime="${WHEN}"`);
  });

  test("keeps same symbols on different chains and decimal scales separate", () => {
    const ethereum = account({ id: "ethereum", chain_id: "eip155:1", asset_id: "eip155:1/slip44:60", account_ref: `eip155:1:0x${"a".repeat(40)}`, balance_minor: "1000000000000000000", connector_type: "alchemy" });
    const token = account({ id: "token", currency: "ETH", decimals: 6, chain_id: "eip155:1", asset_id: `eip155:1/erc20:0x${"e".repeat(40)}`, balance_minor: "2500000" });
    const result = buildOverview([account(), ethereum, token], [], [view()]);
    expect(result.accounts.map((entry) => entry.balance)).toEqual(["1000000000000000000", "2500000"]);
    const html = render([account(), ethereum, token], [view()]);
    expect(html).toContain("eip155:1/slip44:60");
    expect(html).toContain(`eip155:1/erc20:0x${"e".repeat(40)}`);
    expect(html).not.toContain("Net position");
  });

  test("distinguishes unsynced default zero from an observed zero and manual history", () => {
    const history: SummaryRow = { id: "cash", display_name: "Cash", currency: "GBP", decimals: 2, balance_minor: "0", in_minor: "500", out_minor: "200", tx_count: 2 };
    const result = buildOverview([cash(), cash({ id: "observed", balance_as_of: WHEN })], [history]);
    expect(result.accounts[0].balance).toBeNull();
    expect(result.accounts[0].summary).toEqual(history);
    expect(result.accounts[1].balance).toBe("0");
    const html = render([cash()], [], { summary: [history] });
    expect(html).toContain("Balance not recorded");
    expect(html).toContain("In 5.00 GBP");
    expect(html).toContain("Out 2.00 GBP");
    expect(html).toContain("Open Activity");
  });

  test("excludes archived accounts without displaying empty portfolio zero", () => {
    const html = render([account({ status: "ARCHIVED" })]);
    expect(html).toContain("Add an account");
    expect(html).not.toContain("amt-whole");
  });

  test("saved-position failures keep ordinary accounts usable", () => {
    const html = render([account(), cash()], null, { positionsError: "projection unavailable" });
    expect(html).toContain("Saved Base balance unavailable");
    expect(html).toContain("Cash");
    expect(html).toContain("Open Activity");
  });
});

describe("Overview loading and journeys", () => {
  test("loads accounts independently of pending optional evidence and history", async () => {
    let rejectPositions!: (error: Error) => void;
    let rejectSummary!: (error: Error) => void;
    const events: string[] = [];
    const loading = beginOverviewLoad({
      accounts: async () => ({ accounts: [cash()] }),
      summary: () => new Promise<{ accounts: SummaryRow[] }>((_, reject) => { rejectSummary = reject; }),
      walletPositions: () => new Promise<WalletPositionsResponse>((_, reject) => { rejectPositions = reject; }),
    }, {
      accountsLoaded: () => { events.push("accounts"); }, accountsFailed: () => { events.push("accounts-failed"); },
      summaryLoaded: () => { events.push("summary"); }, summaryFailed: () => { events.push("summary-failed"); },
      positionsLoaded: () => { events.push("positions"); }, positionsFailed: () => { events.push("positions-failed"); },
    });
    await loading.accounts;
    expect(events).toEqual(["accounts"]);
    rejectPositions(new Error("unavailable"));
    rejectSummary(new Error("unavailable"));
    await Promise.all([loading.positions, loading.summary]);
    expect(events).toEqual(["accounts", "positions-failed", "summary-failed"]);
  });

  test("next actions carry the selected account without a provider request", () => {
    const calls: unknown[] = [];
    const tree = OverviewContent({ accounts: [account(), cash()], summary: [], positions: [view()], onGoto: (...args) => { calls.push(args); } });
    const walk = (node: ReactNode): void => {
      if (Array.isArray(node)) { node.forEach(walk); return; }
      if (!node || typeof node !== "object" || !("props" in node)) return;
      const element = node as ReactElement<{ children?: ReactNode; onClick?: () => void }>;
      if (element.type === "button") element.props.onClick?.();
      walk(element.props.children);
    };
    walk(tree);
    expect(calls).toEqual([["accounts", { accountId: "base-eth" }], ["accounts", { accountId: "cash" }], ["ledger", { accountId: "cash" }]]);
  });
});
