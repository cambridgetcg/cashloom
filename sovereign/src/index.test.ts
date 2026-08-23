import { beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.CASHLOOM_DATA_DIR = mkdtempSync(join(tmpdir(), "cashloom-local-api-test-"));

const { db, newId } = await import("./db.ts");
const vault = await import("./vault.ts");
const { WalletKernelStore } = await import("./wallet/infrastructure/sqlite/store.ts");
const {
  BASE_CHAIN_ID,
  BASE_ETH_ASSET_ID,
  BASE_USDC_ASSET_ID,
  ensureBaseAccountProjection,
} = await import("./wallet/base-account-projection.ts");
const {
  app,
  basePositionHttpRefusal,
  isCustodyBindAllowed,
  isRequestHostAllowed,
  requiredScopeForLocalRoute,
} = await import("./index.ts");
const { BasePositionServiceError } = await import("./wallet/base-position-service.ts");

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
    expect(requiredScopeForLocalRoute("GET", "/api/wallet/v3/positions")).toBe("accounts:read");
    expect(requiredScopeForLocalRoute("GET", "/api/wallet/v3")).toBe("accounts:read");
    expect(requiredScopeForLocalRoute("GET", "/api/wallet/v2/intents/example")).toBe("accounts:read");
    expect(
      requiredScopeForLocalRoute("POST", "/api/wallet/v2/intents/example/reconcile"),
    ).toBe("accounts:write");
    expect(
      requiredScopeForLocalRoute(
        "POST",
        "/api/wallet/v2/accounts/example/base-positions/refresh",
      ),
    ).toBe("accounts:write");
    expect(requiredScopeForLocalRoute(
      "GET",
      "/api/wallet/v2/reconciliation/status",
    )).toBe("accounts:read");
  });

  it("keeps scheduler status and saved positions networkless on GET", async () => {
    const status = await app.request(
      "/api/wallet/v2/reconciliation/status",
      authorized(readToken),
    );
    expect(status.status).toBe(200);
    const statusBody = await status.json() as Record<string, unknown>;
    expect(typeof statusBody.enabled).toBe("boolean");
    expect(statusBody).toMatchObject({
      schema_version: "cashloom.base-reconciliation-status/1",
      network_on_read: false,
      scheduler: { state: "stopped" },
      jobs: {
        by_state: {
          ready: "0",
          running: "0",
          backoff: "0",
          settled: "0",
          paused: "0",
        },
        durable_error_counts: {},
      },
    });

    const capabilities = await app.request(
      "/api/wallet/v3",
      authorized(readToken),
    );
    expect(capabilities.status).toBe(200);
    expect(await capabilities.json()).toMatchObject({
      schema_version: "cashloom.wallet-agent-capabilities/1",
      network_on_get: false,
      resources: expect.arrayContaining([
        expect.objectContaining({
          href: "/api/wallet/v2/positions",
          method: "GET",
          scope: "accounts:read",
          schema_version: "cashloom.wallet-kernel-positions/2",
        }),
        expect.objectContaining({
          href: "/api/wallet/v3/positions",
          method: "GET",
          scope: "accounts:read",
          schema_version: "cashloom.wallet-kernel-positions/3",
        }),
      ]),
      actions: expect.arrayContaining([
        expect.objectContaining({
          rel: "refresh-finalized-base-positions",
          method: "POST",
          scope: "accounts:write",
          network_effect: "read_only",
          refusal_codes: expect.arrayContaining([
            "base_position_conflict_frozen",
            "base_position_evidence_rejected",
          ]),
        }),
      ]),
      safety: {
        getters_are_local_only: true,
        observation_never_signs_or_broadcasts: true,
      },
    });

    const v2Positions = await app.request(
      "/api/wallet/v2/positions",
      authorized(readToken),
    );
    expect(v2Positions.status).toBe(200);
    expect(await v2Positions.json()).toEqual({
      schema_version: "cashloom.wallet-kernel-positions/2",
      positions: [],
    });

    const positions = await app.request(
      "/api/wallet/v3/positions",
      authorized(readToken),
    );
    expect(positions.status).toBe(200);
    expect(await positions.json()).toMatchObject({
      schema_version: "cashloom.wallet-kernel-positions/3",
      positions: [],
      base_accounts: [],
    });
  });

  it("returns stable Base-position refusal codes instead of raw validation or store errors", async () => {
    const malformed = await app.request(
      "/api/wallet/v2/accounts/not-a-uuid/base-positions/refresh",
      authorized(ownerToken, { method: "POST", body: "{}" }),
    );
    expect(malformed.status).toBe(400);
    expect(await malformed.json()).toEqual({
      error: "invalid_account_id",
      message: "Account id must be a UUID.",
    });

    const missingId = newId();
    const missing = await app.request(
      `/api/wallet/v2/accounts/${missingId}/base-positions/refresh`,
      authorized(ownerToken, { method: "POST", body: "{}" }),
    );
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({
      error: "base_account_not_found",
      message: "No active Base account exists with that id.",
    });

    const invalidId = newId();
    db.query(
      `INSERT INTO accounts
       (id,rail,display_name,currency,decimals,balance_minor,chain_id,asset_id,
        account_ref,status)
       VALUES (?,'CRYPTO','Invalid Base identity','ETH',18,'0',?,?,?,'ACTIVE')`,
    ).run(invalidId, BASE_CHAIN_ID, BASE_ETH_ASSET_ID, `${BASE_CHAIN_ID}:not-an-address`);
    const invalid = await app.request(
      `/api/wallet/v2/accounts/${invalidId}/base-positions/refresh`,
      authorized(ownerToken, { method: "POST", body: "{}" }),
    );
    expect(invalid.status).toBe(422);
    expect(await invalid.json()).toEqual({
      error: "base_account_identity_invalid",
      message: "This account is not an exact supported Base ETH or native USDC identity.",
    });

    const cancelledId = newId();
    const cancelledAddress = `0x${"8".repeat(40)}`;
    db.query(
      `INSERT INTO accounts
       (id,rail,display_name,currency,decimals,balance_minor,chain_id,asset_id,
        account_ref,status)
       VALUES (?,'CRYPTO','Cancelled Base check','ETH',18,'0',?,?,?,'ACTIVE')`,
    ).run(
      cancelledId,
      BASE_CHAIN_ID,
      BASE_ETH_ASSET_ID,
      `${BASE_CHAIN_ID}:${cancelledAddress}`,
    );
    const abort = new AbortController();
    abort.abort();
    const cancelled = await app.request(
      `/api/wallet/v2/accounts/${cancelledId}/base-positions/refresh`,
      authorized(ownerToken, { method: "POST", body: "{}", signal: abort.signal }),
    );
    expect(cancelled.status).toBe(408);
    expect(await cancelled.json()).toEqual({
      error: "base_position_refresh_cancelled",
      message: "The Base position refresh was cancelled before evidence settled.",
    });
  });

  it("projects every Base-position service failure to a fixed secret-safe HTTP refusal", () => {
    const cases = [
      ["base_account_not_found", 404],
      ["base_account_identity_invalid", 422],
      ["base_position_conflict_frozen", 409],
      ["base_position_refresh_cancelled", 408],
      ["base_position_evidence_rejected", 502],
    ] as const;
    const canary = "SECRET_CANARY_must_not_cross_http";
    for (const [code, status] of cases) {
      const refusal = basePositionHttpRefusal(
        new BasePositionServiceError(code, status, canary),
      );
      expect(refusal).toMatchObject({ status, body: { error: code } });
      expect(JSON.stringify(refusal)).not.toContain(canary);
    }
    expect(basePositionHttpRefusal(new Error(canary))).toEqual({
      status: 500,
      body: {
        error: "base_position_internal_failure",
        message: "The local Base position operation could not complete safely.",
      },
    });
  });

  it("returns a stable conflict refusal for a durably frozen Base position", async () => {
    const accountId = newId();
    const address = `0x${"a".repeat(40)}`;
    db.query(
      `INSERT INTO accounts
       (id,rail,display_name,currency,decimals,balance_minor,chain_id,asset_id,
        account_ref,status)
       VALUES (?,'CRYPTO','Frozen Base wallet','USDC',6,'0',?,?,?,'ACTIVE')`,
    ).run(accountId, BASE_CHAIN_ID, BASE_USDC_ASSET_ID, `${BASE_CHAIN_ID}:${address}`);
    const store = new WalletKernelStore(db);
    ensureBaseAccountProjection({ db, store }, accountId);
    const blockTime = "2026-08-23T20:00:00.000Z";
    const items = [
      { assetId: BASE_ETH_ASSET_ID, observedAtomic: "1" },
      { assetId: BASE_USDC_ASSET_ID, observedAtomic: "2" },
    ] as const;
    const evidence = (
      hashNibble: string,
      evidenceNibble: string,
      suffix: string,
    ) => {
      const evidenceHash = `sha256:${evidenceNibble.repeat(64)}` as `sha256:${string}`;
      const blockHash = `0x${hashNibble.repeat(64)}` as `0x${string}`;
      const sightings = ["a", "b"].map((provider, index) => store.appendBasePositionSighting({
        id: `sighting.${accountId}.${suffix}.${provider}`,
        accountId,
        providerId: `base-${provider}`,
        providerTrustDomain: `sha256:${(index === 0 ? "c" : "d").repeat(64)}`,
        evidenceHash,
        blockNumber: "100",
        blockHash,
        blockTime,
        items,
        body: { evidence_hash: evidenceHash, block_hash: blockHash },
        observedAt: blockTime,
        fetchedAt: blockTime,
      }).sighting);
      return {
        id: `snapshot.${accountId}.${suffix}`,
        accountId,
        blockNumber: "100",
        blockHash,
        blockTime,
        evidenceHash,
        providerIds: sightings.map(({ providerId }) => providerId),
        sightingIds: sightings.map(({ id }) => id),
        quorum: 2,
        items,
        decidedAt: blockTime,
      };
    };
    store.applyBasePositionSnapshot(evidence("1", "1", "first"));
    expect(store.applyBasePositionSnapshot(evidence("2", "2", "conflict")).outcome)
      .toBe("conflict");

    const response = await app.request(
      `/api/wallet/v2/accounts/${accountId}/base-positions/refresh`,
      authorized(ownerToken, { method: "POST", body: "{}" }),
    );
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: "base_position_conflict_frozen",
      message:
        "This Base position is frozen after conflicting same-height evidence and requires review.",
    });
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
