import { beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, existsSync } from "node:fs";
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
  it("lets any valid scoped session inspect only its own expiry without renewal", async () => {
    expect(requiredScopeForLocalRoute("GET", "/api/vault/session")).toBe("valid-session");
    expect(requiredScopeForLocalRoute("POST", "/api/vault/session")).toBeUndefined();
    expect(requiredScopeForLocalRoute("GET", "/api/vault/session/other")).toBeUndefined();
    const delegated = vault.createDelegatedAgentSession(ownerToken, {
      delegateKeyId: `sha256:${"d".repeat(64)}`, scopes: ["accounts:read"],
    });
    for (const token of [ownerToken, readToken, delegated.token]) {
      const before = vault.getSessionInfo(token)!;
      const start = Date.now();
      const response = await app.request("/api/vault/session", authorized(token));
      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("private, no-store");
      const body = await response.json() as { expiresAt: string; serverTime: string };
      expect(Object.keys(body).sort()).toEqual(["expiresAt", "serverTime"]);
      expect(body.expiresAt).toBe(before.expiresAt);
      expect(vault.getSessionInfo(token)?.expiresAt).toBe(before.expiresAt);
      expect(Date.parse(body.serverTime)).toBeGreaterThanOrEqual(start);
      expect(Date.parse(body.serverTime)).toBeLessThanOrEqual(Date.now());
    }
  });

  it("rejects absent and expired session inspections", async () => {
    for (const token of [undefined, "synthetic-invalid-session"]) {
      const response = await app.request("/api/vault/session", token ? authorized(token) : undefined);
      expect(response.status).toBe(401);
      expect(response.headers.get("cache-control")).toBe("private, no-store");
    }
    const expired = await vault.unlock(PASSPHRASE, { scopes: ["accounts:read"], ttlMs: 1 });
    await Bun.sleep(5);
    expect((await app.request("/api/vault/session", authorized(expired))).status).toBe(401);
    expect((await app.request("/api/vault/session", authorized(readToken, { method: "POST" }))).status).toBe(403);
  });

  it("prevents HTTP caching of private wallet responses including refused access", async () => {
    for (const init of [undefined, authorized(readToken)]) {
      const response = await app.request("/api/accounts", init);
      expect(response.status).toBe(init ? 200 : 401);
      expect(response.headers.get("cache-control")).toBe("private, no-store");
    }
    const refused = await app.request("/api/vault/keys", authorized(readToken));
    expect(refused.status).toBe(403);
    expect(refused.headers.get("cache-control")).toBe("private, no-store");
  });

  it("maps every private route family to its least required scope", () => {
    expect(requiredScopeForLocalRoute("GET", "/api/vault/keys")).toBe("keys:manage");
    expect(requiredScopeForLocalRoute("POST", "/api/accounts")).toBe("accounts:write");
    expect(requiredScopeForLocalRoute("GET", "/api/accounts")).toBe("accounts:read");
    expect(requiredScopeForLocalRoute("POST", "/api/accounts/a/sync")).toBe("accounts:write");
    expect(requiredScopeForLocalRoute("POST", "/api/accounts/a/balance")).toBe("accounts:write");
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
    expect(requiredScopeForLocalRoute("GET", "/api/wallet/v3/integrations")).toBe("accounts:read");
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

  it("maps TCG routes explicitly without granting arbitrary status mutation", () => {
    for (const path of ["/api/tcg/trades", "/api/tcg/trades/a", "/api/tcg/trades/a/history",
      "/api/tcg/simulations", "/api/tcg/simulations/a", "/api/tcg/simulations/a/history"]) {
      expect(requiredScopeForLocalRoute("GET", path)).toBe("trades:read");
      expect(requiredScopeForLocalRoute("HEAD", path)).toBe("trades:read");
      expect(requiredScopeForLocalRoute("DELETE", path)).toBeUndefined();
    }
    for (const path of ["/api/tcg/trades", "/api/tcg/trades/a/revisions", "/api/tcg/trades/a/evidence"]) {
      expect(requiredScopeForLocalRoute("POST", path)).toBe("trades:write");
    }
    for (const path of ["/api/tcg/simulations", "/api/tcg/simulations/a/commands"]) {
      expect(requiredScopeForLocalRoute("POST", path)).toBe("trades:simulate");
    }
    for (const path of ["/api/tcg/trades/a/status", "/api/tcg/simulations/a/release",
      "/api/tcg/future", "/api/tcg/trades-elsewhere"]) {
      expect(requiredScopeForLocalRoute("POST", path)).toBeUndefined();
    }
  });

  it("keeps TCG reads private and never creates a sandbox on a read", async () => {
    const sandboxPath = join(process.env.CASHLOOM_DATA_DIR!, "tcg-sandbox.db");
    expect(existsSync(sandboxPath)).toBe(false);
    for (const path of ["/api/tcg/trades", "/api/tcg/simulations"]) {
      const missing = await app.request(path);
      expect(missing.status).toBe(401);
      expect(missing.headers.get("cache-control")).toBe("private, no-store");
      const accountReader = await app.request(path, authorized(readToken));
      expect(accountReader.status).toBe(403);
      expect(await accountReader.json()).toMatchObject({ required_scope: "trades:read" });
      const owner = await app.request(path, authorized(ownerToken));
      expect(owner.status).toBe(200);
      expect(owner.headers.get("cache-control")).toBe("private, no-store");
    }
    expect(existsSync(sandboxPath)).toBe(false);
  });

  it("keeps read, write and simulation capabilities separate", async () => {
    const token = await vault.unlock(PASSPHRASE, { scopes: ["trades:read"] });
    expect((await app.request("/api/tcg/trades", authorized(token))).status).toBe(200);
    for (const [path, scope] of [
      ["/api/tcg/trades", "trades:write"],
      ["/api/tcg/simulations", "trades:simulate"],
    ]) {
      const response = await app.request(path!, authorized(token, { method: "POST", body: "{}" }));
      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({ required_scope: scope });
    }
    const unmapped = await app.request("/api/tcg/trades/a/status", authorized(ownerToken, {
      method: "POST", body: JSON.stringify({ status: "protected" }),
    }));
    expect(unmapped.status).toBe(403);
    expect(await unmapped.json()).toMatchObject({ error: "route_scope_unmapped" });
  });

  it("does not delegate owner TCG authority or revive expired sessions", async () => {
    for (const scope of ["trades:read", "trades:write", "trades:simulate"] as const) {
      expect(() => vault.createDelegatedAgentSession(ownerToken, {
        delegateKeyId: `sha256:${"a".repeat(64)}`, scopes: [scope],
      })).toThrow("Agent sessions may only receive");
    }
    const delegated = vault.createDelegatedAgentSession(ownerToken, {
      delegateKeyId: `sha256:${"a".repeat(64)}`, scopes: ["accounts:read"],
    });
    expect((await app.request("/api/tcg/trades", authorized(delegated.token))).status).toBe(403);
    const expired = await vault.unlock(PASSPHRASE, { scopes: ["trades:read"], ttlMs: 1 });
    await Bun.sleep(5);
    expect((await app.request("/api/tcg/trades", authorized(expired))).status).toBe(401);
  });

  it("revokes TCG access when the wallet locks", async () => {
    const staleOwner = ownerToken;
    try {
      const locked = await app.request("/api/vault/lock", authorized(ownerToken, { method: "POST" }));
      expect(locked.status).toBe(200);
      expect((await app.request("/api/vault/session", authorized(staleOwner))).status).toBe(401);
      expect((await app.request("/api/tcg/trades", authorized(staleOwner))).status).toBe(401);
      expect((await app.request("/api/tcg/simulations/a/commands", authorized(staleOwner, {
        method: "POST", body: "{}",
      }))).status).toBe(401);
    } finally {
      readToken = await vault.unlock(PASSPHRASE, { scopes: ["accounts:read"] });
      ownerToken = await vault.unlock(PASSPHRASE);
    }
  });

  it("applies existing hostile-origin protection to TCG mutations", async () => {
    const response = await app.request("/api/tcg/trades", authorized(ownerToken, {
      method: "POST", body: "{}",
      headers: { Origin: "https://attacker.example", "Sec-Fetch-Site": "cross-site" },
    }));
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: "origin_not_allowed" });
  });

  it("persists a mounted trade and sandbox without writing wallet money", async () => {
    const walletSnapshot = () => JSON.stringify({
      accounts: db.query("SELECT * FROM accounts ORDER BY id").all(),
      transactions: db.query("SELECT * FROM transactions ORDER BY id").all(),
      payments: db.query("SELECT * FROM payments ORDER BY id").all(),
      kernel: (db.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'wk_%' ORDER BY name")
        .all() as { name: string }[]).map(({ name }) => ({
          name, rows: db.query(`SELECT * FROM "${name}"`).all(),
        })),
    });
    const before = walletSnapshot();
    const asset = { kind: "fiat", currency: "GBP" };
    const request = {
      idempotencyKey: "mounted-trade", expectedVersion: 0,
      terms: {
        kind: "shipped_sale", title: "Synthetic card sale", originChannel: "Test fixture",
        ownerRole: "seller", buyerLabel: "Fixture buyer", sellerLabel: "Fixture seller",
        quoteAsset: asset, quoteDecimals: 2,
        items: [{ id: "card_1", representation: "physical_copy", game: "OPTCG",
          cardName: "Fixture card", set: "Test", collectorNumber: "001", language: "English",
          variant: "Unknown", quantity: 1,
          condition: { description: "Owner-reported near mint", standard: "Agreed description" },
          unitPrice: { asset, atomic: "1000" } }],
        shipping: { payer: "buyer", amount: { asset, atomic: "100" }, responsibility: "Seller ships" },
        charges: [], plannedPaymentMethod: "cash", inspectionWindowHours: 48,
        disputeTerms: "Discuss the claimed defect", returnTerms: "Return before refund",
        expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
      },
    };
    const post = (path: string, body: unknown) => app.request(path, authorized(ownerToken, {
      method: "POST", body: JSON.stringify(body),
    }));
    const created = await post("/api/tcg/trades", request);
    expect(created.status).toBe(200);
    const first = await created.json();
    expect(first.trade).toMatchObject({ mode: "record", protection: "unavailable", currentRevision: 1 });
    expect(await (await post("/api/tcg/trades", request)).json()).toEqual(first);
    const simulated = await post("/api/tcg/simulations", {
      idempotencyKey: "mounted-simulation", expectedVersion: 0, tradeId: first.trade.id, revision: 1,
    });
    expect(simulated.status).toBe(200);
    const { simulation } = await simulated.json();
    expect(simulation.mode).toBe("simulation");
    expect(existsSync(join(process.env.CASHLOOM_DATA_DIR!, "tcg-sandbox.db"))).toBe(true);
    expect((await app.request(`/api/tcg/simulations/${simulation.id}`, authorized(ownerToken))).status).toBe(200);
    // A fresh process must reopen the existing sandbox on GET, without creating
    // it again or confusing the sandbox database with the wallet connection.
    const restart = Bun.spawnSync([process.execPath, "--no-env-file", "--no-install", "-e", `
      const { app } = await import(${JSON.stringify(new URL("./index.ts", import.meta.url).href)});
      const vault = await import(${JSON.stringify(new URL("./vault.ts", import.meta.url).href)});
      const token = await vault.unlock(${JSON.stringify(PASSPHRASE)}, { scopes: ["trades:read"] });
      const response = await app.request("/api/tcg/simulations/${simulation.id}", {
        headers: { Authorization: "Bearer " + token },
      });
      console.log(JSON.stringify({ status: response.status, body: await response.json() }));
    `], {
      env: { PATH: process.env.PATH!, HOME: process.env.HOME!,
        TMPDIR: process.env.TMPDIR ?? tmpdir(), CASHLOOM_DATA_DIR: process.env.CASHLOOM_DATA_DIR! },
      stdout: "pipe", stderr: "pipe", timeout: 10_000,
    });
    expect(restart.exitCode).toBe(0);
    expect(JSON.parse(restart.stdout.toString())).toMatchObject({
      status: 200, body: { simulation: { id: simulation.id, mode: "simulation" } },
    });
    expect(walletSnapshot()).toBe(before);
    const record = await (await app.request(`/api/tcg/trades/${first.trade.id}`, authorized(ownerToken))).json();
    expect(record.trade.evidence).toEqual([]);
    expect(record.trade.protection).toBe("unavailable");
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
          href: "/api/wallet/v3/integrations",
          method: "GET",
          scope: "accounts:read",
          schema_version: "cashloom.wallet-integrations/1",
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

    const integrations = await app.request(
      "/api/wallet/v3/integrations",
      authorized(readToken),
    );
    expect(integrations.status).toBe(200);
    expect(integrations.headers.get("cache-control")).toBe("private, no-store");
    expect(await integrations.json()).toMatchObject({
      schema_version: "cashloom.wallet-integrations/1",
      runtime: "local_loopback_custody",
      network_on_get: false,
      integrations: expect.arrayContaining([
        expect.objectContaining({ id: "webauthn-passkey", execution_enabled: false }),
        expect.objectContaining({ id: "walletconnect-v2", execution_enabled: false }),
        expect.objectContaining({ id: "erc4337-base-v07", execution_enabled: false }),
        expect.objectContaining({ id: "gocardless-bank-data", execution_enabled: false }),
        expect.objectContaining({ id: "yapily-pay-by-bank", execution_enabled: false }),
      ]),
      safety: { agent_interactive_completion_allowed: false },
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

describe("manual account balance observations", () => {
  const createAccount = (rail = "CASH", connector: string | null = null, status = "ACTIVE") => {
    const id = newId();
    db.query(`INSERT INTO accounts (id, rail, display_name, currency, decimals, connector_type, status)
      VALUES (?, ?, 'Manual balance fixture', 'GBP', 2, ?, ?)`).run(id, rail, connector, status);
    return id;
  };
  const body = (balance: string, expectedBalance = "0", expectedTime: string | null = null) => ({
    balance_minor: balance, expected_balance_minor: expectedBalance, expected_balance_as_of: expectedTime,
  });
  const record = (id: string, payload: unknown, token = ownerToken) =>
    app.request(`/api/accounts/${id}/balance`, authorized(token, { method: "POST", body: JSON.stringify(payload) }));
  const saved = (id: string) => db.query("SELECT balance_minor,balance_as_of FROM accounts WHERE id=?").get(id) as {
    balance_minor: string; balance_as_of: string | null;
  };

  it("requires a live account-write session and refuses a hostile browser origin", async () => {
    const id = createAccount();
    expect((await app.request(`/api/accounts/${id}/balance`, { method: "POST", body: JSON.stringify(body("100")) })).status).toBe(401);
    const denied = await record(id, body("100"), readToken);
    expect(denied.status).toBe(403);
    expect(await denied.json()).toMatchObject({ required_scope: "accounts:write" });
    const hostile = await app.request(`/api/accounts/${id}/balance`, authorized(ownerToken, {
      method: "POST", body: JSON.stringify(body("100")),
      headers: { Origin: "https://attacker.example", "Sec-Fetch-Site": "cross-site" },
    }));
    expect(hostile.status).toBe(403);
    expect(saved(id)).toEqual({ balance_minor: "0", balance_as_of: null });
  });

  it("records exact positive, negative and zero balances without a ledger entry or payment", async () => {
    const id = createAccount();
    const before = JSON.stringify({
      transactions: db.query("SELECT * FROM transactions ORDER BY id").all(),
      payments: db.query("SELECT * FROM payments ORDER BY id").all(),
      journal: db.query("SELECT * FROM wk_journal_entries ORDER BY id").all(),
    });
    for (const amount of ["922337203685477580812345678901", "-922337203685477580812345678901", "0"]) {
      const current = saved(id);
      const response = await record(id, body(amount, current.balance_minor, current.balance_as_of));
      expect(response.status).toBe(200);
      const result = await response.json();
      expect(result.account).toMatchObject({ id, balance_minor: amount, rail: "CASH", currency: "GBP", decimals: 2 });
      expect(Number.isFinite(Date.parse(result.account.balance_as_of))).toBe(true);
      if (current.balance_as_of) expect(Date.parse(result.account.balance_as_of)).toBeGreaterThan(Date.parse(current.balance_as_of));
      expect(saved(id).balance_minor).toBe(amount);
    }
    expect(JSON.stringify({
      transactions: db.query("SELECT * FROM transactions ORDER BY id").all(),
      payments: db.query("SELECT * FROM payments ORDER BY id").all(),
      journal: db.query("SELECT * FROM wk_journal_entries ORDER BY id").all(),
    })).toBe(before);
  });

  it("compares both previous fields and atomically allows only one competing write", async () => {
    const id = createAccount();
    const responses = await Promise.all([record(id, body("100")), record(id, body("200"))]);
    expect(responses.map((response) => response.status).sort()).toEqual([200, 409]);
    const current = saved(id);
    expect((await record(id, body("300", "0", current.balance_as_of))).status).toBe(409);
    const staleTime = await record(id, body("300", current.balance_minor, null));
    expect(staleTime.status).toBe(409);
    expect(await staleTime.json()).toMatchObject({ error: "account_balance_conflict" });
    expect(saved(id)).toEqual(current);
  });

  it("advances the compare-and-swap timestamp even for the same balance", async () => {
    const id = createAccount();
    const previousTime = new Date(Date.now() + 1000).toISOString();
    db.query("UPDATE accounts SET balance_minor='500', balance_as_of=? WHERE id=?").run(previousTime, id);
    const response = await record(id, body("500", "500", previousTime));
    expect(response.status).toBe(200);
    expect(Date.parse(saved(id).balance_as_of!)).toBeGreaterThan(Date.parse(previousTime));
    expect((await record(id, body("500", "500", previousTime))).status).toBe(409);
  });

  it("refuses crypto and connected accounts, and does not revive archived accounts", async () => {
    for (const id of [createAccount("CRYPTO"), createAccount("BANK", "gocardless"), createAccount("CASH", "custom")]) {
      const response = await record(id, body("100"));
      expect(response.status).toBe(422);
      expect(await response.json()).toMatchObject({ error: "manual_balance_not_allowed" });
      expect(saved(id)).toEqual({ balance_minor: "0", balance_as_of: null });
    }
    const archivedId = createAccount("CASH", null, "ARCHIVED");
    expect((await record(archivedId, body("100"))).status).toBe(404);
    expect(saved(archivedId)).toEqual({ balance_minor: "0", balance_as_of: null });
    expect((await record(newId(), body("100"))).status).toBe(404);
  });

  it("allows manual bank, Stripe, credit and gift-card observations without a connector", async () => {
    for (const rail of ["BANK", "STRIPE", "PLATFORM_CREDIT", "GIFT_CARD"]) {
      expect((await record(createAccount(rail), body("12345"))).status).toBe(200);
    }
  });

  it("rejects noninteger, oversized and extra-field requests without changing the account", async () => {
    const id = createAccount();
    for (const balance of [1, "1.0", "1e6", "01", "-0", "9".repeat(121), ""]) {
      expect((await record(id, { ...body("100"), balance_minor: balance })).status).toBe(400);
    }
    for (const extra of [{ rail: "CRYPTO" }, { balance_as_of: "2026-09-23T00:00:00.000Z" }, { display_name: "Changed" }]) {
      expect((await record(id, { ...body("100"), ...extra })).status).toBe(400);
    }
    expect((await record(id, { balance_minor: "100" })).status).toBe(400);
    expect(saved(id)).toEqual({ balance_minor: "0", balance_as_of: null });
  });
});

describe("archived ledger account identity", () => {
  it("keeps the default account list active while explicitly retaining archived precision and history", async () => {
    for (const [currency, decimals, amount] of [["ETH", 18, "1234567890123456789"], ["BTC", 8, "123456789"]] as const) {
      const id = newId();
      db.query("INSERT INTO accounts (id,rail,display_name,currency,decimals) VALUES (?,'CRYPTO',?,?,?)")
        .run(id, `Archived ${currency} fixture`, currency, decimals);
      const created = await app.request("/api/transactions", authorized(ownerToken, {
        method: "POST", body: JSON.stringify({ account_id: id, title: "Retained history", amount_minor: amount }),
      }));
      expect(created.status).toBe(201);
      expect((await app.request(`/api/accounts/${id}/archive`, authorized(ownerToken, { method: "POST" }))).status).toBe(200);
      for (const path of ["/api/accounts", "/api/accounts?includeArchived=false"]) {
        const response = await app.request(path, authorized(readToken));
        expect(response.status).toBe(200);
        expect((await response.json()).accounts.some((account: { id: string }) => account.id === id)).toBe(false);
      }
      const historyAccounts = await app.request("/api/accounts?includeArchived=true", authorized(readToken));
      expect(historyAccounts.status).toBe(200);
      expect((await historyAccounts.json()).accounts.find((account: { id: string }) => account.id === id))
        .toMatchObject({ id, currency, decimals, status: "ARCHIVED", display_name: `Archived ${currency} fixture` });
      const transactions = await app.request(`/api/transactions?accountId=${id}`, authorized(readToken));
      expect((await transactions.json()).transactions).toMatchObject([{ account_id: id, amount_minor: amount }]);
    }
  });

  it("validates the explicit archived switch and retains the private read boundary", async () => {
    for (const value of ["", "1", "yes", "TRUE"]) {
      const response = await app.request(`/api/accounts?includeArchived=${value}`, authorized(readToken));
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ error: "request_failed" });
    }
    expect((await app.request("/api/accounts?includeArchived=true")).status).toBe(401);
  });

  it("refuses new entries for archived or missing accounts without changing retained history", async () => {
    const id = newId();
    db.query("INSERT INTO accounts (id,rail,display_name,currency,decimals,status) VALUES (?,'CASH','Archived fixture','GBP',2,'ARCHIVED')").run(id);
    const before = db.query("SELECT COUNT(*) AS count FROM transactions").get();
    for (const [accountId, status, error] of [[id, 409, "account_not_active"], [newId(), 404, "account_not_found"]] as const) {
      const response = await app.request("/api/transactions", authorized(ownerToken, {
        method: "POST", body: JSON.stringify({ account_id: accountId, title: "Do not create", amount_minor: "123" }),
      }));
      expect(response.status).toBe(status);
      expect(await response.json()).toMatchObject({ error });
    }
    expect(db.query("SELECT COUNT(*) AS count FROM transactions").get()).toEqual(before);
  });
});

describe("owner-controlled Base watch onboarding", () => {
  const path = "/api/connections/crypto/watch";
  const input = () => ({ network: "base", address: `0x${newId().replace(/-/g, "").padEnd(40, "0")}`, display_name: "Synthetic Base watch" });
  const post = (token: string, body = input()) => app.request(path, authorized(token, { method: "POST", body: JSON.stringify(body) }));

  it("maps only the explicit POST and requires owner account-write authority", async () => {
    expect(requiredScopeForLocalRoute("POST", path)).toBe("accounts:write");
    for (const verb of ["GET", "HEAD", "PUT", "DELETE"]) expect(requiredScopeForLocalRoute(verb, path)).toBeUndefined();
    expect(requiredScopeForLocalRoute("POST", "/api/connections/crypto/watch/extra")).toBeUndefined();
    expect((await app.request(path, { method: "POST" })).status).toBe(401);
    expect((await post(readToken)).status).toBe(403);
    const delegated = vault.createDelegatedAgentSession(ownerToken, { delegateKeyId: `sha256:${"c".repeat(64)}`, scopes: ["accounts:read"] });
    expect((await post(delegated.token)).status).toBe(403);
    expect(() => vault.createDelegatedAgentSession(ownerToken, { delegateKeyId: `sha256:${"c".repeat(64)}`, scopes: ["accounts:write"] })).toThrow();
    const narrowOwner = await vault.unlock(PASSPHRASE, { scopes: ["accounts:write"] });
    const created = await post(narrowOwner);
    expect(created.status).toBe(201);
    const account = (await created.json()).account;
    const grant = vault.createAssistAccess(ownerToken, { label: "Watch boundary fixture", account_ids: [account.id], ttl_minutes: 5, allow_proposals: true });
    try { expect((await post(grant.token)).status).toBe(403); }
    finally { vault.revokeAssistAccess(ownerToken, grant.access.id); }
    const hostile = await app.request(path, authorized(ownerToken, { method: "POST", body: JSON.stringify(input()), headers: { Origin: "https://attacker.example", "Sec-Fetch-Site": "cross-site" } }));
    expect(hostile.status).toBe(403);
    expect((await hostile.json()).error).toBe("origin_not_allowed");
  });

  it("saves only the watched account and returns the same account after a lost-response retry", async () => {
    const snapshot = () => JSON.stringify({
      transactions: db.query("SELECT * FROM transactions ORDER BY id").all(),
      payments: db.query("SELECT * FROM payments ORDER BY id").all(),
      keys: db.query("SELECT id,kind,address FROM vault_keys ORDER BY id").all(),
      connections: db.query("SELECT id,status FROM read_connections ORDER BY id").all(),
      kernel: (db.query("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'wk_%' ORDER BY name").all() as { name: string }[])
        .map(({ name }) => ({ name, rows: db.query(`SELECT * FROM "${name}"`).all() })),
    });
    const before = snapshot(), body = input(), originalFetch = globalThis.fetch;
    let networkCalls = 0;
    globalThis.fetch = (async () => { networkCalls++; throw new Error("Watch onboarding cannot contact a provider"); }) as unknown as typeof fetch;
    try {
      const first = await post(ownerToken, body);
      expect(first.status).toBe(201);
      expect(first.headers.get("cache-control")).toBe("private, no-store");
      const saved = await first.json();
      expect(saved.account).toMatchObject({ rail: "CRYPTO", currency: "ETH", decimals: 18, chain_id: BASE_CHAIN_ID,
        asset_id: BASE_ETH_ASSET_ID, account_ref: `${BASE_CHAIN_ID}:${body.address}`, balance_as_of: null,
        vault_key_id: null, connector_type: null, credential_ref: null, read_environment: "live" });
      const replay = await post(ownerToken, { ...body, display_name: "Preserve existing name" });
      expect(replay.status).toBe(200);
      expect(await replay.json()).toEqual({ account: saved.account, created: false });
      expect(snapshot()).toBe(before);
      expect(networkCalls).toBe(0);
    } finally { globalThis.fetch = originalFetch; }
  });

  it("refuses a request whose owner session expires while its body is arriving", async () => {
    const token = await vault.unlock(PASSPHRASE, { scopes: ["accounts:write"], ttlMs: 40 });
    let requested!: () => void, finish!: () => void;
    const reading = new Promise<void>(resolve => { requested = resolve; });
    const body = new TextEncoder().encode(JSON.stringify(input()));
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        requested();
        return new Promise<void>(resolve => { finish = () => { controller.enqueue(body); controller.close(); resolve(); }; });
      },
    }, { highWaterMark: 0 });
    const before = db.query("SELECT COUNT(*) AS n FROM accounts").get();
    const pending = app.request(path, authorized(token, { method: "POST", body: stream }));
    await reading;
    await Bun.sleep(50);
    finish();
    const response = await pending;
    expect(response.status).toBe(403);
    expect((await response.json()).error).toBe("crypto_watch_owner_required");
    expect(db.query("SELECT COUNT(*) AS n FROM accounts").get()).toEqual(before);
  });

  it("refuses an in-flight watch request after lock even if a new owner session replaces it", async () => {
    let requested!: () => void, finish!: () => void;
    const reading = new Promise<void>(resolve => { requested = resolve; });
    const body = new TextEncoder().encode(JSON.stringify(input()));
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        requested();
        return new Promise<void>(resolve => { finish = () => { controller.enqueue(body); controller.close(); resolve(); }; });
      },
    }, { highWaterMark: 0 });
    const before = db.query("SELECT COUNT(*) AS n FROM accounts").get();
    const pending = app.request(path, authorized(ownerToken, { method: "POST", body: stream }));
    await reading;
    vault.lock();
    try {
      ownerToken = await vault.unlock(PASSPHRASE);
      finish();
      const response = await pending;
      expect(response.status).toBe(403);
      expect((await response.json()).error).toBe("crypto_watch_owner_required");
      expect(db.query("SELECT COUNT(*) AS n FROM accounts").get()).toEqual(before);
    } finally { readToken = await vault.unlock(PASSPHRASE, { scopes: ["accounts:read"] }); }
  });
});

describe("owner-only phone wallet configuration", () => {
  it("exposes only setup state to an owner with account-management scope", async () => {
    const path = "/api/connections/crypto/walletconnect";
    expect(requiredScopeForLocalRoute("GET", path)).toBe("accounts:write");
    for (const verb of ["HEAD", "POST", "PUT", "DELETE"]) expect(requiredScopeForLocalRoute(verb, path)).toBeUndefined();
    expect(requiredScopeForLocalRoute("GET", `${path}/extra`)).toBeUndefined();
    expect((await app.request(path)).status).toBe(401);
    expect((await app.request(path, authorized(readToken))).status).toBe(403);
    const delegated = vault.createDelegatedAgentSession(ownerToken, { delegateKeyId: `sha256:${"c".repeat(64)}`, scopes: ["accounts:read"] });
    expect((await app.request(path, authorized(delegated.token))).status).toBe(403);
    const accountId = newId();
    db.query("INSERT INTO accounts(id,rail,display_name,currency,decimals) VALUES(?,'CASH','Pairing setup fixture','USD',2)").run(accountId);
    const grant = vault.createAssistAccess(ownerToken, { label: "Pairing setup fixture", account_ids: [accountId], ttl_minutes: 5, allow_proposals: false });
    try { expect((await app.request(path, authorized(grant.token))).status).toBe(403); }
    finally { vault.revokeAssistAccess(ownerToken, grant.access.id); }
    const previous = process.env.CASHLOOM_WALLETCONNECT_PROJECT_ID;
    try {
      delete process.env.CASHLOOM_WALLETCONNECT_PROJECT_ID;
      const narrowOwner = await vault.unlock(PASSPHRASE, { scopes: ["accounts:write"] });
      const result = await app.request(path, authorized(narrowOwner));
      expect(result.status).toBe(200);
      expect(result.headers.get("cache-control")).toBe("private, no-store");
      expect(await result.json()).toEqual({ state: "not_configured", project_id: null });
      const hostile = await app.request(path, authorized(narrowOwner, { headers: { Origin: "https://attacker.example", "Sec-Fetch-Site": "cross-site" } }));
      expect(hostile.status).toBe(403);
    } finally {
      if (previous === undefined) delete process.env.CASHLOOM_WALLETCONNECT_PROJECT_ID;
      else process.env.CASHLOOM_WALLETCONNECT_PROJECT_ID = previous;
    }
  });
});

describe("Activity search and older pages", () => {
  function fixture() {
    const accountId = newId();
    db.query("INSERT INTO accounts(id,rail,display_name,currency,decimals,balance_minor) VALUES(?,'CASH','History search fixture','USD',2,'12345')").run(accountId);
    const insert = db.query(`INSERT INTO transactions(id,account_id,title,amount_minor,date,category,raw)
      VALUES(?,?,?,'-123456789012345678901',?,'Saved category','synthetic raw must stay private')`);
    for (let index = 1; index <= 3; index++) insert.run(newId(), accountId, `Literal 100% ${index}`, `2026-09-${String(index).padStart(2, "0")}T00:00:00.000Z`);
    return accountId;
  }
  const path = (query: Record<string, string | undefined>) => {
    const parameters = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) if (value !== undefined) parameters.set(key, value);
    return `/api/transactions?${parameters}`;
  };

  it("returns additive page metadata and reads matching saved history through the existing scoped route", async () => {
    const accountId = fixture();
    const response = await app.request(path({ accountId, q: " 100% ", limit: "2" }), authorized(readToken));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    const first = await response.json();
    expect(Object.keys(first).sort()).toEqual(["has_more", "next_cursor", "transactions"]);
    expect(first.transactions.map((row: { title: string }) => row.title)).toEqual(["Literal 100% 3", "Literal 100% 2"]);
    expect(first.has_more).toBe(true);
    const second = await (await app.request(path({ accountId, q: "100%", cursor: first.next_cursor }), authorized(readToken))).json();
    expect(second.transactions.map((row: { title: string }) => row.title)).toEqual(["Literal 100% 1"]);
    expect(second).toMatchObject({ has_more: false, next_cursor: null });
    expect(first.transactions[0].amount_minor).toBe("-123456789012345678901");
    expect(first.transactions[0]).not.toHaveProperty("raw");
    expect(JSON.stringify(first)).not.toContain("synthetic raw must stay private");
  });

  it("refuses invalid parameters and account/search cursor mismatches with fixed private errors", async () => {
    const accountId = fixture();
    const first = await (await app.request(path({ accountId, q: "100%", limit: "1" }), authorized(readToken))).json();
    for (const query of [{ accountId, q: "changed search", cursor: first.next_cursor }, { accountId: newId(), q: "100%", cursor: first.next_cursor }, { accountId, cursor: "private malformed marker" }]) {
      const response = await app.request(path(query), authorized(readToken));
      expect(response.status).toBe(400);
      expect(response.headers.get("cache-control")).toBe("private, no-store");
      const result = await response.json();
      expect(result.error).toBe("activity_cursor_invalid");
      expect(JSON.stringify(result)).not.toContain("private malformed marker");
      expect(JSON.stringify(result)).not.toContain("changed search");
    }
    for (const query of [{ limit: "501" }, { accountId: "wrong" }, { q: "x".repeat(121) }]) {
      const response = await app.request(path(query), authorized(readToken));
      expect(response.status).toBe(400);
      expect((await response.json()).error).toBe("activity_query_invalid");
    }
  });

  it("requires general accounts:read and never promotes an Assist cursor or token into that authority", async () => {
    const accountId = fixture();
    const first = await (await app.request(path({ accountId, limit: "1" }), authorized(readToken))).json();
    const url = path({ accountId, cursor: first.next_cursor });
    expect(requiredScopeForLocalRoute("GET", "/api/transactions")).toBe("accounts:read");
    expect((await app.request(url)).status).toBe(401);
    const keysOnly = await vault.unlock(PASSPHRASE, { scopes: ["keys:manage"] });
    expect((await app.request(url, authorized(keysOnly))).status).toBe(403);
    const assist = vault.createAssistAccess(ownerToken, { label: "History boundary fixture", account_ids: [accountId], allow_proposals: false, ttl_minutes: 5 });
    try { expect((await app.request(url, authorized(assist.token))).status).toBe(403); }
    finally { vault.revokeAssistAccess(ownerToken, assist.access.id); }
    const expired = await vault.unlock(PASSPHRASE, { scopes: ["accounts:read"], ttlMs: 1 });
    await Bun.sleep(5);
    expect((await app.request(url, authorized(expired))).status).toBe(401);
  });

  it("searches saved data without fetching providers, recording payments or changing balances and entries", async () => {
    const accountId = fixture();
    const before = {
      changes: db.query("SELECT total_changes() AS n").get(),
      account: db.query("SELECT balance_minor,balance_as_of FROM accounts WHERE id=?").get(accountId),
      payments: db.query("SELECT COUNT(*) AS n FROM payments").get(),
    };
    const originalFetch = globalThis.fetch;
    let networkCalls = 0;
    globalThis.fetch = (async (): Promise<Response> => { networkCalls++; throw new Error("No network allowed in history reads"); }) as unknown as typeof fetch;
    try {
      for (const query of [{ accountId, q: "category" }, { q: "100%" }, { accountId, q: "missing" }]) {
        expect((await app.request(path(query), authorized(readToken))).status).toBe(200);
      }
    } finally { globalThis.fetch = originalFetch; }
    expect(networkCalls).toBe(0);
    expect({
      changes: db.query("SELECT total_changes() AS n").get(),
      account: db.query("SELECT balance_minor,balance_as_of FROM accounts WHERE id=?").get(accountId),
      payments: db.query("SELECT COUNT(*) AS n FROM payments").get(),
    }).toEqual(before);
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
      read_environment: "local",
      in_minor: "922337203685477580812345679000",
      out_minor: "1844674407370955161624691357802",
      tx_count: 3,
    });
  });
});

describe("unified money view authority and reconciliation", () => {
  it("requires bank disconnection before archiving one of its accounts", async () => {
    const source = newId(), account = newId();
    db.query("INSERT INTO read_connections(id,provider,environment,display_name) VALUES(?,'plaid','sandbox','Synthetic bank')").run(source);
    db.query("INSERT INTO accounts(id,rail,display_name,currency,decimals,connector_type,read_connection_id) VALUES(?,'BANK','Synthetic checking','USD',2,'plaid',?)").run(account, source);
    const list = await (await app.request("/api/accounts", authorized(readToken))).json();
    expect(list.accounts.find((row: { id: string }) => row.id === account).read_connection_status).toBe("active");
    const refused = await app.request(`/api/accounts/${account}/archive`, authorized(ownerToken, { method: "POST" }));
    expect(refused.status).toBe(409);
    expect((await refused.json()).error).toBe("disconnect_before_archive");
    expect(db.query("SELECT status FROM accounts WHERE id=?").get(account)).toEqual({ status: "ACTIVE" });
    db.query("UPDATE read_connections SET status='disconnected' WHERE id=?").run(source);
    expect((await app.request(`/api/accounts/${account}/archive`, authorized(ownerToken, { method: "POST" }))).status).toBe(200);
    expect(db.query("SELECT status FROM accounts WHERE id=?").get(account)).toEqual({ status: "ARCHIVED" });
  });
  it("declares exact route scopes and keeps all connection reads private", async () => {
    for (const path of ["/api/connections", "/api/transfers", "/api/transactions/export"]) {
      expect(requiredScopeForLocalRoute("GET", path)).toBe("accounts:read");
      expect(requiredScopeForLocalRoute("DELETE", path)).toBeUndefined();
      expect((await app.request(path)).status).toBe(401);
      const response = await app.request(path, authorized(readToken));
      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("private, no-store");
    }
    for (const path of ["/api/connections/plaid/link", "/api/connections/plaid/exchange",
      "/api/connections/plaid/a/sync", "/api/connections/plaid/a/disconnect",
      "/api/transfers/link", "/api/transfers/a/unlink", "/api/transactions/import", "/api/transactions/import/preview"]) {
      expect(requiredScopeForLocalRoute("POST", path)).toBe("accounts:write");
      expect(requiredScopeForLocalRoute("GET", path)).toBeUndefined();
    }
    expect(requiredScopeForLocalRoute("POST", "/api/connections/plaid/activate-production")).toBeUndefined();
  });
  it("keeps connection mutation authority out of delegated sessions", async () => {
    expect(() => vault.createDelegatedAgentSession(ownerToken, {
      delegateKeyId: `sha256:${"e".repeat(64)}`, scopes: ["accounts:write"],
    })).toThrow();
    const delegated = vault.createDelegatedAgentSession(ownerToken, {
      delegateKeyId: `sha256:${"e".repeat(64)}`, scopes: ["accounts:read"],
    });
    const view = await app.request("/api/connections", authorized(delegated.token));
    expect((await view.json()).can_manage).toBe(false);
    for (const path of ["/api/connections/plaid/link", "/api/transactions/import/preview", "/api/transfers/link"]) {
      const response = await app.request(path, authorized(delegated.token, { method: "POST", body: "{}" }));
      expect(response.status).toBe(403);
      expect((await response.json()).error).toBe("insufficient_scope");
    }
  });
  it("counts a gross receipt and fee once while excluding pending, removed and confirmed internal transfers", async () => {
    const processor = newId(), bank = newId();
    for (const id of [processor, bank]) db.query("INSERT INTO accounts(id,rail,display_name,currency,decimals) VALUES(?,'BANK','Reconciliation fixture','USD',2)").run(id);
    const insert = db.query(`INSERT INTO transactions(id,account_id,title,amount_minor,date,source,status,gross_minor,fee_minor,net_minor)
      VALUES(?,?,'Synthetic flow',?,'2026-09-29T12:00:00.000Z','CONNECTOR',?,?,?,?)`);
    insert.run(newId(), processor, "9700", "posted", "10000", "300", "9700");
    const outgoing = newId(), incoming = newId();
    insert.run(outgoing, processor, "-9700", "posted", null, null, null);
    insert.run(incoming, bank, "9700", "posted", null, null, null);
    insert.run(newId(), bank, "50000", "pending", null, null, null);
    insert.run(newId(), bank, "60000", "removed", null, null, null);
    const linked = await app.request("/api/transfers/link", authorized(ownerToken, {
      method: "POST", body: JSON.stringify({ outgoing_id: outgoing, incoming_id: incoming }),
    }));
    expect(linked.status).toBe(200);
    const summary = await (await app.request("/api/analytics/summary", authorized(readToken))).json();
    expect(summary.accounts.find((account: { id: string }) => account.id === processor)).toMatchObject({ in_minor: "10000", out_minor: "300", tx_count: 1 });
    expect(summary.accounts.find((account: { id: string }) => account.id === bank)).toMatchObject({ in_minor: "0", out_minor: "0", tx_count: 0 });
  });
});
