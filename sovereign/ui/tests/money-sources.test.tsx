import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { AccountBalances } from "../src/components/AccountBalances";
import { canImportActivity, ImportPreviewTable, importSizeProblem } from "../src/views/ActivityImport";
import { MoneySource, PlaidItemCard, SavedMoneySource } from "../src/views/Connections";
import { LedgerHistory } from "../src/views/Ledger";
import { OverviewContent } from "../src/views/Dashboard";
import { canArchiveAccount } from "../src/views/Accounts";
import type { Account, ReadConnectionView } from "../src/types";

const at = "2026-09-29T12:00:00.000Z";
const account: Account = { id: "a", display_name: "Test checking", rail: "BANK", connector_type: "plaid", currency: "USD", decimals: 2, balance_minor: "12345678901234567890", balance_as_of: at, available_minor: null, pending_minor: "0", held_minor: null, read_connection_id: "source", read_environment: "sandbox", external_account_id: null, chain_id: null, asset_id: null, account_ref: null, credential_ref: null, vault_key_id: null, status: "ACTIVE", created_at: at };

test("balance observations keep missing values unknown and observed zero exact", () => {
  const html = renderToStaticMarkup(<AccountBalances account={account} />);
  expect(html).toContain("123,456,789,012,345,678");
  expect(html).toContain(".90");
  expect(html.match(/Not supplied/g)).toHaveLength(2);
  expect(html).toContain("Pending");
  expect(html).toContain('class="amt-whole">0');
  const unknown = renderToStaticMarkup(<AccountBalances account={{ ...account, balance_as_of: null }} />);
  expect(unknown).toContain("Not checked");
  expect(unknown).not.toContain("123,456,789");
});

test("credit balances are debt and borrowing capacity, not cash", () => {
  const html = renderToStaticMarkup(<AccountBalances account={{ ...account, account_type: "credit:creditcard" }} />);
  expect(html).toContain("Amount owed");
  expect(html).toContain("Available credit");
  expect(html).toContain("not cash you hold");
});

test("sources show sandbox provenance and truthful read-only capability", () => {
  const source: ReadConnectionView = { id: "source", provider: "plaid", environment: "sandbox", display_name: "Test bank", status: "active", last_attempt_at: at, last_success_at: null, last_error_code: null, capabilities: { accounts: true, balances: true, transactions: true, payments: false }, accounts: [{ ...account, balance_kind: "current", read_observed_at: at, read_environment: "sandbox", account_mask: "1234", account_type: "depository", available_minor: null, pending_minor: "0", held_minor: null }] };
  const html = renderToStaticMarkup(<MoneySource source={source} />);
  expect(html).toContain("Sandbox • test accounts");
  expect(html).toContain("Payments are not enabled");
  expect(html).toContain("Last successful check: Not checked");
  expect(html).toContain("ending 1234");
});

test("reconnect follows implemented disconnect/relink and owner-only controls", () => {
  const item = { id: "item", label: "Test bank", state: "reconnect_required" as const, account_count: 1, last_synced_at: null, error_code: null };
  const html = renderToStaticMarkup(<PlaidItemCard item={item} busy={false} canManage onSync={() => undefined} onDisconnect={() => undefined} />);
  expect(html).toContain("Disconnect it, then choose Connect a test bank");
  expect(html).toContain("Review disconnect");
  expect(html).toContain('disabled="">Sync test accounts');
  const readonly = renderToStaticMarkup(<PlaidItemCard item={item} busy={false} canManage={false} onSync={() => undefined} onDisconnect={() => undefined} />);
  expect(readonly).not.toContain("<button");
});

test("Base records defer to finalized evidence instead of showing legacy amount", () => {
  const html = renderToStaticMarkup(<SavedMoneySource account={{ ...account, rail: "CRYPTO", chain_id: "eip155:8453", asset_id: "eip155:8453/slip44:60", account_ref: `eip155:8453:0x${"a".repeat(40)}`, currency: "ETH", decimals: 18 }} />);
  expect(html).toContain("finalized Base balances");
  expect(html).not.toContain("amt-whole");
});

test("sandbox activity and Overview remain labeled and removed records are explicit", () => {
  const history = renderToStaticMarkup(<LedgerHistory accounts={[account]} filter="a" transactions={[{ id: "tx", account_id: "a", external_id: null, title: "Old pending entry", amount_minor: "-125", category: null, date: at, source: "CONNECTOR", created_at: at, status: "removed" }]} />);
  expect(history).toContain("Sandbox • test accounts");
  expect(history).toContain(">removed<");
  const overview = renderToStaticMarkup(<OverviewContent accounts={[{ ...account, account_type: "credit" }]} summary={[]} positions={[]} onGoto={() => undefined} />);
  expect(overview).toContain("Sandbox • test accounts");
  expect(overview).toContain("Amount owed");
});

test("CSV preview escapes imported text, retains exact units and discloses unchanged balances", () => {
  const html = renderToStaticMarkup(<ImportPreviewTable preview={{ preview_hash: "hash", account_id: "a", currency: "USD", decimals: 2, row_count: 1, duplicate_count: 0, distinct_rows: [], rows: [{ row_id: "row", external_id: "row", matched_existing: false, already_recorded: false, distinct_reference: null, date: at, title: "<script>bad</script>", amount_minor: "-12345678901234567890", currency: "USD", category: null }] }} />);
  expect(html).toContain("&lt;script&gt;");
  expect(html).not.toContain("<script>");
  expect(html).toContain("123,456,789,012,345,678");
  expect(html).toContain("does not change balances or move money");
  expect(importSizeProblem(" ")).toContain("Choose a CSV");
  expect(importSizeProblem("£".repeat(500001))).toContain("1 MB");
  expect(importSizeProblem("date,title,amount,currency\n2026-09-29,Test,1.00,USD")).toBeNull();
});

test("CSV match review exposes individual choices and hides outdated outcome counts", () => {
  const preview = { preview_hash: "hash", account_id: "a", currency: "USD", decimals: 2, row_count: 1, duplicate_count: 1, distinct_rows: [], rows: [{ row_id: "row", external_id: "row", matched_existing: true, already_recorded: true, distinct_reference: null, date: at, title: "Coffee", amount_minor: "-450", currency: "USD" }] };
  const html = renderToStaticMarkup(<ImportPreviewTable preview={preview} onChoice={() => undefined} />);
  expect(html).toContain("0 will be added; 1 already recorded will be skipped");
  expect(html).toContain('aria-label="Keep as a separate transaction: row 1, Coffee"');
  expect(html).toContain("case-sensitive and specific to this account");
  const changed = renderToStaticMarkup(<ImportPreviewTable preview={preview} choices={[{ row_id: "row", reference: "Statement 18" }]} changed onChoice={() => undefined} />);
  expect(changed).toContain("Update the preview");
  expect(changed).toContain("Reusable reference for row 1");
  expect(changed).not.toContain("0 will be added");
});

test("CSV imports are restricted to active manual destinations to avoid provider duplication", () => {
  expect(canImportActivity(account)).toBe(false);
  expect(canImportActivity({ ...account, connector_type: null })).toBe(false);
  expect(canImportActivity({ ...account, connector_type: null, read_connection_id: null })).toBe(true);
  expect(canImportActivity({ ...account, connector_type: null, read_connection_id: null, status: "ARCHIVED" })).toBe(false);
});

test("Plaid accounts can be archived only after a confirmed disconnect", () => {
  expect(canArchiveAccount(account)).toBe(false);
  expect(canArchiveAccount({ ...account, read_connection_status: "active" })).toBe(false);
  expect(canArchiveAccount({ ...account, read_connection_status: "reconnect_required" })).toBe(false);
  expect(canArchiveAccount({ ...account, read_connection_status: "disconnected" })).toBe(true);
  expect(canArchiveAccount({ ...account, connector_type: "stripe" })).toBe(true);
  expect(canArchiveAccount({ ...account, connector_type: null, read_connection_id: null })).toBe(true);
});
