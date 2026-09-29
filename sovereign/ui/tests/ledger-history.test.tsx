import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { api } from "../src/api";
import { beginLedgerRead, emptyLedgerRead, failLedgerRead, finishLedgerRead, freshLedgerAccount, hasLedgerDraft, Ledger, LedgerAccountOptions, LedgerHistory, LedgerReadNotice } from "../src/views/Ledger";
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
    const retried = beginLedgerRead({ ...emptyLedgerRead("archived-eth"), transactions, loading: false, error: "temporarily unavailable" }, "archived-eth");
    expect(retried).toMatchObject({ filter: "archived-eth", transactions, loading: true, error: null });
    const changedFilter = beginLedgerRead(retried, "different-wallet");
    expect(changedFilter.transactions).toBeNull();
    expect(changedFilter.filter).toBe("different-wallet");
  });

  test("new criteria clear prior rows/cursor and ignore late success or failure from an old request", () => {
    const first = finishLedgerRead(beginLedgerRead(emptyLedgerRead(), "a", "rent", 1), 1,
      { transactions: [transaction()], has_more: true, next_cursor: "rent-page-2" }, false);
    const changed = beginLedgerRead(first, "b", "groceries", 2);
    expect(changed).toMatchObject({ filter: "b", query: "groceries", transactions: null, hasMore: false, nextCursor: null });
    expect(finishLedgerRead(changed, 1, { transactions: [transaction()], has_more: false, next_cursor: null }, false)).toBe(changed);
    expect(failLedgerRead(changed, 1, "Old request failed", false)).toBe(changed);
    const queryOnly = beginLedgerRead(first, "a", "new search", 3);
    expect(queryOnly.transactions).toBeNull(); expect(queryOnly.nextCursor).toBeNull();
  });

  test("append failure retains existing rows and cursor; retry deduplicates and accepts newer row data", () => {
    const first = finishLedgerRead(beginLedgerRead(emptyLedgerRead(), "a", "", 1), 1,
      { transactions: [transaction()], has_more: true, next_cursor: "page-2" }, false);
    const loading = beginLedgerRead(first, "a", "", 2, true);
    const failed = failLedgerRead(loading, 2, "Temporary failure", true);
    expect(failed).toMatchObject({ transactions: first.transactions, moreError: "Temporary failure", error: null, loadingMore: false, nextCursor: "page-2", hasMore: true });
    const retry = beginLedgerRead(failed, "a", "", 3, true);
    const loaded = finishLedgerRead(retry, 3, { transactions: [transaction({ title: "Provider updated description" }), transaction({ id: "older-entry" })], has_more: false, next_cursor: null }, true);
    expect(loaded.transactions?.map(row => row.id)).toEqual(["entry-a", "older-entry"]);
    expect(loaded.transactions?.[0]?.title).toBe("Provider updated description");
    expect(loaded).toMatchObject({ hasMore: false, nextCursor: null, moreError: null, loadingMore: false });
  });

  test("same-criteria reload failure retains all loaded rows, while a successful reload replaces old pages", () => {
    const saved = { ...emptyLedgerRead("a", "books"), transactions: [transaction(), transaction({ id: "older" })], loading: false, hasMore: true, nextCursor: "next" };
    const reading = beginLedgerRead(saved, "a", "books", 8);
    const failed = failLedgerRead(reading, 8, "Reload unavailable", false);
    expect(failed.transactions).toEqual(saved.transactions); expect(failed.nextCursor).toBe("next");
    const refreshed = finishLedgerRead(beginLedgerRead(failed, "a", "books", 9), 9,
      { transactions: [transaction({ id: "new-first-page" })], has_more: true, next_cursor: "new-cursor" }, false);
    expect(refreshed.transactions?.map(row => row.id)).toEqual(["new-first-page"]);
    expect(refreshed.nextCursor).toBe("new-cursor");
  });

  test("a failed history read offers retry and describes retained rows", () => {
    const html = renderToStaticMarkup(<LedgerReadNotice error="Temporary read failure" loading={false} retained onRetry={() => undefined} />);
    expect(html).toContain("Temporary read failure");
    expect(html).toContain("Showing the last loaded entries");
    expect(html).toContain("Retry history");
    expect(renderToStaticMarkup(<LedgerReadNotice error={null} loading={false} retained onRetry={() => undefined} />)).toBe("");
  });
});

describe("Activity criteria and entry destinations", () => {
  test("fresh entry follows the selected active account but never substitutes for an archived or missing selection", () => {
    const accounts = [account({ id: "a", status: "ACTIVE" }), account({ id: "b", status: "ACTIVE" }), account()];
    expect(freshLedgerAccount(accounts, "b")).toBe("b");
    expect(freshLedgerAccount(accounts, "a")).toBe("a");
    expect(freshLedgerAccount(accounts, "")).toBe("a");
    expect(freshLedgerAccount(accounts, "archived-eth")).toBe("");
    expect(freshLedgerAccount(accounts, "missing")).toBe("");
  });

  test("any entered data or explicit destination preserves a draft, including when its form is closed", () => {
    const empty = { title: "", amount: "", category: "", date: "2026-09-29", initialDate: "2026-09-29", direction: "out" as const, accountChosen: false };
    expect(hasLedgerDraft(empty)).toBe(false);
    for (const patch of [{ title: " " }, { amount: "0" }, { category: "Food" }, { date: "2026-09-28" }, { direction: "in" as const }, { accountChosen: true }]) {
      expect(hasLedgerDraft({ ...empty, ...patch })).toBe(true);
    }
  });

  test("search is explicitly submitted, bounded and escaped; export scope is independent", () => {
    const html = renderToStaticMarkup(<Ledger initialQuery={'<script>secret & account</script>'} initialAccountId="a" />);
    expect(html).toContain('aria-label="Search activity"');
    expect(html).toContain('aria-label="Search titles and categories"');
    expect(html).toContain('maxLength="120"');
    expect(html).toContain('type="submit">Search');
    expect(html).toContain("Clear search");
    expect(html).toContain("&lt;script&gt;secret &amp; account&lt;/script&gt;");
    expect(html).not.toContain("<script>");
    expect(html).toContain("regardless of the search or loaded pages");
    expect(html).not.toContain("?q=");
  });

  test("API sends search and opaque cursors only to the private read endpoint and leaves export unfiltered", async () => {
    const original = globalThis.fetch;
    const calls: Array<{ path: string; method: string }> = [];
    globalThis.fetch = (async (input, init) => {
      calls.push({ path: String(input), method: init?.method ?? "GET" });
      return Response.json({ transactions: [], has_more: false, next_cursor: null });
    }) as typeof fetch;
    try {
      const result = await api.transactions({ accountId: "a/b", q: "  rent & 50%_  ", limit: 200, cursor: "opaque+/=" });
      expect(result).toEqual({ transactions: [], has_more: false, next_cursor: null });
      await api.exportTransactions("a/b");
      await api.transactions({ q: "   " });
    } finally { globalThis.fetch = original; }
    expect(calls).toEqual([
      { path: "/api/transactions?accountId=a%2Fb&limit=200&q=rent+%26+50%25_&cursor=opaque%2B%2F%3D", method: "GET" },
      { path: "/api/transactions/export?accountId=a%2Fb", method: "GET" },
      { path: "/api/transactions", method: "GET" },
    ]);
  });
});
