import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { AccessForm, canApplySuggestion, SuggestionCard } from "../src/views/AgentAccess";
import { api, setToken } from "../src/api";
import { PUBLIC_WORLD_URL, WALLET_VIEWS } from "../src/navigation";
import type { Account, AssistProposal } from "../src/types";

const account: Account = { id: "a", rail: "CASH", connector_type: null, display_name: "Test account", currency: "USD", decimals: 2, balance_minor: "5000", balance_as_of: null, external_account_id: null, chain_id: null, asset_id: null, account_ref: null, credential_ref: null, vault_key_id: null, status: "ACTIVE", created_at: "2026-09-29T00:00:00Z", read_environment: "sandbox" };
const proposal: AssistProposal = {
  id: "p", grant_id: "g", access_label: "Local helper", account_id: "a", transaction_id: "t", category: "Groceries", reason: '<img src="https://not-requested.invalid" onerror="alert(1)">',
  before: { id: "t", account_id: "a", title: "Shop", amount_minor: "-1234", currency: "USD", decimals: 2, date: "2026-09-29T12:00:00Z", category: null, status: "posted", source: "CSV", is_internal_transfer: false, record_version: `sha256:${"1".repeat(64)}` },
  status: "pending", review_state: "current", created_at: "2026-09-29T12:01:00Z", decided_at: null,
};

test("agent access is a Setup destination and public money context goes to the insights route", () => {
  expect(WALLET_VIEWS.find(view => view.id === "assist")).toEqual({ id: "assist", label: "Agent access", path: "assist", group: "Setup" });
  expect(PUBLIC_WORLD_URL).toBe("https://cashloom.io/world");
});

test("access begins with no accounts or proposal permission selected", () => {
  const html = renderToStaticMarkup(<AccessForm accounts={[account, { ...account, id: "archived", display_name: "Archived account", status: "ARCHIVED" }]} busy={false} onCreate={() => undefined} />);
  expect(html).toContain('aria-label="Create agent access"');
  expect(html).not.toContain('checked=""');
  expect(html).toContain('disabled="">Create access');
  expect(html).not.toContain("Archived account");
  expect(html).toContain("not a verified agent identity");
  expect(html).toContain("client or model provider may retain records");
  expect(html).toContain("cannot outlast the issuing owner session");
});

test("only pending suggestions for the current record can be applied", () => {
  for (const status of ["pending", "accepted", "rejected", "stale"] as const) for (const review_state of ["current", "changed", "unavailable"] as const) {
    expect(canApplySuggestion({ ...proposal, status, review_state })).toBe(status === "pending" && review_state === "current");
  }
});

test("suggestion review keeps exact amount, old/new categories, sandbox and untrusted explanation visible", () => {
  const html = renderToStaticMarkup(<SuggestionCard proposal={proposal} account={account} busy={false} onAccept={() => undefined} onReject={() => undefined} />);
  expect(html).toContain('aria-label="Category suggestion for Shop"');
  expect(html.replace(/<[^>]+>/g, "")).toContain("12.34");
  expect(html).toContain("Uncategorised");
  expect(html).toContain("Groceries");
  expect(html).toContain("Sandbox • test accounts");
  expect(html).toContain("2026-09-29");
  expect(html).toContain("&lt;img");
  expect(html).not.toContain("<img");
  expect(html).toContain("does not verify who or what");
});

test("changed and unavailable suggestions block applying while allowing owner rejection", () => {
  for (const review_state of ["changed", "unavailable"] as const) {
    const html = renderToStaticMarkup(<SuggestionCard proposal={{ ...proposal, review_state }} busy={false} onAccept={() => undefined} onReject={() => undefined} />);
    expect(html).toContain('disabled="">Apply category');
    expect(html).toContain('class="btn btn-ghost">Reject suggestion');
  }
  const html = renderToStaticMarkup(<SuggestionCard proposal={{ ...proposal, status: "accepted", decided_at: "2026-09-29T12:02:00Z" }} busy={false} onAccept={() => undefined} onReject={() => undefined} />);
  expect(html).toContain("Category applied");
  expect(html).not.toContain(">Apply category<");
  expect(html).not.toContain(">Reject suggestion<");
});

test("agent-management API routes bind acceptance to the exact reviewed record version", async () => {
  const original = globalThis.fetch;
  const calls: Array<{ path: string; method: string; body: unknown }> = [];
  globalThis.fetch = (async (path, init) => { calls.push({ path: String(path), method: init?.method ?? "GET", body: init?.body ? JSON.parse(String(init.body)) : null }); return Response.json({ ok: true }); }) as typeof fetch;
  try {
    await api.assistAccess(); await api.assistProposals();
    await api.createAssistAccess({ label: "Helper", account_ids: ["a"], allow_proposals: false, ttl_minutes: 15 });
    await api.revokeAssistAccess("g/id"); await api.acceptAssistProposal("p/id", proposal.before.record_version); await api.rejectAssistProposal("p/id");
  } finally { globalThis.fetch = original; }
  expect(calls).toEqual([
    { path: "/api/assist/access", method: "GET", body: null },
    { path: "/api/assist/review", method: "GET", body: null },
    { path: "/api/assist/access", method: "POST", body: { label: "Helper", account_ids: ["a"], allow_proposals: false, ttl_minutes: 15 } },
    { path: "/api/assist/access/g%2Fid/revoke", method: "POST", body: {} },
    { path: "/api/assist/proposals/p%2Fid/accept", method: "POST", body: { expected_record_version: proposal.before.record_version } },
    { path: "/api/assist/proposals/p%2Fid/reject", method: "POST", body: {} },
  ]);
});

test("a late credential response cannot cross an owner lock or session replacement", async () => {
  const original = globalThis.fetch;
  try {
    for (const next of [null, crypto.randomUUID()]) {
      let resolve!: (response: Response) => void;
      globalThis.fetch = (() => new Promise<Response>(done => { resolve = done; })) as typeof fetch;
      setToken(crypto.randomUUID());
      let delivered = false;
      const pending = api.createAssistAccess({ label: "Helper", account_ids: ["a"], allow_proposals: false, ttl_minutes: 5 }).then(() => { delivered = true; });
      setToken(next);
      resolve(Response.json({ access: {}, token: crypto.randomUUID() }));
      await expect(pending).rejects.toThrow("Your session changed");
      expect(delivered).toBe(false);
    }
  } finally { globalThis.fetch = original; setToken(null); }
});
