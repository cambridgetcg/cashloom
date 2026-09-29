import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { api } from "../src/api";
import { beginLedgerRead, LedgerAccountOptions, LedgerHistory, LedgerReadNotice } from "../src/views/Ledger";
import type { Account, Tx } from "../src/types";

const account = (overrides: Partial<Account> = {}): Account => ({
  id: "archived-eth", rail: "CRYPTO", connector_type: null, display_name: "Old ETH wallet",
  currency: "ETH", decimals: 18, balance_minor: "0", balance_as_of: null,
  external_account_id: null, chain_id: "eip155:8453", asset_id: "eip155:8453/slip44:60",
  account_ref: `eip155:8453:0x${"a".repeat(40)}`, credential_ref: null, vault_key_id: null,
  status: "ARCHIVED", created_at: "2026-09-23T00:00:00.000Z", ...overrides,
});
const transaction = (overrides: Partial<Tx> = {}): Tx => ({
  id: "entry-a", account_id: "archived-eth", external_id: null, title: "Recorded entry",
  amount_minor: "1234567890123456789", date: "2026-09-23T00:00:00.000Z", category: null,
  source: "MANUAL", created_at: "2026-09-23T00:00:00.000Z", ...overrides,
});

describe("ledger history account identity", () => {
  test("renders archived ETH and BTC with their exact original precision and labels", () => {
    const html = renderToStaticMarkup(<LedgerHistory filter="" accounts={[
      account(), account({ id: "archived-btc", display_name: "Old BTC wallet", currency: "BTC", decimals: 8 }),
    ]} transactions={[transaction(), transaction({ id: "entry-b", account_id: "archived-btc", amount_minor: "-123456789" })]} />);
    expect(html).toContain("Old ETH wallet · archived");
    expect(html).toContain("Old BTC wallet · archived");
    expect(html).toContain(".234567890123456789");
    expect(html).toContain(".23456789");
    expect(html).toContain('class="amt-cur">ETH');
    expect(html).toContain('class="amt-cur">BTC');
    expect(html).not.toContain("atomic units");
  });

  test("never guesses precision when account metadata is missing or invalid", () => {
    for (const accounts of [[], [account({ decimals: -1 })], [account({ decimals: 100 })]]) {
      const html = renderToStaticMarkup(<LedgerHistory filter="" accounts={accounts} transactions={[transaction()]} />);
      expect(html).toContain("1234567890123456789</code> atomic units");
      expect(html).toContain("Currency and precision unavailable");
      expect(html).not.toContain("amt-whole");
    }
  });

  test("archived accounts remain filterable but cannot be selected for a new entry", () => {
    const accounts = [account(), account({ id: "active", display_name: "Current wallet", status: "ACTIVE" })];
    const history = renderToStaticMarkup(<select><LedgerAccountOptions accounts={accounts} history /></select>);
    const entry = renderToStaticMarkup(<select><LedgerAccountOptions accounts={accounts} /></select>);
    expect(history).toContain('value="archived-eth"');
    expect(history).toContain("· archived");
    expect(entry).not.toContain('value="archived-eth"');
    expect(entry).toContain('value="active"');
  });

  test("API preserves its default and opts into archived metadata using local GETs", async () => {
    const originalFetch = globalThis.fetch;
    const calls: Array<[string, string]> = [];
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      calls.push([typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url, init?.method ?? "GET"]);
      return new Response(JSON.stringify({ accounts: [] }), { headers: { "Content-Type": "application/json" } });
    }) as typeof fetch;
    try {
      await api.accounts();
      await api.accounts({ includeArchived: true });
      await api.accounts({ includeArchived: false });
    } finally { globalThis.fetch = originalFetch; }
    expect(calls).toEqual([["/api/accounts", "GET"], ["/api/accounts?includeArchived=true", "GET"], ["/api/accounts?includeArchived=false", "GET"]]);
  });
});

describe("recoverable ledger reads", () => {
  test("retry clears the error while retaining same-filter history", () => {
    const transactions = [transaction()];
    const retried = beginLedgerRead({ filter: "archived-eth", transactions, loading: false, error: "temporarily unavailable" }, "archived-eth");
    expect(retried).toEqual({ filter: "archived-eth", transactions, loading: true, error: null });
    const changedFilter = beginLedgerRead(retried, "different-wallet");
    expect(changedFilter.transactions).toBeNull();
    expect(changedFilter.filter).toBe("different-wallet");
  });

  test("a failed history read offers retry and describes retained rows", () => {
    const html = renderToStaticMarkup(<LedgerReadNotice error="Temporary read failure" loading={false} retained onRetry={() => undefined} />);
    expect(html).toContain("Temporary read failure");
    expect(html).toContain("Showing the last loaded entries");
    expect(html).toContain("Retry history");
    expect(renderToStaticMarkup(<LedgerReadNotice error={null} loading={false} retained onRetry={() => undefined} />)).toBe("");
  });
});
