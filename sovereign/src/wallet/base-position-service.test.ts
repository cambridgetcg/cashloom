import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import type {
  BasePositionObservation,
  BasePositionObserver,
  BasePositionProviderSighting,
} from "./adapters/base-position-observer.ts";
import {
  BASE_CHAIN_ID,
  BASE_ETH_ASSET_ID,
  BASE_USDC_ASSET_ID,
} from "./base-account-projection.ts";
import {
  BasePositionServiceError,
  createBasePositionService,
} from "./base-position-service.ts";
import { fingerprintRequest } from "./infrastructure/sqlite/store.ts";
import { installWalletKernelSchema } from "./infrastructure/sqlite/schema.ts";
import { WalletKernelStore } from "./infrastructure/sqlite/store.ts";

const ADDRESS = `0x${"1".repeat(40)}` as const;
const BLOCK_HASH = `0x${"a".repeat(64)}` as const;
const OBSERVED_AT = "2026-08-23T20:00:00.000Z";
const BLOCK_SECONDS = "1787515140";

const databases: Database[] = [];
afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

const evidence = (
  input: {
    blockHash?: `0x${string}`;
    blockNumber?: string;
    eth?: string;
    usdc?: string;
  } = {},
) => {
  const body = {
    schema_version: "cashloom.base-position-evidence/1" as const,
    chain_id: BASE_CHAIN_ID,
    account_address: ADDRESS,
    security_level: "FINALIZED" as const,
    block: {
      number: input.blockNumber ?? "9007199254740993123",
      hash: input.blockHash ?? BLOCK_HASH,
      timestamp: BLOCK_SECONDS,
    },
    balances: [
      {
        asset: "ETH" as const,
        asset_id: BASE_ETH_ASSET_ID,
        atomic: input.eth ?? "900719925474099312345678",
        decimals: "18" as const,
      },
      {
        asset: "USDC" as const,
        asset_id: BASE_USDC_ASSET_ID,
        atomic: input.usdc ?? "123456789012345678901234",
        decimals: "6" as const,
        contract_address: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913" as const,
      },
    ] as const,
  };
  return {
    body,
    hash: `sha256:${fingerprintRequest(body)}` as const,
  };
};

const settledObservation = (
  input: Parameters<typeof evidence>[0] = {},
): BasePositionObservation => {
  const core = evidence(input);
  const sighting = (
    providerId: string,
    trustByte: string,
  ): BasePositionProviderSighting => ({
    ...core.body,
    schema_version: "cashloom.base-position-sighting/1",
    provider_id: providerId,
    provider_trust_domain: `sha256:${trustByte.repeat(64)}`,
    evidence_hash: core.hash,
    observed_at: OBSERVED_AT,
    fetched_at: OBSERVED_AT,
  });
  const first = sighting("base-a", "b");
  const second = sighting("base-b", "c");
  return {
    schema_version: "cashloom.base-position-observation/1",
    state: "settled",
    chain_id: BASE_CHAIN_ID,
    account_address: ADDRESS,
    observed_at: OBSERVED_AT,
    providers: [
      { provider_id: "base-a", state: "observed", sighting: first },
      { provider_id: "base-b", state: "observed", sighting: second },
    ],
    sightings: [first, second],
    snapshot: {
      ...core.body,
      schema_version: "cashloom.base-position-snapshot/1",
      evidence_hash: core.hash,
      provider_ids: ["base-a", "base-b"],
      quorum: "2",
      observed_at: OBSERVED_AT,
    },
  };
};

const partialObservation = (): BasePositionObservation => ({
  schema_version: "cashloom.base-position-observation/1",
  state: "partial",
  reason: "provider_unavailable",
  chain_id: BASE_CHAIN_ID,
  account_address: ADDRESS,
  observed_at: "2026-08-23T20:02:00.000Z",
  providers: [
    {
      provider_id: "base-a",
      state: "head_observed",
      finalized_head: { number: "2", hash: BLOCK_HASH, timestamp: BLOCK_SECONDS },
    },
    { provider_id: "base-b", state: "unavailable", error_code: "network_unavailable" },
  ],
  sightings: [],
});

const unavailableObservation = (): BasePositionObservation => ({
  ...partialObservation(),
  observed_at: "2026-08-23T20:02:30.000Z",
  providers: [
    { provider_id: "base-a", state: "unavailable", error_code: "deadline_exceeded" },
    { provider_id: "base-b", state: "unavailable", error_code: "network_unavailable" },
  ],
});

const disagreementObservation = (): BasePositionObservation => {
  const first = settledObservation().sightings[0]!;
  const secondCore = evidence({ eth: "42" });
  const second: BasePositionProviderSighting = {
    ...secondCore.body,
    schema_version: "cashloom.base-position-sighting/1",
    provider_id: "base-b",
    provider_trust_domain: `sha256:${"c".repeat(64)}`,
    evidence_hash: secondCore.hash,
    observed_at: "2026-08-23T20:02:45.000Z",
    fetched_at: "2026-08-23T20:02:45.000Z",
  };
  return {
    schema_version: "cashloom.base-position-observation/1",
    state: "partial",
    reason: "provider_disagreement",
    chain_id: BASE_CHAIN_ID,
    account_address: ADDRESS,
    observed_at: "2026-08-23T20:02:45.000Z",
    providers: [
      { provider_id: "base-a", state: "observed", sighting: first },
      { provider_id: "base-b", state: "observed", sighting: second },
    ],
    sightings: [first, second],
  };
};

const fixture = (observations: Array<BasePositionObservation | Error>) => {
  const database = new Database(":memory:");
  databases.push(database);
  database.exec(`
    PRAGMA foreign_keys=ON;
    CREATE TABLE accounts (
      id TEXT PRIMARY KEY, rail TEXT NOT NULL, display_name TEXT NOT NULL,
      currency TEXT NOT NULL, decimals INTEGER NOT NULL, balance_minor TEXT NOT NULL,
      chain_id TEXT, asset_id TEXT, account_ref TEXT, vault_key_id TEXT,
      status TEXT NOT NULL, created_at TEXT NOT NULL
    );
    CREATE TABLE vault_keys (
      id TEXT PRIMARY KEY, kind TEXT NOT NULL, address TEXT, enc_blob BLOB NOT NULL
    );
  `);
  installWalletKernelSchema(database);
  database.query(
    `INSERT INTO accounts
      (id,rail,display_name,currency,decimals,balance_minor,chain_id,asset_id,
       account_ref,vault_key_id,status,created_at)
     VALUES ('account','CRYPTO','Base wallet','USDC',6,'0',?,?,?,NULL,'ACTIVE',?)`,
  ).run(BASE_CHAIN_ID, BASE_USDC_ASSET_ID, `${BASE_CHAIN_ID}:${ADDRESS}`, OBSERVED_AT);
  const store = new WalletKernelStore(database, {
    now: () => new Date("2026-08-23T20:03:00.000Z"),
  });
  let calls = 0;
  const observer: BasePositionObserver = {
    async observe() {
      const value = observations[Math.min(calls, observations.length - 1)];
      calls += 1;
      if (!value) throw new Error("test observer exhausted");
      if (value instanceof Error) throw value;
      return value;
    },
  };
  const service = createBasePositionService({
    db: database,
    store,
    observer,
    now: () => new Date("2026-08-23T20:04:00.000Z"),
  });
  return { database, store, service, calls: () => calls };
};

describe("Base position service", () => {
  test("keeps GET local and says not checked before an explicit refresh", () => {
    const { service, calls } = fixture([partialObservation()]);
    const view = service.listPositions();
    expect(calls()).toBe(0);
    expect(view.schema_version).toBe("cashloom.wallet-kernel-positions/3");
    expect(view.base_accounts).toHaveLength(1);
    expect(view.base_accounts[0]).toMatchObject({
      status: "not_checked",
      snapshot: null,
      positions: [],
      last_refresh: null,
      actions: { refresh: true },
    });
  });

  test("exposes malformed Base identities as explicit refusals instead of omitting them", () => {
    const { database, service, calls } = fixture([partialObservation()]);
    database.query("UPDATE accounts SET decimals=18 WHERE id='account'").run();
    const view = service.listPositions();
    expect(calls()).toBe(0);
    expect(view.base_accounts).toEqual([expect.objectContaining({
      account_id: "account",
      status: "identity_invalid",
      actions: { refresh: false },
      refusal: {
        code: "base_account_identity_invalid",
        message: "This account is not an exact supported Base ETH or native USDC identity.",
      },
    })]);
  });

  test("marks duplicate legacy rows for one CAIP-10 identity so agents do not double-count", () => {
    const { database, service } = fixture([partialObservation()]);
    database.query(
      `INSERT INTO accounts
       (id,rail,display_name,currency,decimals,balance_minor,chain_id,asset_id,
        account_ref,vault_key_id,status,created_at)
       VALUES ('account-copy','CRYPTO','Same wallet copy','ETH',18,'0',?,?,?,NULL,'ACTIVE',?)`,
    ).run(BASE_CHAIN_ID, BASE_ETH_ASSET_ID, `${BASE_CHAIN_ID}:${ADDRESS}`, OBSERVED_AT);
    const views = service.listPositions().base_accounts;
    expect(views).toHaveLength(2);
    for (const view of views) {
      expect(view.identity_group).toEqual({
        canonical_account_ref: `${BASE_CHAIN_ID}:${ADDRESS}`,
        canonical_account_id: "account",
        account_ids: ["account", "account-copy"],
        duplicate: true,
      });
    }
  });

  test("applies exact two-provider finalized ETH and USDC atomically and replays safely", async () => {
    const observation = settledObservation();
    const { service, store } = fixture([observation, observation]);
    const first = await service.refreshAccount("account");
    expect(first.outcome).toBe("applied");
    expect(first.account.status).toBe("finalized");
    expect(first.account.snapshot).toMatchObject({
      block: { number: "9007199254740993123", hash: BLOCK_HASH },
      provider_ids: ["base-a", "base-b"],
      quorum: "2",
    });
    expect(first.account.positions.map((position) => [
      position.symbol,
      position.observed_atomic,
    ])).toEqual([
      ["USDC", "123456789012345678901234"],
      ["ETH", "900719925474099312345678"],
    ]);
    expect(store.listBasePositionSightings({ accountId: "account" })).toHaveLength(2);
    expect((await service.refreshAccount("account")).outcome).toBe("replayed");
    expect(store.listBasePositions({ accountId: "account" })).toHaveLength(2);
  });

  test("retains the last finalized snapshot when a later provider check is partial", async () => {
    const { service, store } = fixture([settledObservation(), partialObservation()]);
    await service.refreshAccount("account");
    const before = store.listBasePositions({ accountId: "account" });
    const partial = await service.refreshAccount("account");
    expect(partial.outcome).toBe("partial");
    expect(partial.observation).toMatchObject({
      state: "partial",
      available_providers: "1",
      unavailable_providers: "1",
    });
    expect(partial.account.status).toBe("finalized");
    expect(partial.account.last_refresh).toMatchObject({
      outcome: "partial",
      reason_code: "provider_unavailable",
      provider_count: "2",
      available_provider_count: "1",
      agreeing_provider_count: "0",
      retained_head: { state: "ACTIVE" },
    });
    expect(store.listBasePositions({ accountId: "account" })).toEqual(before);
  });

  test("durably distinguishes a fully unavailable check from never checked", async () => {
    const { service, store } = fixture([unavailableObservation()]);
    const result = await service.refreshAccount("account");
    expect(result.outcome).toBe("partial");
    expect(result.account.status).toBe("not_checked");
    expect(result.account.last_refresh).toMatchObject({
      outcome: "partial",
      reason_code: "provider_unavailable",
      provider_count: "2",
      available_provider_count: "0",
      agreeing_provider_count: "0",
      retained_head: null,
    });
    expect(store.listBasePositionSightings({ accountId: "account" })).toHaveLength(0);
    expect(service.listPositions().base_accounts[0]?.last_refresh?.attempt_id)
      .toBe(result.account.last_refresh?.attempt_id);
  });

  test("records the largest evidence agreement group, not the number of disagreeing sightings", async () => {
    const { service } = fixture([disagreementObservation()]);
    const result = await service.refreshAccount("account");
    expect(result.account.last_refresh).toMatchObject({
      outcome: "partial",
      reason_code: "provider_disagreement",
      provider_count: "2",
      available_provider_count: "2",
      agreeing_provider_count: "1",
    });
  });

  test("freezes same-height contradictory evidence without replacing the first balance", async () => {
    const contradiction = settledObservation({
      blockHash: `0x${"d".repeat(64)}`,
      eth: "1",
      usdc: "2",
    });
    const { service, store } = fixture([settledObservation(), contradiction]);
    await service.refreshAccount("account");
    const before = store.listBasePositions({ accountId: "account" });
    const conflict = await service.refreshAccount("account");
    expect(conflict.outcome).toBe("conflict");
    expect(conflict.account.status).toBe("conflicted");
    expect(conflict.account.actions.refresh).toBe(false);
    expect(conflict.account.last_refresh).toMatchObject({
      outcome: "conflict",
      reason_code: "finalized_quorum",
      retained_head: { state: "FROZEN" },
    });
    expect(store.listBasePositions({ accountId: "account" })).toEqual(before.map((row) => ({
      ...row,
      headState: "FROZEN",
      conflictSnapshotId: conflict.account.snapshot === null
        ? row.conflictSnapshotId
        : store.getBasePositionHead("account")!.conflictSnapshotId,
      headVersion: row.headVersion + 1,
    })));
  });

  test("rejects an unauthenticated evidence hash before any sighting or balance write", async () => {
    const malformed = settledObservation();
    const first = malformed.sightings[0]!;
    const changed = { ...first, evidence_hash: `sha256:${"f".repeat(64)}` as const };
    const forged: BasePositionObservation = {
      ...malformed,
      providers: [
        { provider_id: "base-a", state: "observed", sighting: changed },
        malformed.providers[1],
      ],
      sightings: [changed, malformed.sightings[1]!],
    };
    const { service, store } = fixture([forged]);
    try {
      await service.refreshAccount("account");
      throw new Error("expected malformed evidence to be refused");
    } catch (error) {
      expect(error).toBeInstanceOf(BasePositionServiceError);
      expect(error).toMatchObject({
        code: "base_position_evidence_rejected",
        status: 502,
        message:
          "Base position evidence was unavailable, malformed, or failed its durable proof checks.",
      });
    }
    expect(store.listBasePositionSightings({ accountId: "account" })).toHaveLength(0);
    expect(store.listBasePositions({ accountId: "account" })).toHaveLength(0);
  });

  test("rejects duplicate trust domains and unknown provider states before persistence", async () => {
    const duplicated = settledObservation();
    const first = duplicated.sightings[0]!;
    const second = {
      ...duplicated.sightings[1]!,
      provider_trust_domain: first.provider_trust_domain,
    };
    const duplicateTrust: BasePositionObservation = {
      ...duplicated,
      providers: [
        duplicated.providers[0],
        { provider_id: "base-b", state: "observed", sighting: second },
      ],
      sightings: [first, second],
    };
    const unknownState = {
      ...partialObservation(),
      providers: [
        { provider_id: "base-a", state: "invented_state" },
        { provider_id: "base-b", state: "unavailable", error_code: "network_unavailable" },
      ],
    } as unknown as BasePositionObservation;

    for (const observation of [duplicateTrust, unknownState]) {
      const { service, store } = fixture([observation]);
      await expect(service.refreshAccount("account")).rejects.toMatchObject({
        code: "base_position_evidence_rejected",
        status: 502,
      });
      expect(store.listBasePositionSightings({ accountId: "account" })).toHaveLength(0);
    }
  });

  test("rejects extra nested balance telemetry before it can enter durable evidence", async () => {
    const original = settledObservation();
    const balances = [
      { ...original.sightings[0]!.balances[0], secret_note: "SECRET_NESTED_CANARY" },
      original.sightings[0]!.balances[1],
    ] as const;
    const body = {
      schema_version: "cashloom.base-position-evidence/1",
      chain_id: BASE_CHAIN_ID,
      account_address: ADDRESS,
      security_level: "FINALIZED",
      block: original.sightings[0]!.block,
      balances,
    } as const;
    const hash = `sha256:${fingerprintRequest(body)}` as const;
    const first = {
      ...original.sightings[0]!,
      balances,
      evidence_hash: hash,
    };
    const second = {
      ...original.sightings[1]!,
      balances,
      evidence_hash: hash,
    };
    const forged = {
      ...original,
      providers: [
        { provider_id: "base-a", state: "observed", sighting: first },
        { provider_id: "base-b", state: "observed", sighting: second },
      ],
      sightings: [first, second],
      snapshot: {
        ...original.snapshot!,
        balances,
        evidence_hash: hash,
      },
    } as unknown as BasePositionObservation;
    const { service, store } = fixture([forged]);
    await expect(service.refreshAccount("account")).rejects.toMatchObject({
      code: "base_position_evidence_rejected",
      status: 502,
    });
    expect(store.listBasePositionSightings({ accountId: "account" })).toHaveLength(0);
    expect(JSON.stringify(store.listBasePositionRefreshAttempts({ accountId: "account" })))
      .not.toContain("SECRET_NESTED_CANARY");
  });

  test("never echoes credential-bearing observer failures", async () => {
    const canary = "SECRET_CANARY_do_not_echo";
    const { service } = fixture([
      new Error(`https://provider.invalid/v2/${canary} failed`),
    ]);
    try {
      await service.refreshAccount("account");
      throw new Error("expected provider failure");
    } catch (error) {
      expect(error).toMatchObject({
        code: "base_position_evidence_rejected",
        status: 502,
      });
      expect(String(error)).not.toContain(canary);
    }
    expect(service.listPositions().base_accounts[0]?.last_refresh).toMatchObject({
      outcome: "rejected",
      reason_code: "evidence_rejected",
      error_code: "base_position_evidence_rejected",
      provider_count: "2",
      available_provider_count: "0",
    });
  });
});
