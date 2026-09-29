import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { canRecordManualBalance, ManualBalanceEditor, manualBalanceRequest } from "../src/views/Accounts";
import type { Account } from "../src/types";

const account = (overrides: Partial<Account> = {}): Account => ({
  id: "cash-fixture", rail: "CASH", connector_type: null, display_name: "Pocket",
  currency: "GBP", decimals: 2, balance_minor: "0", balance_as_of: null,
  external_account_id: null, chain_id: null, asset_id: null, account_ref: null,
  credential_ref: null, vault_key_id: null, status: "ACTIVE", created_at: "2026-09-23T00:00:00.000Z",
  ...overrides,
});

describe("manual balance entry", () => {
  test("allows only active manual non-crypto accounts", () => {
    expect(canRecordManualBalance(account())).toBe(true);
    expect(canRecordManualBalance(account({ rail: "BANK" }))).toBe(true);
    expect(canRecordManualBalance(account({ rail: "CRYPTO" }))).toBe(false);
    expect(canRecordManualBalance(account({ connector_type: "gocardless" }))).toBe(false);
    expect(canRecordManualBalance(account({ read_connection_id: "connected-source" }))).toBe(false);
    expect(canRecordManualBalance(account({ status: "ARCHIVED" }))).toBe(false);
  });

  test("parses large decimal amounts exactly and preserves the previous observation", () => {
    const previous = account({ balance_minor: "123", balance_as_of: "2026-09-23T12:00:00.000Z" });
    expect(manualBalanceRequest(previous, "9,223,372,036,854,775,808.99")).toEqual({
      balance_minor: "922337203685477580899", expected_balance_minor: "123", expected_balance_as_of: previous.balance_as_of,
    });
    expect(manualBalanceRequest(account(), "-25.50").balance_minor).toBe("-2550");
    expect(manualBalanceRequest(account(), "-0.00").balance_minor).toBe("0");
    expect(manualBalanceRequest(account(), "0")).toMatchObject({ balance_minor: "0", expected_balance_as_of: null });
  });

  test("rejects excessive precision, missing balances, exponents and oversized amounts", () => {
    for (const input of ["", "1.001", "1e8", "not a number", "9".repeat(121)]) {
      expect(() => manualBalanceRequest(account(), input)).toThrow();
    }
    expect(() => manualBalanceRequest(account({ rail: "CRYPTO" }), "1")).toThrow();
  });

  test("asks for a first observation without prefilling the default zero", () => {
    const html = renderToStaticMarkup(<ManualBalanceEditor account={account()} onSaved={() => undefined} onCancel={() => undefined} />);
    expect(html).toContain("No balance recorded yet");
    expect(html).toContain('value=""');
    expect(html).toContain("Balance (GBP)");
    expect(html).toContain("does not add an activity entry or move money");
    expect(html).toContain("Record balance");
  });

  test("shows a saved observation and preserves its exact amount for review", () => {
    const html = renderToStaticMarkup(<ManualBalanceEditor account={account({ balance_minor: "123456", balance_as_of: "2026-09-23T12:00:00.000Z" })} onSaved={() => undefined} onCancel={() => undefined} />);
    expect(html).toContain("Saved: 1,234.56 GBP");
    expect(html).toContain('value="1,234.56"');
  });
});
