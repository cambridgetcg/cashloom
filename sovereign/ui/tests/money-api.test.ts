import { expect, test } from "bun:test";
import { api, currentSessionGuard, setToken } from "../src/api";

test("money reads and mutations preserve explicit private routes and reviewed inputs", async () => {
  const original = globalThis.fetch;
  const calls: Array<{ path: string; method: string; body: unknown }> = [];
  globalThis.fetch = (async (path, init) => { calls.push({ path: String(path), method: init?.method ?? "GET", body: init?.body ? JSON.parse(String(init.body)) : null }); return Response.json({ ok: true }); }) as typeof fetch;
  try {
    await api.connections(); await api.plaidLink(); await api.plaidExchange("attempt", "synthetic-public-token");
    await api.plaidSync("item/id"); await api.plaidDisconnect("item/id"); await api.transferReview();
    await api.linkTransfer("out", "in"); await api.unlinkTransfer("link/id");
    await api.previewImport("account", "csv-text"); await api.importTransactions("account", "csv-text", "review-hash");
    await api.exportTransactions("account/id");
  } finally { globalThis.fetch = original; }
  expect(calls).toEqual([
    { path: "/api/connections", method: "GET", body: null },
    { path: "/api/connections/plaid/link", method: "POST", body: {} },
    { path: "/api/connections/plaid/exchange", method: "POST", body: { attempt_id: "attempt", public_token: "synthetic-public-token" } },
    { path: "/api/connections/plaid/item%2Fid/sync", method: "POST", body: {} },
    { path: "/api/connections/plaid/item%2Fid/disconnect", method: "POST", body: {} },
    { path: "/api/transfers", method: "GET", body: null },
    { path: "/api/transfers/link", method: "POST", body: { outgoing_id: "out", incoming_id: "in" } },
    { path: "/api/transfers/link%2Fid/unlink", method: "POST", body: {} },
    { path: "/api/transactions/import/preview", method: "POST", body: { account_id: "account", csv: "csv-text" } },
    { path: "/api/transactions/import", method: "POST", body: { account_id: "account", csv: "csv-text", preview_hash: "review-hash" } },
    { path: "/api/transactions/export?accountId=account%2Fid", method: "GET", body: null },
  ]);
});

test("Link and file callbacks lose authority after lock and re-unlock", () => {
  try {
    setToken(null); expect(currentSessionGuard()()).toBe(false);
    setToken("synthetic-one"); const current = currentSessionGuard(); expect(current()).toBe(true);
    setToken(null); expect(current()).toBe(false);
    setToken("synthetic-two"); expect(current()).toBe(false);
  } finally { setToken(null); }
});

test("separate-entry choices are sent unchanged to both preview and confirmation", async () => {
  const original = globalThis.fetch;
  const bodies: unknown[] = [];
  globalThis.fetch = (async (_path, init) => { bodies.push(JSON.parse(String(init?.body))); return Response.json({ ok: true }); }) as typeof fetch;
  const choices = [{ row_id: "csv:row:1", reference: "Statement 18" }];
  try {
    await api.previewImport("account", "csv", choices);
    await api.importTransactions("account", "csv", "review", choices);
  } finally { globalThis.fetch = original; }
  expect(bodies).toEqual([
    { account_id: "account", csv: "csv", distinct_rows: choices },
    { account_id: "account", csv: "csv", preview_hash: "review", distinct_rows: choices },
  ]);
});
