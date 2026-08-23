import { afterEach, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import {
  keccak256,
  recoverTransactionAddress,
  serializeTransaction,
  type Address,
  type Hex,
  type TransactionSerializedEIP1559,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  BASE_CHAIN_ID,
  BASE_ETH_ASSET_ID,
  createBaseReconciliationService,
} from "./base-reconciler.ts";
import type {
  BaseCoreEvidence,
  BaseEvidenceObserver,
  BaseProviderSighting,
  BaseTransactionObservation,
  BaseTransactionObservationRequest,
} from "./adapters/base-observer.ts";
import {
  BASE_GAS_PRICE_ORACLE,
  parsePreparedEvmQuote,
  type EvmQuoteDetailV2,
} from "../senders/evm.sender.ts";
import { hashPreparedEvmTransaction, type PreparedEvmTransaction } from "../vault.ts";
import {
  WalletKernelStore,
  fingerprintRequest,
  type JsonValue,
} from "./infrastructure/sqlite/index.ts";

// Hardhat's public throwaway account #0. This suite signs locally and never
// broadcasts or makes a network request.
const TEST_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const signer = privateKeyToAccount(TEST_KEY);
const BENEFICIARY = `0x${"2".repeat(40)}` as Address;
const PAYMENT_ID = "payment.base.truth.1";
const ACCOUNT_ID = "account.base.truth.1";
const WALLET_ID = "wallet.base.truth.1";
const EXECUTION_ID = `execution.${PAYMENT_ID}.0`;
const RESERVATION_ID = `reservation.${PAYMENT_ID}.nonce`;
const AUTHORIZATION_ID = `authorization.${PAYMENT_ID}`;
const ARTIFACT_ID = `artifact.${PAYMENT_ID}`;
const ASSET_LEDGER_ID = `ledger.asset.${ACCOUNT_ID}`;
const CLEARING_LEDGER_ID = "ledger.clearing.payments";
const AMOUNT_ATOMIC = "900719925474099312345678";
const GAS_LIMIT = 30_000n;
const MAX_FEE_PER_GAS = 10_000_000_000_000_000n;
const MAX_PRIORITY_FEE_PER_GAS = 1_000_000_000n;
const QUOTED_L1_UPPER_BOUND = 10_000_000_000_000_000_000n;
const QUOTED_OPERATOR_UPPER_BOUND = 10_000_000_000_000_000_000n;
const QUOTED_EXECUTION_CAP = GAS_LIMIT * MAX_FEE_PER_GAS;
const QUOTED_TOTAL =
  QUOTED_EXECUTION_CAP + QUOTED_L1_UPPER_BOUND + QUOTED_OPERATOR_UPPER_BOUND;
const SUBMITTED_AT = "2026-08-23T00:00:00.000Z";
const FINALIZED_AT = "2026-08-23T00:10:00.000Z";
const BLOCK_TIMESTAMP = Math.floor(Date.parse(FINALIZED_AT) / 1_000).toString();
const BLOCK_NUMBER = "900719925474099312345";
const BLOCK_HASH = `0x${"a".repeat(64)}` as const;
const OTHER_BLOCK_HASH = `0x${"b".repeat(64)}` as const;
const NORMAL_L1_FEE = "9007199254740993123";
const NORMAL_OPERATOR_FEE = "9007199254740993555";
const GAS_USED = "21000";
const EFFECTIVE_GAS_PRICE = "9007199254740993";
const L2_FEE = (BigInt(GAS_USED) * BigInt(EFFECTIVE_GAS_PRICE)).toString();
const NORMAL_TOTAL_FEE = (
  BigInt(L2_FEE) + BigInt(NORMAL_L1_FEE) + BigInt(NORMAL_OPERATOR_FEE)
).toString();

const openDatabases: Database[] = [];

afterEach(() => {
  while (openDatabases.length > 0) openDatabases.pop()?.close();
});

const installLegacyTables = (db: Database): void => {
  db.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE accounts (
      id TEXT PRIMARY KEY,
      rail TEXT NOT NULL,
      display_name TEXT NOT NULL,
      currency TEXT NOT NULL,
      decimals INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'ACTIVE'
    );
    CREATE TABLE transactions (
      id TEXT PRIMARY KEY,
      account_id TEXT NOT NULL REFERENCES accounts(id),
      external_id TEXT,
      title TEXT NOT NULL,
      amount_minor TEXT NOT NULL,
      date TEXT NOT NULL,
      source TEXT NOT NULL,
      UNIQUE(account_id, external_id)
    );
    CREATE TABLE payments (
      id TEXT PRIMARY KEY,
      account_id TEXT NOT NULL REFERENCES accounts(id),
      rail TEXT NOT NULL,
      to_addr TEXT NOT NULL,
      asset TEXT NOT NULL,
      amount_minor TEXT NOT NULL,
      fee_minor TEXT,
      status TEXT NOT NULL,
      tx_hash TEXT,
      error TEXT,
      detail TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT
    );
  `);
};

interface Harness {
  readonly db: Database;
  readonly store: WalletKernelStore;
  readonly signedTransaction: Hex;
  readonly transactionHash: `0x${string}`;
  readonly requestHash: `sha256:${string}`;
  readonly quoteDetail: EvmQuoteDetailV2;
  service(observations: readonly BaseTransactionObservation[]): {
    readonly observer: ScriptedObserver;
    readonly reconciliation: ReturnType<typeof createBaseReconciliationService>;
  };
}

type StartingExecutionState = "submitted" | "ambiguous" | "signed" | "failed";

interface HarnessOptions {
  readonly executionState?: StartingExecutionState;
  readonly includeSubmissionProjection?: boolean;
}

interface ScriptedObserver extends BaseEvidenceObserver {
  readonly requests: BaseTransactionObservationRequest[];
}

const scriptedObserver = (
  observations: readonly BaseTransactionObservation[],
): ScriptedObserver => {
  if (observations.length === 0) throw new Error("A scripted observation is required.");
  const requests: BaseTransactionObservationRequest[] = [];
  let cursor = 0;
  return {
    requests,
    async observe(request) {
      requests.push(request);
      const result = observations[Math.min(cursor, observations.length - 1)]!;
      cursor += 1;
      return result;
    },
  };
};

const advanceIntent = (
  store: WalletKernelStore,
  toState:
    | "reserved"
    | "authorized"
    | "prepared"
    | "signed"
    | "submitted"
    | "ambiguous"
    | "failed",
): void => {
  const current = store.getPaymentIntent(PAYMENT_ID)!;
  store.transitionIntent({
    intentId: PAYMENT_ID,
    expectedState: current.state,
    expectedVersion: current.version,
    toState,
    actor: { type: "HUMAN", ref: "base-truth-test" },
    eventType: `intent.${toState}`,
    at: SUBMITTED_AT,
  });
};

const makeHarness = async (options: HarnessOptions = {}): Promise<Harness> => {
  const executionState = options.executionState ?? "submitted";
  const includeSubmissionProjection = options.includeSubmissionProjection ??
    executionState === "submitted";
  const db = new Database(":memory:");
  openDatabases.push(db);
  installLegacyTables(db);
  let generatedId = 0;
  const store = new WalletKernelStore(db, {
    now: () => new Date(SUBMITTED_AT),
    newId: () => `generated.base.truth.${++generatedId}`,
  });

  store.putWallet({ id: WALLET_ID, label: "Base truth wallet" });
  store.putAsset({
    id: BASE_ETH_ASSET_ID,
    instrumentId: "native:ETH",
    kind: "CRYPTO",
    symbol: "ETH",
    name: "Ether on Base",
    decimals: 18,
    chainId: BASE_CHAIN_ID,
  });
  store.putAccount({
    id: ACCOUNT_ID,
    walletId: WALLET_ID,
    label: "Base signer",
    kind: "CRYPTO",
    rail: "evm-base",
    chainId: BASE_CHAIN_ID,
    accountRef: `${BASE_CHAIN_ID}:${signer.address.toLowerCase()}`,
    address: signer.address,
    custodyMode: "local_self_custody",
  });
  store.putLedgerAccount({
    id: CLEARING_LEDGER_ID,
    code: "clearing.payments",
    name: "Payment clearing",
    kind: "CLEARING",
    walletId: WALLET_ID,
  });
  store.putLedgerAccount({
    id: ASSET_LEDGER_ID,
    code: `asset.${ACCOUNT_ID}`,
    name: "Base ETH asset",
    kind: "ASSET",
    walletId: WALLET_ID,
    externalAccountId: ACCOUNT_ID,
  });
  store.setPosition({
    accountId: ACCOUNT_ID,
    assetId: BASE_ETH_ASSET_ID,
    observedAtomic: "999999999999999999999999999999999999",
    source: "TEST",
    asOf: SUBMITTED_AT,
  });
  db.query(
    `INSERT INTO accounts (id, rail, display_name, currency, decimals)
     VALUES (?, 'CRYPTO', 'Base signer', 'ETH', 18)`,
  ).run(ACCOUNT_ID);

  const prepared: PreparedEvmTransaction = {
    kind: "cashloom.evm-transaction/1",
    chainId: 8453,
    from: signer.address,
    to: BENEFICIARY,
    valueAtomic: AMOUNT_ATOMIC,
    data: "0x",
    gasLimit: GAS_LIMIT.toString(),
    maxFeePerGas: MAX_FEE_PER_GAS.toString(),
    maxPriorityFeePerGas: MAX_PRIORITY_FEE_PER_GAS.toString(),
    nonce: 17,
  };
  const requestHash = hashPreparedEvmTransaction(prepared);
  const unsignedTransaction = serializeTransaction({
    type: "eip1559",
    chainId: prepared.chainId,
    nonce: prepared.nonce,
    gas: GAS_LIMIT,
    maxFeePerGas: MAX_FEE_PER_GAS,
    maxPriorityFeePerGas: MAX_PRIORITY_FEE_PER_GAS,
    to: BENEFICIARY,
    value: BigInt(AMOUNT_ATOMIC),
    data: "0x",
    accessList: [],
  });
  const quoteDetail: EvmQuoteDetailV2 = {
    v: 2,
    transactionType: "eip1559",
    chainId: 8453,
    from: signer.address,
    recipient: BENEFICIARY,
    asset: "ETH",
    amountAtomic: AMOUNT_ATOMIC,
    to: BENEFICIARY,
    value: AMOUNT_ATOMIC,
    data: null,
    gas: GAS_LIMIT.toString(),
    maxFeePerGas: MAX_FEE_PER_GAS.toString(),
    maxPriorityFeePerGas: MAX_PRIORITY_FEE_PER_GAS.toString(),
    nonce: 17,
    requestHash,
    feeEstimate: {
      method: "base-gas-price-oracle-predeploy/1",
      oracleAddress: BASE_GAS_PRICE_ORACLE,
      l1FeeMethod: "getL1FeeUpperBound(uint256)",
      operatorFeeMethod: "getOperatorFee(uint256)",
      sourceBlockNumber: "9007199254740993999",
      unsignedTransactionSizeBytes: ((unsignedTransaction.length - 2) / 2).toString(),
      hardExecutionCapAtomic: QUOTED_EXECUTION_CAP.toString(),
      estimatedL1UpperBoundAtomic: QUOTED_L1_UPPER_BOUND.toString(),
      estimatedOperatorUpperBoundAtomic: QUOTED_OPERATOR_UPPER_BOUND.toString(),
      estimatedTotalAtomic: QUOTED_TOTAL.toString(),
      totalIsHardCap: false,
    },
  };
  const instruction = {
    to: BENEFICIARY,
    amountMinor: AMOUNT_ATOMIC,
    asset: "ETH",
    detail: JSON.stringify(quoteDetail),
  };
  expect(parsePreparedEvmQuote(instruction).request).toEqual(prepared);

  const signedTransaction = await signer.signTransaction({
    type: "eip1559",
    chainId: prepared.chainId,
    nonce: prepared.nonce,
    gas: GAS_LIMIT,
    maxFeePerGas: MAX_FEE_PER_GAS,
    maxPriorityFeePerGas: MAX_PRIORITY_FEE_PER_GAS,
    to: BENEFICIARY,
    value: BigInt(AMOUNT_ATOMIC),
    data: "0x",
  });
  const transactionHash = keccak256(signedTransaction);
  expect(
    (await recoverTransactionAddress({
      serializedTransaction: signedTransaction as TransactionSerializedEIP1559,
    })).toLowerCase(),
  ).toBe(signer.address.toLowerCase());

  const intentHash = `sha256:${"1".repeat(64)}`;
  store.createPaymentIntent({
    id: PAYMENT_ID,
    kind: "transfer",
    sourceAccountId: ACCOUNT_ID,
    assetId: BASE_ETH_ASSET_ID,
    amountAtomic: AMOUNT_ATOMIC,
    destination: { kind: "account", address: BENEFICIARY },
    feeCeilingAtomic: QUOTED_TOTAL.toString(),
    feeAssetId: BASE_ETH_ASSET_ID,
    initialState: "quoted",
    intentHash,
    createdBy: { type: "HUMAN", ref: "base-truth-test" },
    expiresAt: "2026-08-24T00:00:00.000Z",
    metadata: { test_fixture: "real-eip1559-artifact" },
  });
  store.acquireReservation({
    id: RESERVATION_ID,
    intentId: PAYMENT_ID,
    accountId: ACCOUNT_ID,
    assetId: BASE_ETH_ASSET_ID,
    kind: "NONCE",
    resourceKey: `${BASE_CHAIN_ID}:${signer.address.toLowerCase()}:17`,
    amountAtomic: "1",
    expiresAt: "2026-08-24T00:00:00.000Z",
  });
  advanceIntent(store, "reserved");
  advanceIntent(store, "authorized");
  const authorization = store.createSigningAuthorization({
    id: AUTHORIZATION_ID,
    intentId: PAYMENT_ID,
    intentHash,
    keyId: "key.base.truth.1",
    requestHash,
    actor: { type: "HUMAN", ref: "base-truth-test" },
    method: "LOCAL_VAULT_CONFIRMATION",
    grantHash: `sha256:${"2".repeat(64)}`,
    constraints: { chain_id: BASE_CHAIN_ID, single_use: true },
    expiresAt: "2026-08-24T00:00:00.000Z",
  }).authorization;
  advanceIntent(store, "prepared");
  const preparedExecution = store.createExecution({
    id: EXECUTION_ID,
    intentId: PAYMENT_ID,
    sequence: 0,
    rail: "evm-base",
    state: "prepared",
    idempotencyKey: `payment.${PAYMENT_ID}`,
    preparedRef: authorization.id,
    requestHash,
  }).execution;
  const artifact = store.persistSignedArtifact({
    id: ARTIFACT_ID,
    authorizationId: authorization.id,
    intentId: PAYMENT_ID,
    intentHash,
    keyId: authorization.keyId,
    requestHash,
    encoding: "hex",
    payload: signedTransaction,
    externalTxId: transactionHash,
  }).artifact;
  expect(store.getSigningAuthorization(AUTHORIZATION_ID)?.status).toBe("CONSUMED");
  expect(store.getReservation(RESERVATION_ID)?.state).toBe("CONSUMED");
  advanceIntent(store, "signed");
  const signedExecution = store.transitionExecution({
    id: preparedExecution.id,
    expectedState: "prepared",
    expectedVersion: preparedExecution.version,
    toState: "signed",
    networkTxId: transactionHash,
    signedArtifactId: artifact.id,
    response: { artifact_id: artifact.id },
  });
  if (executionState === "submitted") {
    advanceIntent(store, "submitted");
    store.transitionExecution({
      id: signedExecution.id,
      expectedState: "signed",
      expectedVersion: signedExecution.version,
      toState: "submitted",
      submissionRef: transactionHash,
      submittedAt: SUBMITTED_AT,
    });
  } else if (executionState === "ambiguous") {
    advanceIntent(store, "submitted");
    advanceIntent(store, "ambiguous");
    store.transitionExecution({
      id: signedExecution.id,
      expectedState: "signed",
      expectedVersion: signedExecution.version,
      toState: "ambiguous",
      submissionRef: transactionHash,
      ambiguous: true,
      errorCode: "BROADCAST_OUTCOME_UNKNOWN",
      errorMessage: "Injected ambiguous broadcast outcome.",
      submittedAt: SUBMITTED_AT,
    });
  } else if (executionState === "failed") {
    advanceIntent(store, "failed");
    store.transitionExecution({
      id: signedExecution.id,
      expectedState: "signed",
      expectedVersion: signedExecution.version,
      toState: "failed",
      errorCode: "LOCAL_RECORDING_FAILED",
      errorMessage: "Signed transaction outcome was not projected locally.",
    });
  }

  const legacyStatus = executionState === "submitted"
    ? "broadcast"
    : executionState === "failed"
      ? "failed"
      : "confirmed";
  const legacyTxHash = executionState === "submitted" ? transactionHash : null;

  db.query(
    `INSERT INTO payments
       (id, account_id, rail, to_addr, asset, amount_minor, fee_minor,
        status, tx_hash, detail, created_at, updated_at)
     VALUES (?, ?, 'evm-base', ?, 'ETH', ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    PAYMENT_ID,
    ACCOUNT_ID,
    BENEFICIARY,
    AMOUNT_ATOMIC,
    QUOTED_TOTAL.toString(),
    legacyStatus,
    legacyTxHash,
    instruction.detail,
    SUBMITTED_AT,
    SUBMITTED_AT,
  );
  if (includeSubmissionProjection) {
    db.query(
      `INSERT INTO transactions
         (id, account_id, external_id, title, amount_minor, date, source)
       VALUES (?, ?, ?, 'submitted Base ETH payment', ?, ?, 'PAYMENT')`,
    ).run(
      `transaction.${PAYMENT_ID}.submission`,
      ACCOUNT_ID,
      transactionHash,
      `-${AMOUNT_ATOMIC}`,
      SUBMITTED_AT,
    );
    store.postJournalEntry({
      id: `journal.${PAYMENT_ID}.submitted`,
      description: "Outbound ETH transfer",
      effectiveAt: SUBMITTED_AT,
      referenceType: "PAYMENT_INTENT",
      referenceId: PAYMENT_ID,
      metadata: {
        network_tx_id: transactionHash,
        lifecycle_state: "submitted",
        network_fee: "pending_chain_observation",
      },
      postings: [
        {
          ledgerAccountId: CLEARING_LEDGER_ID,
          assetId: BASE_ETH_ASSET_ID,
          direction: "DEBIT",
          amountAtomic: AMOUNT_ATOMIC,
        },
        {
          ledgerAccountId: ASSET_LEDGER_ID,
          assetId: BASE_ETH_ASSET_ID,
          direction: "CREDIT",
          amountAtomic: AMOUNT_ATOMIC,
        },
      ],
    });
    const submissionBody: JsonValue = {
      schema: "cashloom.payment-receipt/1",
      intent_id: PAYMENT_ID,
      execution_id: EXECUTION_ID,
      network_tx_id: transactionHash,
      state: "submitted",
      observed_at: SUBMITTED_AT,
      network_fee: {
        state: "pending_chain_observation",
        asset_id: BASE_ETH_ASSET_ID,
        ceiling_atomic: QUOTED_TOTAL.toString(),
        actual_atomic: null,
      },
    };
    store.recordReceipt({
      id: `receipt.${PAYMENT_ID}.submission`,
      intentId: PAYMENT_ID,
      executionId: EXECUTION_ID,
      kind: "SUBMISSION",
      receiptHash: `sha256:${fingerprintRequest(submissionBody)}`,
      body: submissionBody,
      observedAt: SUBMITTED_AT,
    });
  }

  return {
    db,
    store,
    signedTransaction,
    transactionHash,
    requestHash,
    quoteDetail,
    service(observations) {
      const observer = scriptedObserver(observations);
      return {
        observer,
        reconciliation: createBaseReconciliationService({ db, store, observer }),
      };
    },
  };
};

const canonicalEvidence = (
  core: Omit<BaseCoreEvidence, "evidence_hash">,
): BaseCoreEvidence => ({
  ...core,
  evidence_hash: `sha256:${fingerprintRequest(core)}`,
});

const coreEvidence = (
  harness: Harness,
  options: {
    outcome?: "success" | "reverted";
    hashSeed?: string;
    blockHash?: `0x${string}`;
    blockNumber?: string;
    l1Fee?: string;
    operatorFee?: string;
  } = {},
): BaseCoreEvidence => {
  const outcome = options.outcome ?? "success";
  const l1Fee = options.l1Fee ?? NORMAL_L1_FEE;
  const operatorFee = options.operatorFee ?? NORMAL_OPERATOR_FEE;
  const totalFee = (BigInt(L2_FEE) + BigInt(l1Fee) + BigInt(operatorFee)).toString();
  // hashSeed exists only to let conflict fixtures alter a harmless canonical
  // field. A Base evidence hash is always recomputed from the complete body.
  const transactionIndex = options.hashSeed === undefined
    ? "9007199254740993"
    : BigInt(`0x${options.hashSeed.repeat(2)}`).toString();
  return canonicalEvidence({
    schema_version: "cashloom.base-evidence/1",
    transaction: {
      hash: harness.transactionHash,
      from: signer.address,
      to: BENEFICIARY,
      nonce: "17",
      value_wei: AMOUNT_ATOMIC,
      calldata: "0x",
      gas_limit: GAS_LIMIT.toString(),
      max_fee_per_gas_wei: MAX_FEE_PER_GAS.toString(),
      max_priority_fee_per_gas_wei: MAX_PRIORITY_FEE_PER_GAS.toString(),
      access_list: [],
    },
    inclusion: {
      block_hash: options.blockHash ?? BLOCK_HASH,
      block_number: options.blockNumber ?? BLOCK_NUMBER,
      block_timestamp: BLOCK_TIMESTAMP,
      transaction_index: transactionIndex,
    },
    outcome,
    economic_effect: {
      asset: "ETH",
      beneficiary: BENEFICIARY,
      amount_atomic: outcome === "success" ? AMOUNT_ATOMIC : "0",
    },
    fees: {
      gas_used: GAS_USED,
      effective_gas_price_wei: EFFECTIVE_GAS_PRICE,
      l2_execution_fee_wei: L2_FEE,
      l1_data_fee_wei: l1Fee,
      operator_fee_wei: operatorFee,
      total_fee_wei: totalFee,
    },
  });
};

const includedSighting = (
  evidence: BaseCoreEvidence,
  providerId: string,
  fetchedAt = FINALIZED_AT,
  securityLevel: "UNSAFE" | "SAFE" | "FINALIZED" = "FINALIZED",
): BaseProviderSighting => ({
  provider_id: providerId,
  visibility: "INCLUDED",
  outcome: evidence.outcome === "success" ? "SUCCESS" : "REVERTED",
  security_level: securityLevel,
  block_number: evidence.inclusion.block_number,
  block_hash: evidence.inclusion.block_hash,
  evidence_hash: evidence.evidence_hash,
  body: {
    schema_version: "cashloom.base-included-sighting/2",
    evidence,
    security_level: securityLevel,
  } as unknown as JsonValue,
  observed_at: FINALIZED_AT,
  fetched_at: fetchedAt,
});

const finalizedObservation = (
  harness: Harness,
  evidence: BaseCoreEvidence,
  fetchedAt = FINALIZED_AT,
): BaseTransactionObservation => {
  const providerIds = ["base-a", "base-b"] as const;
  const sightings = providerIds.map((providerId) =>
    includedSighting(evidence, providerId, fetchedAt)
  );
  return {
    schema_version: "cashloom.base-observation/1",
    state: "settled",
    transaction_hash: harness.transactionHash,
    observed_at: fetchedAt,
    quorum: {
      required_distinct_providers: "2",
      groups: [{
        evidence_hash: evidence.evidence_hash,
        provider_ids: providerIds,
        finalized_provider_ids: providerIds,
      }],
    },
    providers: providerIds.map((providerId) => ({
      provider_id: providerId,
      state: "included" as const,
      evidence,
      finality: {
        latest: { status: "confirmed" as const },
        safe: { status: "confirmed" as const },
        finalized: { status: "confirmed" as const },
      },
    })),
    sightings,
    evidence,
    consensus: {
      provider_ids: providerIds,
      quorum: "2",
      evidence_hash: evidence.evidence_hash,
      outcome: evidence.outcome === "success" ? "SUCCESS" : "REVERTED",
      security_level: "FINALIZED",
      block_number: evidence.inclusion.block_number,
      block_hash: evidence.inclusion.block_hash,
      body: evidence,
      observed_at: fetchedAt,
    },
  };
};

const notFoundObservation = (
  harness: Harness,
  fetchedAt = FINALIZED_AT,
): BaseTransactionObservation => {
  const providerIds = ["base-a", "base-b"] as const;
  const body: JsonValue = {
    schema_version: "cashloom.base-sighting/1",
    transaction_hash: harness.transactionHash,
    visibility: "NOT_FOUND",
    authorized_payment: {
      asset: "ETH",
      from: signer.address,
      beneficiary: BENEFICIARY,
      amount_atomic: AMOUNT_ATOMIC,
    },
  };
  const hash = `sha256:${fingerprintRequest(body)}` as const;
  return {
    schema_version: "cashloom.base-observation/1",
    state: "pending",
    transaction_hash: harness.transactionHash,
    observed_at: fetchedAt,
    quorum: { required_distinct_providers: "2", groups: [] },
    providers: providerIds.map((providerId) => ({
      provider_id: providerId,
      state: "pending" as const,
      reason: "transaction_not_visible" as const,
    })),
    sightings: providerIds.map((providerId) => ({
      provider_id: providerId,
      visibility: "NOT_FOUND" as const,
      outcome: "UNKNOWN" as const,
      security_level: "UNSAFE" as const,
      block_number: null,
      block_hash: null,
      evidence_hash: hash,
      body,
      observed_at: fetchedAt,
      fetched_at: fetchedAt,
    })),
  };
};

const includedNonfinalObservation = (
  harness: Harness,
  evidence: BaseCoreEvidence,
  fetchedAt: string,
  securityLevel: "UNSAFE" | "SAFE" = "UNSAFE",
): BaseTransactionObservation => {
  const providerIds = ["base-a", "base-b"] as const;
  const safe = securityLevel === "SAFE";
  return {
    schema_version: "cashloom.base-observation/1",
    state: "partial",
    transaction_hash: harness.transactionHash,
    observed_at: fetchedAt,
    quorum: {
      required_distinct_providers: "2",
      groups: [{
        evidence_hash: evidence.evidence_hash,
        provider_ids: providerIds,
        finalized_provider_ids: [],
      }],
    },
    providers: providerIds.map((providerId) => ({
      provider_id: providerId,
      state: "included" as const,
      evidence,
      finality: {
        latest: { status: "confirmed" as const },
        safe: { status: safe ? "confirmed" as const : "not_confirmed" as const },
        finalized: { status: "not_confirmed" as const },
      },
    })),
    sightings: providerIds.map((providerId) =>
      includedSighting(evidence, providerId, fetchedAt, securityLevel)
    ),
  };
};

const singleProviderFinalizedObservation = (
  harness: Harness,
  evidence: BaseCoreEvidence,
  fetchedAt = FINALIZED_AT,
): BaseTransactionObservation => ({
  schema_version: "cashloom.base-observation/1",
  state: "partial",
  transaction_hash: harness.transactionHash,
  observed_at: fetchedAt,
  quorum: {
    required_distinct_providers: "2",
    groups: [{
      evidence_hash: evidence.evidence_hash,
      provider_ids: ["base-a"],
      finalized_provider_ids: ["base-a"],
    }],
  },
  providers: [
    {
      provider_id: "base-a",
      state: "included",
      evidence,
      finality: {
        latest: { status: "confirmed" },
        safe: { status: "confirmed" },
        finalized: { status: "confirmed" },
      },
    },
    { provider_id: "base-b", state: "unavailable", error_code: "network_unavailable" },
  ],
  sightings: [includedSighting(evidence, "base-a", fetchedAt, "FINALIZED")],
});

const legacyPayment = (db: Database): {
  status: string;
  tx_hash: string | null;
  error: string | null;
} => db.query(
  "SELECT status, tx_hash, error FROM payments WHERE id=?",
).get(PAYMENT_ID) as { status: string; tx_hash: string | null; error: string | null };

const tableCount = (db: Database, table: string): number =>
  (db.query(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count;

const paymentJournalIds = (store: WalletKernelStore): string[] =>
  store.listJournalEntriesForReferencePrefix({ referenceIdPrefix: PAYMENT_ID })
    .map(({ id }) => id)
    .sort();

const legacyAmounts = (db: Database): string[] =>
  (db.query(
    "SELECT amount_minor FROM transactions WHERE account_id=? ORDER BY external_id",
  ).all(ACCOUNT_ID) as Array<{ amount_minor: string }>).map(({ amount_minor }) => amount_minor);

describe("Base reconciliation — finalized economic truth", () => {
  it("keeps NOT_FOUND nonterminal and never releases the signed nonce", async () => {
    const harness = await makeHarness();
    const { observer, reconciliation } = harness.service([notFoundObservation(harness)]);

    const result = await reconciliation.reconcilePayment(PAYMENT_ID);

    expect(observer.requests).toEqual([{
      signed_transaction: harness.signedTransaction,
      expected_transaction_hash: harness.transactionHash,
      payment: {
        asset: "ETH",
        from: signer.address,
        beneficiary: BENEFICIARY,
        amount_atomic: AMOUNT_ATOMIC,
      },
    }]);
    expect(result.check).toEqual({
      state: "pending",
      checked_at: FINALIZED_AT,
      available_providers: "2",
      unavailable_providers: "0",
    });
    expect(result.truth).toMatchObject({
      lifecycle_state: "submitted",
      legacy_status: "broadcast",
      visibility: "not_found",
      execution_result: null,
      security_level: null,
      canonicality: "unknown",
      actions: {
        reconcile: true,
        exact_rebroadcast: false,
        safe_to_create_new_payment: false,
      },
    });
    expect(harness.store.getReservation(RESERVATION_ID)?.state).toBe("CONSUMED");
    expect(harness.store.getExecution(EXECUTION_ID)?.state).toBe("submitted");
    expect(harness.store.listChainSightings({ intentId: PAYMENT_ID })).toHaveLength(2);
    expect(harness.store.listChainConsensus({ intentId: PAYMENT_ID })).toHaveLength(0);
    expect(harness.store.listReceiptsForIntent(PAYMENT_ID).map(({ kind }) => kind)).toEqual([
      "SUBMISSION",
    ]);
    expect(harness.store.listReconciliationLinksForIntent(PAYMENT_ID)).toHaveLength(0);
    expect(harness.store.listJournalEntriesForReferencePrefix({
      referenceIdPrefix: PAYMENT_ID,
    }).map(({ id }) => id)).toEqual([`journal.${PAYMENT_ID}.submitted`]);
  });

  it("keeps one-provider finalized evidence nonterminal and explicitly checkable", async () => {
    const harness = await makeHarness();
    const evidence = coreEvidence(harness, { hashSeed: "d" });
    const { reconciliation } = harness.service([
      singleProviderFinalizedObservation(harness, evidence),
    ]);

    const result = await reconciliation.reconcilePayment(PAYMENT_ID);

    expect(result.check).toEqual({
      state: "partial",
      checked_at: FINALIZED_AT,
      available_providers: "1",
      unavailable_providers: "1",
    });
    expect(result.truth).toMatchObject({
      lifecycle_state: "submitted",
      visibility: "included",
      execution_result: "success",
      security_level: "finalized",
      canonicality: "unknown",
      evidence: {
        receipt_id: null,
        evidence_hash: evidence.evidence_hash,
        provider_ids: ["base-a"],
        quorum: null,
      },
      actions: {
        reconcile: true,
        safe_to_create_new_payment: false,
      },
    });
    expect(harness.store.listChainConsensus({ intentId: PAYMENT_ID })).toHaveLength(0);
    expect(harness.store.listReceiptsForIntent(PAYMENT_ID).map(({ kind }) => kind)).toEqual([
      "SUBMISSION",
    ]);
    expect(harness.store.getExecution(EXECUTION_ID)?.state).toBe("submitted");
    expect(harness.store.getReservation(RESERVATION_ID)?.state).toBe("CONSUMED");
  });

  it("refuses a non-consensus sighting whose body does not match its evidence hash", async () => {
    const harness = await makeHarness();
    const evidence = coreEvidence(harness, { hashSeed: "e" });
    const valid = singleProviderFinalizedObservation(harness, evidence);
    const sighting = valid.sightings[0]!;
    const malformed: BaseTransactionObservation = {
      ...valid,
      sightings: [{
        ...sighting,
        body: {
          schema_version: "cashloom.base-included-sighting/2",
          evidence: {
            ...evidence,
            economic_effect: { ...evidence.economic_effect, amount_atomic: "1" },
          },
          security_level: "FINALIZED",
        } as unknown as JsonValue,
      }],
    };
    const { reconciliation } = harness.service([malformed]);

    await expect(reconciliation.reconcilePayment(PAYMENT_ID)).rejects.toThrow(
      /does not authenticate its evidence body/i,
    );
    expect(harness.store.listChainSightings({ intentId: PAYMENT_ID })).toHaveLength(0);
    expect(harness.store.listChainConsensus({ intentId: PAYMENT_ID })).toHaveLength(0);
    expect(harness.store.listReceiptsForIntent(PAYMENT_ID).map(({ kind }) => kind)).toEqual([
      "SUBMISSION",
    ]);
  });

  it("settles finalized ETH once with exact three-part fees and audit links", async () => {
    const harness = await makeHarness();
    const evidence = coreEvidence(harness);
    const observation = finalizedObservation(harness, evidence);
    const { reconciliation } = harness.service([observation, observation]);

    const first = await reconciliation.reconcilePayment(PAYMENT_ID);
    const second = await reconciliation.reconcilePayment(PAYMENT_ID);

    expect(first.truth).toMatchObject({
      lifecycle_state: "settled",
      legacy_status: "settled",
      network_tx_id: harness.transactionHash,
      visibility: "included",
      execution_result: "success",
      security_level: "finalized",
      canonicality: "canonical",
      block: { number: BLOCK_NUMBER, hash: BLOCK_HASH },
      fee: {
        asset: BASE_ETH_ASSET_ID,
        l2_execution_atomic: L2_FEE,
        l1_data_security_atomic: NORMAL_L1_FEE,
        operator_atomic: NORMAL_OPERATOR_FEE,
        total_atomic: NORMAL_TOTAL_FEE,
        completeness: "exact",
        budget_atomic: QUOTED_TOTAL.toString(),
        budget_exceeded: false,
      },
      actions: {
        reconcile: false,
        exact_rebroadcast: false,
        safe_to_create_new_payment: true,
      },
    });
    expect(second.truth).toEqual(first.truth);
    expect(legacyPayment(harness.db)).toEqual({
      status: "settled",
      tx_hash: harness.transactionHash,
      error: null,
    });
    expect(harness.store.getPaymentIntent(PAYMENT_ID)?.state).toBe("settled");
    expect(harness.store.getExecution(EXECUTION_ID)).toMatchObject({
      state: "succeeded",
      networkTxId: harness.transactionHash,
    });
    expect(harness.store.getReservation(RESERVATION_ID)?.state).toBe("CONSUMED");

    const journals = harness.store.listJournalEntriesForReferencePrefix({
      referenceIdPrefix: PAYMENT_ID,
    });
    expect(journals.map(({ id }) => id).sort()).toEqual([
      `journal.${PAYMENT_ID}.base-finalized.fee`,
      `journal.${PAYMENT_ID}.submitted`,
    ].sort());
    const feeJournal = journals.find(({ id }) => id.endsWith(".base-finalized.fee"))!;
    expect(feeJournal.postings.map((posting) => ({
      ledger: posting.ledgerAccountId,
      asset: posting.assetId,
      direction: posting.direction,
      amount: posting.amountAtomic,
    }))).toEqual([
      {
        ledger: CLEARING_LEDGER_ID,
        asset: BASE_ETH_ASSET_ID,
        direction: "DEBIT",
        amount: NORMAL_TOTAL_FEE,
      },
      {
        ledger: ASSET_LEDGER_ID,
        asset: BASE_ETH_ASSET_ID,
        direction: "CREDIT",
        amount: NORMAL_TOTAL_FEE,
      },
    ]);

    const receipts = harness.store.listReceiptsForIntent(PAYMENT_ID);
    expect(receipts.map(({ kind }) => kind).sort()).toEqual([
      "BASE_FINALIZED_SUCCESS",
      "SUBMISSION",
    ]);
    const finalizedReceipt = receipts.find(({ kind }) => kind === "BASE_FINALIZED_SUCCESS")!;
    expect(finalizedReceipt.body).toMatchObject({
      outcome: "success",
      economic_effect: { amount_atomic: AMOUNT_ATOMIC },
      fee: {
        gas_used: GAS_USED,
        effective_gas_price_wei: EFFECTIVE_GAS_PRICE,
        l2_execution_fee_wei: L2_FEE,
        l1_data_fee_wei: NORMAL_L1_FEE,
        operator_fee_wei: NORMAL_OPERATOR_FEE,
        total_fee_wei: NORMAL_TOTAL_FEE,
        quoted_budget_atomic: QUOTED_TOTAL.toString(),
        budget_exceeded: false,
      },
      proof: {
        provider_ids: ["base-a", "base-b"],
        quorum: "2",
        evidence_hash: evidence.evidence_hash,
      },
    });
    expect(harness.store.listObservationsForIntent(PAYMENT_ID)).toHaveLength(1);
    expect(harness.store.listReconciliationLinksForIntent(PAYMENT_ID)).toHaveLength(1);
    expect(harness.store.listChainSightings({ intentId: PAYMENT_ID })).toHaveLength(2);
    expect(harness.store.listChainConsensus({ intentId: PAYMENT_ID })).toHaveLength(1);
    expect(tableCount(harness.db, "transactions")).toBe(1);
  });

  it("charges a finalized revert fee, reverses only the submitted value, and consumes no nonce twice", async () => {
    const harness = await makeHarness();
    const evidence = coreEvidence(harness, { outcome: "reverted", hashSeed: "5" });
    const { reconciliation } = harness.service([finalizedObservation(harness, evidence)]);

    const result = await reconciliation.reconcilePayment(PAYMENT_ID);

    expect(result.truth).toMatchObject({
      lifecycle_state: "failed",
      legacy_status: "failed",
      execution_result: "reverted",
      security_level: "finalized",
      canonicality: "canonical",
      fee: {
        total_atomic: NORMAL_TOTAL_FEE,
        completeness: "exact",
        budget_exceeded: false,
      },
    });
    expect(legacyPayment(harness.db)).toMatchObject({
      status: "failed",
      tx_hash: harness.transactionHash,
    });
    expect(legacyPayment(harness.db).error).toContain("transfer value was reversed");
    expect(harness.store.getExecution(EXECUTION_ID)).toMatchObject({
      state: "failed",
      errorCode: "BASE_EXECUTION_REVERTED",
    });
    expect(harness.store.getReservation(RESERVATION_ID)).toMatchObject({
      state: "CONSUMED",
      version: 1,
    });
    expect(harness.store.listReceiptsForIntent(PAYMENT_ID).map(({ kind }) => kind).sort()).toEqual([
      "BASE_FINALIZED_REVERTED",
      "SUBMISSION",
    ]);
    expect(harness.store.listJournalEntriesForReferencePrefix({
      referenceIdPrefix: PAYMENT_ID,
    }).map(({ id }) => id).sort()).toEqual([
      `journal.${PAYMENT_ID}.base-finalized.fee`,
      `journal.${PAYMENT_ID}.base-finalized.reversal`,
      `journal.${PAYMENT_ID}.submitted`,
    ].sort());
    const reversal = harness.store.getJournalEntry(
      `journal.${PAYMENT_ID}.base-finalized.reversal`,
    )!;
    expect(reversal.postings.map(({ direction, amountAtomic, ledgerAccountId }) => ({
      direction,
      amountAtomic,
      ledgerAccountId,
    }))).toEqual([
      { direction: "DEBIT", amountAtomic: AMOUNT_ATOMIC, ledgerAccountId: ASSET_LEDGER_ID },
      { direction: "CREDIT", amountAtomic: AMOUNT_ATOMIC, ledgerAccountId: CLEARING_LEDGER_ID },
    ]);
    expect(harness.db.query(
      "SELECT external_id, amount_minor FROM transactions WHERE account_id=? ORDER BY amount_minor",
    ).all(ACCOUNT_ID)).toEqual([
      { external_id: harness.transactionHash, amount_minor: `-${AMOUNT_ATOMIC}` },
      {
        external_id: `${harness.transactionHash}:cashloom-reversal`,
        amount_minor: AMOUNT_ATOMIC,
      },
    ]);
  });

  it("records exact finalized truth even when the protocol fee exceeds its quote budget", async () => {
    const harness = await makeHarness();
    const evidence = coreEvidence(harness, {
      hashSeed: "6",
      l1Fee: "200000000000000000000",
      operatorFee: "20000000000000000000",
    });
    expect(BigInt(evidence.fees.total_fee_wei)).toBeGreaterThan(QUOTED_TOTAL);
    const { reconciliation } = harness.service([finalizedObservation(harness, evidence)]);

    const result = await reconciliation.reconcilePayment(PAYMENT_ID);

    expect(result.truth.fee).toEqual({
      asset: BASE_ETH_ASSET_ID,
      l2_execution_atomic: L2_FEE,
      l1_data_security_atomic: "200000000000000000000",
      operator_atomic: "20000000000000000000",
      total_atomic: evidence.fees.total_fee_wei,
      completeness: "exact",
      budget_atomic: QUOTED_TOTAL.toString(),
      budget_exceeded: true,
    });
    expect(harness.store.getJournalEntry(
      `journal.${PAYMENT_ID}.base-finalized.fee`,
    )?.postings.every(({ amountAtomic }) => amountAtomic === evidence.fees.total_fee_wei)).toBe(true);
    const receipt = harness.store.listReceiptsForIntent(PAYMENT_ID)
      .find(({ kind }) => kind === "BASE_FINALIZED_SUCCESS")!;
    expect(receipt.body).toMatchObject({
      fee: {
        quoted_budget_atomic: QUOTED_TOTAL.toString(),
        total_fee_wei: evidence.fees.total_fee_wei,
        budget_exceeded: true,
        truth_policy: "record_exact_chain_fee_even_when_quote_budget_is_exceeded",
      },
    });
    expect(harness.store.getPaymentIntent(PAYMENT_ID)?.state).toBe("settled");
  });

  it("preserves the first economic event when later finalized providers conflict", async () => {
    const harness = await makeHarness();
    const firstEvidence = coreEvidence(harness, { hashSeed: "7" });
    const conflictingEvidence = coreEvidence(harness, {
      outcome: "reverted",
      hashSeed: "8",
      blockHash: OTHER_BLOCK_HASH,
      blockNumber: (BigInt(BLOCK_NUMBER) + 1n).toString(),
      l1Fee: "300000000000000000000",
      operatorFee: "30000000000000000000",
    });
    const { reconciliation } = harness.service([
      // Commit the first economic fact with a later evidence clock. The
      // conflicting call arrives second but claims an earlier decided_at, so
      // projection must follow the receipt—not timestamp sort order.
      finalizedObservation(harness, firstEvidence, "2026-08-23T00:20:00.000Z"),
      finalizedObservation(harness, conflictingEvidence, FINALIZED_AT),
    ]);

    const first = await reconciliation.reconcilePayment(PAYMENT_ID);
    expect(first.truth.canonicality).toBe("canonical");
    const firstFinalReceipt = harness.store.listReceiptsForIntent(PAYMENT_ID)
      .find(({ kind }) => kind === "BASE_FINALIZED_SUCCESS")!;
    const firstFeeFingerprint = harness.store.getJournalEntry(
      `journal.${PAYMENT_ID}.base-finalized.fee`,
    )!.entryFingerprint;

    const conflict = await reconciliation.reconcilePayment(PAYMENT_ID);

    expect(conflict.truth).toMatchObject({
      canonicality: "conflicted",
      lifecycle_state: "settled",
      legacy_status: "settled",
      execution_result: "success",
      block: { number: BLOCK_NUMBER, hash: BLOCK_HASH },
      fee: { total_atomic: firstEvidence.fees.total_fee_wei },
      evidence: {
        receipt_id: firstFinalReceipt.id,
        evidence_hash: firstEvidence.evidence_hash,
      },
    });
    expect(conflict.truth.actions.safe_to_create_new_payment).toBe(false);
    expect(harness.store.listChainConsensus({ intentId: PAYMENT_ID })).toHaveLength(2);
    expect(harness.store.listChainSightings({ intentId: PAYMENT_ID })).toHaveLength(4);
    expect(harness.store.listReceiptsForIntent(PAYMENT_ID).map(({ kind }) => kind).sort()).toEqual([
      "BASE_FINALIZED_SUCCESS",
      "SUBMISSION",
    ]);
    expect(harness.store.listReceiptsForIntent(PAYMENT_ID)
      .find(({ kind }) => kind === "BASE_FINALIZED_SUCCESS")).toEqual(firstFinalReceipt);
    expect(harness.store.getJournalEntry(
      `journal.${PAYMENT_ID}.base-finalized.fee`,
    )?.entryFingerprint).toBe(firstFeeFingerprint);
    expect(harness.store.getJournalEntry(
      `journal.${PAYMENT_ID}.base-finalized.reversal`,
    )).toBeNull();
    expect(harness.store.getExecution(EXECUTION_ID)?.state).toBe("succeeded");
    expect(legacyPayment(harness.db).status).toBe("settled");
  });

  it("rolls finalized consensus and lifecycle back atomically when journal posting crashes", async () => {
    const harness = await makeHarness();
    const evidence = coreEvidence(harness, { hashSeed: "9" });
    const observation = finalizedObservation(harness, evidence);
    const { reconciliation } = harness.service([observation, observation]);
    harness.db.exec(`
      CREATE TRIGGER inject_base_finalized_fee_failure
      BEFORE INSERT ON wk_journal_entries
      WHEN NEW.id = 'journal.${PAYMENT_ID}.base-finalized.fee'
      BEGIN
        SELECT RAISE(ABORT, 'injected finalized journal crash');
      END;
    `);

    await expect(reconciliation.reconcilePayment(PAYMENT_ID)).rejects.toThrow(
      /injected finalized journal crash/,
    );

    expect(harness.store.listChainSightings({ intentId: PAYMENT_ID })).toHaveLength(0);
    expect(harness.store.listChainConsensus({ intentId: PAYMENT_ID })).toHaveLength(0);
    expect(harness.store.listReceiptsForIntent(PAYMENT_ID).map(({ kind }) => kind)).toEqual([
      "SUBMISSION",
    ]);
    expect(tableCount(harness.db, "wk_observations")).toBe(0);
    expect(harness.store.listReconciliationLinksForIntent(PAYMENT_ID)).toHaveLength(0);
    expect(harness.store.listJournalEntriesForReferencePrefix({
      referenceIdPrefix: PAYMENT_ID,
    }).map(({ id }) => id)).toEqual([`journal.${PAYMENT_ID}.submitted`]);
    expect(harness.store.getPaymentIntent(PAYMENT_ID)?.state).toBe("submitted");
    expect(harness.store.getExecution(EXECUTION_ID)?.state).toBe("submitted");
    expect(legacyPayment(harness.db).status).toBe("broadcast");
    expect(harness.store.getReservation(RESERVATION_ID)?.state).toBe("CONSUMED");

    harness.db.exec("DROP TRIGGER inject_base_finalized_fee_failure");
    await expect(reconciliation.reconcilePayment(PAYMENT_ID)).resolves.toMatchObject({
      truth: { lifecycle_state: "settled", canonicality: "canonical" },
    });
  });

  it("repairs an ambiguous success with no local submission projection exactly once", async () => {
    const harness = await makeHarness({ executionState: "ambiguous" });
    expect(paymentJournalIds(harness.store)).toEqual([]);
    expect(tableCount(harness.db, "transactions")).toBe(0);
    const evidence = coreEvidence(harness, { hashSeed: "a" });
    const observation = finalizedObservation(harness, evidence);
    const { reconciliation } = harness.service([observation, observation]);

    const first = await reconciliation.reconcilePayment(PAYMENT_ID);
    const replay = await reconciliation.reconcilePayment(PAYMENT_ID);

    expect(first.truth).toMatchObject({
      lifecycle_state: "settled",
      legacy_status: "settled",
      execution_result: "success",
      canonicality: "canonical",
      fee: { total_atomic: NORMAL_TOTAL_FEE, completeness: "exact" },
    });
    expect(replay.truth).toEqual(first.truth);
    expect(paymentJournalIds(harness.store)).toEqual([
      `journal.${PAYMENT_ID}.base-finalized.fee`,
      `journal.${PAYMENT_ID}.submitted`,
    ].sort());
    expect(harness.store.getJournalEntry(`journal.${PAYMENT_ID}.submitted`)?.postings.map(
      ({ ledgerAccountId, direction, amountAtomic }) => ({
        ledgerAccountId,
        direction,
        amountAtomic,
      }),
    )).toEqual([
      {
        ledgerAccountId: CLEARING_LEDGER_ID,
        direction: "DEBIT",
        amountAtomic: AMOUNT_ATOMIC,
      },
      {
        ledgerAccountId: ASSET_LEDGER_ID,
        direction: "CREDIT",
        amountAtomic: AMOUNT_ATOMIC,
      },
    ]);
    expect(harness.store.getJournalEntry(
      `journal.${PAYMENT_ID}.base-finalized.fee`,
    )?.postings.every(({ amountAtomic }) => amountAtomic === NORMAL_TOTAL_FEE)).toBe(true);
    expect(legacyAmounts(harness.db)).toEqual([`-${AMOUNT_ATOMIC}`]);
    expect(harness.store.getExecution(EXECUTION_ID)?.state).toBe("succeeded");
    expect(harness.store.getReservation(RESERVATION_ID)?.state).toBe("CONSUMED");
  });

  it("projects an ambiguous revert as transfer plus reversal with no phantom legacy value", async () => {
    const harness = await makeHarness({ executionState: "ambiguous" });
    const evidence = coreEvidence(harness, { outcome: "reverted", hashSeed: "b" });
    const { reconciliation } = harness.service([finalizedObservation(harness, evidence)]);

    const result = await reconciliation.reconcilePayment(PAYMENT_ID);

    expect(result.truth).toMatchObject({
      lifecycle_state: "failed",
      legacy_status: "failed",
      execution_result: "reverted",
      canonicality: "canonical",
      fee: { total_atomic: NORMAL_TOTAL_FEE, completeness: "exact" },
    });
    expect(paymentJournalIds(harness.store)).toEqual([
      `journal.${PAYMENT_ID}.base-finalized.fee`,
      `journal.${PAYMENT_ID}.base-finalized.reversal`,
      `journal.${PAYMENT_ID}.submitted`,
    ].sort());
    const transfer = harness.store.getJournalEntry(`journal.${PAYMENT_ID}.submitted`)!;
    const reversal = harness.store.getJournalEntry(
      `journal.${PAYMENT_ID}.base-finalized.reversal`,
    )!;
    expect(transfer.postings.map(({ ledgerAccountId, direction, amountAtomic }) => ({
      ledgerAccountId,
      direction,
      amountAtomic,
    }))).toEqual([
      { ledgerAccountId: CLEARING_LEDGER_ID, direction: "DEBIT", amountAtomic: AMOUNT_ATOMIC },
      { ledgerAccountId: ASSET_LEDGER_ID, direction: "CREDIT", amountAtomic: AMOUNT_ATOMIC },
    ]);
    expect(reversal.postings.map(({ ledgerAccountId, direction, amountAtomic }) => ({
      ledgerAccountId,
      direction,
      amountAtomic,
    }))).toEqual([
      { ledgerAccountId: ASSET_LEDGER_ID, direction: "DEBIT", amountAtomic: AMOUNT_ATOMIC },
      { ledgerAccountId: CLEARING_LEDGER_ID, direction: "CREDIT", amountAtomic: AMOUNT_ATOMIC },
    ]);
    const amounts = legacyAmounts(harness.db);
    expect(amounts.sort()).toEqual([`-${AMOUNT_ATOMIC}`, AMOUNT_ATOMIC].sort());
    expect(amounts.reduce((sum, amount) => sum + BigInt(amount), 0n)).toBe(0n);
    expect(harness.store.getReservation(RESERVATION_ID)?.state).toBe("CONSUMED");
  });

  it("settles a signed artifact when broadcast succeeded before local submission projection", async () => {
    const harness = await makeHarness({ executionState: "signed" });
    expect(legacyPayment(harness.db)).toMatchObject({ status: "confirmed", tx_hash: null });
    expect(paymentJournalIds(harness.store)).toEqual([]);
    const evidence = coreEvidence(harness, { hashSeed: "c" });
    const { reconciliation } = harness.service([finalizedObservation(harness, evidence)]);

    const result = await reconciliation.reconcilePayment(PAYMENT_ID);

    expect(result.truth).toMatchObject({
      lifecycle_state: "settled",
      legacy_status: "settled",
      network_tx_id: harness.transactionHash,
      execution_result: "success",
      canonicality: "canonical",
    });
    expect(harness.store.getExecution(EXECUTION_ID)).toMatchObject({
      state: "succeeded",
      networkTxId: harness.transactionHash,
    });
    expect(paymentJournalIds(harness.store)).toEqual([
      `journal.${PAYMENT_ID}.base-finalized.fee`,
      `journal.${PAYMENT_ID}.submitted`,
    ].sort());
    expect(legacyAmounts(harness.db)).toEqual([`-${AMOUNT_ATOMIC}`]);
  });

  it("persists finalized chain accounting even when the artifact-bound local execution already failed", async () => {
    const harness = await makeHarness({ executionState: "failed" });
    const evidence = coreEvidence(harness, { hashSeed: "d" });
    const { reconciliation } = harness.service([finalizedObservation(harness, evidence)]);

    const result = await reconciliation.reconcilePayment(PAYMENT_ID);

    expect(result.truth).toMatchObject({
      lifecycle_state: "failed",
      legacy_status: "settled",
      visibility: "included",
      execution_result: "success",
      security_level: "finalized",
      canonicality: "canonical",
      fee: { total_atomic: NORMAL_TOTAL_FEE, completeness: "exact" },
    });
    expect(harness.store.getExecution(EXECUTION_ID)?.state).toBe("failed");
    expect(harness.store.getPaymentIntent(PAYMENT_ID)?.state).toBe("failed");
    expect(harness.store.listChainConsensus({ intentId: PAYMENT_ID })).toHaveLength(1);
    expect(harness.store.listReceiptsForIntent(PAYMENT_ID).map(({ kind }) => kind)).toContain(
      "BASE_FINALIZED_SUCCESS",
    );
    expect(paymentJournalIds(harness.store)).toEqual([
      `journal.${PAYMENT_ID}.base-finalized.fee`,
      `journal.${PAYMENT_ID}.submitted`,
    ].sort());
    expect(legacyAmounts(harness.db)).toEqual([`-${AMOUNT_ATOMIC}`]);
    expect(harness.store.getReservation(RESERVATION_ID)?.state).toBe("CONSUMED");
  });

  it("refuses malformed consensus bindings and fee arithmetic without persisting partial facts", async () => {
    const malformed = [
      (harness: Harness): BaseTransactionObservation => {
        const evidence = coreEvidence(harness, { hashSeed: "e" });
        const other = coreEvidence(harness, {
          hashSeed: "f",
          blockHash: OTHER_BLOCK_HASH,
          blockNumber: (BigInt(BLOCK_NUMBER) + 1n).toString(),
        });
        const observation = finalizedObservation(harness, evidence);
        return {
          ...observation,
          consensus: { ...observation.consensus!, body: other },
        };
      },
      (harness: Harness): BaseTransactionObservation => {
        const evidence = coreEvidence(harness, { hashSeed: "1" });
        const observation = finalizedObservation(harness, evidence);
        return {
          ...observation,
          consensus: {
            ...observation.consensus!,
            evidence_hash: `sha256:${"f".repeat(64)}`,
          },
        };
      },
      (harness: Harness): BaseTransactionObservation => {
        const evidence = {
          ...coreEvidence(harness, { hashSeed: "2" }),
          evidence_hash: `sha256:${"0".repeat(64)}` as const,
        };
        return finalizedObservation(harness, evidence);
      },
      (harness: Harness): BaseTransactionObservation => {
        const valid = coreEvidence(harness, { hashSeed: "3" });
        const { evidence_hash: _ignored, ...core } = valid;
        const evidence = canonicalEvidence({
          ...core,
          fees: {
            ...core.fees,
            total_fee_wei: (BigInt(core.fees.total_fee_wei) + 1n).toString(),
          },
        });
        return finalizedObservation(harness, evidence);
      },
    ];

    for (const makeMalformed of malformed) {
      const harness = await makeHarness({ executionState: "ambiguous" });
      const { observer, reconciliation } = harness.service([makeMalformed(harness)]);

      await expect(reconciliation.reconcilePayment(PAYMENT_ID)).rejects.toThrow();

      // This must be a reconciliation-boundary rejection, not an early refusal
      // caused by the deliberately absent legacy tx_hash projection.
      expect(observer.requests).toHaveLength(1);
      expect(harness.store.listChainSightings({ intentId: PAYMENT_ID })).toHaveLength(0);
      expect(harness.store.listChainConsensus({ intentId: PAYMENT_ID })).toHaveLength(0);
      expect(harness.store.listReceiptsForIntent(PAYMENT_ID)).toHaveLength(0);
      expect(harness.store.listReconciliationLinksForIntent(PAYMENT_ID)).toHaveLength(0);
      expect(paymentJournalIds(harness.store)).toEqual([]);
      expect(tableCount(harness.db, "transactions")).toBe(0);
      expect(harness.store.getExecution(EXECUTION_ID)?.state).toBe("ambiguous");
      expect(harness.store.getPaymentIntent(PAYMENT_ID)?.state).toBe("ambiguous");
      expect(legacyPayment(harness.db)).toMatchObject({ status: "confirmed", tx_hash: null });
      expect(harness.store.getReservation(RESERVATION_ID)?.state).toBe("CONSUMED");
    }
  });

  it("treats absence after inclusion as uncertainty and makes an INCLUDED recurrence current", async () => {
    const harness = await makeHarness();
    const evidence = coreEvidence(harness, { hashSeed: "4" });
    const firstIncludedAt = "2026-08-23T00:05:00.000Z";
    const absentAt = "2026-08-23T00:15:00.000Z";
    const recurredAt = "2026-08-23T00:25:00.000Z";
    const { reconciliation } = harness.service([
      includedNonfinalObservation(harness, evidence, firstIncludedAt),
      notFoundObservation(harness, absentAt),
      includedNonfinalObservation(harness, evidence, recurredAt),
    ]);

    const included = await reconciliation.reconcilePayment(PAYMENT_ID);
    expect(included.truth).toMatchObject({
      visibility: "included",
      canonicality: "canonical",
      security_level: "unsafe",
      checked_at: firstIncludedAt,
    });

    const absent = await reconciliation.reconcilePayment(PAYMENT_ID);
    expect(absent.truth).toMatchObject({
      visibility: "not_found",
      canonicality: "unknown",
      security_level: null,
      checked_at: absentAt,
    });
    expect(absent.truth.canonicality).not.toBe("reorged");

    const recurred = await reconciliation.reconcilePayment(PAYMENT_ID);
    expect(recurred.truth).toMatchObject({
      visibility: "included",
      canonicality: "canonical",
      security_level: "unsafe",
      checked_at: recurredAt,
      block: { number: BLOCK_NUMBER, hash: BLOCK_HASH },
    });
    expect(harness.store.getPaymentIntent(PAYMENT_ID)?.state).toBe("submitted");
    expect(harness.store.getReservation(RESERVATION_ID)?.state).toBe("CONSUMED");
  });
});
