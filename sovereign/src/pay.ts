/**
 * Wallet Kernel v2 compatibility facade.
 *
 * The public v1 rite remains quote -> confirm, while each quote is persisted
 * as an asset-qualified intent with reservations, a one-shot authorization,
 * execution evidence, and balanced postings. Existing UUIDs stay stable.
 */

import { db, newId } from "./db.ts";
import { btcSender } from "./senders/btc.sender.ts";
import { evmSender, parsePreparedEvmQuote } from "./senders/evm.sender.ts";
import {
  AmbiguousBroadcastError,
  type PaymentInstruction,
  type PaymentFeeTerms,
  type PaymentReceipt,
  type PaymentReservationClaim,
  type PaymentSender,
  type SignedTransactionEnvelope,
} from "./senders/types.ts";
import type { SigningBinding } from "./vault.ts";
import {
  canTransition,
  canonicalizeJson,
  createPaymentIntentV1,
  cryptoAccountRef,
  cryptoAssetRef,
  nonNegativeMoney,
  positiveMoney,
  type PaymentLifecycleState,
} from "./wallet/domain/index.ts";
import {
  fingerprintRequest,
  WalletKernelStore,
  type Actor,
  type JsonValue,
  type PaymentIntentRecord,
  type SignedArtifactRecord,
} from "./wallet/infrastructure/sqlite/index.ts";
import { createBaseEvidenceObserver } from "./wallet/adapters/base-observer.ts";
import {
  createBaseReconciliationService,
  type PaymentTruthV1,
} from "./wallet/base-reconciler.ts";

const SENDERS: PaymentSender[] = [evmSender, btcSender];
const QUOTE_TTL_MS = 5 * 60 * 1000;
const LOCAL_WALLET_ID = "wallet.local-default";
const LOCAL_ACTOR = { type: "human", ref: "local-owner" } as const;
const BITCOIN_CHAIN = "bip122:000000000019d6689c085ae165831e93";
const BITCOIN_ASSET = `${BITCOIN_CHAIN}/slip44:0`;
const BASE_CHAIN = "eip155:8453";
const BASE_ETH_ASSET = `${BASE_CHAIN}/slip44:60`;
const BASE_USDC_ADDRESS = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
const BASE_USDC_ASSET = `${BASE_CHAIN}/erc20:${BASE_USDC_ADDRESS}`;
const store = new WalletKernelStore(db);
const baseReconciliation = createBaseReconciliationService({
  db,
  store,
  observer: createBaseEvidenceObserver(),
});

const sha256Id = (value: unknown): `sha256:${string}` =>
  `sha256:${fingerprintRequest(value)}`;

const senderForAsset = (asset: string): PaymentSender => {
  const normalized = asset.trim().toUpperCase();
  const sender = SENDERS.find((candidate) => candidate.assets.includes(normalized));
  if (!sender) {
    throw new Error(
      `No sender for asset "${asset}". Available: ${SENDERS.flatMap((candidate) => candidate.assets).join(", ")}.`,
    );
  }
  return sender;
};

interface AccountRow {
  id: string;
  rail: string;
  connector_type: string | null;
  display_name: string;
  currency: string;
  decimals: number;
  balance_minor: string;
  external_account_id: string | null;
  chain_id: string | null;
  asset_id: string | null;
  account_ref: string | null;
  vault_key_id: string | null;
}

const sendingAccount = (accountId: string): AccountRow => {
  const row = db.query(
    `SELECT id, rail, connector_type, display_name, currency, decimals,
            balance_minor, external_account_id, chain_id, asset_id, account_ref, vault_key_id
     FROM accounts WHERE id=? AND status='ACTIVE'`,
  ).get(accountId) as AccountRow | null;
  if (!row) throw new Error(`No active account ${accountId}`);
  if (!row.vault_key_id) {
    throw new Error(
      `Account "${row.display_name}" has no local signing key — only key-backed accounts can send.`,
    );
  }
  return row;
};

interface ResolvedPaymentContext {
  account: AccountRow;
  sender: PaymentSender;
  assetSymbol: "BTC" | "ETH" | "USDC";
  chainId: string;
  accountId: string;
  assetId: string;
  assetName: string;
  assetDecimals: number;
  destinationAccountId(address: string): string;
  feeAssetId: string;
  keyId: string;
  publicAddress: string;
  assetLedgerId: string;
  feeLedgerId: string;
  clearingLedgerId: string;
}

const resolvePaymentContext = (
  account: AccountRow,
  sender: PaymentSender,
  requestedAsset: string,
): ResolvedPaymentContext => {
  const asset = requestedAsset.trim().toUpperCase();
  if (account.rail !== "CRYPTO") {
    throw new Error(`Account "${account.display_name}" is ${account.rail}, not a crypto payment account.`);
  }
  if (account.currency.trim().toUpperCase() !== asset) {
    throw new Error(
      `Account "${account.display_name}" holds ${account.currency}; it cannot send ${asset}. Choose the matching asset position.`,
    );
  }
  const key = db.query("SELECT kind, address FROM vault_keys WHERE id=?").get(account.vault_key_id!) as
    | { kind: string; address: string | null }
    | null;
  if (!key?.address) throw new Error(`No usable vault key ${account.vault_key_id}`);
  const common = {
    account,
    sender,
    keyId: account.vault_key_id!,
    publicAddress: key.address,
    assetLedgerId: `ledger.asset.${account.id}`,
    clearingLedgerId: "ledger.clearing.payments",
  };
  if (sender.type === "btc") {
    if (asset !== "BTC" || key.kind !== "btc" || account.decimals !== 8) {
      throw new Error("Bitcoin payments require a BTC/8 account backed by a Bitcoin vault key.");
    }
    const explicitBitcoinIdentity =
      account.chain_id === BITCOIN_CHAIN &&
      account.asset_id === BITCOIN_ASSET &&
      account.account_ref === `${BITCOIN_CHAIN}:${key.address}` &&
      (account.connector_type?.toLowerCase() !== "esplora" ||
        account.external_account_id === key.address);
    const safelyMappedLegacyEsplora =
      account.chain_id === null &&
      account.asset_id === null &&
      account.account_ref === null &&
      account.connector_type?.toLowerCase() === "esplora" &&
      account.external_account_id === key.address;
    if (!explicitBitcoinIdentity && !safelyMappedLegacyEsplora) {
      throw new Error(
        "Bitcoin sending requires explicit matching CAIP-2, CAIP-19, and CAIP-10 account identity (legacy Esplora accounts are the only safe automatic mapping).",
      );
    }
    return {
      ...common,
      assetSymbol: "BTC",
      chainId: BITCOIN_CHAIN,
      accountId: `${BITCOIN_CHAIN}:${key.address}`,
      assetId: BITCOIN_ASSET,
      assetName: "Bitcoin",
      assetDecimals: 8,
      destinationAccountId: (address) => `${BITCOIN_CHAIN}:${address}`,
      feeAssetId: BITCOIN_ASSET,
      feeLedgerId: `ledger.asset.${account.id}`,
    };
  }
  if (sender.type !== "evm-base" || key.kind !== "evm") {
    throw new Error("This account and sender do not share a compatible signing key type.");
  }
  if (account.connector_type?.toLowerCase() === "alchemy") {
    throw new Error(
      "This legacy account reads Ethereum mainnet but writes on Base. Split it into explicit Ethereum and Base accounts before sending.",
    );
  }
  const isUsdc = asset === "USDC";
  const expectedDecimals = isUsdc ? 6 : 18;
  if ((asset !== "ETH" && !isUsdc) || account.decimals !== expectedDecimals) {
    throw new Error(`Base ${asset} payments require an exact ${asset}/${expectedDecimals} account position.`);
  }
  const expectedAssetId = isUsdc ? BASE_USDC_ASSET : BASE_ETH_ASSET;
  const expectedAccountRef = `${BASE_CHAIN}:${key.address.toLowerCase()}`;
  if (
    account.chain_id !== BASE_CHAIN ||
    account.asset_id?.toLowerCase() !== expectedAssetId ||
    account.account_ref?.toLowerCase() !== expectedAccountRef
  ) {
    throw new Error(
      "EVM sending will not guess a chain from an address. This position must explicitly match Base CAIP-2, CAIP-19, and CAIP-10 identity.",
    );
  }
  return {
    ...common,
    assetSymbol: asset as "ETH" | "USDC",
    chainId: BASE_CHAIN,
    accountId: expectedAccountRef,
    assetId: expectedAssetId,
    assetName: isUsdc ? "USD Coin" : "Ether",
    assetDecimals: expectedDecimals,
    destinationAccountId: (address) => `${BASE_CHAIN}:${address.toLowerCase()}`,
    feeAssetId: BASE_ETH_ASSET,
    feeLedgerId: isUsdc
      ? `ledger.asset.${account.id}.${BASE_ETH_ASSET}`
      : `ledger.asset.${account.id}`,
  };
};

const ensureKernelProjection = (context: ResolvedPaymentContext): void => {
  const now = new Date().toISOString();
  store.putWallet({ id: LOCAL_WALLET_ID, label: "Local CashLoom wallet", ownerRef: LOCAL_ACTOR.ref });
  store.putAsset({
    id: context.assetId,
    instrumentId: context.assetSymbol,
    kind: context.assetSymbol === "USDC" ? "TOKEN" : "NATIVE",
    symbol: context.assetSymbol,
    name: context.assetName,
    decimals: context.assetDecimals,
    chainId: context.chainId,
    contractAddress: context.assetSymbol === "USDC" ? BASE_USDC_ADDRESS : null,
  });
  if (context.feeAssetId !== context.assetId) {
    store.putAsset({
      id: context.feeAssetId,
      instrumentId: "ETH",
      kind: "NATIVE",
      symbol: "ETH",
      name: "Ether",
      decimals: 18,
      chainId: BASE_CHAIN,
    });
  }
  store.putAccount({
    id: context.account.id,
    walletId: LOCAL_WALLET_ID,
    label: context.account.display_name,
    kind: "CHAIN_ACCOUNT",
    rail: context.sender.type,
    chainId: context.chainId,
    accountRef: context.accountId,
    address: context.publicAddress,
    custodyMode: "local_self_custody",
    metadata: { legacy_account_id: context.account.id, migration_status: "mapped_exactly" },
  });
  if (!db.query("SELECT 1 FROM wk_positions WHERE account_id=? AND asset_id=?").get(context.account.id, context.assetId)) {
    store.setPosition({
      accountId: context.account.id,
      assetId: context.assetId,
      observedAtomic: context.account.balance_minor,
      source: "legacy-account-projection",
    });
  }
  store.putLedgerAccount({
    id: context.assetLedgerId,
    walletId: LOCAL_WALLET_ID,
    externalAccountId: context.account.id,
    code: `asset:${context.account.id}:${context.assetId}`,
    name: `${context.account.display_name} · ${context.assetSymbol}`,
    kind: "ASSET",
  });
  if (context.feeLedgerId !== context.assetLedgerId) {
    store.putLedgerAccount({
      id: context.feeLedgerId,
      walletId: LOCAL_WALLET_ID,
      externalAccountId: context.account.id,
      code: `asset:${context.account.id}:${context.feeAssetId}`,
      name: `${context.account.display_name} · network fee asset`,
      kind: "ASSET",
    });
  }
  store.putLedgerAccount({
    id: context.clearingLedgerId,
    code: "clearing:payments",
    name: "Outbound payment clearing",
    kind: "CLEARING",
  });
  db.query(
    `INSERT INTO wk_signers
       (id, wallet_id, account_id, kind, public_ref, key_ref, capabilities_json,
        status, created_at, updated_at)
     VALUES (?, ?, ?, 'LOCAL_ISOLATED', ?, ?, ?, 'ACTIVE', ?, ?)
     ON CONFLICT(id) DO UPDATE SET account_id=excluded.account_id,
       public_ref=excluded.public_ref, key_ref=excluded.key_ref,
       capabilities_json=excluded.capabilities_json, status='ACTIVE', updated_at=excluded.updated_at`,
  ).run(
    `signer.${context.account.id}.${context.keyId}`,
    LOCAL_WALLET_ID,
    context.account.id,
    context.accountId,
    context.keyId,
    JSON.stringify({ chain_id: context.chainId, assets: [context.assetId] }),
    now,
    now,
  );
};

const quoteHashFor = (
  context: ResolvedPaymentContext,
  instruction: PaymentInstruction,
  feeMinor: string,
  feeAsset: string,
): `sha256:${string}` => sha256Id({
  schema: "cashloom.legacy-quote/1",
  rail: context.sender.type,
  account_id: context.account.id,
  chain_id: context.chainId,
  asset_id: context.assetId,
  destination: instruction.to,
  amount_atomic: instruction.amountMinor,
  fee_atomic: feeMinor,
  fee_asset: feeAsset,
  prepared_detail: instruction.detail ?? null,
});

interface PersistedFeePolicy {
  /** Present only when the rail really binds the complete fee maximum, or
   * for immutable legacy v1 intents whose hash must remain recoverable. */
  ceilingAtomic: string | null;
  budgetAtomic: string;
  terms: JsonValue;
}

const feePolicyFor = (
  context: ResolvedPaymentContext,
  instruction: PaymentInstruction,
  feeMinor: string,
  quotedTerms?: PaymentFeeTerms,
): PersistedFeePolicy => {
  if (context.sender.type !== "evm-base") {
    return {
      ceilingAtomic: feeMinor,
      budgetAtomic: feeMinor,
      terms: {
        classification: "complete_fee_ceiling",
        asset_id: context.feeAssetId,
        amount_atomic: feeMinor,
        total_is_hard_cap: true,
      },
    };
  }
  const prepared = parsePreparedEvmQuote(instruction);
  if (prepared.detail.v === 1) {
    // Preserve the already-hashed v1 intent shape for exact crash recovery.
    // The metadata corrects its scope: this value caps EIP-1559 execution,
    // not Base's separate L1/operator protocol charges.
    return {
      ceilingAtomic: feeMinor,
      budgetAtomic: feeMinor,
      terms: {
        classification: "legacy_execution_cap_only",
        asset_id: context.feeAssetId,
        hard_execution_cap_atomic: feeMinor,
        total_is_hard_cap: false,
        limitation: "Legacy v1 did not estimate Base L1 data/security or operator fees.",
      },
    };
  }
  const estimate = prepared.detail.feeEstimate;
  const terms = quotedTerms ?? {
    schema_version: "cashloom.payment-fee-terms/1" as const,
    hard_execution_cap_atomic: estimate.hardExecutionCapAtomic,
    estimated_l1_upper_bound_atomic: estimate.estimatedL1UpperBoundAtomic,
    estimated_operator_upper_bound_atomic: estimate.estimatedOperatorUpperBoundAtomic,
    estimated_total_atomic: estimate.estimatedTotalAtomic,
    total_is_hard_cap: false as const,
    components: [
      {
        kind: "l2_execution" as const,
        amount_atomic: estimate.hardExecutionCapAtomic,
        classification: "hard_cap" as const,
        method: "eip1559.gas_limit_x_max_fee_per_gas",
      },
      {
        kind: "l1_data_security" as const,
        amount_atomic: estimate.estimatedL1UpperBoundAtomic,
        classification: "estimated_upper_bound" as const,
        method: `GasPriceOracle.${estimate.l1FeeMethod}`,
        source_block: estimate.sourceBlockNumber,
      },
      {
        kind: "operator" as const,
        amount_atomic: estimate.estimatedOperatorUpperBoundAtomic,
        classification: "estimated_upper_bound" as const,
        method: `GasPriceOracle.${estimate.operatorFeeMethod}`,
        source_block: estimate.sourceBlockNumber,
      },
    ],
  };
  if (terms.estimated_total_atomic !== feeMinor) {
    throw new Error("Base quote fee budget does not match its bound structured estimate.");
  }
  return {
    ceilingAtomic: null,
    budgetAtomic: feeMinor,
    terms: terms as unknown as JsonValue,
  };
};

const canonicalIntent = (input: {
  id: string;
  context: ResolvedPaymentContext;
  instruction: PaymentInstruction;
  createdAt: string;
  expiresAt: string;
  quoteHash: `sha256:${string}`;
  feeCeilingAtomic: string | null;
}) => createPaymentIntentV1({
  schema_version: "cashloom.payment-intent/1",
  intent_id: input.id,
  kind: "transfer",
  source_account: cryptoAccountRef(input.context.accountId),
  destination: {
    kind: "account",
    account: cryptoAccountRef(input.context.destinationAccountId(input.instruction.to)),
  },
  amount: positiveMoney(cryptoAssetRef(input.context.assetId), input.instruction.amountMinor),
  ...(input.feeCeilingAtomic === null
    ? {}
    : {
        fee_ceiling: nonNegativeMoney(
          cryptoAssetRef(input.context.feeAssetId),
          input.feeCeilingAtomic,
        ),
      }),
  created_by: { kind: "human", actor_id: LOCAL_ACTOR.ref },
  nonce: input.id,
  created_at: input.createdAt,
  expires_at: input.expiresAt,
  quote_hash: input.quoteHash,
  purpose: `Transfer ${input.context.assetSymbol}`,
});

const persistIntent = (input: {
  intent: ReturnType<typeof canonicalIntent>;
  context: ResolvedPaymentContext;
  feeMinor: string;
  feePolicy: PersistedFeePolicy;
  claims: readonly PaymentReservationClaim[];
  quoteBody: JsonValue;
}): PaymentIntentRecord => {
  const created = store.createPaymentIntent({
    id: input.intent.intent_id,
    schemaVersion: input.intent.schema_version,
    kind: input.intent.kind,
    sourceAccountId: input.context.account.id,
    assetId: input.context.assetId,
    amountAtomic: input.intent.amount.atomic,
    destination: input.intent.destination,
    feeCeilingAtomic: input.feePolicy.ceilingAtomic,
    feeAssetId: input.context.feeAssetId,
    initialState: "quoted",
    intentHash: input.intent.intent_hash,
    createdBy: LOCAL_ACTOR,
    expiresAt: input.intent.expires_at,
    metadata: {
      canonical_intent: input.intent,
      compatibility: "payments-v1",
      fee_policy: input.feePolicy.terms,
      quoted_fee_budget_atomic: input.feePolicy.budgetAtomic,
    },
  }).intent;
  input.claims.forEach((claim, index) => store.acquireReservation({
    id: `reservation.${input.intent.intent_id}.${index}`,
    intentId: input.intent.intent_id,
    accountId: input.context.account.id,
    assetId: input.context.assetId,
    kind: claim.kind,
    resourceKey: claim.resourceKey,
    amountAtomic: claim.amountAtomic,
    expiresAt: input.intent.expires_at,
    enforceAvailable: false,
  }));
  store.recordQuote({
    id: `quote.${input.intent.intent_id}`,
    intentId: input.intent.intent_id,
    provider: input.context.sender.type,
    quoteHash: input.intent.quote_hash!,
    inputAmountAtomic: input.intent.amount.atomic,
    feeAssetId: input.context.feeAssetId,
    feeAtomic: input.feeMinor,
    expiresAt: input.intent.expires_at,
    body: input.quoteBody,
  });
  return created;
};

export interface QuoteResult {
  paymentId: string;
  feeMinor: string;
  feeAsset: string;
  summary: string;
  expiresAt: string;
  intentHash: string;
  quoteHash: string;
  feeTerms?: PaymentFeeTerms;
}

export const quotePayment = async (opts: {
  accountId: string;
  to: string;
  amountMinor: string;
  asset: string;
}): Promise<QuoteResult> => {
  const sender = senderForAsset(opts.asset);
  const account = sendingAccount(opts.accountId);
  const context = resolvePaymentContext(account, sender, opts.asset);
  ensureKernelProjection(context);
  const quoted = await sender.quote(
    { vaultKeyId: context.keyId },
    { to: opts.to, amountMinor: opts.amountMinor, asset: context.assetSymbol },
  );
  const instruction: PaymentInstruction = {
    to: opts.to,
    amountMinor: opts.amountMinor,
    asset: context.assetSymbol,
    detail: quoted.detail ?? null,
  };
  const claims = await sender.reservationClaims({ vaultKeyId: context.keyId }, instruction);
  const id = newId();
  const createdAt = new Date().toISOString();
  const expiresAt = new Date(Date.parse(createdAt) + QUOTE_TTL_MS).toISOString();
  const quoteHash = quoteHashFor(context, instruction, quoted.feeMinor, context.feeAssetId);
  const feePolicy = feePolicyFor(context, instruction, quoted.feeMinor, quoted.feeTerms);
  const intent = canonicalIntent({
    id,
    context,
    instruction,
    createdAt,
    expiresAt,
    quoteHash,
    feeCeilingAtomic: feePolicy.ceilingAtomic,
  });
  db.transaction(() => {
    persistIntent({
      intent,
      context,
      feeMinor: quoted.feeMinor,
      feePolicy,
      claims,
      quoteBody: {
        summary: quoted.summary,
        fee_asset: quoted.feeAsset,
        fee_terms: quoted.feeTerms
          ? quoted.feeTerms as unknown as JsonValue
          : null,
        detail: quoted.detail ?? null,
      },
    });
    db.query(
      `INSERT INTO payments
         (id, account_id, rail, to_addr, asset, amount_minor, fee_minor, status, detail, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'quoted', ?, ?)`,
    ).run(
      id, account.id, sender.type, opts.to, context.assetSymbol, opts.amountMinor,
      quoted.feeMinor, quoted.detail ?? null, createdAt,
    );
  }).immediate();
  return {
    paymentId: id,
    feeMinor: quoted.feeMinor,
    feeAsset: quoted.feeAsset,
    summary: quoted.summary,
    expiresAt,
    intentHash: intent.intent_hash,
    quoteHash,
    ...(quoted.feeTerms ? { feeTerms: quoted.feeTerms } : {}),
  };
};

interface LegacyPaymentRow extends Record<string, string | null> {
  id: string;
  account_id: string;
  rail: string;
  to_addr: string;
  asset: string;
  amount_minor: string;
  fee_minor: string | null;
  status: string;
  detail: string | null;
  created_at: string;
}

const getLegacyPayment = (paymentId: string): LegacyPaymentRow | null =>
  db.query("SELECT * FROM payments WHERE id=?").get(paymentId) as LegacyPaymentRow | null;

const activeReservations = (intentId: string) => db.query(
  "SELECT id, version FROM wk_reservations WHERE intent_id=? AND state='ACTIVE' ORDER BY id",
).all(intentId) as Array<{ id: string; version: number }>;

const advanceIntent = (
  intentId: string,
  toState: PaymentLifecycleState,
  eventType: string,
  reason?: string,
  actor: Actor = LOCAL_ACTOR,
): PaymentIntentRecord => {
  const current = store.getPaymentIntent(intentId);
  if (!current) throw new Error(`Wallet Kernel intent ${intentId} is missing.`);
  if (current.state === toState) return current;
  if (!canTransition(current.state as PaymentLifecycleState, toState)) {
    throw new Error(`Wallet Kernel intent ${intentId} cannot move ${current.state} -> ${toState}.`);
  }
  return store.transitionIntent({
    intentId,
    expectedState: current.state,
    expectedVersion: current.version,
    toState,
    actor,
    eventType,
    reason,
  });
};

/** Lazily projects pre-v2 quoted rows without rewriting their opaque detail. */
const ensureLegacyIntent = async (
  row: LegacyPaymentRow,
  context: ResolvedPaymentContext,
  instruction: PaymentInstruction,
): Promise<PaymentIntentRecord> => {
  const existing = store.getPaymentIntent(row.id);
  const createdAt = new Date(row.created_at).toISOString();
  const expiresAt = new Date(Date.parse(createdAt) + QUOTE_TTL_MS).toISOString();
  const feeMinor = row.fee_minor ?? "0";
  const quoteHash = quoteHashFor(context, instruction, feeMinor, context.feeAssetId);
  const feePolicy = feePolicyFor(context, instruction, feeMinor);
  const intent = canonicalIntent({
    id: row.id,
    context,
    instruction,
    createdAt,
    expiresAt,
    quoteHash,
    feeCeilingAtomic: feePolicy.ceilingAtomic,
  });
  if (existing) {
    const quote = store.getQuote(`quote.${row.id}`);
    const quoteBody = quote?.body && typeof quote.body === "object" && !Array.isArray(quote.body)
      ? quote.body as Record<string, JsonValue>
      : null;
    const metadata = existing.metadata && typeof existing.metadata === "object" && !Array.isArray(existing.metadata)
      ? existing.metadata as Record<string, JsonValue>
      : null;
    const canonical = metadata?.canonical_intent;
    const coherent =
      existing.intentHash === intent.intent_hash &&
      existing.sourceAccountId === context.account.id &&
      existing.assetId === context.assetId &&
      existing.amountAtomic === instruction.amountMinor &&
      existing.feeCeilingAtomic === feePolicy.ceilingAtomic &&
      existing.feeAssetId === context.feeAssetId &&
      existing.expiresAt === expiresAt &&
      canonical !== undefined &&
      canonicalizeJson(canonical) === canonicalizeJson(intent) &&
      quote?.quoteHash === quoteHash &&
      quote?.inputAmountAtomic === instruction.amountMinor &&
      quote?.feeAtomic === feeMinor &&
      quote?.feeAssetId === context.feeAssetId &&
      quote?.expiresAt === expiresAt &&
      quoteBody?.detail === (row.detail ?? null);
    if (!coherent) {
      throw new Error(
        "The persisted quote no longer matches its immutable Wallet Kernel intent; refusing to authorize or sign it.",
      );
    }
    return existing;
  }
  const claims = await context.sender.reservationClaims({ vaultKeyId: context.keyId }, instruction);
  return persistIntent({
    intent,
    context,
    feeMinor,
    feePolicy,
    claims,
    quoteBody: { detail: row.detail, migrated_from: "payments-v1" },
  });
};

const transitionExecution = (
  executionId: string,
  toState: string,
  changes: Partial<{
    submissionRef: string | null;
    networkTxId: string | null;
    signedArtifactId: string | null;
    ambiguous: boolean;
    errorCode: string | null;
    errorMessage: string | null;
    submittedAt: string | null;
    response: JsonValue | null;
  }> = {},
) => {
  const current = store.getExecution(executionId);
  if (!current) throw new Error(`Wallet Kernel execution ${executionId} is missing.`);
  if (current.state === toState) return current;
  return store.transitionExecution({
    id: executionId,
    expectedState: current.state,
    expectedVersion: current.version,
    toState,
    ...changes,
  });
};

const releaseActiveReservations = (intentId: string): void => {
  for (const reservation of activeReservations(intentId)) {
    store.releaseReservation(reservation.id, reservation.version);
  }
};

const durableSignedEnvelope = (
  envelope: SignedTransactionEnvelope,
): SignedTransactionEnvelope => {
  if (
    envelope.encoding !== "hex" ||
    !/^0x[0-9a-f]+$/.test(envelope.payload) ||
    envelope.payload.length % 2 !== 0 ||
    (envelope.payload.length - 2) / 2 > 256 * 1024
  ) {
    throw new Error("Sender returned a malformed or oversized signed transaction envelope.");
  }
  return Object.freeze({ encoding: "hex", payload: envelope.payload });
};

const signedArtifactResponse = (artifact: SignedArtifactRecord): JsonValue => ({
  signed_artifact: {
    id: artifact.id,
    authorization_id: artifact.authorizationId,
    request_hash: artifact.requestHash,
    envelope_hash: artifact.envelopeHash,
    encoding: artifact.encoding,
    byte_length: (artifact.payload.length - 2) / 2,
    external_tx_id: artifact.externalTxId,
  },
  signed_at: artifact.createdAt,
  recovery: "explicit-exact-rebroadcast-only",
});

const assertArtifactBinding = (input: {
  artifact: SignedArtifactRecord;
  authorizationId: string;
  intent: PaymentIntentRecord;
  keyId: string;
  requestHash: string;
}): void => {
  const { artifact } = input;
  if (
    artifact.authorizationId !== input.authorizationId ||
    artifact.intentId !== input.intent.id ||
    artifact.intentHash !== input.intent.intentHash ||
    artifact.keyId !== input.keyId ||
    artifact.requestHash !== input.requestHash
  ) {
    throw new Error("Durable signed artifact does not match the canonical intent and prepared request.");
  }
};

const linkSignedArtifactToExecution = (input: {
  paymentId: string;
  executionId: string;
  authorizationId: string;
  intent: PaymentIntentRecord;
  keyId: string;
  requestHash: string;
  externalId: string;
  envelope: SignedTransactionEnvelope;
}): SignedArtifactRecord => {
  const signedEnvelope = durableSignedEnvelope(input.envelope);
  const artifact = store.getSignedArtifactByAuthorization(input.authorizationId);
  if (!artifact) throw new Error("Vault signer returned without a durable signed artifact.");
  assertArtifactBinding({
    artifact,
    authorizationId: input.authorizationId,
    intent: input.intent,
    keyId: input.keyId,
    requestHash: input.requestHash,
  });
  if (
    artifact.externalTxId !== input.externalId ||
    artifact.encoding !== signedEnvelope.encoding ||
    artifact.payload !== signedEnvelope.payload
  ) {
    throw new Error("Sender result differs from the vault's immutable signed artifact.");
  }
  db.transaction(() => {
    db.query("UPDATE payments SET status='confirmed', tx_hash=?, updated_at=? WHERE id=?").run(
      artifact.externalTxId,
      artifact.createdAt,
      input.paymentId,
    );
    const currentIntent = store.getPaymentIntent(input.paymentId);
    const execution = store.getExecution(input.executionId);
    if (!currentIntent || !execution) throw new Error("Signing lifecycle disappeared during artifact linkage.");
    if (currentIntent.state === "prepared" && execution.state === "prepared") {
      for (const reservation of activeReservations(input.paymentId)) {
        store.consumeReservation(reservation.id, reservation.version);
      }
      advanceIntent(input.paymentId, "signed", "intent.transaction_signed");
      transitionExecution(input.executionId, "signed", {
        networkTxId: artifact.externalTxId,
        signedArtifactId: artifact.id,
        response: signedArtifactResponse(artifact),
      });
      return;
    }
    if (
      currentIntent.state !== "signed" ||
      execution.state !== "signed" ||
      execution.signedArtifactId !== artifact.id ||
      execution.networkTxId !== artifact.externalTxId ||
      canonicalizeJson(execution.response) !== canonicalizeJson(signedArtifactResponse(artifact))
    ) {
      throw new Error("Signed artifact linkage conflicts with the existing execution lifecycle.");
    }
  }).immediate();
  return artifact;
};

class SignedBroadcastDeferredError extends Error {
  constructor(readonly externalId: string) {
    super("Signed transaction is durably queued for explicit exact-byte broadcast.");
    this.name = "SignedBroadcastDeferredError";
  }
}

class SimulatedPostSigningCrashError extends Error {
  constructor() {
    super("Injected crash after durable vault signing and before execution linkage.");
    this.name = "SimulatedPostSigningCrashError";
  }
}

class SimulatedPreSigningCrashError extends Error {
  constructor() {
    super("Injected crash after durable authorization and before vault artifact commit.");
    this.name = "SimulatedPreSigningCrashError";
  }
}

export interface ConfirmResult {
  paymentId: string;
  status: string;
  txHash: string | null;
  error: string | null;
  intentState?: string;
}

const recordBroadcastSuccess = (
  paymentId: string,
  row: LegacyPaymentRow,
  context: ResolvedPaymentContext,
  receipt: PaymentReceipt,
  executionId: string,
): ConfirmResult => {
  try {
    const now = new Date().toISOString();
    db.transaction(() => {
      const signedExecution = store.getExecution(executionId);
      const artifact = signedExecution?.signedArtifactId
        ? store.getSignedArtifact(signedExecution.signedArtifactId)
        : null;
      if (
        !signedExecution ||
        !artifact ||
        artifact.externalTxId !== receipt.externalId ||
        signedExecution.networkTxId !== artifact.externalTxId
      ) {
        throw new Error("Broadcast receipt is not bound to the execution's immutable signed artifact.");
      }
      db.query(
        "UPDATE payments SET status='broadcast', tx_hash=?, error=NULL, updated_at=? WHERE id=?",
      ).run(receipt.externalId, now, paymentId);
      db.query(
        `INSERT OR IGNORE INTO transactions
           (id, account_id, external_id, title, amount_minor, date, source)
         VALUES (?, ?, ?, ?, ?, ?, 'PAYMENT')`,
      ).run(
        newId(),
        context.account.id,
        receipt.externalId,
        `pay · ${row.asset} → ${row.to_addr.slice(0, 12)}…`,
        `-${receipt.totalOutMinor ?? row.amount_minor}`,
        now,
      );
      const currentIntent = store.getPaymentIntent(paymentId);
      if (currentIntent?.state === "signed") {
        advanceIntent(paymentId, "submitted", "intent.submitted");
      }
      const execution = store.getExecution(executionId);
      if (execution?.state === "signed") {
        transitionExecution(executionId, "submitted", {
          submissionRef: receipt.externalId,
          networkTxId: receipt.externalId,
          submittedAt: now,
        });
      }
      const outflow = receipt.totalOutMinor ?? row.amount_minor;
      store.postJournalEntry({
        id: `journal.${paymentId}.submitted`,
        description: `Outbound ${context.assetSymbol} transfer`,
        effectiveAt: now,
        referenceType: "PAYMENT_INTENT",
        referenceId: paymentId,
        metadata: {
          network_tx_id: receipt.externalId,
          lifecycle_state: "submitted",
          network_fee: context.sender.type === "evm-base"
            ? "pending_chain_observation"
            : "included_exactly_in_outflow",
        },
        postings: [
          {
            ledgerAccountId: context.clearingLedgerId,
            assetId: context.assetId,
            direction: "DEBIT",
            amountAtomic: outflow,
          },
          {
            ledgerAccountId: context.assetLedgerId,
            assetId: context.assetId,
            direction: "CREDIT",
            amountAtomic: outflow,
          },
        ],
      });
      const networkFeeEvidence: JsonValue = context.sender.type === "evm-base"
        ? {
            state: "pending_chain_observation",
            asset_id: context.feeAssetId,
            quoted_budget_atomic: row.fee_minor ?? "0",
            total_is_hard_cap: false,
            actual_atomic: null,
          }
        : {
            state: "included_exactly_in_outflow",
            asset_id: context.feeAssetId,
            actual_atomic: row.fee_minor ?? "0",
          };
      const receiptBody: JsonValue = {
        schema: "cashloom.payment-receipt/1",
        intent_id: paymentId,
        execution_id: executionId,
        network_tx_id: receipt.externalId,
        state: "submitted",
        observed_at: now,
        network_fee: networkFeeEvidence,
      };
      store.recordReceipt({
        id: `receipt.${paymentId}.submission`,
        intentId: paymentId,
        executionId,
        kind: "SUBMISSION",
        receiptHash: sha256Id(receiptBody),
        body: receiptBody,
        observedAt: now,
      });
    }).immediate();
    return {
      paymentId,
      status: "broadcast",
      txHash: receipt.externalId,
      error: null,
      intentState: "submitted",
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "recording failed";
    const note = `Broadcast succeeded (txid ${receipt.externalId}); recording it locally failed: ${message}. Do NOT re-quote — the payment is live.`;
    try {
      db.query("UPDATE payments SET error=?, updated_at=? WHERE id=?").run(
        note,
        new Date().toISOString(),
        paymentId,
      );
    } catch {
      // onSigned already persisted the signed bytes and transaction id.
    }
    return {
      paymentId,
      status: "confirmed",
      txHash: receipt.externalId,
      error: note,
      intentState: store.getPaymentIntent(paymentId)?.state,
    };
  }
};

export const confirmPayment = async (
  paymentId: string,
  options: {
    agentAuthorizationId?: string;
    /** Internal worker/test control: persist a fully signed transaction but
     * deliberately leave network submission to resumePaymentBroadcast(). */
    deferBroadcastAfterSigning?: boolean;
    /** Internal fault injection: emulate process death after the vault's
     * atomic artifact+authorization commit but before execution linkage. */
    simulateCrashAfterVaultCommit?: boolean;
    /** Internal fault injection: emulate process death after the owner claim,
     * prepared execution, and ACTIVE authorization commit, before signing. */
    simulateCrashBeforeVaultCommit?: boolean;
  } = {},
): Promise<ConfirmResult> => {
  const row = getLegacyPayment(paymentId);
  if (!row) throw new Error(`No payment ${paymentId}`);
  if (row.status !== "quoted") {
    throw new Error(`Payment ${paymentId} is "${row.status}" — only a fresh quote can be confirmed.`);
  }
  if (Date.now() - Date.parse(row.created_at) > QUOTE_TTL_MS) {
    db.transaction(() => {
      const changed = db.query(
        `UPDATE payments SET status='failed', error='quote expired', updated_at=?
         WHERE id=? AND status='quoted'`,
      ).run(new Date().toISOString(), paymentId);
      if (changed.changes !== 1) throw new Error("Quote changed while it was being expired.");
      releaseActiveReservations(paymentId);
      const current = store.getPaymentIntent(paymentId);
      if (current && canTransition(current.state as PaymentLifecycleState, "expired")) {
        advanceIntent(paymentId, "expired", "intent.quote_expired", "quote expired");
      }
    }).immediate();
    throw new Error("Quote expired — request a fresh one (fees move).");
  }

  const account = sendingAccount(row.account_id);
  const sender = senderForAsset(row.asset);
  const context = resolvePaymentContext(account, sender, row.asset);
  ensureKernelProjection(context);
  const instruction: PaymentInstruction = {
    to: row.to_addr,
    amountMinor: row.amount_minor,
    asset: row.asset,
    detail: row.detail,
  };

  let intent: PaymentIntentRecord;
  let requestHash: `sha256:${string}`;
  try {
    intent = await ensureLegacyIntent(row, context, instruction);
    requestHash = await sender.signingRequestHash({ vaultKeyId: context.keyId }, instruction);
  } catch (error) {
    const message = error instanceof Error ? error.message : "prepared request is invalid";
    db.query(
      "UPDATE payments SET status='failed', error=?, updated_at=? WHERE id=? AND status='quoted'",
    ).run(message, new Date().toISOString(), paymentId);
    const current = store.getPaymentIntent(paymentId);
    if (current && canTransition(current.state as PaymentLifecycleState, "declined")) {
      advanceIntent(paymentId, "declined", "intent.prepared_request_refused", message);
    }
    return {
      paymentId,
      status: "failed",
      txHash: null,
      error: message,
      intentState: store.getPaymentIntent(paymentId)?.state,
    };
  }

  // @agenttool/wallet treats the signed max_fee as a hard bound. Base's L1
  // data/security and operator fee components are estimates rather than
  // transaction-enforced caps, so no payment-bound agent authorization—old
  // or new—may cross the signing boundary. Keep this in the kernel, not only
  // the HTTP route, so alternate in-process callers cannot revive a stale
  // pre-policy authorization.
  if (options.agentAuthorizationId && context.chainId === BASE_CHAIN) {
    throw new Error(
      "Base autonomous execution is proposal-only: the signed agent max_fee is a hard bound, but Base L1 data/security and operator charges are not transaction-hard-capped.",
    );
  }

  const authorizationId = newId();
  const executionId = `execution.${paymentId}.0`;
  const binding = db.transaction((): SigningBinding => {
    const now = new Date().toISOString();
    const claimed = db.query(
      "UPDATE payments SET status='confirmed', updated_at=? WHERE id=? AND status='quoted'",
    ).run(now, paymentId);
    if (claimed.changes !== 1) {
      throw new Error(`Payment ${paymentId} was already claimed by another confirmation.`);
    }
    let confirmationActor: Actor = LOCAL_ACTOR;
    if (options.agentAuthorizationId) {
      const delegated = db.query(
        `SELECT wallet_id, grant_id FROM wk_agent_authorizations
         WHERE id=? AND payment_intent_id=? AND status='ATTESTED'
           AND expires_at>? AND grant_revocation_nonce=(
             SELECT revocation_nonce FROM wk_agent_capability_usage
             WHERE grant_id=wk_agent_authorizations.grant_id
           )`,
      ).get(options.agentAuthorizationId, paymentId, now) as
        | { wallet_id: string; grant_id: string }
        | null;
      if (!delegated) {
        throw new Error("Agent authorization is absent, mismatched, expired, revoked, or already consumed.");
      }
      const consumed = db.query(
        `UPDATE wk_agent_authorizations
         SET status='CONSUMED', consumed_at=?
         WHERE id=? AND payment_intent_id=? AND status='ATTESTED'
           AND expires_at>? AND grant_revocation_nonce=(
             SELECT revocation_nonce FROM wk_agent_capability_usage
             WHERE grant_id=wk_agent_authorizations.grant_id
           )`,
      ).run(now, options.agentAuthorizationId, paymentId, now);
      if (consumed.changes !== 1) {
        throw new Error("Agent authorization is absent, mismatched, expired, revoked, or already consumed.");
      }
      confirmationActor = {
        type: "agent",
        ref: `${delegated.wallet_id}:${delegated.grant_id}`,
      };
    }
    advanceIntent(paymentId, "reserved", "intent.resources_reserved", undefined, confirmationActor);
    advanceIntent(paymentId, "authorized", "intent.authorized", undefined, confirmationActor);
    const authorization = store.createSigningAuthorization({
      id: authorizationId,
      intentId: paymentId,
      intentHash: intent.intentHash,
      keyId: context.keyId,
      requestHash,
      actor: confirmationActor,
      method: "LOCAL_VAULT_CONFIRMATION",
      grantHash: sha256Id({
        intent_hash: intent.intentHash,
        key_id: context.keyId,
        request_hash: requestHash,
      }),
      constraints: {
        chain_id: context.chainId,
        asset_id: context.assetId,
        single_use: true,
        agent_authorization_id: options.agentAuthorizationId ?? null,
      },
      expiresAt: intent.expiresAt,
    }).authorization;
    advanceIntent(paymentId, "prepared", "intent.transaction_prepared", undefined, confirmationActor);
    store.createExecution({
      id: executionId,
      intentId: paymentId,
      sequence: 0,
      rail: sender.type,
      state: "prepared",
      idempotencyKey: `payment.${paymentId}`,
      preparedRef: authorization.id,
      requestHash,
    });
    if (!authorization.expiresAt) throw new Error("Signing authorization has no expiry.");
    return {
      intentId: paymentId,
      intentHash: intent.intentHash as `sha256:${string}`,
      authorizationId: authorization.id,
      requestHash,
      expiresAt: authorization.expiresAt,
    };
  }).immediate();

  if (options.simulateCrashBeforeVaultCommit) throw new SimulatedPreSigningCrashError();

  let receipt;
  try {
    receipt = await sender.send(
      { vaultKeyId: context.keyId, paymentId, signingBinding: binding },
      instruction,
      {
        onSigned: (externalId, envelope) => {
          const artifact = store.getSignedArtifactByAuthorization(authorizationId);
          if (!artifact) throw new Error("Vault signer returned without a durable signed artifact.");
          if (options.simulateCrashAfterVaultCommit) {
            throw new SimulatedPostSigningCrashError();
          }
          linkSignedArtifactToExecution({
            paymentId,
            executionId,
            authorizationId,
            intent,
            keyId: context.keyId,
            requestHash,
            externalId,
            envelope,
          });
          if (options.deferBroadcastAfterSigning) {
            throw new SignedBroadcastDeferredError(externalId);
          }
        },
      },
    );
  } catch (error) {
    if (error instanceof SimulatedPostSigningCrashError) throw error;
    if (error instanceof SignedBroadcastDeferredError) {
      db.query("UPDATE payments SET error=?, updated_at=? WHERE id=?").run(
        error.message,
        new Date().toISOString(),
        paymentId,
      );
      return {
        paymentId,
        status: "confirmed",
        txHash: error.externalId,
        error: error.message,
        intentState: "signed",
      };
    }
    if (error instanceof AmbiguousBroadcastError) {
      db.transaction(() => {
        const now = new Date().toISOString();
        db.query("UPDATE payments SET error=?, updated_at=? WHERE id=?").run(
          error.message,
          now,
          paymentId,
        );
        const current = store.getPaymentIntent(paymentId);
        if (current?.state === "signed") advanceIntent(paymentId, "submitted", "intent.submitted");
        advanceIntent(paymentId, "ambiguous", "intent.broadcast_ambiguous", error.message);
        transitionExecution(executionId, "ambiguous", {
          networkTxId: error.externalId,
          ambiguous: true,
          errorCode: "BROADCAST_OUTCOME_UNKNOWN",
          errorMessage: error.message,
          submittedAt: now,
        });
      }).immediate();
      return {
        paymentId,
        status: "confirmed",
        txHash: error.externalId,
        error: error.message,
        intentState: "ambiguous",
      };
    }
    const strandedArtifact = store.getSignedArtifactByAuthorization(authorizationId);
    const strandedExecution = store.getExecution(executionId);
    if (strandedArtifact && strandedExecution?.state === "prepared") {
      return {
        paymentId,
        status: "confirmed",
        txHash: strandedArtifact.externalTxId,
        error:
          "Signing completed durably, but execution linkage did not. Use explicit exact-byte recovery; do not re-quote or re-sign.",
        intentState: store.getPaymentIntent(paymentId)?.state,
      };
    }
    const message = error instanceof Error ? error.message : "send failed";
    db.transaction(() => {
      const now = new Date().toISOString();
      db.query("UPDATE payments SET status='failed', error=?, updated_at=? WHERE id=?").run(
        message,
        now,
        paymentId,
      );
      releaseActiveReservations(paymentId);
      db.query(
        `UPDATE wk_authorizations SET status='REVOKED', revoked_at=?
         WHERE id=? AND status='ACTIVE'`,
      ).run(now, authorizationId);
      const current = store.getPaymentIntent(paymentId);
      if (current && canTransition(current.state as PaymentLifecycleState, "failed")) {
        advanceIntent(paymentId, "failed", "intent.execution_failed", message);
      }
      transitionExecution(executionId, "failed", {
        errorCode: "EXECUTION_FAILED",
        errorMessage: message,
      });
    }).immediate();
    return { paymentId, status: "failed", txHash: null, error: message, intentState: "failed" };
  }

  return recordBroadcastSuccess(paymentId, row, context, receipt, executionId);
};

/** Resume one already-owner-authorized prepared execution without re-quoting,
 * reselecting resources, or minting new authority. If its ACTIVE one-shot
 * authorization has no artifact yet, recovery finishes that exact prepared
 * signature once. Once an artifact exists, only its immutable bytes may be
 * linked or rebroadcast; recovery never produces another signature. */
const resumePaymentBroadcastOnce = async (paymentId: string): Promise<ConfirmResult> => {
  const row = getLegacyPayment(paymentId);
  if (!row) throw new Error(`No payment ${paymentId}`);
  const executionId = `execution.${paymentId}.0`;
  let execution = store.getExecution(executionId);
  if (!execution || !["prepared", "signed", "submitted"].includes(execution.state)) {
    throw new Error(
      "Payment execution is not in a recoverable prepared-artifact or signed state; inspect reconciliation evidence instead.",
    );
  }
  const account = sendingAccount(row.account_id);
  const sender = senderForAsset(row.asset);
  const context = resolvePaymentContext(account, sender, row.asset);
  ensureKernelProjection(context);
  const instruction: PaymentInstruction = {
    to: row.to_addr,
    amountMinor: row.amount_minor,
    asset: row.asset,
    detail: row.detail,
  };
  const intent = await ensureLegacyIntent(row, context, instruction);
  const requestHash = await sender.signingRequestHash(
    { vaultKeyId: context.keyId },
    instruction,
  );
  if (
    execution.intentId !== paymentId ||
    execution.rail !== sender.type ||
    !execution.preparedRef ||
    execution.requestHash !== requestHash
  ) {
    throw new Error("Execution no longer matches the canonical rail and prepared request.");
  }
  const authorization = store.getSigningAuthorization(execution.preparedRef);
  if (
    !authorization ||
    authorization.intentId !== paymentId ||
    authorization.intentHash !== intent.intentHash ||
    authorization.keyId !== context.keyId ||
    authorization.requestHash !== requestHash ||
    !["ACTIVE", "CONSUMED"].includes(authorization.status)
  ) {
    throw new Error("Recoverable execution has no matching active or consumed signing authorization.");
  }
  let artifact = execution.signedArtifactId
    ? store.getSignedArtifact(execution.signedArtifactId)
    : store.getSignedArtifactByAuthorization(authorization.id);
  if (authorization.status === "CONSUMED" && !artifact) {
    throw new Error("Consumed signing authorization has no durable signed artifact; recovery fails closed.");
  }
  if (authorization.status === "ACTIVE" && artifact) {
    throw new Error("Active signing authorization unexpectedly has committed artifact evidence.");
  }
  if (artifact) {
    assertArtifactBinding({
      artifact,
      authorizationId: authorization.id,
      intent,
      keyId: context.keyId,
      requestHash,
    });
  }

  if (execution.state === "submitted" && artifact) {
    if (
      execution.signedArtifactId !== artifact.id ||
      execution.networkTxId !== artifact.externalTxId
    ) {
      throw new Error("Submitted execution is not anchored to its immutable signed artifact.");
    }
    return {
      paymentId,
      status: "broadcast",
      txHash: artifact.externalTxId,
      error: row.error,
      intentState: store.getPaymentIntent(paymentId)?.state,
    };
  }

  let broadcastAction: () => Promise<PaymentReceipt>;
  let recoveryMode: "finish-authorized-signing" | "exact-rebroadcast";
  if (authorization.status === "ACTIVE") {
    const recoveryAt = new Date().toISOString();
    if (!authorization.expiresAt || authorization.expiresAt <= recoveryAt) {
      const message = "Prepared signing authorization expired before recovery; no transaction was signed.";
      db.transaction(() => {
        db.query("UPDATE payments SET status='failed', error=?, updated_at=? WHERE id=?").run(
          message,
          recoveryAt,
          paymentId,
        );
        releaseActiveReservations(paymentId);
        db.query(
          `UPDATE wk_authorizations SET status='EXPIRED'
           WHERE id=? AND status='ACTIVE'`,
        ).run(authorization.id);
        const current = store.getPaymentIntent(paymentId);
        if (current && canTransition(current.state as PaymentLifecycleState, "expired")) {
          advanceIntent(paymentId, "expired", "intent.signing_authorization_expired", message);
        }
        transitionExecution(executionId, "failed", {
          errorCode: "SIGNING_AUTHORIZATION_EXPIRED",
          errorMessage: message,
        });
      }).immediate();
      return {
        paymentId,
        status: "failed",
        txHash: null,
        error: message,
        intentState: "expired",
      };
    }
    if (
      execution.state !== "prepared" ||
      execution.signedArtifactId !== null
    ) {
      throw new Error("Active prepared signing authorization is no longer safely recoverable.");
    }
    recoveryMode = "finish-authorized-signing";
    const binding: SigningBinding = {
      intentId: paymentId,
      intentHash: intent.intentHash as `sha256:${string}`,
      authorizationId: authorization.id,
      requestHash,
      expiresAt: authorization.expiresAt ?? intent.expiresAt ?? "",
    };
    broadcastAction = () => sender.send(
      { vaultKeyId: context.keyId, paymentId, signingBinding: binding },
      instruction,
      {
        onSigned: (externalId, envelope) => {
          artifact = linkSignedArtifactToExecution({
            paymentId,
            executionId,
            authorizationId: authorization.id,
            intent,
            keyId: context.keyId,
            requestHash,
            externalId,
            envelope,
          });
        },
      },
    );
  } else {
    if (!artifact) {
      throw new Error("Consumed signing authorization has no durable signed artifact; recovery fails closed.");
    }
    const envelope = durableSignedEnvelope({
      encoding: artifact.encoding,
      payload: artifact.payload,
    });
    linkSignedArtifactToExecution({
      paymentId,
      executionId,
      authorizationId: authorization.id,
      intent,
      keyId: context.keyId,
      requestHash,
      externalId: artifact.externalTxId,
      envelope,
    });
    if (!sender.resumeBroadcast) {
      throw new Error(`The ${sender.type} rail cannot resume an exact signed broadcast.`);
    }
    recoveryMode = "exact-rebroadcast";
    broadcastAction = () => sender.resumeBroadcast!(
      { vaultKeyId: context.keyId, paymentId },
      instruction,
      envelope,
      artifact!.externalTxId,
    );
  }

  let receipt: PaymentReceipt;
  try {
    receipt = await broadcastAction();
    artifact ??= store.getSignedArtifactByAuthorization(authorization.id);
    if (!artifact || receipt.externalId !== artifact.externalTxId) {
      throw new Error("Recovered broadcast is not bound to a durable signed artifact.");
    }
  } catch (error) {
    artifact ??= store.getSignedArtifactByAuthorization(authorization.id);
    if (error instanceof AmbiguousBroadcastError) {
      if (!artifact) {
        throw new Error("Broadcast became ambiguous before durable signed evidence existed.");
      }
      const ambiguousArtifact = artifact;
      const now = new Date().toISOString();
      db.transaction(() => {
        db.query("UPDATE payments SET error=?, updated_at=? WHERE id=?").run(
          error.message,
          now,
          paymentId,
        );
        const current = store.getPaymentIntent(paymentId);
        if (current?.state === "signed") advanceIntent(paymentId, "submitted", "intent.submitted");
        advanceIntent(paymentId, "ambiguous", "intent.broadcast_ambiguous", error.message);
        transitionExecution(executionId, "ambiguous", {
          networkTxId: ambiguousArtifact.externalTxId,
          ambiguous: true,
          errorCode: "BROADCAST_OUTCOME_UNKNOWN",
          errorMessage: error.message,
          submittedAt: now,
        });
      }).immediate();
      return {
        paymentId,
        status: "confirmed",
        txHash: ambiguousArtifact.externalTxId,
        error: error.message,
        intentState: "ambiguous",
      };
    }
    const strandedExecution = store.getExecution(executionId);
    if (artifact && strandedExecution?.state === "prepared") {
      return {
        paymentId,
        status: "confirmed",
        txHash: artifact.externalTxId,
        error:
          "Signing completed durably, but execution linkage did not. Retry recovery; no new signature will be created.",
        intentState: store.getPaymentIntent(paymentId)?.state,
      };
    }
    const message = error instanceof Error
      ? error.message
      : recoveryMode === "exact-rebroadcast"
        ? "exact rebroadcast failed"
        : "authorized signing recovery failed";
    db.transaction(() => {
      const now = new Date().toISOString();
      db.query("UPDATE payments SET status='failed', error=?, updated_at=? WHERE id=?").run(
        message,
        now,
        paymentId,
      );
      const current = store.getPaymentIntent(paymentId);
      if (current && canTransition(current.state as PaymentLifecycleState, "failed")) {
        advanceIntent(paymentId, "failed", "intent.rebroadcast_failed", message);
      }
      if (!artifact) {
        releaseActiveReservations(paymentId);
        db.query(
          `UPDATE wk_authorizations SET status='REVOKED', revoked_at=?
           WHERE id=? AND status='ACTIVE'`,
        ).run(now, authorization.id);
      }
      transitionExecution(executionId, "failed", {
        errorCode: recoveryMode === "exact-rebroadcast"
          ? "EXACT_REBROADCAST_FAILED"
          : "AUTHORIZED_SIGNING_RECOVERY_FAILED",
        errorMessage: message,
      });
    }).immediate();
    return {
      paymentId,
      status: "failed",
      txHash: artifact?.externalTxId ?? null,
      error: message,
      intentState: "failed",
    };
  }
  if (row.asset === "BTC" && row.fee_minor !== null) {
    receipt = {
      ...receipt,
      totalOutMinor: (BigInt(row.amount_minor) + BigInt(row.fee_minor)).toString(),
    };
  }
  return recordBroadcastSuccess(paymentId, row, context, receipt, executionId);
};

const recoveryFlights = new Map<string, Promise<ConfirmResult>>();

/** Coalesce concurrent local recovery calls. Every caller observes the same
 * network attempt and lifecycle result; a second request cannot race an
 * accepted response against an ambiguous one for the same execution. */
export const resumePaymentBroadcast = (paymentId: string): Promise<ConfirmResult> => {
  const existing = recoveryFlights.get(paymentId);
  if (existing) return existing;
  const recovery = resumePaymentBroadcastOnce(paymentId);
  recoveryFlights.set(paymentId, recovery);
  const cleanup = () => {
    if (recoveryFlights.get(paymentId) === recovery) recoveryFlights.delete(paymentId);
  };
  recovery.then(cleanup, cleanup);
  return recovery;
};

export const getPaymentTruth = (paymentId: string): PaymentTruthV1 | null =>
  baseReconciliation.getPaymentTruth(paymentId);

export const reconcileBasePayment = (paymentId: string, signal?: AbortSignal) =>
  baseReconciliation.reconcilePayment(paymentId, signal);

export const listPayments = (limit = 50) => (db.query(
  `SELECT p.id, p.account_id, p.rail, p.to_addr, p.asset, p.amount_minor,
          p.fee_minor, p.status, p.tx_hash, p.error, p.created_at,
          i.intent_hash, i.state AS intent_state
   FROM payments p LEFT JOIN wk_payment_intents i ON i.id=p.id
   ORDER BY p.created_at DESC LIMIT ?`,
).all(limit) as Array<Record<string, unknown> & { id: string; rail: string }>).map((row) => ({
  ...row,
  truth: row.rail === "evm-base" ? getPaymentTruth(row.id) : null,
}));

/** Local audit projection for humans and agents. It contains identifiers,
 * lifecycle and evidence only—never sealed blobs, credentials, or RPC URLs. */
export const getWalletKernelIntent = (intentId: string) => {
  const intent = store.getPaymentIntent(intentId);
  if (!intent) return null;
  const execution = store.getExecution(`execution.${intentId}.0`);
  const signedArtifact = execution?.preparedRef
    ? store.getSignedArtifactByAuthorization(execution.preparedRef)
    : null;
  const signedArtifactView = signedArtifact
    ? {
        id: signedArtifact.id,
        authorization_id: signedArtifact.authorizationId,
        request_hash: signedArtifact.requestHash,
        envelope_hash: signedArtifact.envelopeHash,
        encoding: signedArtifact.encoding,
        byte_length: (signedArtifact.payload.length - 2) / 2,
        external_tx_id: signedArtifact.externalTxId,
        recovery_available: execution?.state === "prepared" || execution?.state === "signed",
        created_at: signedArtifact.createdAt,
      }
    : null;
  let executionView = execution;
  if (
    execution?.response &&
    typeof execution.response === "object" &&
    !Array.isArray(execution.response)
  ) {
    const response = execution.response as Record<string, JsonValue>;
    const signed = response.signed_envelope;
    if (signed && typeof signed === "object" && !Array.isArray(signed)) {
      const envelope = signed as Record<string, JsonValue>;
      const payload = typeof envelope.payload === "string" ? envelope.payload : "";
      executionView = {
        ...execution,
        response: {
          ...response,
          signed_envelope: {
            encoding: envelope.encoding ?? "hex",
            payload_redacted: true,
            byte_length: payload.startsWith("0x") ? (payload.length - 2) / 2 : null,
            recovery_available: execution.state === "signed",
          },
        },
      };
    }
  }
  const receipt = store.getReceipt(`receipt.${intentId}.submission`);
  const receipts = store.listReceiptsForIntent(intentId);
  const chainSightings = store.listChainSightings({ intentId });
  const chainConsensus = store.listChainConsensus({ intentId });
  const observations = store.listObservationsForIntent(intentId);
  const reconciliationLinks = store.listReconciliationLinksForIntent(intentId);
  const reservations = db.query(
    `SELECT id, kind, resource_key, amount_atomic, state, expires_at,
            consumed_at, released_at
     FROM wk_reservations WHERE intent_id=? ORDER BY id`,
  ).all(intentId);
  const authorizations = db.query(
    `SELECT id, actor_type, actor_ref, method, request_hash, status,
            expires_at, consumed_at, revoked_at
     FROM wk_authorizations WHERE intent_id=? ORDER BY created_at`,
  ).all(intentId);
  const hasAgentAuthorizations = db.query(
    "SELECT 1 FROM sqlite_master WHERE type='table' AND name='wk_agent_authorizations'",
  ).get() !== null;
  const agentAuthorizations = hasAgentAuthorizations
    ? db.query(
      `SELECT id, grant_id, intent_record_id, status, expires_at,
              created_at, attested_at, consumed_at
       FROM wk_agent_authorizations WHERE payment_intent_id=? ORDER BY created_at`,
    ).all(intentId)
    : [];
  const journalEntries = store.listJournalEntriesForReferencePrefix({
    referenceIdPrefix: intentId,
  }).filter((entry) => entry.referenceId === intentId);
  const journal = journalEntries.map((entry) => ({
    id: entry.id,
    description: entry.description,
    effective_at: entry.effectiveAt,
    reference_type: entry.referenceType,
    reference_id: entry.referenceId,
    status: entry.status,
    metadata: entry.metadata,
    posted_at: entry.postedAt,
  }));
  const postings = journalEntries.flatMap((entry) => entry.postings.map((posting) => ({
    journal_entry_id: entry.id,
    posting_index: posting.index,
    ledger_account_id: posting.ledgerAccountId,
    asset_id: posting.assetId,
    direction: posting.direction,
    amount_atomic: posting.amountAtomic,
    memo: posting.memo,
  })));
  return {
    schema_version: "cashloom.wallet-kernel-intent/2",
    intent,
    events: store.listIntentEvents(intentId),
    quote: store.getQuote(`quote.${intentId}`),
    execution: executionView,
    signed_artifact: signedArtifactView,
    receipt,
    receipts,
    chain_sightings: chainSightings,
    chain_consensus: chainConsensus,
    observations,
    reconciliation_links: reconciliationLinks,
    truth: getPaymentTruth(intentId),
    reservations,
    authorizations,
    agent_authorizations: agentAuthorizations,
    journal,
    postings,
  } as const;
};

export const listWalletKernelPositions = () => ({
  schema_version: "cashloom.wallet-kernel-positions/2",
  positions: db.query(
    `SELECT p.account_id, p.asset_id, p.observed_atomic, p.pending_atomic,
            p.source, p.source_cursor, p.as_of, p.version,
            a.account_ref, a.chain_id, a.custody_mode, a.status AS account_status,
            s.symbol, s.name, s.decimals, s.kind AS asset_kind
     FROM wk_positions p
     JOIN wk_accounts a ON a.id=p.account_id
     JOIN wk_assets s ON s.id=p.asset_id
     ORDER BY p.account_id, p.asset_id`,
  ).all(),
});
