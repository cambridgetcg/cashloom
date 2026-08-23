import { beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.CASHLOOM_DATA_DIR = mkdtempSync(join(tmpdir(), "cashloom-local-api-test-"));

const { db, newId } = await import("./db.ts");
const vault = await import("./vault.ts");
const {
  app,
  isCustodyBindAllowed,
  isRequestHostAllowed,
  requiredScopeForLocalRoute,
} = await import("./index.ts");

const PASSPHRASE = "correct horse battery staple";
let readToken = "";
let ownerToken = "";

const authorized = (token: string, init: RequestInit = {}): RequestInit => ({
  ...init,
  headers: {
    ...init.headers,
    Authorization: `Bearer ${token}`,
    ...(init.body ? { "Content-Type": "application/json" } : {}),
  },
});

beforeAll(async () => {
  await vault.initialize(PASSPHRASE);
  readToken = await vault.unlock(PASSPHRASE, { scopes: ["accounts:read"] });
  ownerToken = await vault.unlock(PASSPHRASE);
});

describe("local API vault-session authority", () => {
  it("maps every private route family to its least required scope", () => {
    expect(requiredScopeForLocalRoute("GET", "/api/vault/keys")).toBe("keys:manage");
    expect(requiredScopeForLocalRoute("POST", "/api/accounts")).toBe("accounts:write");
    expect(requiredScopeForLocalRoute("GET", "/api/accounts")).toBe("accounts:read");
    expect(requiredScopeForLocalRoute("POST", "/api/accounts/a/sync")).toBe("accounts:write");
    expect(requiredScopeForLocalRoute("POST", "/api/transactions")).toBe("accounts:write");
    expect(requiredScopeForLocalRoute("GET", "/api/analytics/summary")).toBe("accounts:read");
    expect(requiredScopeForLocalRoute("POST", "/api/pay/quote")).toBe("payments:quote");
    expect(requiredScopeForLocalRoute("POST", "/api/pay/confirm")).toBe("payments:confirm");
    expect(requiredScopeForLocalRoute("POST", "/api/pay/recover")).toBe("payments:confirm");
    expect(requiredScopeForLocalRoute("POST", "/api/pay/agent/authorize")).toBe("agent:authorize");
    expect(requiredScopeForLocalRoute("POST", "/api/pay/agent/confirm")).toBe("agent:authorize");
    expect(requiredScopeForLocalRoute("POST", "/api/vault/sessions")).toBe("keys:manage");
    expect(requiredScopeForLocalRoute("GET", "/api/payments")).toBe("accounts:read");
    expect(requiredScopeForLocalRoute("GET", "/api/wallet/v2/positions")).toBe("accounts:read");
    expect(requiredScopeForLocalRoute("GET", "/api/wallet/v2/intents/example")).toBe("accounts:read");
    expect(
      requiredScopeForLocalRoute("POST", "/api/wallet/v2/intents/example/reconcile"),
    ).toBe("accounts:write");
  });

  it("mints actor-bound agent sessions without ever delegating human confirmation", async () => {
    const minted = await app.request(
      "/api/vault/sessions",
      authorized(ownerToken, {
        method: "POST",
        body: JSON.stringify({
          trust: {
            walletId: "wallet.agent-test",
            descriptorRecordId: `sha256:${"b".repeat(64)}`,
            ownerKeyId: `sha256:${"c".repeat(64)}`,
            grantId: "grant.agent-test",
            capabilityRecordId: `sha256:${"d".repeat(64)}`,
            delegateKeyId: `sha256:${"a".repeat(64)}`,
            trustedSimulationAdapterKeyIds: [`sha256:${"e".repeat(64)}`],
          },
          scopes: ["accounts:read", "payments:quote", "agent:authorize"],
          ttlMs: 60_000,
        }),
      }),
    );
    expect(minted.status).toBe(201);
    const body = await minted.json() as {
      token: string;
      session: { principal: { kind: string; ref: string }; scopes: string[] };
    };
    expect(body.session.principal).toEqual({ kind: "agent", ref: `sha256:${"a".repeat(64)}` });
    expect(body.session.scopes).not.toContain("payments:confirm");

    const bypass = await app.request(
      "/api/pay/confirm",
      authorized(body.token, { method: "POST", body: JSON.stringify({ paymentId: newId() }) }),
    );
    expect(bypass.status).toBe(403);
    expect(await bypass.json()).toMatchObject({ error: "insufficient_scope" });

    const boundRoute = await app.request(
      "/api/pay/agent/confirm",
      authorized(body.token, {
        method: "POST",
        body: JSON.stringify({
          paymentId: newId(),
          agentAuthorizationId: newId(),
        }),
      }),
    );
    expect(boundRoute.status).toBe(403);
    expect(await boundRoute.json()).toMatchObject({ error: "base_agent_proposal_only" });
  });

  it("rejects hostile Host and Origin values before vault endpoints", async () => {
    expect(isCustodyBindAllowed("127.0.0.1")).toBe(true);
    expect(isCustodyBindAllowed("::1")).toBe(true);
    expect(isCustodyBindAllowed("0.0.0.0")).toBe(false);
    expect(isCustodyBindAllowed("192.168.1.10")).toBe(false);
    expect(isRequestHostAllowed("127.0.0.1", new Set(), "localhost")).toBe(true);
    expect(isRequestHostAllowed("0.0.0.0", new Set(["cashloom.local"]), "127.0.0.1")).toBe(false);
    expect(isRequestHostAllowed("0.0.0.0", new Set(["cashloom.local"]), "cashloom.local")).toBe(true);

    const hostileHost = await app.request(new Request("http://attacker.example/api/vault/init", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ passphrase: "attacker controls this" }),
    }));
    expect(hostileHost.status).toBe(403);
    expect(await hostileHost.json()).toMatchObject({ error: "host_not_allowed" });

    const forgedHeader = await app.request("http://localhost/api/meta", {
      headers: { Host: "attacker.example" },
    });
    expect(forgedHeader.status).toBe(403);

    const hostileOrigin = await app.request("/api/meta", {
      headers: { Origin: "https://attacker.example", "Sec-Fetch-Site": "cross-site" },
    });
    expect(hostileOrigin.status).toBe(403);
    expect(await hostileOrigin.json()).toMatchObject({ error: "origin_not_allowed" });

    const sameOrigin = await app.request("http://localhost/api/meta", {
      headers: { Origin: "http://localhost", "Sec-Fetch-Site": "same-origin" },
    });
    expect(sameOrigin.status).toBe(200);
  });

  it("requires explicit CAIP routing identity for every new crypto account", async () => {
    const common = {
      rail: "CRYPTO",
      display_name: "Base USDC",
      currency: "USDC",
      decimals: 6,
      external_account_id: `0x${"1".repeat(40)}`,
    };
    const missing = await app.request(
      "/api/accounts",
      authorized(ownerToken, { method: "POST", body: JSON.stringify(common) }),
    );
    expect(missing.status).toBe(400);

    const chain = "eip155:8453";
    const created = await app.request(
      "/api/accounts",
      authorized(ownerToken, {
        method: "POST",
        body: JSON.stringify({
          ...common,
          chain_id: chain,
          asset_id: `${chain}/erc20:0x833589fcd6edb6e08f4c7c32d4f71b54bda02913`,
          account_ref: `${chain}:0x${"1".repeat(40)}`,
        }),
      }),
    );
    expect(created.status).toBe(201);
    expect(await created.json()).toMatchObject({
      account: { chain_id: chain, currency: "USDC" },
    });
  });

  it("returns 401 for no session and 403 with the missing capability for a narrow session", async () => {
    const missing = await app.request("/api/accounts");
    expect(missing.status).toBe(401);

    const allowed = await app.request("/api/accounts", authorized(readToken));
    expect(allowed.status).toBe(200);

    const unmapped = await app.request("/api/private-future", authorized(readToken));
    expect(unmapped.status).toBe(403);
    expect(await unmapped.json()).toMatchObject({ error: "route_scope_unmapped" });

    for (const [path, method, scope] of [
      ["/api/vault/keys", "GET", "keys:manage"],
      ["/api/accounts", "POST", "accounts:write"],
      ["/api/pay/quote", "POST", "payments:quote"],
      ["/api/pay/confirm", "POST", "payments:confirm"],
      ["/api/pay/agent/authorize", "POST", "agent:authorize"],
    ] as const) {
      const response = await app.request(path, authorized(readToken, { method }));
      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({
        error: "insufficient_scope",
        required_scope: scope,
      });
    }
  });

  it("keeps passphrase-only unlock backward compatible with all scopes", async () => {
    const response = await app.request("/api/vault/unlock", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ passphrase: PASSPHRASE }),
    });
    expect(response.status).toBe(200);
    const { token } = await response.json() as { token: string };
    const keys = await app.request("/api/vault/keys", authorized(token));
    expect(keys.status).toBe(200);

    // The legacy passphrase-only shape still has each authority family. Use
    // intentionally invalid request bodies so the handlers prove the scope
    // gate passed without creating keys, accounts, or payments.
    const probes = [
      ["/api/accounts", "POST"],
      ["/api/pay/quote", "POST"],
      ["/api/pay/confirm", "POST"],
    ] as const;
    for (const [path, method] of probes) {
      const probe = await app.request(
        path,
        authorized(token, {
          method,
          body: JSON.stringify({}),
        }),
      );
      expect(probe.status).toBe(400);
      expect((await probe.json()).error).not.toBe("insufficient_scope");
    }

    const agentProbe = await app.request(
      "/api/pay/agent/authorize",
      authorized(token, { method: "POST", body: JSON.stringify({}) }),
    );
    expect(agentProbe.status).toBe(403);
    expect(await agentProbe.json()).toMatchObject({ authorized: false });
  });
});

describe("analytics exact atomic values", () => {
  it("sums values beyond SQLite's signed-64-bit range as decimal strings", async () => {
    const accountId = newId();
    const incoming = "922337203685477580812345678901";
    const outgoing = "-1844674407370955161624691357802";
    db.query(
      `INSERT INTO accounts
         (id, rail, display_name, currency, decimals, balance_minor)
       VALUES (?, 'CRYPTO', 'huge atomic account', 'ETH', 18, ?)`,
    ).run(accountId, incoming);
    const insert = db.query(
      `INSERT INTO transactions
         (id, account_id, title, amount_minor, date, source)
       VALUES (?, ?, ?, ?, ?, 'MANUAL')`,
    );
    insert.run(newId(), accountId, "in one", incoming, "2026-08-01T00:00:00.000Z");
    insert.run(newId(), accountId, "in two", "99", "2026-08-02T00:00:00.000Z");
    insert.run(newId(), accountId, "out", outgoing, "2026-08-03T00:00:00.000Z");

    const response = await app.request("/api/analytics/summary", authorized(readToken));
    expect(response.status).toBe(200);
    const body = await response.json() as {
      accounts: Array<Record<string, unknown>>;
    };
    expect(body.accounts.find((row) => row.id === accountId)).toEqual({
      id: accountId,
      display_name: "huge atomic account",
      currency: "ETH",
      decimals: 18,
      balance_minor: incoming,
      in_minor: "922337203685477580812345679000",
      out_minor: "1844674407370955161624691357802",
      tx_count: 3,
    });
  });
});
