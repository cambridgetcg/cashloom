import { afterEach, beforeAll, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AssistAccessCreated, AssistContext, AssistProposalInput, AssistProposalResult } from "./contracts";

// The actual API/vault imports are deliberately delayed until isolation exists.
process.env.CASHLOOM_DATA_DIR = mkdtempSync(join(tmpdir(), "cashloom-assist-test-"));
const { db } = await import("../db");
const vault = await import("../vault");
const { app, requiredScopeForLocalRoute } = await import("../index");
const passphrase = "synthetic test workspace passphrase";
// Each initialize/unlock is one Argon2id derivation (64 MiB, t=3), about 2 s on a GitHub
// runner. The hook and test that run two or three of them get this instead of bun's 5 s default.
const KDF_TIMEOUT_MS = 30_000;
let owner: string, accountId: string, otherId: string, transactionId: string;
const request = (path: string, token: string, body?: unknown) => app.request(path, { method: body === undefined ? "GET" : "POST",
  headers: { Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { "Content-Type": "application/json" }) }, body: body === undefined ? undefined : JSON.stringify(body) });
const grantInput = () => ({ label: "Statement helper", account_ids: [accountId], allow_proposals: true, ttl_minutes: 60 });
async function create(allow = true): Promise<AssistAccessCreated> {
  const response = await request("/api/assist/access", owner, { ...grantInput(), allow_proposals: allow });
  expect(response.status).toBe(201); return response.json() as Promise<AssistAccessCreated>;
}
async function proposalInput(token: string): Promise<AssistProposalInput> {
  const context = await (await request("/api/assist/context", token)).json() as AssistContext;
  return { request_id: crypto.randomUUID(), transaction_id: transactionId, expected_record_version: context.transactions.find((row) => row.id === transactionId)!.record_version, category: "Travel", reason: "An owner should review this category.\nNo money movement is proposed." };
}
beforeAll(async () => {
  await vault.initialize(passphrase); owner = await vault.unlock(passphrase);
  accountId = crypto.randomUUID(); otherId = crypto.randomUUID(); transactionId = crypto.randomUUID();
  for (const id of [accountId, otherId]) db.query("INSERT INTO accounts(id,display_name,rail,currency,decimals,balance_minor,credential_ref,external_account_id,vault_key_id,account_ref) VALUES(?,'Test account','BANK','USD',2,'12300','PRIVATE_CREDENTIAL','PRIVATE_EXTERNAL','PRIVATE_KEY','PRIVATE_ADDRESS')").run(id);
  db.query("INSERT INTO transactions(id,account_id,title,amount_minor,date,raw) VALUES(?,?,'Bus','-240','2026-09-29T12:00:00.000Z','PRIVATE_RAW')").run(transactionId, accountId);
}, KDF_TIMEOUT_MS);
afterEach(() => { if (vault.isValidSession(owner)) for (const access of vault.listAssistAccess(owner)) vault.revokeAssistAccess(owner, access.id); });

test("exact methods are scoped and new grants cannot use general wallet, payment, key or trade APIs", async () => {
  expect(requiredScopeForLocalRoute("GET", "/api/assist/context")).toBe("assist:read");
  expect(requiredScopeForLocalRoute("POST", "/api/assist/context")).toBeUndefined();
  expect(requiredScopeForLocalRoute("POST", "/api/assist/proposals")).toBe("assist:propose");
  expect(requiredScopeForLocalRoute("GET", "/api/assist/proposals")).toBe("assist:read");
  expect(requiredScopeForLocalRoute("GET", "/api/assist/review")).toBe("accounts:read");
  expect(requiredScopeForLocalRoute("POST", "/api/assist/review")).toBeUndefined();
  const { token, access } = await create();
  expect(vault.getSessionInfo(token)).toMatchObject({ scopes: ["assist:propose", "assist:read"], principal: { kind: "agent", ref: access.id } });
  for (const path of ["/api/accounts", "/api/transactions", "/api/transactions/export", "/api/payments", "/api/wallet/v3/positions", "/api/connections", "/api/vault/keys", "/api/tcg/trades", "/api/assist/access", "/api/assist/review"]) {
    expect((await request(path, token)).status).toBe(403);
  }
  for (const path of ["/api/pay/quote", "/api/pay/confirm", "/api/pay/agent/authorize", "/api/accounts", "/api/vault/sessions", "/api/vault/lock", "/api/assist/access", `/api/assist/proposals/${crypto.randomUUID()}/accept`, `/api/assist/proposals/${crypto.randomUUID()}/reject`]) {
    expect((await request(path, token, {})).status).toBe(403);
  }
  expect(db.query("SELECT COUNT(*) AS n FROM payments").get()).toEqual({ n: 0 });
  expect(db.query("SELECT COUNT(*) AS n FROM vault_keys").get()).toEqual({ n: 0 });
});

test("owner-controlled grants list no tokens, stay account-scoped, and revoke individually", async () => {
  const first = await create(), second = await create();
  expect(Date.parse(first.access.expires_at)).toBeLessThanOrEqual(Date.parse(vault.getSessionInfo(owner)!.expiresAt));
  const listing = await (await request("/api/assist/access", owner)).json();
  expect(listing.access).toHaveLength(2);
  for (const forbidden of [first.token, second.token, '"token"']) expect(JSON.stringify(listing)).not.toContain(forbidden);
  const context = await (await request("/api/assist/context?limit=1", first.token)).json() as AssistContext;
  expect(context.accounts.map((row) => row.id)).toEqual([accountId]);
  expect(context.accounts[0].balance_minor).toBeNull();
  for (const forbidden of ["PRIVATE_CREDENTIAL", "PRIVATE_EXTERNAL", "PRIVATE_KEY", "PRIVATE_ADDRESS", "PRIVATE_RAW"]) expect(JSON.stringify(context)).not.toContain(forbidden);
  expect((await request(`/api/assist/context?account_id=${otherId}`, first.token)).status).toBe(403);
  expect((await request(`/api/assist/context?limit=101`, first.token)).status).toBe(400);
  expect((await request(`/api/assist/context?include_secrets=true`, first.token)).status).toBe(400);
  expect(await (await request(`/api/assist/access/${first.access.id}/revoke`, owner, {})).json()).toEqual({ ok: true, revoked: true });
  expect((await request("/api/assist/context", first.token)).status).toBe(401);
  expect((await request("/api/assist/context", second.token)).status).toBe(200);
  expect(await (await request(`/api/assist/access/${first.access.id}/revoke`, owner, {})).json()).toEqual({ ok: true, revoked: false });
});

test("read-only grants cannot propose; proposals retain attribution, replay and survive revocation for owner review", async () => {
  const readOnly = await create(false), writer = await create(), other = await create();
  expect((await request("/api/assist/proposals", readOnly.token, await proposalInput(readOnly.token))).status).toBe(403);
  const body = await proposalInput(writer.token);
  const response = await request("/api/assist/proposals", writer.token, body);
  expect(response.status).toBe(201);
  const created = await response.json() as AssistProposalResult;
  expect(created.proposal).toMatchObject({ access_label: writer.access.label, grant_id: writer.access.id, category: "Travel", status: "pending" });
  expect((await (await request("/api/assist/proposals", writer.token, body)).json()).replayed).toBe(true);
  expect((await request("/api/assist/proposals", writer.token, { ...body, category: "Another" })).status).toBe(409);
  expect((await (await request("/api/assist/proposals", other.token)).json()).proposals).toHaveLength(0);
  vault.revokeAssistAccess(owner, writer.access.id);
  expect((await request("/api/assist/proposals", writer.token, body)).status).toBe(401);
  const reviewed = await request(`/api/assist/proposals/${created.proposal.id}/accept`, owner, { expected_record_version: body.expected_record_version });
  expect(reviewed.status).toBe(200);
  expect((await reviewed.json()).proposal.status).toBe("accepted");
  expect(db.query("SELECT category FROM transactions WHERE id=?").get(transactionId)).toEqual({ category: "Travel" });
  expect(db.query("SELECT balance_minor FROM accounts WHERE id=?").get(accountId)).toEqual({ balance_minor: "12300" });
  db.query("UPDATE transactions SET category=NULL WHERE id=?").run(transactionId);
});

test("grant input bounds and active-account checks cannot broaden authority", async () => {
  for (const patch of [{ label: "" }, { label: "a".repeat(81) }, { label: "bad\nlabel" }, { account_ids: [] }, { account_ids: [accountId, accountId] }, { ttl_minutes: 0 }, { ttl_minutes: 61 }, { ttl_minutes: 1.5 }, { scopes: ["accounts:read"] }]) {
    expect((await request("/api/assist/access", owner, { ...grantInput(), ...patch })).status).toBe(400);
  }
  expect((await request("/api/assist/access", owner, { ...grantInput(), account_ids: [crypto.randomUUID()] })).status).toBe(409);
  db.query("UPDATE accounts SET status='ARCHIVED' WHERE id=?").run(otherId);
  expect((await request("/api/assist/access", owner, { ...grantInput(), account_ids: [otherId] })).status).toBe(409);
  db.query("UPDATE accounts SET status='ACTIVE' WHERE id=?").run(otherId);
  for (let n = 0; n < 20; n++) await create();
  expect((await request("/api/assist/access", owner, grantInput())).status).toBe(409);
});

async function delayedBody(path: string, token: string, payload: unknown, duringRead: () => void | Promise<void>): Promise<Response> {
  let finish!: (value?: unknown) => void;
  const held = new Promise((resolve) => { finish = resolve; });
  const stream = new ReadableStream<Uint8Array>({ async start(controller) {
    await held; controller.enqueue(new TextEncoder().encode(JSON.stringify(payload))); controller.close();
  } });
  const pending = app.request(path, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: stream, duplex: "half" } as RequestInit);
  // Hono has entered its authenticated handler and is waiting for the body.
  await Bun.sleep(5); await duringRead(); finish(); return pending;
}

test("revocation during body read prevents submission and lock/re-unlock cannot revive an old owner approval", async () => {
  const writer = await create(), body = await proposalInput(writer.token);
  const pending = await delayedBody("/api/assist/proposals", writer.token, body, () => { vault.revokeAssistAccess(owner, writer.access.id); });
  expect(pending.status).toBe(403);
  expect(db.query("SELECT COUNT(*) AS n FROM assist_proposals WHERE grant_id=?").get(writer.access.id)).toEqual({ n: 0 });
  const next = await create();
  const input = await proposalInput(next.token);
  const { proposal } = await (await request("/api/assist/proposals", next.token, input)).json() as AssistProposalResult;
  const priorOwner = owner;
  const outcome = await delayedBody(`/api/assist/proposals/${proposal.id}/accept`, priorOwner, { expected_record_version: input.expected_record_version }, async () => {
    vault.lock(); owner = await vault.unlock(passphrase);
  });
  expect(outcome.status).toBe(403);
  expect(db.query("SELECT category FROM transactions WHERE id=?").get(transactionId)).toEqual({ category: null });
  expect((await request("/api/assist/context", next.token)).status).toBe(401);
  expect((await (await request("/api/assist/access", owner)).json()).access).toHaveLength(0);
});

test("creation rechecks owner after body read and preserves narrow owner requirements", async () => {
  const restricted = await vault.unlock(passphrase, { scopes: ["keys:manage"] });
  expect((await request("/api/assist/access", restricted, grantInput())).status).toBe(403);
  expect((await request("/api/assist/access", restricted)).status).toBe(200);
  const accountReader = await vault.unlock(passphrase, { scopes: ["accounts:read"] });
  expect((await request("/api/assist/review", accountReader)).status).toBe(200);
  expect((await request("/api/assist/proposals", accountReader)).status).toBe(403);
  expect((await request("/api/assist/access", accountReader)).status).toBe(403);
  const priorOwner = owner;
  const response = await delayedBody("/api/assist/access", owner, grantInput(), async () => { vault.lock(); owner = await vault.unlock(passphrase); });
  expect(response.status).toBe(403); expect(vault.isValidSession(priorOwner)).toBe(false);
  expect(vault.listAssistAccess(owner)).toHaveLength(0);
}, KDF_TIMEOUT_MS);

test("expiry caps child lifetime and expired grants cannot regain access after later owner unlock", async () => {
  const shortOwner = await vault.unlock(passphrase, { ttlMs: 20 });
  const grant = vault.createAssistAccess(shortOwner, grantInput());
  expect(grant.access.expires_at).toBe(vault.getSessionInfo(shortOwner)!.expiresAt);
  await Bun.sleep(30);
  expect((await request("/api/assist/context", grant.token)).status).toBe(401);
  expect(vault.listAssistAccess(owner).some((entry) => entry.id === grant.access.id)).toBe(false);
});

test("bounded strict JSON refuses oversized and injected proposal fields without an effect", async () => {
  const writer = await create(), body = await proposalInput(writer.token);
  const before = (db.query("SELECT COUNT(*) AS n FROM assist_proposals").get() as { n: number }).n;
  expect((await request("/api/assist/proposals", writer.token, { ...body, reason: "x".repeat(16_385) })).status).toBe(413);
  expect((await request("/api/assist/proposals", writer.token, { ...body, grant_id: crypto.randomUUID() })).status).toBe(400);
  expect((await request("/api/assist/proposals", writer.token, { ...body, reason: "bad\u0000reason" })).status).toBe(400);
  expect((db.query("SELECT COUNT(*) AS n FROM assist_proposals").get() as { n: number }).n).toBe(before);
});

test("owner tokens cannot act as Assist agents and broad delegated readers cannot review owner suggestions", async () => {
  for (const path of ["/api/assist/context", "/api/assist/proposals"]) {
    expect((await request(path, owner)).status).toBe(403);
  }
  const reader = vault.createDelegatedAgentSession(owner, { delegateKeyId: `sha256:${"a".repeat(64)}`, scopes: ["accounts:read"] });
  expect((await request("/api/assist/review", reader.token)).status).toBe(403);
  const writer = await create();
  const { proposal } = await (await request("/api/assist/proposals", writer.token, await proposalInput(writer.token))).json() as AssistProposalResult;
  const review = await request("/api/assist/review", owner);
  expect(review.status).toBe(200);
  expect((await review.json()).proposals.some((entry: { id: string }) => entry.id === proposal.id)).toBe(true);
  expect((await request("/api/assist/review", writer.token)).status).toBe(403);
  expect((await (await request("/api/assist/proposals", writer.token)).json()).proposals.map((entry: { id: string }) => entry.id)).toEqual([proposal.id]);
});
