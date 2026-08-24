import { afterEach, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AuthorizationConflictError,
  BASE_CHAIN_ID,
  BASE_ETH_ASSET_ID,
  BASE_USDC_ASSET_ID,
  BasePositionRefreshAttemptConflictError,
  BasePositionSnapshotConflictError,
  BaseReconciliationJobConflictError,
  ChainEvidenceConflictError,
  ExecutionConflictError,
  IdempotencyConflictError,
  InsufficientAvailableBalanceError,
  IntentTransitionConflictError,
  JournalUnbalancedError,
  ReservationConflictError,
  WALLET_KERNEL_TABLES,
  WalletKernelStore,
  installWalletKernelSchema,
} from "./index.ts";

const openDatabases: Database[] = [];
const temporaryDirectories: string[] = [];

afterEach(() => {
  while (openDatabases.length > 0) openDatabases.pop()?.close();
  while (temporaryDirectories.length > 0) {
    const directory = temporaryDirectories.pop();
    if (directory) rmSync(directory, { recursive: true, force: true });
  }
});

const database = (): Database => {
  const db = new Database(":memory:");
  openDatabases.push(db);
  return db;
};

const makeStore = (): WalletKernelStore => {
  const store = new WalletKernelStore(database());
  store.putWallet({ id: "wallet-1", label: "Primary" });
  store.putAsset({
    id: "iso4217:USD",
    kind: "FIAT",
    symbol: "USD",
    name: "US Dollar",
    decimals: 2,
  });
  store.putAsset({
    id: "eip155:1/slip44:60",
    instrumentId: "native:ETH",
    kind: "CRYPTO",
    symbol: "ETH",
    name: "Ether",
    decimals: 18,
    chainId: "eip155:1",
  });
  store.putAccount({
    id: "account-1",
    walletId: "wallet-1",
    label: "Checking",
    kind: "BANK",
    rail: "ACH",
    accountRef: "provider-account-1",
    custodyMode: "regulated_fiat_provider",
  });
  store.setPosition({
    accountId: "account-1",
    assetId: "iso4217:USD",
    observedAtomic: "10000",
    source: "TEST",
  });
  return store;
};

const createIntent = (store: WalletKernelStore, overrides: { amountAtomic?: string; id?: string } = {}) =>
  store.createPaymentIntent({
    id: overrides.id,
    kind: "TRANSFER",
    sourceAccountId: "account-1",
    assetId: "iso4217:USD",
    amountAtomic: overrides.amountAtomic ?? "2500",
    destination: { kind: "BANK_ACCOUNT", payeeId: "payee-1" },
    intentHash: "intent-hash-1",
    createdBy: { type: "HUMAN", ref: "user-1" },
  });

const reserveSigningResource = (
  store: WalletKernelStore,
  intentId: string,
  id = `signing-reservation.${intentId}`,
  expiresAt: string | null = null,
) => store.acquireReservation({
  id,
  intentId,
  accountId: "account-1",
  assetId: "iso4217:USD",
  kind: "NONCE",
  resourceKey: `test:${intentId}`,
  amountAtomic: "1",
  expiresAt,
}).reservation;

const createSubmittedExecution = (store: WalletKernelStore, suffix: string) => {
  const intent = createIntent(store, { id: `chain-intent-${suffix}` }).intent;
  const reservation = reserveSigningResource(
    store,
    intent.id,
    `chain-reservation-${suffix}`,
  );
  const authorization = store.createSigningAuthorization({
    id: `chain-authorization-${suffix}`,
    intentId: intent.id,
    intentHash: intent.intentHash,
    keyId: `chain-key-${suffix}`,
    requestHash: `chain-request-${suffix}`,
    actor: { type: "HUMAN", ref: "chain-test" },
    method: "TEST",
    grantHash: `chain-grant-${suffix}`,
  }).authorization;
  const networkTxId = `0x${suffix.padEnd(64, "0")}`;
  const artifact = store.persistSignedArtifact({
    id: `chain-artifact-${suffix}`,
    authorizationId: authorization.id,
    intentId: intent.id,
    intentHash: intent.intentHash,
    keyId: authorization.keyId,
    requestHash: authorization.requestHash,
    encoding: "hex",
    payload: "0x0102",
    externalTxId: networkTxId,
  }).artifact;
  const prepared = store.createExecution({
    id: `chain-execution-${suffix}`,
    intentId: intent.id,
    rail: "eip155:8453",
    preparedRef: authorization.id,
    requestHash: authorization.requestHash,
  }).execution;
  const signed = store.transitionExecution({
    id: prepared.id,
    expectedState: "prepared",
    expectedVersion: prepared.version,
    toState: "signed",
    networkTxId,
    signedArtifactId: artifact.id,
    response: { artifact_id: artifact.id },
  });
  const execution = store.transitionExecution({
    id: signed.id,
    expectedState: "signed",
    expectedVersion: signed.version,
    toState: "submitted",
    submissionRef: `base:${networkTxId}`,
    submittedAt: "2026-08-23T00:00:00.000Z",
  });
  return { intent, reservation, authorization, artifact, execution, networkTxId };
};

const makeBaseTruthStore = (db: Database = database()) => {
  let clock = "2026-08-23T10:00:00.000Z";
  let nextId = 0;
  const store = new WalletKernelStore(db, {
    now: () => new Date(clock),
    newId: () => `base-generated-${++nextId}`,
  });
  store.putWallet({ id: "base-wallet", label: "Base wallet" });
  store.putAsset({
    id: BASE_ETH_ASSET_ID,
    instrumentId: "native:ETH",
    kind: "CRYPTO",
    symbol: "ETH",
    name: "Ether on Base",
    decimals: 18,
    chainId: BASE_CHAIN_ID,
  });
  store.putAsset({
    id: BASE_USDC_ASSET_ID,
    instrumentId: "native:USDC",
    kind: "CRYPTO",
    symbol: "USDC",
    name: "Circle USDC on Base",
    decimals: 6,
    chainId: BASE_CHAIN_ID,
    contractAddress: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
  });
  store.putAccount({
    id: "base-account",
    walletId: "base-wallet",
    label: "Base account",
    kind: "CRYPTO",
    rail: "evm-base",
    chainId: BASE_CHAIN_ID,
    accountRef: `${BASE_CHAIN_ID}:0x1111111111111111111111111111111111111111`,
    address: "0x1111111111111111111111111111111111111111",
    custodyMode: "local_self_custody",
  });
  store.setPosition({
    accountId: "base-account",
    assetId: BASE_ETH_ASSET_ID,
    observedAtomic: "1",
    pendingAtomic: "5",
    source: "TEST",
  });
  store.setPosition({
    accountId: "base-account",
    assetId: BASE_USDC_ASSET_ID,
    observedAtomic: "2",
    pendingAtomic: "7",
    source: "TEST",
  });
  return {
    store,
    setClock: (value: string) => {
      clock = value;
    },
  };
};

const createBaseExecution = (store: WalletKernelStore, suffix: string) => {
  const intent = store.createPaymentIntent({
    id: `base-intent-${suffix}`,
    kind: "TRANSFER",
    sourceAccountId: "base-account",
    assetId: BASE_ETH_ASSET_ID,
    amountAtomic: "1",
    destination: { kind: "EVM_ADDRESS", address: "0x2222222222222222222222222222222222222222" },
    intentHash: `base-intent-hash-${suffix}`,
    createdBy: { type: "HUMAN", ref: "base-test" },
  }).intent;
  store.acquireReservation({
    id: `base-reservation-${suffix}`,
    intentId: intent.id,
    accountId: "base-account",
    assetId: BASE_ETH_ASSET_ID,
    kind: "NONCE",
    resourceKey: `base-nonce-${suffix}`,
    amountAtomic: "1",
  });
  const authorization = store.createSigningAuthorization({
    id: `base-auth-${suffix}`,
    intentId: intent.id,
    intentHash: intent.intentHash,
    keyId: `base-key-${suffix}`,
    requestHash: `base-request-${suffix}`,
    actor: { type: "HUMAN", ref: "base-test" },
    method: "TEST",
    grantHash: `base-grant-${suffix}`,
  }).authorization;
  const nibble = /^[0-9a-f]$/.test(suffix) ? suffix : "a";
  const networkTxId = `0x${nibble.repeat(64)}`;
  const artifact = store.persistSignedArtifact({
    id: `base-artifact-${suffix}`,
    authorizationId: authorization.id,
    intentId: intent.id,
    intentHash: intent.intentHash,
    keyId: authorization.keyId,
    requestHash: authorization.requestHash,
    encoding: "hex",
    payload: "0x0102",
    externalTxId: networkTxId,
  }).artifact;
  const prepared = store.createExecution({
    id: `base-execution-${suffix}`,
    intentId: intent.id,
    rail: "evm-base",
    preparedRef: authorization.id,
    requestHash: authorization.requestHash,
  }).execution;
  const signed = store.transitionExecution({
    id: prepared.id,
    expectedState: "prepared",
    expectedVersion: prepared.version,
    toState: "signed",
    networkTxId,
    signedArtifactId: artifact.id,
  });
  const execution = store.transitionExecution({
    id: signed.id,
    expectedState: "signed",
    expectedVersion: signed.version,
    toState: "submitted",
    submissionRef: `base:${networkTxId}`,
    submittedAt: "2026-08-23T10:00:00.000Z",
  });
  return { intent, artifact, execution, networkTxId };
};

const hash = (nibble: string): `0x${string}` => `0x${nibble.repeat(64)}`;
const digest = (nibble: string): `sha256:${string}` => `sha256:${nibble.repeat(64)}`;

const appendBasePositionEvidence = (
  store: WalletKernelStore,
  input: {
    blockNumber: string;
    blockHash: `0x${string}`;
    blockTime: string;
    evidenceHash: `sha256:${string}`;
    ethAtomic: string;
    usdcAtomic: string;
    observedAt: string;
    trustDomains?: readonly [`sha256:${string}`, `sha256:${string}`];
  },
) => {
  const items = [
    { assetId: BASE_ETH_ASSET_ID, observedAtomic: input.ethAtomic },
    { assetId: BASE_USDC_ASSET_ID, observedAtomic: input.usdcAtomic },
  ] as const;
  const trustDomains = input.trustDomains ?? [digest("a"), digest("b")];
  const sightings = (["base-position-a", "base-position-b"] as const).map(
    (providerId, index) => store.appendBasePositionSighting({
      accountId: "base-account",
      providerId,
      providerTrustDomain: trustDomains[index]!,
      evidenceHash: input.evidenceHash,
      blockNumber: input.blockNumber,
      blockHash: input.blockHash,
      blockTime: input.blockTime,
      items,
      body: { header: input.blockHash, balances: items },
      observedAt: input.observedAt,
      fetchedAt: input.observedAt,
    }).sighting,
  );
  return {
    accountId: "base-account",
    blockNumber: input.blockNumber,
    blockHash: input.blockHash,
    blockTime: input.blockTime,
    evidenceHash: input.evidenceHash,
    providerIds: sightings.map(({ providerId }) => providerId),
    sightingIds: sightings.map(({ id }) => id),
    quorum: 2,
    items,
    decidedAt: input.observedAt,
  } as const;
};

describe("Wallet Kernel v2 schema", () => {
  it("installs idempotently without replacing the sovereign v1 accounts table", () => {
    const db = database();
    db.exec("CREATE TABLE accounts (id TEXT PRIMARY KEY, legacy_value TEXT NOT NULL)");
    db.query("INSERT INTO accounts VALUES ('legacy-account', 'preserved')").run();

    installWalletKernelSchema(db);
    db.exec("DROP TRIGGER wk_executions_initial_state");
    db.exec(`
      CREATE TRIGGER wk_executions_initial_state
      BEFORE INSERT ON wk_executions
      BEGIN SELECT 1; END
    `);
    db.exec(`
      CREATE UNIQUE INDEX wk_accounts_external_identity_uq
      ON wk_accounts(wallet_id, rail, account_ref)
      WHERE account_ref IS NOT NULL
    `);
    installWalletKernelSchema(db);

    const tables = new Set(
      (db.query("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>).map(
        ({ name }) => name,
      ),
    );
    expect(WALLET_KERNEL_TABLES.every((name) => tables.has(name))).toBe(true);
    expect(db.query("SELECT legacy_value FROM accounts WHERE id='legacy-account'").get()).toEqual({
      legacy_value: "preserved",
    });
    expect(db.query("SELECT version FROM wk_schema_meta ORDER BY version").all()).toEqual([
      { version: 5 },
      { version: 6 },
      { version: 7 },
      { version: 8 },
    ]);
    expect(
      db.query("SELECT name FROM sqlite_master WHERE type='index' AND name='wk_accounts_external_identity_uq'").get(),
    ).toBeNull();
    const upgradedTrigger = db.query(
      "SELECT sql FROM sqlite_master WHERE type='trigger' AND name='wk_executions_initial_state'",
    ).get() as { sql: string };
    expect(upgradedTrigger.sql).toContain("execution must begin prepared");
  });

  it("grows pre-release authorization bindings before installing their safety triggers", () => {
    const db = database();
    db.exec(`
      CREATE TABLE wk_authorizations (
        id TEXT PRIMARY KEY,
        intent_id TEXT NOT NULL,
        actor_type TEXT NOT NULL,
        actor_ref TEXT NOT NULL,
        method TEXT NOT NULL,
        grant_hash TEXT NOT NULL UNIQUE,
        constraints_json TEXT NOT NULL DEFAULT '{}',
        status TEXT NOT NULL DEFAULT 'ACTIVE',
        expires_at TEXT,
        consumed_at TEXT,
        revoked_at TEXT,
        created_at TEXT NOT NULL
      )
    `);
    db.query(
      `INSERT INTO wk_authorizations
         (id, intent_id, actor_type, actor_ref, method, grant_hash,
          constraints_json, status, consumed_at, created_at)
       VALUES ('legacy-consumed', 'legacy-intent', 'HUMAN', 'legacy-user',
               'LEGACY', 'legacy-grant', '{}', 'CONSUMED',
               '2026-08-20T00:00:00.000Z', '2026-08-20T00:00:00.000Z')`,
    ).run();

    expect(() => installWalletKernelSchema(db)).not.toThrow();
    const columns = new Set(
      (db.query("PRAGMA table_info(wk_authorizations)").all() as Array<{ name: string }>).map(
        ({ name }) => name,
      ),
    );
    expect(["intent_hash", "key_id", "request_hash"].every((name) => columns.has(name))).toBe(true);
    expect(db.query(
      "SELECT COUNT(*) AS count FROM wk_signed_artifacts WHERE authorization_id='legacy-consumed'",
    ).get()).toEqual({ count: 0 });
    expect(() =>
      db.query("UPDATE wk_authorizations SET status='ACTIVE' WHERE id='legacy-consumed'").run(),
    ).toThrow(/consumed signing authorizations are immutable/);
  });

  it("upgrades a v5 marker to v6 exactly once while preserving v5 history", () => {
    const db = database();
    installWalletKernelSchema(db);
    db.exec(`
      DROP TABLE wk_chain_consensus;
      DROP TABLE wk_chain_sightings;
      DELETE FROM wk_schema_meta WHERE version=6;
    `);

    installWalletKernelSchema(db);
    installWalletKernelSchema(db);

    expect(db.query("SELECT version FROM wk_schema_meta ORDER BY version").all()).toEqual([
      { version: 5 },
      { version: 6 },
      { version: 7 },
      { version: 8 },
    ]);
    expect(db.query(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='wk_chain_sightings'",
    ).get()).toEqual({ name: "wk_chain_sightings" });
    expect(db.query(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='wk_chain_consensus'",
    ).get()).toEqual({ name: "wk_chain_consensus" });
  });

  it("installs the additive v7 queue and Base position evidence tables idempotently", () => {
    const db = database();
    installWalletKernelSchema(db);
    db.exec(`
      DROP TABLE wk_base_position_snapshot_heads;
      DROP TABLE wk_base_position_snapshot_items;
      DROP TABLE wk_base_position_snapshots;
      DROP TABLE wk_base_position_snapshot_sightings;
      DROP TABLE wk_base_reconciliation_jobs;
      DELETE FROM wk_schema_meta WHERE version=7;
    `);

    installWalletKernelSchema(db);
    installWalletKernelSchema(db);

    const tables = new Set(
      (db.query(
        "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'wk_base_%'",
      ).all() as Array<{ name: string }>).map(({ name }) => name),
    );
    expect([
      "wk_base_reconciliation_jobs",
      "wk_base_position_snapshot_sightings",
      "wk_base_position_snapshots",
      "wk_base_position_snapshot_items",
      "wk_base_position_snapshot_heads",
    ].every((name) => tables.has(name))).toBe(true);
    expect(db.query("SELECT COUNT(*) AS count FROM wk_schema_meta WHERE version=7").get()).toEqual({
      count: 1,
    });
  });

  it("upgrades v7 with the append-only Base refresh-attempt ledger exactly once", () => {
    const db = database();
    installWalletKernelSchema(db);
    db.exec(`
      DROP TABLE wk_base_position_refresh_attempts;
      DELETE FROM wk_schema_meta WHERE version=8;
    `);

    installWalletKernelSchema(db);
    installWalletKernelSchema(db);

    expect(db.query(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='wk_base_position_refresh_attempts'",
    ).get()).toEqual({ name: "wk_base_position_refresh_attempts" });
    expect(db.query(
      "SELECT COUNT(*) AS count FROM wk_schema_meta WHERE version=8",
    ).get()).toEqual({ count: 1 });
    const managedObjects = new Set((db.query(
      `SELECT name FROM sqlite_master
       WHERE name LIKE 'wk_base_position_refresh_attempts_%'`,
    ).all() as Array<{ name: string }>).map(({ name }) => name));
    expect([
      "wk_base_position_refresh_attempts_account_idx",
      "wk_base_position_refresh_attempts_binding_insert",
      "wk_base_position_refresh_attempts_no_update",
      "wk_base_position_refresh_attempts_no_delete",
    ].every((name) => managedObjects.has(name))).toBe(true);
  });

  it("fails an old duplicate-consumed resource migration with an actionable quarantine error", () => {
    const store = makeStore();
    const first = createIntent(store, { id: "migration-conflict-intent-1" }).intent;
    const second = createIntent(store, { id: "migration-conflict-intent-2" }).intent;
    store.db.exec("DROP INDEX wk_reservations_claimed_resource_uq");
    const insert = store.db.query(`
      INSERT INTO wk_reservations
        (id, intent_id, account_id, asset_id, kind, resource_key, amount_atomic,
         state, version, created_at, updated_at, consumed_at)
      VALUES (?, ?, 'account-1', 'iso4217:USD', 'NONCE',
              'eip155:1:account-1:legacy-duplicate', '1', 'CONSUMED', 1, ?, ?, ?)
    `);
    for (const [id, intentId] of [
      ["legacy-duplicate-reservation-1", first.id],
      ["legacy-duplicate-reservation-2", second.id],
    ] as const) {
      insert.run(
        id,
        intentId,
        "2026-08-20T00:00:00.000Z",
        "2026-08-20T00:00:00.000Z",
        "2026-08-20T00:00:00.000Z",
      );
    }

    expect(() => installWalletKernelSchema(store.db)).toThrow(
      /migration blocked.*2 live\/consumed NONCE claims.*Quarantine and reconcile/,
    );
    expect(store.db.query(
      "SELECT COUNT(*) AS count FROM wk_reservations WHERE resource_key='eip155:1:account-1:legacy-duplicate'",
    ).get()).toEqual({ count: 2 });
  });

  it("repairs artifact-backed ACTIVE claims and fail-closes legacy submitted executions", () => {
    const store = makeStore();
    const intent = createIntent(store, { id: "migration-artifact-intent" }).intent;
    const reservation = reserveSigningResource(store, intent.id, "migration-artifact-reservation");
    const authorization = store.createSigningAuthorization({
      id: "migration-artifact-authorization",
      intentId: intent.id,
      intentHash: intent.intentHash,
      keyId: "migration-artifact-key",
      requestHash: "migration-artifact-request",
      actor: { type: "HUMAN", ref: "migration-test" },
      method: "TEST",
      grantHash: "migration-artifact-grant",
    }).authorization;
    const artifact = store.persistSignedArtifact({
      authorizationId: authorization.id,
      intentId: intent.id,
      intentHash: intent.intentHash,
      keyId: authorization.keyId,
      requestHash: authorization.requestHash,
      encoding: "hex",
      payload: "0x0102",
      externalTxId: "migration-artifact-transaction",
    }).artifact;
    store.db.exec("DROP TRIGGER wk_reservations_consumed_transition_guard");
    store.db.query(
      `UPDATE wk_reservations
       SET state='ACTIVE', version=version+1, consumed_at=NULL
       WHERE id=?`,
    ).run(reservation.id);

    const execution = store.createExecution({
      id: "migration-legacy-submitted-execution",
      intentId: intent.id,
      rail: "btc",
      state: "prepared",
      preparedRef: authorization.id,
      requestHash: authorization.requestHash,
    }).execution;
    store.db.exec("DROP TRIGGER wk_executions_state_transition");
    store.db.exec("DROP TRIGGER wk_executions_signed_artifact_binding_update");
    store.db.query(
      "UPDATE wk_executions SET state='submitted', network_tx_id='legacy-unbound-tx' WHERE id=?",
    ).run(execution.id);

    installWalletKernelSchema(store.db);
    expect(store.getReservation(reservation.id)).toMatchObject({ state: "CONSUMED" });
    expect(store.getSignedArtifact(artifact.id)?.id).toBe(artifact.id);
    expect(() =>
      store.db.query(
        "UPDATE wk_executions SET state='succeeded', version=version+1 WHERE id=?",
      ).run(execution.id),
    ).toThrow(/not bound to its durable artifact/);
  });

  it("preserves distinct legacy account rows that share one external identity", () => {
    const store = makeStore();
    store.putAccount({
      id: "account-2",
      walletId: "wallet-1",
      label: "Same bank connection, separate legacy row",
      kind: "BANK",
      rail: "ACH",
      accountRef: "provider-account-1",
      custodyMode: "regulated_fiat_provider",
      metadata: { migration_status: "needs_review" },
    });

    expect(
      store.db
        .query(
          `SELECT id FROM wk_accounts
           WHERE wallet_id='wallet-1' AND rail='ACH' AND account_ref='provider-account-1'
           ORDER BY id`,
        )
        .all(),
    ).toEqual([{ id: "account-1" }, { id: "account-2" }]);
  });

  it("does not rebind stable asset or account ids to new economic/custody identities", () => {
    const store = makeStore();

    expect(() =>
      store.putAsset({
        id: "iso4217:USD",
        kind: "FIAT",
        symbol: "USD",
        name: "US Dollar",
        decimals: 6,
      }),
    ).toThrow(/asset identity is immutable/);
    expect(() =>
      store.putAccount({
        id: "account-1",
        walletId: "wallet-1",
        label: "Checking",
        kind: "BANK",
        rail: "ACH",
        accountRef: "provider-account-2",
        custodyMode: "regulated_fiat_provider",
      }),
    ).toThrow(/account and custody identity is immutable/);
    expect(() =>
      store.db
        .query("UPDATE wk_accounts SET custody_mode='external_signer' WHERE id='account-1'")
        .run(),
    ).toThrow(/custody identity is immutable/);

    expect(() =>
      store.putAccount({
        id: "account-1",
        walletId: "wallet-1",
        label: "Renamed checking",
        kind: "BANK",
        rail: "ACH",
        accountRef: "provider-account-1",
        custodyMode: "regulated_fiat_provider",
        status: "LOCKED",
        metadata: { reviewed: true },
      }),
    ).not.toThrow();
  });

  it("keeps agent authorization bindings immutable and status changes monotonic", () => {
    const store = makeStore();
    store.db.query(
      `INSERT INTO wk_agent_authorizations
        (id, payment_intent_id, wallet_id, grant_id, grant_revocation_nonce,
         capability_record_id, intent_id, intent_record_id, simulation_record_id,
         delegate_key_id, policy_hash, source_account, declared_spends_json, payees_json, body_json,
         body_sha256, signature, host_authority, status, expires_at, created_at,
         attested_at, consumed_at)
       VALUES (?, NULL, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, '[]', '[]', '{}', ?, NULL, ?,
               'RESERVED', ?, ?, NULL, NULL)`,
    ).run(
      "agent-authorization-1",
      "wallet-1",
      "grant-1",
      "capability-record-1",
      "intent-1",
      "intent-record-1",
      "simulation-record-1",
      "did:key:delegate-1",
      "policy-hash-1",
      "eip155:1:0x1111111111111111111111111111111111111111",
      "sha256:body-1",
      "ed25519:host-1",
      "2099-01-01T00:00:00.000Z",
      "2026-08-21T00:00:00.000Z",
    );

    expect(() =>
      store.db
        .query("UPDATE wk_agent_authorizations SET expires_at=? WHERE id=?")
        .run("2098-01-01T00:00:00.000Z", "agent-authorization-1"),
    ).toThrow(/binding is immutable/);
    expect(() =>
      store.db
        .query("UPDATE wk_agent_authorizations SET delegate_key_id=? WHERE id=?")
        .run("did:key:attacker", "agent-authorization-1"),
    ).toThrow(/binding is immutable/);
    expect(() =>
      store.db
        .query("UPDATE wk_agent_authorizations SET status='CONSUMED', consumed_at=? WHERE id=?")
        .run("2026-08-21T00:01:00.000Z", "agent-authorization-1"),
    ).toThrow(/agent authorization (?:status transition|evidence)/);

    store.db
      .query(
        `UPDATE wk_agent_authorizations
         SET signature=?, status='ATTESTED', attested_at=?
         WHERE id=?`,
      )
      .run("ed25519:signature-1", "2026-08-21T00:01:00.000Z", "agent-authorization-1");
    store.db
      .query(
        `UPDATE wk_agent_authorizations
         SET status='CONSUMED', consumed_at=?
         WHERE id=?`,
      )
      .run("2026-08-21T00:02:00.000Z", "agent-authorization-1");

    expect(() =>
      store.db
        .query("UPDATE wk_agent_authorizations SET status='ATTESTED' WHERE id=?")
        .run("agent-authorization-1"),
    ).toThrow(/invalid agent authorization status transition/);
    expect(() =>
      store.db
        .query("UPDATE wk_agent_authorizations SET body_json='{}' WHERE id=?")
        .run("agent-authorization-1"),
    ).not.toThrow();
    expect(() =>
      store.db
        .query("UPDATE wk_agent_authorizations SET body_json='{\"tampered\":true}' WHERE id=?")
        .run("agent-authorization-1"),
    ).toThrow(/binding is immutable/);
    expect(() =>
      store.db.query("DELETE FROM wk_agent_authorizations WHERE id=?").run("agent-authorization-1"),
    ).toThrow(/audit evidence/);

    store.db.query(
      `INSERT INTO wk_agent_authorizations
        (id, payment_intent_id, wallet_id, grant_id, grant_revocation_nonce,
         capability_record_id, intent_id, delegate_key_id, intent_record_id,
         simulation_record_id, policy_hash, source_account, declared_spends_json,
         payees_json, body_json, body_sha256, signature, host_authority, status,
         expires_at, created_at, attested_at, consumed_at)
       VALUES ('legacy-agent-blank-delegate', NULL, 'wallet-1', 'legacy-grant', 0,
               'legacy-capability', 'legacy-intent', '', 'legacy-intent-record',
               'legacy-simulation', 'legacy-policy', 'legacy-source', '[]', '[]',
               '{}', 'legacy-body-sha', NULL, 'legacy-host', 'RESERVED',
               '2099-01-01T00:00:00.000Z', '2026-08-21T00:00:00.000Z', NULL, NULL)`,
    ).run();
    expect(() =>
      store.db.query(
        `UPDATE wk_agent_authorizations
         SET status='ATTESTED', signature='legacy-signature',
             attested_at='2026-08-21T00:01:00.000Z'
         WHERE id='legacy-agent-blank-delegate'`,
      ).run(),
    ).toThrow(/no bound delegate key/);
  });
});

describe("payment intents", () => {
  it("replays the same idempotent request and rejects key reuse with another fingerprint", () => {
    const store = makeStore();
    const request = {
      kind: "TRANSFER",
      sourceAccountId: "account-1",
      assetId: "iso4217:USD",
      amountAtomic: "2500",
      destination: { kind: "BANK_ACCOUNT", payeeId: "payee-1" } as const,
      intentHash: "intent-hash-1",
      createdBy: { type: "HUMAN", ref: "user-1" },
    };
    const first = store.createPaymentIntent(
      { ...request, id: "intent-first" },
      { scope: "wallet-1", key: "request-1" },
    );
    const replay = store.createPaymentIntent(
      { ...request, id: "a-different-generated-id-would-be-ignored" },
      { scope: "wallet-1", key: "request-1" },
    );

    expect(first.replayed).toBe(false);
    expect(replay.replayed).toBe(true);
    expect(replay.intent.id).toBe("intent-first");
    expect(() =>
      store.createPaymentIntent(
        { ...request, amountAtomic: "2501" },
        { scope: "wallet-1", key: "request-1" },
      ),
    ).toThrow(IdempotencyConflictError);
  });

  it("allows exactly one compare-and-set transition from a stale state/version", async () => {
    const store = makeStore();
    const { intent } = createIntent(store, { id: "intent-cas" });
    const attempt = () =>
      store.transitionIntent({
        intentId: intent.id,
        expectedState: "draft",
        expectedVersion: 0,
        toState: "validated",
        actor: { type: "SYSTEM", ref: "validator" },
      });

    const results = await Promise.allSettled([
      Promise.resolve().then(attempt),
      Promise.resolve().then(attempt),
    ]);
    expect(results.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
    const rejected = results.find(({ status }) => status === "rejected") as PromiseRejectedResult;
    expect(rejected.reason).toBeInstanceOf(IntentTransitionConflictError);
    expect(store.getPaymentIntent(intent.id)).toMatchObject({ state: "validated", version: 1 });
    expect(store.listIntentEvents(intent.id).map(({ sequence }) => sequence)).toEqual([0, 1]);
  });

  it("persists intent events as append-only audit facts", () => {
    const store = makeStore();
    const { intent } = createIntent(store, { id: "intent-events" });
    store.appendIntentEvent({
      intentId: intent.id,
      expectedState: "draft",
      expectedVersion: 0,
      eventType: "intent.reviewed",
      actor: { type: "HUMAN", ref: "user-1" },
      data: { decision: "continue" },
    });

    expect(() =>
      store.db.query("UPDATE wk_intent_events SET event_type='tampered' WHERE intent_id=?").run(intent.id),
    ).toThrow(/append-only/);
    expect(() => store.db.query("DELETE FROM wk_intent_events WHERE intent_id=?").run(intent.id)).toThrow(
      /append-only/,
    );
  });

  it("rejects fabricated initial outcomes and invalid state transitions at the store boundary", () => {
    const store = makeStore();
    expect(() =>
      store.createPaymentIntent({
        id: "intent-fabricated-settlement",
        kind: "TRANSFER",
        sourceAccountId: "account-1",
        assetId: "iso4217:USD",
        amountAtomic: "1",
        destination: { kind: "BANK_ACCOUNT", payeeId: "payee-1" },
        initialState: "settled",
        intentHash: "intent-hash-fabricated",
        createdBy: { type: "HUMAN", ref: "user-1" },
      }),
    ).toThrow();

    const draft = createIntent(store, { id: "intent-invalid-transition" }).intent;
    expect(() =>
      store.transitionIntent({
        intentId: draft.id,
        expectedState: "draft",
        expectedVersion: 0,
        toState: "submitted",
        actor: { type: "SYSTEM", ref: "executor" },
      }),
    ).toThrow(/invalid payment lifecycle transition/);
    expect(store.getPaymentIntent(draft.id)).toMatchObject({ state: "draft", version: 0 });

    const provider = store.createPaymentIntent({
      id: "intent-provider-authorized",
      kind: "TRANSFER",
      sourceAccountId: "account-1",
      assetId: "iso4217:USD",
      amountAtomic: "1",
      destination: { kind: "BANK_ACCOUNT", payeeId: "payee-1" },
      initialState: "authorized",
      intentHash: "intent-hash-provider",
      createdBy: { type: "SERVICE", ref: "bank-provider" },
    }).intent;
    const prepared = store.transitionIntent({
      intentId: provider.id,
      expectedState: "authorized",
      expectedVersion: 0,
      toState: "prepared",
      actor: { type: "SERVICE", ref: "bank-provider" },
    });
    expect(
      store.transitionIntent({
        intentId: provider.id,
        expectedState: "prepared",
        expectedVersion: prepared.version,
        toState: "submitted",
        actor: { type: "SERVICE", ref: "bank-provider" },
      }).state,
    ).toBe("submitted");
  });
});

describe("one-time signing authorizations", () => {
  it("consumes only atomically with immutable exact signed bytes and replays that artifact", () => {
    const store = makeStore();
    const { intent } = createIntent(store, { id: "intent-authorization" });
    const reservation = reserveSigningResource(
      store,
      intent.id,
      undefined,
      "2099-01-01T00:00:00.000Z",
    );
    const { authorization } = store.createSigningAuthorization({
      id: "authorization-1",
      intentId: intent.id,
      intentHash: intent.intentHash,
      keyId: "key-1",
      requestHash: "prepared-request-hash-1",
      actor: { type: "HUMAN", ref: "user-1" },
      method: "PASSKEY",
      grantHash: "grant-hash-1",
    });

    expect(() =>
      store.persistSignedArtifact({
        authorizationId: authorization.id,
        intentId: intent.id,
        intentHash: intent.intentHash,
        keyId: "key-1",
        requestHash: "another-request",
        encoding: "hex",
        payload: "0x0102",
        externalTxId: "transaction-1",
      }),
    ).toThrow(AuthorizationConflictError);
    expect(store.getSigningAuthorization(authorization.id)?.status).toBe("ACTIVE");

    expect(() =>
      store.db
        .query("UPDATE wk_authorizations SET status='CONSUMED', consumed_at=? WHERE id=?")
        .run("2026-08-21T00:00:00.000Z", authorization.id),
    ).toThrow(/requires a durable signed artifact/);

    store.db.exec(`
      CREATE TRIGGER test_abort_signed_artifact_commit
      BEFORE INSERT ON wk_signed_artifacts
      BEGIN
        SELECT RAISE(ABORT, 'injected crash before artifact commit');
      END
    `);
    expect(() =>
      store.persistSignedArtifact({
        authorizationId: authorization.id,
        intentId: intent.id,
        intentHash: intent.intentHash,
        keyId: "key-1",
        requestHash: "prepared-request-hash-1",
        encoding: "hex",
        payload: "0x0102",
        externalTxId: "transaction-1",
      }),
    ).toThrow(/injected crash before artifact commit/);
    expect(store.getSigningAuthorization(authorization.id)?.status).toBe("ACTIVE");
    expect(store.getSignedArtifactByAuthorization(authorization.id)).toBeNull();
    expect(store.getReservation(reservation.id)?.state).toBe("ACTIVE");
    store.db.exec("DROP TRIGGER test_abort_signed_artifact_commit");

    const committed = store.persistSignedArtifact({
      authorizationId: authorization.id,
      intentId: intent.id,
      intentHash: intent.intentHash,
      keyId: "key-1",
      requestHash: "prepared-request-hash-1",
      encoding: "hex",
      payload: "0x0102",
      externalTxId: "transaction-1",
    });
    expect(committed.authorization.status).toBe("CONSUMED");
    expect(store.getReservation(reservation.id)).toMatchObject({ state: "CONSUMED", version: 1 });
    expect(committed.artifact).toMatchObject({
      authorizationId: authorization.id,
      payload: "0x0102",
      externalTxId: "transaction-1",
    });
    expect(committed.artifact.envelopeHash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(() =>
      store.db
        .query("UPDATE wk_authorizations SET status='ACTIVE' WHERE id=?")
        .run(authorization.id),
    ).toThrow(/immutable/);
    const replay = store.persistSignedArtifact({
      authorizationId: authorization.id,
      intentId: intent.id,
      intentHash: intent.intentHash,
      keyId: "key-1",
      requestHash: "prepared-request-hash-1",
      encoding: "hex",
      payload: "0x0102",
      externalTxId: "transaction-1",
    });
    expect(replay).toMatchObject({ replayed: true, artifact: { id: committed.artifact.id } });
    expect(() =>
      store.persistSignedArtifact({
        authorizationId: authorization.id,
        intentId: intent.id,
        intentHash: intent.intentHash,
        keyId: "key-1",
        requestHash: "prepared-request-hash-1",
        encoding: "hex",
        payload: "0x0304",
        externalTxId: "transaction-2",
      }),
    ).toThrow(/reused with different execution evidence|one-time use/);
    expect(() =>
      store.db.query("UPDATE wk_signed_artifacts SET payload='0x0304' WHERE id=?").run(
        committed.artifact.id,
      ),
    ).toThrow(/append-only/);
    expect(() =>
      store.db.query("DELETE FROM wk_signed_artifacts WHERE id=?").run(committed.artifact.id),
    ).toThrow(/append-only/);

    const afterExpiry = new WalletKernelStore(store.db, {
      now: () => new Date("2100-01-01T00:00:00.000Z"),
    });
    const competitor = createIntent(afterExpiry, { id: "intent-authorization-competitor" }).intent;
    expect(() =>
      afterExpiry.acquireReservation({
        intentId: competitor.id,
        accountId: "account-1",
        assetId: "iso4217:USD",
        kind: "NONCE",
        resourceKey: reservation.resourceKey,
        amountAtomic: "1",
      }),
    ).toThrow(/already committed/);
  });

  it("uses the trusted store clock and refuses a caller-backdated artifact", () => {
    const base = makeStore();
    let now = new Date("2098-01-01T00:00:00.000Z");
    const store = new WalletKernelStore(base.db, { now: () => now });
    const intent = createIntent(store, { id: "intent-backdated-artifact" }).intent;
    reserveSigningResource(
      store,
      intent.id,
      "reservation-backdated-artifact",
      "2099-01-01T00:00:00.000Z",
    );
    const authorization = store.createSigningAuthorization({
      id: "authorization-backdated-artifact",
      intentId: intent.id,
      intentHash: intent.intentHash,
      keyId: "key-backdated-artifact",
      requestHash: "request-backdated-artifact",
      actor: { type: "HUMAN", ref: "user-1" },
      method: "PASSKEY",
      grantHash: "grant-backdated-artifact",
      expiresAt: "2099-01-01T00:00:00.000Z",
    }).authorization;
    now = new Date("2100-01-01T00:00:00.000Z");

    expect(() =>
      store.persistSignedArtifact({
        authorizationId: authorization.id,
        intentId: intent.id,
        intentHash: intent.intentHash,
        keyId: authorization.keyId,
        requestHash: authorization.requestHash,
        encoding: "hex",
        payload: "0x0102",
        externalTxId: "transaction-backdated-artifact",
        // Simulate an untyped/legacy caller trying the removed v5 argument.
        at: "2098-01-01T00:00:00.000Z",
      } as Parameters<WalletKernelStore["persistSignedArtifact"]>[0] & { at: string }),
    ).toThrow(/has expired/);
    expect(store.getSigningAuthorization(authorization.id)?.status).toBe("EXPIRED");
    expect(store.getSignedArtifactByAuthorization(authorization.id)).toBeNull();
  });
});

describe("quotes, executions, and receipts", () => {
  it("persists reviewed quote evidence, CAS execution state and an immutable receipt", () => {
    const store = makeStore();
    const { intent } = createIntent(store, { id: "intent-execution" });
    reserveSigningResource(store, intent.id);
    const { quote } = store.recordQuote({
      id: "quote-1",
      intentId: intent.id,
      provider: "bank-adapter",
      quoteHash: "quote-hash-1",
      inputAmountAtomic: intent.amountAtomic,
      feeAssetId: "iso4217:USD",
      feeAtomic: "25",
      expiresAt: "2099-01-01T00:00:00.000Z",
      body: { scheme: "ACH", feeAtomic: "25" },
    });
    expect(() =>
      store.db.query("UPDATE wk_quotes SET quote_hash='tampered' WHERE id=?").run(quote.id),
    ).toThrow(/append-only/);
    for (const fabricated of ["signed", "submitted", "succeeded", "dropped", "replaced"]) {
      expect(() =>
        store.createExecution({
          id: `fabricated-${fabricated}`,
          intentId: intent.id,
          rail: "ACH",
          state: fabricated,
        }),
      ).toThrow(/must begin prepared|not bound to its durable artifact/);
    }

    const authorization = store.createSigningAuthorization({
      id: "authorization-execution-1",
      intentId: intent.id,
      intentHash: intent.intentHash,
      keyId: "key-execution-1",
      requestHash: "prepared-request-hash-1",
      actor: { type: "HUMAN", ref: "user-1" },
      method: "PASSKEY",
      grantHash: "grant-hash-execution-1",
    }).authorization;
    const artifact = store.persistSignedArtifact({
      authorizationId: authorization.id,
      intentId: intent.id,
      intentHash: intent.intentHash,
      keyId: authorization.keyId,
      requestHash: authorization.requestHash,
      encoding: "hex",
      payload: "0x0102",
      externalTxId: "durable-transaction-hash-1",
    }).artifact;

    const { execution } = store.createExecution({
      id: "execution-1",
      intentId: intent.id,
      rail: "ACH",
      state: "prepared",
      idempotencyKey: "provider-request-1",
      preparedRef: authorization.id,
      requestHash: "prepared-request-hash-1",
    });
    const signed = store.transitionExecution({
      id: execution.id,
      expectedState: "prepared",
      expectedVersion: 0,
      toState: "signed",
      networkTxId: "durable-transaction-hash-1",
      signedArtifactId: artifact.id,
      response: { artifact_id: artifact.id, envelope_hash: artifact.envelopeHash },
    });
    expect(signed).toMatchObject({
      state: "signed",
      version: 1,
      networkTxId: "durable-transaction-hash-1",
    });
    expect(() =>
      store.transitionExecution({
        id: execution.id,
        expectedState: "prepared",
        expectedVersion: 0,
        toState: "signed",
      }),
    ).toThrow(ExecutionConflictError);
    expect(() =>
      store.transitionExecution({
        id: execution.id,
        expectedState: "signed",
        expectedVersion: 1,
        toState: "submitted",
        networkTxId: "a-different-transaction-hash",
      }),
    ).toThrow(/immutable transaction id/);
    expect(() =>
      store.db.query("UPDATE wk_executions SET request_hash='tampered' WHERE id=?").run(
        execution.id,
      ),
    ).toThrow(/request or signed evidence is immutable|not bound to its durable artifact/);
    expect(() =>
      store.db
        .query("UPDATE wk_executions SET network_tx_id='coherent-fake', response_json='{}' WHERE id=?")
        .run(execution.id),
    ).toThrow(/request or signed evidence is immutable|not bound to its durable artifact/);

    const submitted = store.transitionExecution({
      id: execution.id,
      expectedState: "signed",
      expectedVersion: 1,
      toState: "submitted",
      submissionRef: "provider-submission-1",
      submittedAt: "2026-08-21T00:00:00.000Z",
    });
    const firstReceipt = store.recordReceipt({
      id: "receipt-1",
      intentId: intent.id,
      executionId: submitted.id,
      kind: "SUBMISSION",
      receiptHash: "receipt-hash-1",
      body: { providerStatus: "accepted" },
    });
    const replay = store.recordReceipt({
      id: "another-id-is-ignored-on-hash-replay",
      intentId: intent.id,
      executionId: submitted.id,
      kind: "SUBMISSION",
      receiptHash: "receipt-hash-1",
      body: { providerStatus: "accepted" },
    });
    expect(firstReceipt.replayed).toBe(false);
    expect(replay).toMatchObject({ replayed: true, receipt: { id: "receipt-1" } });
    expect(() =>
      store.db.query("DELETE FROM wk_receipts WHERE id=?").run(firstReceipt.receipt.id),
    ).toThrow(/append-only/);
  });
});

describe("Base chain truth", () => {
  it("appends deterministic provider milestones, dedupes polls, and records quorum consensus", () => {
    const store = makeStore();
    const { intent, execution, networkTxId } = createSubmittedExecution(store, "truth");
    const common = {
      intentId: intent.id,
      executionId: execution.id,
      chainId: "eip155:8453",
      networkTxId,
    } as const;

    const missing = store.appendChainSighting({
      id: "sighting-not-found",
      ...common,
      providerId: "base-rpc-a",
      evidenceHash: "sha256:not-found",
      visibility: "NOT_FOUND",
      outcome: "UNKNOWN",
      securityLevel: "UNSAFE",
      body: { transaction: null },
      observedAt: "2026-08-23T00:00:01.000Z",
      fetchedAt: "2026-08-23T00:00:02.000Z",
    });
    const repeatedPoll = store.appendChainSighting({
      id: "a-new-id-does-not-duplicate-a-stable-poll",
      ...common,
      providerId: "base-rpc-a",
      evidenceHash: "sha256:not-found",
      visibility: "NOT_FOUND",
      outcome: "UNKNOWN",
      securityLevel: "UNSAFE",
      body: { transaction: null },
      observedAt: "2026-08-23T00:00:01.000Z",
      fetchedAt: "2026-08-23T00:00:02.000Z",
    });
    expect(missing.replayed).toBe(false);
    expect(repeatedPoll).toMatchObject({
      replayed: true,
      sighting: {
        id: "sighting-not-found",
        observedAt: "2026-08-23T00:00:01.000Z",
        fetchedAt: "2026-08-23T00:00:02.000Z",
      },
    });

    const body = { receipt: { status: "0x1", blockHash: "0xbase-block" } } as const;
    for (const [id, securityLevel, observedAt] of [
      ["sighting-a-unsafe", "UNSAFE", "2026-08-23T00:01:00.000Z"],
      ["sighting-a-safe", "SAFE", "2026-08-23T00:02:00.000Z"],
      ["sighting-a-finalized", "FINALIZED", "2026-08-23T00:03:00.000Z"],
    ] as const) {
      expect(store.appendChainSighting({
        id,
        ...common,
        providerId: "base-rpc-a",
        evidenceHash: "sha256:shared-receipt",
        visibility: "INCLUDED",
        outcome: "SUCCESS",
        securityLevel,
        blockHash: "0xbase-block",
        blockNumber: "900719925474099312345",
        body: { ...body, finalityHead: securityLevel },
        observedAt,
        fetchedAt: observedAt,
      }).replayed).toBe(false);
    }
    store.appendChainSighting({
      id: "sighting-b-unsafe",
      ...common,
      providerId: "base-rpc-b",
      evidenceHash: "sha256:shared-receipt",
      visibility: "INCLUDED",
      outcome: "SUCCESS",
      securityLevel: "UNSAFE",
      blockHash: "0xbase-block",
      blockNumber: "900719925474099312345",
      body: { ...body, finalityHead: "UNSAFE" },
      observedAt: "2026-08-23T00:01:01.000Z",
    });
    expect(store.appendChainSighting({
      id: "sighting-b-finalized",
      ...common,
      providerId: "base-rpc-b",
      evidenceHash: "sha256:shared-receipt",
      visibility: "INCLUDED",
      outcome: "SUCCESS",
      securityLevel: "FINALIZED",
      blockHash: "0xbase-block",
      blockNumber: "900719925474099312345",
      body: { ...body, finalityHead: "FINALIZED" },
      observedAt: "2026-08-23T00:03:01.000Z",
    }).replayed).toBe(false);

    expect(() => store.appendChainSighting({
      id: "sighting-conflicting-body",
      ...common,
      providerId: "base-rpc-a",
      evidenceHash: "sha256:shared-receipt",
      visibility: "INCLUDED",
      outcome: "SUCCESS",
      securityLevel: "FINALIZED",
      blockHash: "0xbase-block",
      blockNumber: "900719925474099312345",
      body: { receipt: { status: "0x0", blockHash: "0xbase-block" } },
      observedAt: "2026-08-23T00:03:02.000Z",
      fetchedAt: "2026-08-23T00:03:02.000Z",
    })).toThrow(ChainEvidenceConflictError);

    const unsafeConsensus = store.appendChainConsensus({
      id: "consensus-unsafe",
      ...common,
      evidenceHash: "sha256:shared-receipt",
      visibility: "INCLUDED",
      outcome: "SUCCESS",
      securityLevel: "UNSAFE",
      blockHash: "0xbase-block",
      blockNumber: "900719925474099312345",
      providerIds: ["base-rpc-a", "base-rpc-b"],
      quorum: 2,
      body: { rule: "two-independent-unsafe-receipts" },
      decidedAt: "2026-08-23T00:01:30.000Z",
    }).consensus;
    const consensus = store.appendChainConsensus({
      id: "consensus-finalized",
      ...common,
      evidenceHash: "sha256:shared-receipt",
      visibility: "INCLUDED",
      outcome: "SUCCESS",
      securityLevel: "FINALIZED",
      blockHash: "0xbase-block",
      blockNumber: "900719925474099312345",
      providerIds: ["base-rpc-b", "base-rpc-a"],
      quorum: 2,
      body: { rule: "two-independent-finalized-receipts" },
      decidedAt: "2026-08-23T00:04:00.000Z",
    });
    expect(consensus).toMatchObject({
      replayed: false,
      consensus: { providerIds: ["base-rpc-a", "base-rpc-b"], quorum: 2 },
    });
    expect(store.appendChainConsensus({
      id: "consensus-replay-id-is-ignored",
      ...common,
      evidenceHash: "sha256:shared-receipt",
      visibility: "INCLUDED",
      outcome: "SUCCESS",
      securityLevel: "FINALIZED",
      blockHash: "0xbase-block",
      blockNumber: "900719925474099312345",
      providerIds: ["base-rpc-a", "base-rpc-b"],
      quorum: 2,
      body: { rule: "two-independent-finalized-receipts" },
      decidedAt: "2026-08-23T00:05:00.000Z",
    })).toMatchObject({
      replayed: true,
      consensus: { id: "consensus-finalized", decidedAt: "2026-08-23T00:04:00.000Z" },
    });
    expect(() => store.appendChainConsensus({
      id: "consensus-conflict",
      ...common,
      evidenceHash: "sha256:shared-receipt",
      visibility: "INCLUDED",
      outcome: "SUCCESS",
      securityLevel: "FINALIZED",
      blockHash: "0xbase-block",
      blockNumber: "900719925474099312345",
      providerIds: ["base-rpc-a", "base-rpc-b"],
      quorum: 1,
      body: { rule: "weakened-after-the-fact" },
      decidedAt: "2026-08-23T00:04:00.000Z",
    })).toThrow(ChainEvidenceConflictError);

    expect(() => store.appendChainConsensus({
      id: "consensus-without-matching-provider-evidence",
      ...common,
      evidenceHash: "sha256:not-seen-by-the-providers",
      visibility: "INCLUDED",
      outcome: "SUCCESS",
      securityLevel: "FINALIZED",
      blockHash: "0xbase-block",
      blockNumber: "900719925474099312345",
      providerIds: ["base-rpc-a", "base-rpc-b"],
      quorum: 2,
      body: { rule: "must-not-be-accepted" },
      decidedAt: "2026-08-23T00:06:00.000Z",
    })).toThrow(/no matching durable chain sighting/);

    expect(store.listChainSightings({ executionId: execution.id })).toHaveLength(6);
    expect(store.listChainSightings({
      executionId: execution.id,
      providerId: "base-rpc-a",
      securityLevel: "FINALIZED",
    })).toHaveLength(1);
    expect(store.listChainConsensus({ intentId: intent.id })).toEqual([
      unsafeConsensus,
      consensus.consensus,
    ]);

    expect(() => store.db.query(
      "UPDATE wk_chain_sightings SET outcome='REVERTED' WHERE id='sighting-a-finalized'",
    ).run()).toThrow(/append-only/);
    expect(() => store.db.query(
      "DELETE FROM wk_chain_sightings WHERE id='sighting-a-finalized'",
    ).run()).toThrow(/append-only/);
    expect(() => store.db.query(
      "UPDATE wk_chain_consensus SET quorum=1 WHERE id='consensus-finalized'",
    ).run()).toThrow(/append-only/);
    expect(() => store.db.query(
      "DELETE FROM wk_chain_consensus WHERE id='consensus-finalized'",
    ).run()).toThrow(/append-only/);
  });

  it("allows a finalized revert to fail a submitted execution without releasing its nonce", () => {
    const store = makeStore();
    const { intent, execution, reservation, networkTxId } = createSubmittedExecution(store, "revert");
    const common = {
      intentId: intent.id,
      executionId: execution.id,
      chainId: "eip155:8453",
      networkTxId,
      visibility: "INCLUDED" as const,
      outcome: "REVERTED" as const,
      securityLevel: "FINALIZED" as const,
      blockHash: "0xrevert-block",
      blockNumber: "123456789",
      body: { receipt: { status: "0x0" } },
      observedAt: "2026-08-23T01:00:00.000Z",
    };
    for (const providerId of ["base-rpc-a", "base-rpc-b"] as const) {
      store.appendChainSighting({
        id: `revert-${providerId}`,
        ...common,
        providerId,
        evidenceHash: "sha256:revert-consensus",
      });
    }
    store.appendChainConsensus({
      id: "revert-consensus",
      intentId: intent.id,
      executionId: execution.id,
      chainId: "eip155:8453",
      networkTxId,
      evidenceHash: "sha256:revert-consensus",
      visibility: "INCLUDED",
      outcome: "REVERTED",
      securityLevel: "FINALIZED",
      blockHash: "0xrevert-block",
      blockNumber: "123456789",
      providerIds: ["base-rpc-a", "base-rpc-b"],
      quorum: 2,
      body: { decision: "finalized-revert" },
      decidedAt: "2026-08-23T01:01:00.000Z",
    });
    const failed = store.transitionExecution({
      id: execution.id,
      expectedState: "submitted",
      expectedVersion: execution.version,
      toState: "failed",
      errorCode: "CHAIN_REVERTED",
      errorMessage: "Finalized Base receipt status is reverted",
      settledAt: "2026-08-23T01:01:00.000Z",
    });
    expect(failed.state).toBe("failed");
    expect(store.getReservation(reservation.id)?.state).toBe("CONSUMED");
    expect(() => store.transitionExecution({
      id: failed.id,
      expectedState: "failed",
      expectedVersion: failed.version,
      toState: "succeeded",
    })).toThrow(/invalid execution state transition/);
    expect(() => store.createExecution({
      id: "fabricated-final-outcome",
      intentId: intent.id,
      rail: "eip155:8453",
      state: "failed",
    })).toThrow(/must begin prepared/);

    const successful = createSubmittedExecution(store, "success").execution;
    const succeeded = store.transitionExecution({
      id: successful.id,
      expectedState: "submitted",
      expectedVersion: successful.version,
      toState: "succeeded",
      settledAt: "2026-08-23T01:02:00.000Z",
    });
    expect(() => store.transitionExecution({
      id: succeeded.id,
      expectedState: "succeeded",
      expectedVersion: succeeded.version,
      toState: "failed",
    })).toThrow(/invalid execution state transition/);
  });

  it("rejects direct SQL chain facts that do not bind to the execution transaction", () => {
    const store = makeStore();
    const { intent, execution } = createSubmittedExecution(store, "binding");
    expect(() => store.db.query(
      `INSERT INTO wk_chain_sightings
        (id, intent_id, execution_id, chain_id, network_tx_id, provider_id,
         evidence_hash, visibility, outcome, security_level, block_hash,
         block_number, body_json, observed_at, fetched_at, created_at)
       VALUES ('forged-sighting', ?, ?, 'eip155:8453', '0xwrong', 'base-rpc-a',
               'sha256:forged', 'NOT_FOUND', 'UNKNOWN', 'UNSAFE', NULL,
               NULL, '{}', ?, ?, ?)`,
    ).run(
      intent.id,
      execution.id,
      "2026-08-23T00:00:00.000Z",
      "2026-08-23T00:00:00.000Z",
      "2026-08-23T00:00:00.000Z",
    )).toThrow(/does not match execution transaction identity/);
  });
});

describe("durable Base reconciliation jobs", () => {
  it("discovers exact bindings, leases once, reschedules without false failures, and settles by lease CAS", () => {
    const { store } = makeBaseTruthStore();
    const { execution, artifact, networkTxId } = createBaseExecution(store, "a");
    const candidates = store.discoverEligibleBaseReconciliations();
    expect(candidates).toEqual([{
      executionId: execution.id,
      intentId: execution.intentId,
      signedArtifactId: artifact.id,
      externalTxId: networkTxId,
      networkTxId,
      rail: "evm-base",
      chainId: BASE_CHAIN_ID,
      assetId: BASE_ETH_ASSET_ID,
      executionState: "submitted",
    }]);

    const [enqueued] = store.enqueueBaseReconciliationJobs(candidates, {
      now: "2026-08-23T10:00:00.000Z",
    });
    expect(enqueued).toMatchObject({
      state: "READY",
      attemptCount: 0,
      failureCount: 0,
      nextAttemptAt: "2026-08-23T10:00:00.000Z",
    });
    expect(store.enqueueBaseReconciliationJobs(candidates)[0]?.id).toBe(enqueued!.id);

    const [claimed] = store.claimDueBaseReconciliationJobs({
      limit: 8,
      leaseOwner: "worker-a",
      leaseUntil: "2026-08-23T10:01:00.000Z",
      now: "2026-08-23T10:00:01.000Z",
    });
    expect(claimed).toMatchObject({ state: "RUNNING", attemptCount: 1, leaseOwner: "worker-a" });
    expect(store.claimDueBaseReconciliationJobs({
      limit: 8,
      leaseOwner: "worker-b",
      leaseUntil: "2026-08-23T10:01:00.000Z",
      now: "2026-08-23T10:00:01.000Z",
    })).toEqual([]);

    const backoff = store.rescheduleBaseReconciliationJob({
      jobId: claimed!.id,
      leaseToken: claimed!.leaseToken!,
      nextAttemptAt: "2026-08-23T10:02:00.000Z",
      observation: "pending",
      errorCode: null,
      incrementFailure: false,
      now: "2026-08-23T10:00:30.000Z",
    });
    expect(backoff).toMatchObject({
      state: "BACKOFF",
      attemptCount: 1,
      failureCount: 0,
      lastObservation: "pending",
      lastErrorCode: null,
    });
    expect(store.claimDueBaseReconciliationJobs({
      limit: 8,
      leaseOwner: "worker-b",
      leaseUntil: "2026-08-23T10:03:00.000Z",
      now: "2026-08-23T10:01:59.999Z",
    })).toEqual([]);
    const [claimedAgain] = store.claimDueBaseReconciliationJobs({
      limit: 8,
      leaseOwner: "worker-b",
      leaseUntil: "2026-08-23T10:03:00.000Z",
      now: "2026-08-23T10:02:00.000Z",
    });
    expect(claimedAgain).toMatchObject({ state: "RUNNING", attemptCount: 2 });
    expect(() => store.settleBaseReconciliationJob({
      jobId: claimedAgain!.id,
      leaseToken: claimed!.leaseToken!,
      now: "2026-08-23T10:02:01.000Z",
    })).toThrow(BaseReconciliationJobConflictError);
    expect(store.settleBaseReconciliationJob({
      jobId: claimedAgain!.id,
      leaseToken: claimedAgain!.leaseToken!,
      observation: "settled",
      now: "2026-08-23T10:02:01.000Z",
    })).toMatchObject({
      state: "SETTLED",
      lastObservation: "settled",
      settledAt: "2026-08-23T10:02:01.000Z",
    });
  });

  it("allows only one claimant across independent SQLite connections", () => {
    const directory = mkdtempSync(join(tmpdir(), "cashloom-wk-v7-"));
    temporaryDirectories.push(directory);
    const path = join(directory, "wallet.db");
    const firstDb = new Database(path, { create: true });
    openDatabases.push(firstDb);
    const { store: first } = makeBaseTruthStore(firstDb);
    createBaseExecution(first, "d");
    first.enqueueBaseReconciliationJobs(first.discoverEligibleBaseReconciliations(), {
      now: "2026-08-23T10:00:00.000Z",
    });
    const secondDb = new Database(path);
    openDatabases.push(secondDb);
    const second = new WalletKernelStore(secondDb);

    expect(first.claimDueBaseReconciliationJobs({
      limit: 1,
      leaseOwner: "connection-a",
      leaseUntil: "2026-08-23T10:01:00.000Z",
      now: "2026-08-23T10:00:01.000Z",
    })).toHaveLength(1);
    expect(second.claimDueBaseReconciliationJobs({
      limit: 1,
      leaseOwner: "connection-b",
      leaseUntil: "2026-08-23T10:01:00.000Z",
      now: "2026-08-23T10:00:01.000Z",
    })).toEqual([]);
    expect(second.listBaseReconciliationJobs({ state: "RUNNING" })).toHaveLength(1);
  });

  it("reaps dead leases and still claims terminal truth that arrived during backoff", () => {
    const { store } = makeBaseTruthStore();
    const { intent, execution, networkTxId } = createBaseExecution(store, "b");
    const [job] = store.enqueueBaseReconciliationJobs(
      store.discoverEligibleBaseReconciliations(),
      { now: "2026-08-23T10:00:00.000Z" },
    );
    const [expired] = store.claimDueBaseReconciliationJobs({
      limit: 1,
      leaseOwner: "crashed-worker",
      leaseUntil: "2026-08-23T10:00:10.000Z",
      now: "2026-08-23T10:00:01.000Z",
    });
    expect(store.reapExpiredBaseReconciliationLeases({
      now: "2026-08-23T10:00:10.000Z",
    })).toBe(1);
    expect(store.getBaseReconciliationJob(job!.id)).toMatchObject({
      state: "BACKOFF",
      failureCount: 1,
      lastErrorCode: "RECONCILIATION_LEASE_EXPIRED",
    });
    expect(() => store.pauseBaseReconciliationJob({
      jobId: job!.id,
      leaseToken: expired!.leaseToken!,
      errorCode: "STALE_WORKER",
      now: "2026-08-23T10:00:11.000Z",
    })).toThrow(BaseReconciliationJobConflictError);

    const common = {
      intentId: intent.id,
      executionId: execution.id,
      chainId: BASE_CHAIN_ID,
      networkTxId,
      evidenceHash: "sha256:manual-finalized",
      visibility: "INCLUDED" as const,
      outcome: "SUCCESS" as const,
      securityLevel: "FINALIZED" as const,
      blockHash: hash("b"),
      blockNumber: "123",
      body: { status: "0x1" },
      observedAt: "2026-08-23T10:00:11.000Z",
    };
    for (const providerId of ["manual-a", "manual-b"] as const) {
      store.appendChainSighting({ id: `manual-${providerId}`, providerId, ...common });
    }
    store.appendChainConsensus({
      id: "manual-consensus",
      intentId: intent.id,
      executionId: execution.id,
      chainId: BASE_CHAIN_ID,
      networkTxId,
      evidenceHash: common.evidenceHash,
      visibility: "INCLUDED",
      outcome: "SUCCESS",
      securityLevel: "FINALIZED",
      blockHash: common.blockHash,
      blockNumber: common.blockNumber,
      providerIds: ["manual-a", "manual-b"],
      quorum: 2,
      body: { decision: "manual-finalized" },
      decidedAt: "2026-08-23T10:00:12.000Z",
    });
    store.transitionExecution({
      id: execution.id,
      expectedState: "submitted",
      expectedVersion: execution.version,
      toState: "succeeded",
      settledAt: "2026-08-23T10:00:12.000Z",
    });
    expect(store.discoverEligibleBaseReconciliations()).toEqual([]);
    const [terminalClaim] = store.claimDueBaseReconciliationJobs({
      limit: 1,
      leaseOwner: "truth-only-worker",
      leaseUntil: "2026-08-23T10:01:00.000Z",
      now: "2026-08-23T10:00:12.000Z",
    });
    expect(terminalClaim).toMatchObject({ state: "RUNNING", executionState: "succeeded" });
  });

  it("rejects a directly forged job binding and keeps jobs undeletable", () => {
    const { store } = makeBaseTruthStore();
    const { intent, execution, artifact } = createBaseExecution(store, "c");
    expect(() => store.db.query(
      `INSERT INTO wk_base_reconciliation_jobs
        (id, execution_id, intent_id, signed_artifact_id, external_tx_id,
         network_tx_id, rail, chain_id, asset_id, state, next_attempt_at,
         created_at, updated_at)
       VALUES ('forged-job', ?, ?, ?, ?, ?, 'evm-base', 'eip155:8453', ?,
               'READY', ?, ?, ?)`,
    ).run(
      execution.id,
      intent.id,
      artifact.id,
      hash("d"),
      hash("d"),
      BASE_ETH_ASSET_ID,
      "2026-08-23T10:00:00.000Z",
      "2026-08-23T10:00:00.000Z",
      "2026-08-23T10:00:00.000Z",
    )).toThrow(/no exact eligible execution binding/);
    const [job] = store.enqueueBaseReconciliationJobs(store.discoverEligibleBaseReconciliations());
    expect(() => store.db.query(
      "DELETE FROM wk_base_reconciliation_jobs WHERE id=?",
    ).run(job!.id)).toThrow(/durable audit records/);
  });
});

describe("Base position refresh attempt provenance", () => {
  it("retains sanitized outcomes, provider counts, and the exact durable head", () => {
    const { store, setClock } = makeBaseTruthStore();
    const partial = store.appendBasePositionRefreshAttempt({
      id: "base-refresh-partial",
      accountId: "base-account",
      attemptedAt: "2026-08-23T10:00:00.000Z",
      outcome: "partial",
      reasonCode: "provider_unavailable",
      providerCount: 2,
      availableProviderCount: 1,
      agreeingProviderCount: 1,
    });
    expect(partial).toEqual({
      id: "base-refresh-partial",
      accountId: "base-account",
      attemptedAt: "2026-08-23T10:00:00.000Z",
      outcome: "partial",
      reasonCode: "provider_unavailable",
      providerCount: 2,
      availableProviderCount: 1,
      agreeingProviderCount: 1,
      retainedHead: null,
      errorCode: null,
      createdAt: "2026-08-23T10:00:00.000Z",
    });

    const evidence = appendBasePositionEvidence(store, {
      blockNumber: "300",
      blockHash: hash("9"),
      blockTime: "2026-08-23T10:00:00.000Z",
      evidenceHash: digest("9"),
      ethAtomic: "3000",
      usdcAtomic: "4000",
      observedAt: "2026-08-23T10:00:01.000Z",
    });
    setClock("2026-08-23T10:00:02.000Z");
    const applied = store.applyBasePositionSnapshot(evidence);
    setClock("2026-08-23T10:00:03.000Z");
    const recorded = store.appendBasePositionRefreshAttempt({
      id: "base-refresh-applied",
      accountId: "base-account",
      attemptedAt: "2026-08-23T10:00:01.000Z",
      outcome: "applied",
      reasonCode: "finalized_consensus",
      providerCount: 2,
      availableProviderCount: 2,
      agreeingProviderCount: 2,
      retainedHead: applied.head,
    });
    expect(recorded).toMatchObject({
      outcome: "applied",
      reasonCode: "finalized_consensus",
      retainedHead: {
        snapshotId: applied.snapshot.id,
        state: "ACTIVE",
        conflictSnapshotId: null,
        version: 0,
      },
      errorCode: null,
      createdAt: "2026-08-23T10:00:03.000Z",
    });

    setClock("2026-08-23T10:00:04.000Z");
    store.appendBasePositionRefreshAttempt({
      id: "base-refresh-rejected",
      accountId: "base-account",
      attemptedAt: "2026-08-23T10:00:04.000Z",
      outcome: "rejected",
      reasonCode: "evidence_rejected",
      providerCount: 2,
      availableProviderCount: 0,
      agreeingProviderCount: 0,
      errorCode: "base_position_evidence_rejected",
    });
    expect(store.getBasePositionRefreshAttempt("base-refresh-rejected")).toMatchObject({
      retainedHead: recorded.retainedHead,
      errorCode: "base_position_evidence_rejected",
    });
    expect(store.listBasePositionRefreshAttempts({
      accountId: "base-account",
      limit: 2,
    }).map(({ id }) => id)).toEqual([
      "base-refresh-rejected",
      "base-refresh-applied",
    ]);
    expect(store.listBasePositionRefreshAttempts({ outcome: "partial" })).toEqual([partial]);

    expect(() => store.db.query(
      "UPDATE wk_base_position_refresh_attempts SET outcome='stale' WHERE id=?",
    ).run(recorded.id)).toThrow(/append-only/);
    expect(() => store.db.query(
      "DELETE FROM wk_base_position_refresh_attempts WHERE id=?",
    ).run(recorded.id)).toThrow(/append-only/);
  });

  it("rejects raw text, impossible counts, and a forged or stale head binding", () => {
    const { store, setClock } = makeBaseTruthStore();
    const common = {
      accountId: "base-account",
      attemptedAt: "2026-08-23T10:00:00.000Z",
      outcome: "rejected" as const,
      reasonCode: "evidence_rejected",
      providerCount: 2,
      availableProviderCount: 0,
      agreeingProviderCount: 0,
      errorCode: "base_position_evidence_rejected",
    };
    expect(() => store.appendBasePositionRefreshAttempt({
      ...common,
      reasonCode: "https://rpc.example/internal",
    })).toThrow(/stable lower-case code/);
    expect(() => store.appendBasePositionRefreshAttempt({
      ...common,
      errorCode: "upstream said ECONNREFUSED at https://rpc.example",
    })).toThrow(/stable lower-case code/);
    expect(() => store.appendBasePositionRefreshAttempt({
      ...common,
      availableProviderCount: 3,
    })).toThrow(/agreeing <= available <= total/);

    const evidence = appendBasePositionEvidence(store, {
      blockNumber: "400",
      blockHash: hash("c"),
      blockTime: "2026-08-23T10:00:00.000Z",
      evidenceHash: digest("c"),
      ethAtomic: "1",
      usdcAtomic: "2",
      observedAt: "2026-08-23T10:00:01.000Z",
    });
    setClock("2026-08-23T10:00:02.000Z");
    const { head } = store.applyBasePositionSnapshot(evidence);
    expect(() => store.appendBasePositionRefreshAttempt({
      ...common,
      retainedHead: { ...head, version: head.version + 1 },
    })).toThrow(BasePositionRefreshAttemptConflictError);
    expect(() => store.db.query(
      `INSERT INTO wk_base_position_refresh_attempts
        (id, account_id, attempted_at, outcome, reason_code,
         provider_count, available_provider_count, agreeing_provider_count,
         created_at)
       VALUES ('forged-refresh', 'base-account', ?, 'partial',
               'provider_unavailable', 2, 1, 1, ?)`,
    ).run(common.attemptedAt, common.attemptedAt)).toThrow(/does not match its retained head/);

    const columnNames = (store.db.query(
      "PRAGMA table_info(wk_base_position_refresh_attempts)",
    ).all() as Array<{ name: string }>).map(({ name }) => name);
    expect(columnNames.some((name) => /(?:url|origin|body|message|raw)/i.test(name))).toBe(false);
  });

  it("survives a store reload without replaying network work", () => {
    const directory = mkdtempSync(join(tmpdir(), "cashloom-base-refresh-attempt-"));
    temporaryDirectories.push(directory);
    const path = join(directory, "wallet.db");
    const firstDb = new Database(path);
    openDatabases.push(firstDb);
    const { store: first } = makeBaseTruthStore(firstDb);
    first.appendBasePositionRefreshAttempt({
      id: "persisted-base-refresh",
      accountId: "base-account",
      attemptedAt: "2026-08-23T10:00:00.000Z",
      outcome: "partial",
      reasonCode: "provider_unavailable",
      providerCount: 2,
      availableProviderCount: 1,
      agreeingProviderCount: 1,
    });

    const secondDb = new Database(path);
    openDatabases.push(secondDb);
    const reloaded = new WalletKernelStore(secondDb);
    expect(reloaded.listBasePositionRefreshAttempts({ accountId: "base-account" })).toEqual([
      {
        id: "persisted-base-refresh",
        accountId: "base-account",
        attemptedAt: "2026-08-23T10:00:00.000Z",
        outcome: "partial",
        reasonCode: "provider_unavailable",
        providerCount: 2,
        availableProviderCount: 1,
        agreeingProviderCount: 1,
        retainedHead: null,
        errorCode: null,
        createdAt: "2026-08-23T10:00:00.000Z",
      },
    ]);
  });

  it("returns the latest appended refresh attempt when timestamps are identical", () => {
    const { store } = makeBaseTruthStore();
    store.appendBasePositionRefreshAttempt({
      id: "attempt-same-clock-first",
      accountId: "base-account",
      attemptedAt: "2026-08-23T10:00:00.000Z",
      outcome: "partial",
      reasonCode: "provider_unavailable",
      providerCount: 2,
      availableProviderCount: 0,
      agreeingProviderCount: 0,
    });
    store.appendBasePositionRefreshAttempt({
      id: "attempt-same-clock-second",
      accountId: "base-account",
      attemptedAt: "2026-08-23T10:00:00.000Z",
      outcome: "rejected",
      reasonCode: "evidence_rejected",
      providerCount: 2,
      availableProviderCount: 0,
      agreeingProviderCount: 0,
      errorCode: "base_position_evidence_rejected",
    });
    expect(store.listBasePositionRefreshAttempts({ accountId: "base-account", limit: 1 })[0])
      .toMatchObject({ id: "attempt-same-clock-second", outcome: "rejected" });
  });
});

describe("finalized Base position snapshots", () => {
  it("retains evidence while applying, replaying, rejecting stale rollback, freezing conflict, and superseding", () => {
    const { store, setClock } = makeBaseTruthStore();
    const first = appendBasePositionEvidence(store, {
      blockNumber: "100",
      blockHash: hash("1"),
      blockTime: "2026-08-23T09:59:00.000Z",
      evidenceHash: digest("1"),
      ethAtomic: "100",
      usdcAtomic: "200",
      observedAt: "2026-08-23T10:00:00.000Z",
    });
    setClock("2026-08-23T10:00:01.000Z");
    expect(store.applyBasePositionSnapshot(first)).toMatchObject({
      outcome: "applied",
      head: { blockNumber: "100", state: "ACTIVE", version: 0 },
    });
    const appliedPositions = store.listBasePositions({ accountId: "base-account" });
    expect(appliedPositions.find(({ assetId }) => assetId === BASE_ETH_ASSET_ID)).toMatchObject({
      observedAtomic: "100",
      pendingAtomic: "5",
      asOf: "2026-08-23T09:59:00.000Z",
      updatedAt: "2026-08-23T10:00:01.000Z",
    });
    expect(appliedPositions.find(({ assetId }) => assetId === BASE_USDC_ASSET_ID)).toMatchObject({
      observedAtomic: "200",
      pendingAtomic: "7",
    });
    expect(store.applyBasePositionSnapshot(first).outcome).toBe("replayed");
    expect(store.listBasePositionSnapshots({ accountId: "base-account" })).toHaveLength(1);

    const stale = appendBasePositionEvidence(store, {
      blockNumber: "99",
      blockHash: hash("2"),
      blockTime: "2026-08-23T09:58:00.000Z",
      evidenceHash: digest("2"),
      ethAtomic: "90",
      usdcAtomic: "190",
      observedAt: "2026-08-23T10:00:02.000Z",
    });
    setClock("2026-08-23T10:00:03.000Z");
    expect(store.applyBasePositionSnapshot(stale).outcome).toBe("stale");
    expect(store.getBasePositionHead("base-account")?.blockNumber).toBe("100");
    expect(store.listBasePositions({ accountId: "base-account" }).find(
      ({ assetId }) => assetId === BASE_ETH_ASSET_ID,
    )?.observedAtomic).toBe("100");

    const newer = appendBasePositionEvidence(store, {
      blockNumber: "101",
      blockHash: hash("4"),
      blockTime: "2026-08-23T10:00:00.000Z",
      evidenceHash: digest("4"),
      ethAtomic: "300",
      usdcAtomic: "400",
      observedAt: "2026-08-23T10:00:06.000Z",
    });
    setClock("2026-08-23T10:00:07.000Z");
    expect(store.applyBasePositionSnapshot(newer)).toMatchObject({
      outcome: "superseded",
      head: { blockNumber: "101", state: "ACTIVE", conflictSnapshotId: null, version: 1 },
    });
    expect(store.listBasePositions()).toHaveLength(2);

    const conflict = appendBasePositionEvidence(store, {
      blockNumber: "101",
      blockHash: hash("3"),
      blockTime: "2026-08-23T10:00:01.000Z",
      evidenceHash: digest("3"),
      ethAtomic: "999",
      usdcAtomic: "999",
      observedAt: "2026-08-23T10:00:08.000Z",
    });
    setClock("2026-08-23T10:00:09.000Z");
    expect(store.applyBasePositionSnapshot(conflict)).toMatchObject({
      outcome: "conflict",
      head: { blockNumber: "101", state: "FROZEN", version: 2 },
    });
    expect(store.listBasePositions({ accountId: "base-account" }).find(
      ({ assetId }) => assetId === BASE_ETH_ASSET_ID,
    )).toMatchObject({ observedAtomic: "300", headState: "FROZEN" });

    const higherAfterConflict = appendBasePositionEvidence(store, {
      blockNumber: "102",
      blockHash: hash("8"),
      blockTime: "2026-08-23T10:01:00.000Z",
      evidenceHash: digest("8"),
      ethAtomic: "500",
      usdcAtomic: "600",
      observedAt: "2026-08-23T10:00:10.000Z",
    });
    setClock("2026-08-23T10:00:11.000Z");
    expect(store.applyBasePositionSnapshot(higherAfterConflict)).toMatchObject({
      outcome: "conflict",
      head: { blockNumber: "101", state: "FROZEN", version: 2 },
    });
    expect(store.listBasePositions({ accountId: "base-account" }).map((position) => ({
      assetId: position.assetId,
      observedAtomic: position.observedAtomic,
      pendingAtomic: position.pendingAtomic,
      asOf: position.asOf,
    }))).toEqual([
      {
        assetId: BASE_USDC_ASSET_ID,
        observedAtomic: "400",
        pendingAtomic: "7",
        asOf: "2026-08-23T10:00:00.000Z",
      },
      {
        assetId: BASE_ETH_ASSET_ID,
        observedAtomic: "300",
        pendingAtomic: "5",
        asOf: "2026-08-23T10:00:00.000Z",
      },
    ]);
    expect(store.listBasePositionSnapshots({ accountId: "base-account" })).toHaveLength(5);
    expect(store.listBasePositionSightings({ accountId: "base-account" })).toHaveLength(10);
    expect(() => store.db.query(
      "UPDATE wk_base_position_snapshots SET quorum=1 WHERE id=?",
    ).run(store.getBasePositionHead("base-account")!.snapshotId)).toThrow(/append-only/);
    expect(() => store.db.query(
      "DELETE FROM wk_base_position_snapshot_sightings WHERE account_id='base-account'",
    ).run()).toThrow(/append-only/);
  });

  it("requires canonical two-origin evidence and rolls the entire newer CAS back on projection failure", () => {
    const { store, setClock } = makeBaseTruthStore();
    expect(() => store.appendBasePositionSighting({
      accountId: "base-account",
      providerId: "bad-provider",
      providerTrustDomain: digest("a"),
      evidenceHash: digest("a"),
      blockNumber: "01",
      blockHash: hash("a"),
      blockTime: "2026-08-23T10:00:00Z",
      items: [
        { assetId: BASE_ETH_ASSET_ID, observedAtomic: "1" },
        { assetId: BASE_USDC_ASSET_ID, observedAtomic: "1" },
      ],
      body: {},
      observedAt: "2026-08-23T10:00:00.000Z",
      fetchedAt: "2026-08-23T10:00:00.000Z",
    })).toThrow(/canonical unsigned integer|millisecond precision/);

    const first = appendBasePositionEvidence(store, {
      blockNumber: "200",
      blockHash: hash("5"),
      blockTime: "2026-08-23T10:00:00.000Z",
      evidenceHash: digest("5"),
      ethAtomic: "500",
      usdcAtomic: "600",
      observedAt: "2026-08-23T10:01:00.000Z",
    });
    setClock("2026-08-23T10:01:01.000Z");
    store.applyBasePositionSnapshot(first);

    const duplicateTrust = appendBasePositionEvidence(store, {
      blockNumber: "201",
      blockHash: hash("6"),
      blockTime: "2026-08-23T10:01:00.000Z",
      evidenceHash: digest("6"),
      ethAtomic: "700",
      usdcAtomic: "800",
      observedAt: "2026-08-23T10:02:00.000Z",
      trustDomains: [digest("c"), digest("c")],
    });
    expect(() => store.applyBasePositionSnapshot(duplicateTrust)).toThrow(
      BasePositionSnapshotConflictError,
    );
    expect(store.listBasePositionSnapshots({ accountId: "base-account" })).toHaveLength(1);

    const newer = appendBasePositionEvidence(store, {
      blockNumber: "202",
      blockHash: hash("7"),
      blockTime: "2026-08-23T10:02:00.000Z",
      evidenceHash: digest("7"),
      ethAtomic: "900",
      usdcAtomic: "1000",
      observedAt: "2026-08-23T10:03:00.000Z",
    });
    store.db.exec(`
      CREATE TRIGGER test_base_projection_abort
      BEFORE UPDATE OF observed_atomic ON wk_positions
      WHEN NEW.account_id='base-account'
        AND NEW.asset_id='${BASE_USDC_ASSET_ID}'
      BEGIN
        SELECT RAISE(ABORT, 'simulated projection failure');
      END;
    `);
    setClock("2026-08-23T10:03:01.000Z");
    expect(() => store.applyBasePositionSnapshot(newer)).toThrow(/simulated projection failure/);
    expect(store.listBasePositionSnapshots({ accountId: "base-account" })).toHaveLength(1);
    expect(store.getBasePositionHead("base-account")).toMatchObject({
      blockNumber: "200",
      state: "ACTIVE",
      version: 0,
    });
    expect(store.listBasePositions({ accountId: "base-account" }).map(
      ({ observedAtomic }) => observedAtomic,
    ).sort()).toEqual(["500", "600"]);
  });
});

describe("reservations", () => {
  it("prevents oversubscription and allows funds again only after an atomic release", () => {
    const store = makeStore();
    const firstIntent = createIntent(store, { id: "intent-reserve-1" }).intent;
    const secondIntent = store.createPaymentIntent({
      id: "intent-reserve-2",
      kind: "TRANSFER",
      sourceAccountId: "account-1",
      assetId: "iso4217:USD",
      amountAtomic: "4000",
      destination: { kind: "BANK_ACCOUNT", payeeId: "payee-2" },
      intentHash: "intent-hash-2",
      createdBy: { type: "HUMAN", ref: "user-1" },
    }).intent;
    const first = store.acquireReservation({
      id: "reservation-1",
      intentId: firstIntent.id,
      accountId: "account-1",
      assetId: "iso4217:USD",
      kind: "BALANCE",
      amountAtomic: "7000",
    });
    expect(first.availableAfterAtomic).toBe("3000");
    expect(() =>
      store.acquireReservation({
        intentId: secondIntent.id,
        accountId: "account-1",
        assetId: "iso4217:USD",
        kind: "BALANCE",
        amountAtomic: "4000",
      }),
    ).toThrow(InsufficientAvailableBalanceError);

    expect(store.releaseReservation(first.reservation.id, 0).state).toBe("RELEASED");
    expect(() => store.releaseReservation(first.reservation.id, 0)).toThrow(ReservationConflictError);
    expect(
      store.acquireReservation({
        intentId: secondIntent.id,
        accountId: "account-1",
        assetId: "iso4217:USD",
        kind: "BALANCE",
        amountAtomic: "4000",
      }).availableAfterAtomic,
    ).toBe("6000");
  });

  it("keeps a consumed nonce or UTXO claimed after signing", () => {
    const store = makeStore();
    const firstIntent = createIntent(store, { id: "intent-nonce-1" }).intent;
    const secondIntent = store.createPaymentIntent({
      id: "intent-nonce-2",
      kind: "TRANSFER",
      sourceAccountId: "account-1",
      assetId: "iso4217:USD",
      amountAtomic: "1",
      destination: { kind: "BANK_ACCOUNT", payeeId: "payee-2" },
      intentHash: "intent-hash-nonce-2",
      createdBy: { type: "HUMAN", ref: "user-1" },
    }).intent;
    const claimed = store.acquireReservation({
      id: "nonce-reservation-1",
      intentId: firstIntent.id,
      accountId: "account-1",
      assetId: "iso4217:USD",
      kind: "NONCE",
      resourceKey: "eip155:1:account-1:7",
      amountAtomic: "1",
    }).reservation;
    expect(store.consumeReservation(claimed.id, 0).state).toBe("CONSUMED");

    expect(() =>
      store.acquireReservation({
        id: "nonce-reservation-2",
        intentId: secondIntent.id,
        accountId: "account-1",
        assetId: "iso4217:USD",
        kind: "NONCE",
        resourceKey: "eip155:1:account-1:7",
        amountAtomic: "1",
      }),
    ).toThrow(ReservationConflictError);
  });

  it("releases a consumed resource only through exact append-only reconciliation evidence", () => {
    const store = makeStore();
    const firstIntent = createIntent(store, { id: "intent-reconcile-1" }).intent;
    const secondIntent = createIntent(store, { id: "intent-reconcile-2" }).intent;
    const claimed = store.acquireReservation({
      id: "nonce-reservation-reconcile",
      intentId: firstIntent.id,
      accountId: "account-1",
      assetId: "iso4217:USD",
      kind: "NONCE",
      resourceKey: "eip155:1:account-1:8",
      amountAtomic: "1",
    }).reservation;
    const reconciliationAuthorization = store.createSigningAuthorization({
      id: "authorization-reconcile-1",
      intentId: firstIntent.id,
      intentHash: firstIntent.intentHash,
      keyId: "key-reconcile-1",
      requestHash: "request-reconcile-1",
      actor: { type: "SERVICE", ref: "reconciliation-fixture" },
      method: "TEST",
      grantHash: "grant-reconcile-1",
    }).authorization;
    const reconciliationArtifact = store.persistSignedArtifact({
      authorizationId: reconciliationAuthorization.id,
      intentId: firstIntent.id,
      intentHash: firstIntent.intentHash,
      keyId: reconciliationAuthorization.keyId,
      requestHash: reconciliationAuthorization.requestHash,
      encoding: "hex",
      payload: "0x0506",
      externalTxId: "0xdeadbeef",
    }).artifact;
    const consumed = store.getReservation(claimed.id)!;
    expect(consumed).toMatchObject({ state: "CONSUMED", version: claimed.version + 1 });
    expect(() => store.releaseReservation(consumed.id, consumed.version)).toThrow(
      ReservationConflictError,
    );
    expect(() =>
      store.db
        .query("UPDATE wk_reservations SET state='RELEASED' WHERE id=?")
        .run(consumed.id),
    ).toThrow(/requires reconciliation evidence/);
    const preparedExecution = store.createExecution({
      id: "execution-reconcile-1",
      intentId: firstIntent.id,
      rail: "evm",
      state: "prepared",
      preparedRef: reconciliationAuthorization.id,
      requestHash: reconciliationAuthorization.requestHash,
    }).execution;
    const signedExecution = store.transitionExecution({
      id: preparedExecution.id,
      expectedState: "prepared",
      expectedVersion: preparedExecution.version,
      toState: "signed",
      networkTxId: reconciliationArtifact.externalTxId,
      signedArtifactId: reconciliationArtifact.id,
      response: { artifact_id: reconciliationArtifact.id },
    });
    const submittedExecution = store.transitionExecution({
      id: signedExecution.id,
      expectedState: "signed",
      expectedVersion: signedExecution.version,
      toState: "submitted",
      submissionRef: reconciliationArtifact.externalTxId,
    });
    const execution = store.transitionExecution({
      id: submittedExecution.id,
      expectedState: "submitted",
      expectedVersion: submittedExecution.version,
      toState: "dropped",
    });
    const unverified = store.recordReceipt({
      id: "receipt-reconcile-unverified",
      intentId: firstIntent.id,
      executionId: execution.id,
      kind: "RECONCILIATION_DROPPED",
      receiptHash: "receipt-hash-reconcile-unverified",
      body: {
        schema_version: "cashloom.reservation-release-evidence/1",
        verified: true,
        resource_reusable: false,
        reservation_id: consumed.id,
        intent_id: firstIntent.id,
        execution_id: execution.id,
        outcome: "DROPPED",
        match_basis: "exact-transaction-id",
        matched_reference: "0xdeadbeef",
      },
    }).receipt;
    expect(() =>
      store.releaseConsumedReservationAfterReconciliation({
        reservationId: consumed.id,
        expectedVersion: consumed.version,
        executionId: execution.id,
        evidenceReceiptId: unverified.id,
        outcome: "DROPPED",
        matchBasis: "exact-transaction-id",
        verifiedBy: { type: "SERVICE", ref: "chain-reconciler" },
      }),
    ).toThrow(/does not exactly bind/);
    expect(store.getReservation(consumed.id)?.state).toBe("CONSUMED");

    const evidence = store.recordReceipt({
      id: "receipt-reconcile-verified",
      intentId: firstIntent.id,
      executionId: execution.id,
      kind: "RECONCILIATION_DROPPED",
      receiptHash: "receipt-hash-reconcile-verified",
      body: {
        schema_version: "cashloom.reservation-release-evidence/1",
        verified: true,
        resource_reusable: true,
        reservation_id: consumed.id,
        intent_id: firstIntent.id,
        execution_id: execution.id,
        outcome: "DROPPED",
        match_basis: "exact-transaction-id",
        matched_reference: "0xdeadbeef",
      },
    }).receipt;
    const released = store.releaseConsumedReservationAfterReconciliation({
      id: "resolution-reconcile-1",
      reservationId: consumed.id,
      expectedVersion: consumed.version,
      executionId: execution.id,
      evidenceReceiptId: evidence.id,
      outcome: "DROPPED",
      matchBasis: "exact-transaction-id",
      verifiedBy: { type: "SERVICE", ref: "chain-reconciler" },
      data: { confirmation_depth: 12 },
    });
    expect(released).toMatchObject({
      replayed: false,
      reservation: { state: "RELEASED", version: 2 },
      resolution: { evidenceReceiptHash: "receipt-hash-reconcile-verified" },
    });
    expect(
      store.releaseConsumedReservationAfterReconciliation({
        reservationId: consumed.id,
        expectedVersion: consumed.version,
        executionId: execution.id,
        evidenceReceiptId: evidence.id,
        outcome: "DROPPED",
        matchBasis: "exact-transaction-id",
        verifiedBy: { type: "SERVICE", ref: "chain-reconciler" },
        data: { confirmation_depth: 12 },
      }).replayed,
    ).toBe(true);
    expect(() =>
      store.db
        .query("UPDATE wk_reservation_resolutions SET verifier_ref='tampered' WHERE id=?")
        .run(released.resolution.id),
    ).toThrow(/append-only/);

    expect(
      store.acquireReservation({
        id: "nonce-reservation-reused-after-evidence",
        intentId: secondIntent.id,
        accountId: "account-1",
        assetId: "iso4217:USD",
        kind: "NONCE",
        resourceKey: "eip155:1:account-1:8",
        amountAtomic: "1",
      }).reservation.state,
    ).toBe("ACTIVE");
  });
});

describe("reconciliation audit reads", () => {
  it("appends generic observations/links safely and lists intent evidence without ad hoc SQL", () => {
    const store = makeStore();
    const intent = createIntent(store, { id: "audit-intent" }).intent;
    store.putLedgerAccount({ id: "audit-ledger-cash", code: "audit:1000", name: "Cash", kind: "ASSET" });
    store.putLedgerAccount({
      id: "audit-ledger-clearing",
      code: "audit:2000",
      name: "Clearing",
      kind: "CLEARING",
    });
    const journal = store.postJournalEntry({
      id: "audit-journal",
      description: "Observed provider settlement",
      effectiveAt: "2026-08-23T02:00:00.000Z",
      referenceType: "PAYMENT_INTENT",
      referenceId: `intent:${intent.id}:principal`,
      postings: [
        {
          ledgerAccountId: "audit-ledger-cash",
          assetId: "iso4217:USD",
          direction: "DEBIT",
          amountAtomic: "2500",
        },
        {
          ledgerAccountId: "audit-ledger-clearing",
          assetId: "iso4217:USD",
          direction: "CREDIT",
          amountAtomic: "2500",
        },
      ],
    }).entry;
    store.postJournalEntry({
      id: "unrelated-audit-journal",
      description: "Unrelated settlement",
      effectiveAt: "2026-08-23T02:00:01.000Z",
      referenceType: "PAYMENT_INTENT",
      referenceId: "intent:other:principal",
      postings: [
        {
          ledgerAccountId: "audit-ledger-cash",
          assetId: "iso4217:USD",
          direction: "DEBIT",
          amountAtomic: "1",
        },
        {
          ledgerAccountId: "audit-ledger-clearing",
          assetId: "iso4217:USD",
          direction: "CREDIT",
          amountAtomic: "1",
        },
      ],
    });

    const observation = store.appendObservation({
      id: "audit-observation",
      accountId: "account-1",
      assetId: "iso4217:USD",
      provider: "bank-provider",
      externalId: "provider-event-1",
      kind: "SETTLEMENT",
      amountAtomic: "-2500",
      state: "SETTLED",
      occurredAt: "2026-08-23T02:00:00.000Z",
      body: { provider_event_id: "provider-event-1" },
    });
    expect(store.appendObservation({
      id: "audit-observation-replay-id",
      accountId: "account-1",
      assetId: "iso4217:USD",
      provider: "bank-provider",
      externalId: "provider-event-1",
      kind: "SETTLEMENT",
      amountAtomic: "-2500",
      state: "SETTLED",
      occurredAt: "2026-08-23T02:00:00.000Z",
      body: { provider_event_id: "provider-event-1" },
    })).toMatchObject({ replayed: true, observation: { id: "audit-observation" } });
    expect(() => store.appendObservation({
      id: "audit-observation-conflict",
      accountId: "account-1",
      assetId: "iso4217:USD",
      provider: "bank-provider",
      externalId: "provider-event-1",
      kind: "SETTLEMENT",
      amountAtomic: "-2501",
      state: "SETTLED",
      occurredAt: "2026-08-23T02:00:00.000Z",
      body: { provider_event_id: "provider-event-1" },
    })).toThrow(/OBSERVATION_FINGERPRINT_MISMATCH|different evidence/);

    const link = store.appendReconciliationLink({
      id: "audit-link",
      observationId: observation.observation.id,
      intentId: intent.id,
      journalEntryId: journal.id,
      matchKind: "EXACT_PROVIDER_REFERENCE",
      confidenceBps: 10_000,
      data: { matched: true },
    });
    expect(store.appendReconciliationLink({
      id: "audit-link-replay-id",
      observationId: observation.observation.id,
      intentId: intent.id,
      journalEntryId: journal.id,
      matchKind: "EXACT_PROVIDER_REFERENCE",
      confidenceBps: 10_000,
      data: { matched: true },
    })).toMatchObject({ replayed: true, link: { id: "audit-link" } });

    const receipt = store.recordReceipt({
      id: "audit-receipt",
      intentId: intent.id,
      kind: "PROVIDER_SETTLEMENT",
      receiptHash: "sha256:audit-receipt",
      body: { settled: true },
      observedAt: "2026-08-23T02:00:00.000Z",
    }).receipt;
    expect(store.listReceiptsForIntent(intent.id)).toEqual([receipt]);
    expect(store.listObservationsForIntent(intent.id)).toEqual([observation.observation]);
    expect(store.listReconciliationLinksForIntent(intent.id)).toEqual([link.link]);
    expect(store.listJournalEntriesForReferencePrefix({
      referenceType: "PAYMENT_INTENT",
      referenceIdPrefix: `intent:${intent.id}:`,
    })).toEqual([journal]);
    expect(store.getJournalEntry(journal.id)).toEqual(journal);

    expect(() => store.db.query(
      "UPDATE wk_observations SET state='REVERSED' WHERE id='audit-observation'",
    ).run()).toThrow(/append-only/);
    expect(() => store.db.query(
      "DELETE FROM wk_reconciliation_links WHERE id='audit-link'",
    ).run()).toThrow(/append-only/);
  });
});

describe("double-entry journal", () => {
  it("requires exact per-asset balance and preserves integers larger than SQLite int64", () => {
    const store = makeStore();
    store.putLedgerAccount({ id: "ledger-cash", code: "1000", name: "Cash", kind: "ASSET" });
    store.putLedgerAccount({
      id: "ledger-clearing",
      code: "2000",
      name: "Settlement clearing",
      kind: "CLEARING",
    });

    expect(() =>
      store.postJournalEntry({
        id: "bad-entry",
        description: "An apparent balance that crosses assets",
        effectiveAt: "2026-08-21T00:00:00.000Z",
        postings: [
          {
            ledgerAccountId: "ledger-cash",
            assetId: "iso4217:USD",
            direction: "DEBIT",
            amountAtomic: "10",
          },
          {
            ledgerAccountId: "ledger-clearing",
            assetId: "eip155:1/slip44:60",
            direction: "CREDIT",
            amountAtomic: "10",
          },
        ],
      }),
    ).toThrow(JournalUnbalancedError);
    expect(store.db.query("SELECT count(*) AS count FROM wk_journal_entries").get()).toEqual({ count: 0 });

    const huge = "900719925474099312345678901234567890";
    const { entry } = store.postJournalEntry({
      id: "balanced-entry",
      description: "Exact multi-asset settlement",
      effectiveAt: "2026-08-21T00:00:00.000Z",
      postings: [
        {
          ledgerAccountId: "ledger-cash",
          assetId: "iso4217:USD",
          direction: "DEBIT",
          amountAtomic: huge,
        },
        {
          ledgerAccountId: "ledger-clearing",
          assetId: "iso4217:USD",
          direction: "CREDIT",
          amountAtomic: huge,
        },
        {
          ledgerAccountId: "ledger-cash",
          assetId: "eip155:1/slip44:60",
          direction: "DEBIT",
          amountAtomic: "1",
        },
        {
          ledgerAccountId: "ledger-clearing",
          assetId: "eip155:1/slip44:60",
          direction: "CREDIT",
          amountAtomic: "1",
        },
      ],
    });
    expect(entry.status).toBe("POSTED");
    expect(entry.postings[0]?.amountAtomic).toBe(huge);
    expect(() =>
      store.db.query("UPDATE wk_postings SET amount_atomic='2' WHERE journal_entry_id=?").run(entry.id),
    ).toThrow(/immutable/);
  });
});
