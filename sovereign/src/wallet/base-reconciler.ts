/**
 * Base transaction truth for Wallet Kernel v2.
 *
 * The immutable local signed artifact is the transaction authority. The
 * observer contributes only inclusion, outcome, fee and finality evidence;
 * transport failures and missing receipts never become "dropped" or release
 * a nonce. Economic settlement happens once, only after two-provider
 * finalized consensus, in the same SQLite transaction as the receipt,
 * journals and lifecycle transitions.
 */

import type { Database } from "bun:sqlite";
import { parsePreparedEvmQuote } from "../senders/evm.sender.ts";
import type { PaymentInstruction } from "../senders/types.ts";
import type { PaymentLifecycleState } from "./domain/lifecycle.ts";
import {
  type BaseCoreEvidence,
  type BaseEvidenceObserver,
  type BaseFinalizedConsensus,
  type BaseProviderSighting,
  type BaseTransactionObservation,
} from "./adapters/base-observer.ts";
import {
  canonicalJson,
  fingerprintRequest,
  type ChainConsensusRecord,
  type ChainSecurityLevel,
  type ChainSightingRecord,
  type JsonValue,
  type WalletKernelStore,
} from "./infrastructure/sqlite/index.ts";

export const BASE_CHAIN_ID = "eip155:8453" as const;
export const BASE_ETH_ASSET_ID = `${BASE_CHAIN_ID}/slip44:60` as const;
const SYSTEM_ACTOR = { type: "system", ref: "base-finality-quorum" } as const;
const EXECUTION_PREFIX = "execution.";

interface LegacyBasePaymentRow {
  id: string;
  account_id: string;
  rail: string;
  to_addr: string;
  asset: string;
  amount_minor: string;
  fee_minor: string | null;
  status: string;
  tx_hash: string | null;
  detail: string | null;
  created_at: string;
}

export interface BaseTruthFee {
  asset: typeof BASE_ETH_ASSET_ID;
  l2_execution_atomic: string | null;
  l1_data_security_atomic: string | null;
  operator_atomic: string | null;
  total_atomic: string | null;
  completeness: "unknown" | "estimated" | "exact";
  budget_atomic: string | null;
  budget_exceeded: boolean | null;
}

export interface PaymentTruthV1 {
  schema_version: "cashloom.payment-truth/1";
  intent_id: string;
  lifecycle_state: string | null;
  legacy_status: string;
  rail: string;
  chain_id: typeof BASE_CHAIN_ID;
  network_tx_id: string | null;
  visibility: "not_checked" | "not_found" | "mempool" | "included";
  execution_result: "success" | "reverted" | null;
  security_level: "unsafe" | "safe" | "finalized" | null;
  canonicality: "unknown" | "canonical" | "reorged" | "conflicted" | null;
  block: { number: string; hash: string } | null;
  fee: BaseTruthFee | null;
  checked_at: string | null;
  observed_at: string | null;
  evidence: {
    receipt_id: string | null;
    evidence_hash: string | null;
    provider_ids: string[];
    quorum: string | null;
  } | null;
  actions: {
    reconcile: boolean;
    exact_rebroadcast: boolean;
    safe_to_create_new_payment: boolean;
  };
}

export interface BaseReconcileResult {
  truth: PaymentTruthV1;
  check: {
    state: BaseTransactionObservation["state"];
    checked_at: string;
    available_providers: string;
    unavailable_providers: string;
  };
}

export interface BaseReconciliationService {
  getPaymentTruth(paymentId: string): PaymentTruthV1 | null;
  reconcilePayment(paymentId: string, signal?: AbortSignal): Promise<BaseReconcileResult>;
}

export interface BaseReconciliationDependencies {
  db: Database;
  store: WalletKernelStore;
  observer: BaseEvidenceObserver;
}

const sha256Id = (value: unknown): `sha256:${string}` =>
  `sha256:${fingerprintRequest(value)}`;

const asJson = (value: unknown): JsonValue => value as JsonValue;

const basePayment = (db: Database, paymentId: string): LegacyBasePaymentRow | null =>
  db.query(
    `SELECT id, account_id, rail, to_addr, asset, amount_minor, fee_minor,
            status, tx_hash, detail, created_at
     FROM payments WHERE id=?`,
  ).get(paymentId) as LegacyBasePaymentRow | null;

const canonicalUnsigned = (value: string | null): string | null =>
  value !== null && /^(0|[1-9][0-9]*)$/.test(value) ? value : null;

const requiredUnsigned = (value: unknown, label: string): bigint => {
  if (typeof value !== "string" || !/^(0|[1-9][0-9]*)$/.test(value)) {
    throw new Error(`Base finalized evidence has an invalid ${label}.`);
  }
  return BigInt(value);
};

const sameJson = (left: unknown, right: unknown): boolean =>
  canonicalJson(left) === canonicalJson(right);

const objectRecord = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;

/** Authenticate every provider sighting before it enters append-only audit
 * storage. Finalized accounting has its own stronger aggregate verifier below;
 * this boundary prevents an injected/alternate observer from corrupting the
 * pending, safe, or lone-provider evidence history with a mismatched body. */
const verifyProviderSightings = (
  observation: BaseTransactionObservation,
  row: LegacyBasePaymentRow,
  prepared: ReturnType<typeof parsePreparedEvmQuote>,
  expectedNetworkTxId: string,
): void => {
  if (
    observation.schema_version !== "cashloom.base-observation/1" ||
    observation.transaction_hash.toLowerCase() !== expectedNetworkTxId.toLowerCase() ||
    !Array.isArray(observation.providers) ||
    !Array.isArray(observation.sightings)
  ) {
    throw new Error("Base observer returned an invalid transaction observation envelope.");
  }
  const providers = new Map<string, BaseTransactionObservation["providers"][number]>();
  for (const provider of observation.providers) {
    if (providers.has(provider.provider_id)) {
      throw new Error("Base observer returned duplicate provider identities.");
    }
    providers.set(provider.provider_id, provider);
  }
  const sightingProviders = new Set<string>();
  for (const sighting of observation.sightings) {
    if (sightingProviders.has(sighting.provider_id)) {
      throw new Error("Base observer returned duplicate sightings for one provider check.");
    }
    sightingProviders.add(sighting.provider_id);
    const provider = providers.get(sighting.provider_id);
    if (!provider || provider.state === "unavailable") {
      throw new Error("Base observer sighting has no matching available provider result.");
    }
    const body = objectRecord(sighting.body);
    if (!body || !/^sha256:[0-9a-f]{64}$/.test(sighting.evidence_hash)) {
      throw new Error("Base observer returned a malformed provider sighting.");
    }
    if (sighting.visibility !== "INCLUDED") {
      const payment = objectRecord(body.authorized_payment);
      const expectedVisibility = provider.state === "pending" &&
          provider.reason === "transaction_not_visible"
        ? "NOT_FOUND"
        : provider.state === "pending" && provider.reason === "receipt_pending"
          ? "MEMPOOL"
          : null;
      if (
        provider.state !== "pending" ||
        expectedVisibility !== sighting.visibility ||
        sighting.outcome !== "UNKNOWN" ||
        sighting.security_level !== "UNSAFE" ||
        sighting.block_hash !== null ||
        sighting.block_number !== null ||
        body.schema_version !== "cashloom.base-sighting/1" ||
        typeof body.transaction_hash !== "string" ||
        body.transaction_hash.toLowerCase() !== expectedNetworkTxId.toLowerCase() ||
        body.visibility !== sighting.visibility ||
        !payment ||
        payment.asset !== row.asset ||
        typeof payment.from !== "string" ||
        payment.from.toLowerCase() !== prepared.detail.from.toLowerCase() ||
        typeof payment.beneficiary !== "string" ||
        payment.beneficiary.toLowerCase() !== prepared.detail.recipient.toLowerCase() ||
        payment.amount_atomic !== row.amount_minor ||
        sighting.evidence_hash !== sha256Id(sighting.body)
      ) {
        throw new Error("Base pending provider sighting does not authenticate its body.");
      }
      continue;
    }
    const evidenceRecord = objectRecord(body.evidence);
    if (
      provider.state !== "included" ||
      body.schema_version !== "cashloom.base-included-sighting/2" ||
      body.security_level !== sighting.security_level ||
      !evidenceRecord ||
      !objectRecord(evidenceRecord.transaction) ||
      !objectRecord(evidenceRecord.inclusion) ||
      !objectRecord(evidenceRecord.economic_effect)
    ) {
      throw new Error("Base included provider sighting has an invalid evidence wrapper.");
    }
    const evidence = evidenceRecord as unknown as BaseCoreEvidence;
    const { evidence_hash: claimedHash, ...hashBody } = evidence;
    const derivedSecurity = provider.finality.finalized.status === "confirmed"
      ? "FINALIZED"
      : provider.finality.safe.status === "confirmed"
        ? "SAFE"
        : "UNSAFE";
    const derivedOutcome = evidence.outcome === "success" ? "SUCCESS" : "REVERTED";
    if (
      (evidence.outcome !== "success" && evidence.outcome !== "reverted") ||
      claimedHash !== sighting.evidence_hash ||
      claimedHash !== `sha256:${fingerprintRequest(hashBody)}` ||
      evidence.transaction.hash.toLowerCase() !== expectedNetworkTxId.toLowerCase() ||
      evidence.transaction.from.toLowerCase() !== prepared.detail.from.toLowerCase() ||
      evidence.inclusion.block_hash !== sighting.block_hash ||
      evidence.inclusion.block_number !== sighting.block_number ||
      evidence.economic_effect.asset !== row.asset ||
      evidence.economic_effect.beneficiary.toLowerCase() !== prepared.detail.recipient.toLowerCase() ||
      evidence.economic_effect.amount_atomic !==
        (evidence.outcome === "success" ? row.amount_minor : "0") ||
      !sameJson(provider.evidence, evidence) ||
      derivedSecurity !== sighting.security_level ||
      derivedOutcome !== sighting.outcome
    ) {
      throw new Error("Base included provider sighting does not authenticate its evidence body.");
    }
  }
};

/** Re-prove the aggregate returned by an injected observer before any
 * immutable receipt or journal is written. The low-level adapter validates
 * RPC data; this boundary validates that its aggregate has not mixed bodies,
 * hashes, fee arithmetic, economic effects, or quorum endorsements. */
const verifiedFinalizedObservation = (
  observation: BaseTransactionObservation,
  row: LegacyBasePaymentRow,
  prepared: ReturnType<typeof parsePreparedEvmQuote>,
  expectedNetworkTxId: string,
): { evidence: BaseCoreEvidence; consensus: BaseFinalizedConsensus } | null => {
  if (
    observation.schema_version !== "cashloom.base-observation/1" ||
    observation.transaction_hash.toLowerCase() !== expectedNetworkTxId.toLowerCase() ||
    !Array.isArray(observation.providers) ||
    !Array.isArray(observation.sightings)
  ) {
    throw new Error("Base observer returned an invalid transaction observation envelope.");
  }
  const evidence = observation.evidence;
  const consensus = observation.consensus;
  if (!evidence && !consensus) {
    if (observation.state === "settled") {
      throw new Error("Base observer called an observation settled without finalized evidence.");
    }
    return null;
  }
  if (!evidence || !consensus || observation.state !== "settled") {
    throw new Error("Base observer returned incomplete finalized consensus.");
  }
  if (
    evidence.schema_version !== "cashloom.base-evidence/1" ||
    !/^sha256:[0-9a-f]{64}$/.test(evidence.evidence_hash) ||
    !/^0x[0-9a-f]{64}$/.test(evidence.inclusion.block_hash) ||
    evidence.transaction.hash.toLowerCase() !== observation.transaction_hash.toLowerCase()
  ) {
    throw new Error("Base observer returned malformed finalized evidence.");
  }
  const { evidence_hash: claimedHash, ...hashBody } = evidence;
  const recomputedHash = `sha256:${fingerprintRequest(hashBody)}`;
  if (claimedHash !== recomputedHash) {
    throw new Error("Base finalized evidence hash does not authenticate its canonical body.");
  }
  const request = prepared.request;
  if (
    evidence.transaction.hash.toLowerCase() !== expectedNetworkTxId.toLowerCase() ||
    evidence.transaction.from.toLowerCase() !== request.from.toLowerCase() ||
    evidence.transaction.to.toLowerCase() !== request.to.toLowerCase() ||
    evidence.transaction.nonce !== request.nonce.toString() ||
    evidence.transaction.value_wei !== request.valueAtomic ||
    evidence.transaction.calldata.toLowerCase() !== request.data.toLowerCase() ||
    evidence.transaction.gas_limit !== request.gasLimit ||
    evidence.transaction.max_fee_per_gas_wei !== request.maxFeePerGas ||
    evidence.transaction.max_priority_fee_per_gas_wei !== request.maxPriorityFeePerGas ||
    !Array.isArray(evidence.transaction.access_list) ||
    evidence.transaction.access_list.length !== 0
  ) {
    throw new Error("Base finalized evidence does not match the immutable signed request.");
  }
  requiredUnsigned(evidence.inclusion.block_number, "block number");
  requiredUnsigned(evidence.inclusion.block_timestamp, "block timestamp");
  requiredUnsigned(evidence.inclusion.transaction_index, "transaction index");
  const gasUsed = requiredUnsigned(evidence.fees.gas_used, "gas used");
  const effectiveGasPrice = requiredUnsigned(
    evidence.fees.effective_gas_price_wei,
    "effective gas price",
  );
  const l2Execution = requiredUnsigned(evidence.fees.l2_execution_fee_wei, "L2 execution fee");
  const l1Data = requiredUnsigned(evidence.fees.l1_data_fee_wei, "L1 data fee");
  const operator = requiredUnsigned(evidence.fees.operator_fee_wei, "operator fee");
  const total = requiredUnsigned(evidence.fees.total_fee_wei, "total fee");
  if (
    gasUsed > BigInt(request.gasLimit) ||
    effectiveGasPrice > BigInt(request.maxFeePerGas) ||
    l2Execution !== gasUsed * effectiveGasPrice ||
    total !== l2Execution + l1Data + operator
  ) {
    throw new Error("Base finalized evidence has inconsistent exact fee arithmetic.");
  }
  const success = evidence.outcome === "success";
  if (
    (!success && evidence.outcome !== "reverted") ||
    evidence.economic_effect.asset !== row.asset ||
    evidence.economic_effect.beneficiary.toLowerCase() !== prepared.detail.recipient.toLowerCase() ||
    evidence.economic_effect.amount_atomic !== (success ? row.amount_minor : "0") ||
    (row.asset === "USDC" && success &&
      requiredUnsigned(evidence.economic_effect.transfer_log_index, "USDC transfer log index") < 0n) ||
    ((row.asset === "ETH" || !success) && evidence.economic_effect.transfer_log_index !== undefined)
  ) {
    throw new Error("Base finalized evidence has an invalid economic effect.");
  }
  const providerIds = consensus.provider_ids;
  const quorumGroup = Array.isArray(observation.quorum?.groups)
    ? observation.quorum.groups.find((group) => group.evidence_hash === claimedHash)
    : undefined;
  if (
    consensus.security_level !== "FINALIZED" ||
    consensus.quorum !== "2" ||
    !Array.isArray(providerIds) ||
    new Set(providerIds).size !== providerIds.length ||
    providerIds.length < 2 ||
    consensus.evidence_hash !== claimedHash ||
    consensus.outcome !== (success ? "SUCCESS" : "REVERTED") ||
    consensus.block_hash !== evidence.inclusion.block_hash ||
    consensus.block_number !== evidence.inclusion.block_number ||
    !sameJson(consensus.body, evidence) ||
    observation.quorum.required_distinct_providers !== "2" ||
    !quorumGroup ||
    providerIds.some((providerId) =>
      !quorumGroup.provider_ids.includes(providerId) ||
      !quorumGroup.finalized_provider_ids.includes(providerId)
    )
  ) {
    throw new Error("Base finalized consensus does not exactly bind its evidence body.");
  }
  for (const providerId of providerIds) {
    const provider = observation.providers.find((candidate) =>
      candidate.provider_id === providerId && candidate.state === "included"
    );
    const sighting = observation.sightings.find((candidate) =>
      candidate.provider_id === providerId &&
      candidate.visibility === "INCLUDED" &&
      candidate.outcome === (success ? "SUCCESS" : "REVERTED") &&
      candidate.security_level === "FINALIZED" &&
      candidate.evidence_hash === claimedHash &&
      candidate.block_hash === evidence.inclusion.block_hash &&
      candidate.block_number === evidence.inclusion.block_number
    );
    if (
      !provider || provider.state !== "included" || !sighting ||
      !sameJson(provider.evidence, evidence) ||
      provider.finality.latest.status !== "confirmed" ||
      provider.finality.safe.status !== "confirmed" ||
      provider.finality.finalized.status !== "confirmed"
    ) {
      throw new Error("Base finalized consensus cites a provider without matching exact evidence.");
    }
  }
  return { evidence, consensus };
};

const blockTimestampIso = (seconds: string, fallback: string): string => {
  if (!/^(0|[1-9][0-9]*)$/.test(seconds)) return fallback;
  const value = BigInt(seconds);
  // ECMAScript Date's TimeClip bound is 8.64e15 milliseconds.
  if (value > 8_640_000_000_000n) return fallback;
  const parsed = new Date(Number(value * 1_000n));
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : fallback;
};

const sightingId = (
  paymentId: string,
  sighting: BaseProviderSighting,
): string => `chain-sighting.${fingerprintRequest({
  payment_id: paymentId,
  provider_id: sighting.provider_id,
  evidence_hash: sighting.evidence_hash,
  visibility: sighting.visibility,
  outcome: sighting.outcome,
  security_level: sighting.security_level,
  block_hash: sighting.block_hash,
  block_number: sighting.block_number,
  observed_at: sighting.observed_at,
  fetched_at: sighting.fetched_at,
})}`;

const consensusId = (paymentId: string, evidenceHash: string): string =>
  `chain-consensus.${fingerprintRequest({ payment_id: paymentId, evidence_hash: evidenceHash })}`;

const securityRank: Readonly<Record<ChainSecurityLevel, number>> = {
  UNSAFE: 0,
  SAFE: 1,
  FINALIZED: 2,
};

const latestSightingsByProvider = (
  sightings: readonly ChainSightingRecord[],
): ChainSightingRecord[] => {
  const latest = new Map<string, ChainSightingRecord>();
  for (const sighting of sightings) {
    const prior = latest.get(sighting.providerId);
    if (
      !prior ||
      sighting.fetchedAt > prior.fetchedAt ||
      (sighting.fetchedAt === prior.fetchedAt && sighting.createdAt > prior.createdAt)
    ) {
      latest.set(sighting.providerId, sighting);
    }
  }
  return [...latest.values()].sort((left, right) => left.providerId.localeCompare(right.providerId));
};

const evidenceFromConsensus = (consensus: ChainConsensusRecord): BaseCoreEvidence | null => {
  const body = consensus.body as Partial<BaseCoreEvidence>;
  if (
    body.schema_version !== "cashloom.base-evidence/1" ||
    body.evidence_hash !== consensus.evidenceHash ||
    !body.inclusion ||
    !body.fees ||
    (body.outcome !== "success" && body.outcome !== "reverted")
  ) return null;
  return body as BaseCoreEvidence;
};

const receiptIdFor = (paymentId: string, evidenceHash: string): string =>
  `receipt.${paymentId}.base-finalized.${fingerprintRequest(evidenceHash).slice(0, 24)}`;

const makeTruth = (
  db: Database,
  store: WalletKernelStore,
  row: LegacyBasePaymentRow,
): PaymentTruthV1 => {
  const intent = store.getPaymentIntent(row.id);
  const executionId = `${EXECUTION_PREFIX}${row.id}.0`;
  const execution = store.getExecution(executionId);
  const sightings = store.listChainSightings({ intentId: row.id, chainId: BASE_CHAIN_ID });
  const latest = latestSightingsByProvider(sightings);
  const finalized = store.listChainConsensus({
    intentId: row.id,
    chainId: BASE_CHAIN_ID,
    securityLevel: "FINALIZED",
  });
  const distinctFinal = new Map(finalized.map((entry) => [entry.evidenceHash, entry]));
  const conflicted = distinctFinal.size > 1;
  // If providers later contradict a posted finalized event, continue showing
  // the consensus whose immutable receipt actually posted the economic event.
  // `decided_at` is evidence time, not commit order, so selecting the first
  // sorted consensus could display the later contradictory body while the
  // journals still contain the first committed one.
  const finalCandidates = [...distinctFinal.values()];
  const receiptBackedConsensus = finalCandidates.find((entry) =>
    store.getReceipt(receiptIdFor(row.id, entry.evidenceHash)) !== null
  );
  const finalConsensus = receiptBackedConsensus ?? finalCandidates[0] ?? null;
  const finalEvidence = finalConsensus ? evidenceFromConsensus(finalConsensus) : null;
  const includedLatest = latest
    .filter((entry) => entry.visibility === "INCLUDED")
    .sort((left, right) => {
      const rank = securityRank[right.securityLevel] - securityRank[left.securityLevel];
      return rank !== 0 ? rank : right.fetchedAt.localeCompare(left.fetchedAt);
    });
  const bestIncluded = includedLatest[0] ?? null;

  let visibility: PaymentTruthV1["visibility"] = "not_checked";
  if (finalConsensus || bestIncluded) visibility = "included";
  else if (latest.some((entry) => entry.visibility === "MEMPOOL")) visibility = "mempool";
  else if (latest.some((entry) => entry.visibility === "NOT_FOUND")) visibility = "not_found";

  let canonicality: PaymentTruthV1["canonicality"] = null;
  if (conflicted) canonicality = "conflicted";
  else if (finalConsensus) canonicality = "canonical";
  else if (bestIncluded) {
    const matching = includedLatest.filter((entry) =>
      entry.evidenceHash === bestIncluded.evidenceHash &&
      entry.blockHash === bestIncluded.blockHash &&
      entry.blockNumber === bestIncluded.blockNumber
    );
    canonicality = new Set(matching.map((entry) => entry.providerId)).size >= 2
      ? "canonical"
      : "unknown";
  } else if (visibility !== "not_checked") canonicality = "unknown";

  const budget = canonicalUnsigned(row.fee_minor);
  const fee: BaseTruthFee | null = finalEvidence
    ? {
        asset: BASE_ETH_ASSET_ID,
        l2_execution_atomic: finalEvidence.fees.l2_execution_fee_wei,
        l1_data_security_atomic: finalEvidence.fees.l1_data_fee_wei,
        operator_atomic: finalEvidence.fees.operator_fee_wei,
        total_atomic: finalEvidence.fees.total_fee_wei,
        completeness: "exact",
        budget_atomic: budget,
        budget_exceeded: budget === null
          ? null
          : BigInt(finalEvidence.fees.total_fee_wei) > BigInt(budget),
      }
    : budget === null
      ? null
      : {
          asset: BASE_ETH_ASSET_ID,
          l2_execution_atomic: null,
          l1_data_security_atomic: null,
          operator_atomic: null,
          total_atomic: null,
          completeness: "estimated",
          budget_atomic: budget,
          budget_exceeded: null,
        };
  const checkedAt = latest.reduce<string | null>(
    (current, entry) => current === null || entry.fetchedAt > current ? entry.fetchedAt : current,
    finalConsensus?.decidedAt ?? null,
  );
  const result = finalEvidence?.outcome ?? (
    bestIncluded?.outcome === "SUCCESS"
      ? "success"
      : bestIncluded?.outcome === "REVERTED"
        ? "reverted"
        : null
  );
  const block = finalConsensus
    ? { number: finalConsensus.blockNumber!, hash: finalConsensus.blockHash! }
    : bestIncluded?.blockNumber && bestIncluded.blockHash
      ? { number: bestIncluded.blockNumber, hash: bestIncluded.blockHash }
      : null;
  const matchingProviders = finalConsensus
    ? [...finalConsensus.providerIds]
    : bestIncluded
      ? includedLatest
          .filter((entry) => entry.evidenceHash === bestIncluded.evidenceHash)
          .map((entry) => entry.providerId)
          .sort()
      : [];
  const receiptId = finalConsensus
    ? receiptIdFor(row.id, finalConsensus.evidenceHash)
    : null;
  const hasArtifact = execution?.signedArtifactId
    ? store.getSignedArtifact(execution.signedArtifactId) !== null
    : false;
  const finalizedCanonical = finalConsensus !== null && !conflicted && finalEvidence !== null;

  return {
    schema_version: "cashloom.payment-truth/1",
    intent_id: row.id,
    lifecycle_state: intent?.state ?? null,
    legacy_status: row.status,
    rail: row.rail,
    chain_id: BASE_CHAIN_ID,
    network_tx_id: execution?.networkTxId ?? row.tx_hash,
    visibility,
    execution_result: result,
    security_level: finalConsensus
      ? "finalized"
      : bestIncluded
        ? bestIncluded.securityLevel.toLowerCase() as "unsafe" | "safe" | "finalized"
        : null,
    canonicality,
    block,
    fee,
    checked_at: checkedAt,
    observed_at: finalEvidence
      ? blockTimestampIso(finalEvidence.inclusion.block_timestamp, finalConsensus!.decidedAt)
      : bestIncluded?.observedAt ?? null,
    evidence: finalConsensus || bestIncluded
      ? {
          receipt_id: finalConsensus && store.getReceipt(receiptId!) ? receiptId : null,
          evidence_hash: finalConsensus?.evidenceHash ?? bestIncluded?.evidenceHash ?? null,
          provider_ids: matchingProviders,
          quorum: finalConsensus ? finalConsensus.quorum.toString() : null,
        }
      : null,
    actions: {
      reconcile: hasArtifact && !finalizedCanonical && !conflicted,
      exact_rebroadcast: hasArtifact && !finalizedCanonical &&
        (execution?.state === "signed" || execution?.state === "ambiguous"),
      safe_to_create_new_payment: finalizedCanonical,
    },
  };
};

const persistSighting = (
  store: WalletKernelStore,
  paymentId: string,
  executionId: string,
  networkTxId: string,
  sighting: BaseProviderSighting,
): void => {
  // Each explicit observation round is retained. Including its clocks in the
  // fact identity lets INCLUDED -> NOT_FOUND -> INCLUDED become a truthful
  // temporal sequence instead of leaving absence as the permanent latest row.
  store.appendChainSighting({
    id: sightingId(paymentId, sighting),
    intentId: paymentId,
    executionId,
    chainId: BASE_CHAIN_ID,
    networkTxId,
    providerId: sighting.provider_id,
    evidenceHash: sighting.evidence_hash,
    visibility: sighting.visibility,
    outcome: sighting.outcome,
    securityLevel: sighting.security_level,
    blockHash: sighting.block_hash,
    blockNumber: sighting.block_number,
    body: sighting.body,
    observedAt: sighting.observed_at,
    fetchedAt: sighting.fetched_at,
  });
};

const ensureFinalizedTransferProjection = (
  db: Database,
  store: WalletKernelStore,
  row: LegacyBasePaymentRow,
  networkTxId: string,
  blockTime: string,
): void => {
  const intent = store.getPaymentIntent(row.id);
  if (!intent) throw new Error(`Payment intent ${row.id} disappeared before settlement.`);
  const clearingLedgerId = "ledger.clearing.payments";
  const assetLedgerId = `ledger.asset.${row.account_id}`;
  const journalId = `journal.${row.id}.submitted`;
  const expectedPostings = [
    {
      ledgerAccountId: clearingLedgerId,
      assetId: intent.assetId,
      direction: "DEBIT" as const,
      amountAtomic: row.amount_minor,
    },
    {
      ledgerAccountId: assetLedgerId,
      assetId: intent.assetId,
      direction: "CREDIT" as const,
      amountAtomic: row.amount_minor,
    },
  ];
  const existingJournal = store.getJournalEntry(journalId);
  if (existingJournal) {
    const exact = existingJournal.referenceType === "PAYMENT_INTENT" &&
      existingJournal.referenceId === row.id &&
      existingJournal.postings.length === expectedPostings.length &&
      existingJournal.postings.every((posting, index) => {
        const expected = expectedPostings[index]!;
        return posting.ledgerAccountId === expected.ledgerAccountId &&
          posting.assetId === expected.assetId &&
          posting.direction === expected.direction &&
          posting.amountAtomic === expected.amountAtomic;
      });
    if (!exact) {
      throw new Error("Existing payment submission journal conflicts with finalized Base evidence.");
    }
  } else {
    store.postJournalEntry({
      id: journalId,
      description: `Outbound ${row.asset} transfer recovered from finalized Base evidence`,
      effectiveAt: blockTime,
      referenceType: "PAYMENT_INTENT",
      referenceId: row.id,
      metadata: {
        network_tx_id: networkTxId,
        lifecycle_state: "submitted_from_finalized_evidence",
        network_fee: "recorded_separately_from_finalized_chain_observation",
      },
      postings: expectedPostings,
    });
  }

  const existingLegacy = db.query(
    `SELECT amount_minor, source FROM transactions
     WHERE account_id=? AND external_id=?`,
  ).get(row.account_id, networkTxId) as { amount_minor: string; source: string } | null;
  if (existingLegacy) {
    if (existingLegacy.amount_minor !== `-${row.amount_minor}` || existingLegacy.source !== "PAYMENT") {
      throw new Error("Existing legacy payment projection conflicts with finalized Base evidence.");
    }
  } else {
    db.query(
      `INSERT INTO transactions
         (id, account_id, external_id, title, amount_minor, date, source)
       VALUES (?, ?, ?, ?, ?, ?, 'PAYMENT')`,
    ).run(
      `transaction.${row.id}.base-finalized-transfer`,
      row.account_id,
      networkTxId,
      `pay · ${row.asset} → ${row.to_addr.slice(0, 12)}…`,
      `-${row.amount_minor}`,
      blockTime,
    );
  }
};

const settleFinalized = (
  db: Database,
  store: WalletKernelStore,
  row: LegacyBasePaymentRow,
  finalized: { evidence: BaseCoreEvidence; consensus: BaseFinalizedConsensus } | null,
): void => {
  if (!finalized) return;
  const { consensus, evidence } = finalized;
  const executionId = `${EXECUTION_PREFIX}${row.id}.0`;
  const networkTxId = evidence.transaction.hash;
  const decidedAt = consensus.observed_at;
  const blockTime = blockTimestampIso(evidence.inclusion.block_timestamp, decidedAt);
  const consensusRecord = store.appendChainConsensus({
    id: consensusId(row.id, consensus.evidence_hash),
    intentId: row.id,
    executionId,
    chainId: BASE_CHAIN_ID,
    networkTxId,
    evidenceHash: consensus.evidence_hash,
    visibility: "INCLUDED",
    outcome: consensus.outcome,
    securityLevel: "FINALIZED",
    blockHash: consensus.block_hash,
    blockNumber: consensus.block_number,
    providerIds: consensus.provider_ids,
    quorum: Number(consensus.quorum),
    body: asJson(consensus.body),
    decidedAt,
  }).consensus;
  const allFinal = store.listChainConsensus({
    intentId: row.id,
    executionId,
    chainId: BASE_CHAIN_ID,
    securityLevel: "FINALIZED",
  });
  if (new Set(allFinal.map((entry) => entry.evidenceHash)).size > 1) {
    // Preserve the contradictory final statements for operator review. Never
    // rewrite an already-posted economic event from conflicting RPC claims.
    return;
  }

  const feeBudget = canonicalUnsigned(row.fee_minor);
  const feeBudgetExceeded = feeBudget === null
    ? null
    : BigInt(evidence.fees.total_fee_wei) > BigInt(feeBudget);
  const receiptBody = {
    schema_version: "cashloom.base-finality-receipt/1",
    intent_id: row.id,
    execution_id: executionId,
    chain_id: BASE_CHAIN_ID,
    network_tx_id: networkTxId,
    outcome: evidence.outcome,
    security_level: "finalized",
    canonical_block: {
      number: evidence.inclusion.block_number,
      hash: evidence.inclusion.block_hash,
      timestamp: evidence.inclusion.block_timestamp,
      transaction_index: evidence.inclusion.transaction_index,
    },
    economic_effect: evidence.economic_effect,
    fee: {
      asset_id: BASE_ETH_ASSET_ID,
      ...evidence.fees,
      quoted_budget_atomic: feeBudget,
      budget_exceeded: feeBudgetExceeded,
      truth_policy: "record_exact_chain_fee_even_when_quote_budget_is_exceeded",
    },
    proof: {
      method: "two-distinct-provider-finalized-consensus",
      provider_ids: [...consensusRecord.providerIds],
      quorum: consensusRecord.quorum.toString(),
      evidence_hash: consensusRecord.evidenceHash,
    },
    observed_at: blockTime,
    decided_at: consensusRecord.decidedAt,
  } as const;
  const receiptId = receiptIdFor(row.id, consensusRecord.evidenceHash);
  const receipt = store.recordReceipt({
    id: receiptId,
    intentId: row.id,
    executionId,
    kind: evidence.outcome === "success"
      ? "BASE_FINALIZED_SUCCESS"
      : "BASE_FINALIZED_REVERTED",
    receiptHash: sha256Id(receiptBody),
    body: asJson(receiptBody),
    observedAt: blockTime,
  }).receipt;
  const observationRecord = store.appendObservation({
    id: `observation.${row.id}.base-finalized.${fingerprintRequest(consensusRecord.evidenceHash).slice(0, 24)}`,
    accountId: row.account_id,
    assetId: store.getPaymentIntent(row.id)?.assetId ?? null,
    provider: "base-finalized-quorum",
    externalId: `${networkTxId}:${evidence.inclusion.block_hash}:${evidence.outcome}`,
    kind: "BASE_TRANSACTION_FINALIZED",
    state: evidence.outcome.toUpperCase(),
    occurredAt: blockTime,
    body: asJson(receiptBody),
  }).observation;

  // A timeout can leave the durable artifact in signed/ambiguous state even
  // though the chain accepted it. Finalized inclusion itself proves the
  // transfer attempt, so establish its provisional journal/legacy projection
  // exactly once before success or a compensating revert is posted.
  ensureFinalizedTransferProjection(db, store, row, networkTxId, blockTime);

  const clearingLedgerId = "ledger.clearing.payments";
  const assetLedgerId = `ledger.asset.${row.account_id}`;
  const feeLedgerId = row.asset.toUpperCase() === "USDC"
    ? `ledger.asset.${row.account_id}.${BASE_ETH_ASSET_ID}`
    : assetLedgerId;
  const feeJournalId = `journal.${row.id}.base-finalized.fee`;
  if (BigInt(evidence.fees.total_fee_wei) > 0n) {
    store.postJournalEntry({
      id: feeJournalId,
      description: `Finalized Base network fee for ${networkTxId}`,
      effectiveAt: blockTime,
      referenceType: "PAYMENT_INTENT_NETWORK_FEE",
      referenceId: row.id,
      metadata: asJson(receiptBody),
      postings: [
        {
          ledgerAccountId: clearingLedgerId,
          assetId: BASE_ETH_ASSET_ID,
          direction: "DEBIT",
          amountAtomic: evidence.fees.total_fee_wei,
        },
        {
          ledgerAccountId: feeLedgerId,
          assetId: BASE_ETH_ASSET_ID,
          direction: "CREDIT",
          amountAtomic: evidence.fees.total_fee_wei,
        },
      ],
    });
  }

  if (evidence.outcome === "reverted") {
    store.postJournalEntry({
      id: `journal.${row.id}.base-finalized.reversal`,
      description: `Reverse reverted Base transfer ${networkTxId}`,
      effectiveAt: blockTime,
      referenceType: "PAYMENT_INTENT_REVERSAL",
      referenceId: row.id,
      metadata: {
        network_tx_id: networkTxId,
        receipt_id: receipt.id,
        reason: "finalized_evm_execution_reverted",
      },
      postings: [
        {
          ledgerAccountId: assetLedgerId,
          assetId: store.getPaymentIntent(row.id)!.assetId,
          direction: "DEBIT",
          amountAtomic: row.amount_minor,
        },
        {
          ledgerAccountId: clearingLedgerId,
          assetId: store.getPaymentIntent(row.id)!.assetId,
          direction: "CREDIT",
          amountAtomic: row.amount_minor,
        },
      ],
    });
    db.query(
      `INSERT OR IGNORE INTO transactions
         (id, account_id, external_id, title, amount_minor, date, source)
       VALUES (?, ?, ?, ?, ?, ?, 'PAYMENT')`,
    ).run(
      `transaction.${row.id}.base-reversal`,
      row.account_id,
      `${networkTxId}:cashloom-reversal`,
      `reverted pay · ${row.asset} transfer reversed`,
      row.amount_minor,
      blockTime,
    );
  }

  store.appendReconciliationLink({
    id: `reconciliation.${row.id}.base-finalized.${fingerprintRequest(consensusRecord.evidenceHash).slice(0, 24)}`,
    observationId: observationRecord.id,
    intentId: row.id,
    executionId,
    journalEntryId: BigInt(evidence.fees.total_fee_wei) > 0n ? feeJournalId : null,
    matchKind: "SIGNED_TX_HASH_AND_FINALIZED_QUORUM",
    confidenceBps: 10_000,
    data: {
      receipt_id: receipt.id,
      consensus_id: consensusRecord.id,
      evidence_hash: consensusRecord.evidenceHash,
      provider_ids: [...consensusRecord.providerIds],
    },
  });

  let execution = store.getExecution(executionId);
  if (execution?.state === "signed") {
    execution = store.transitionExecution({
      id: execution.id,
      expectedState: "signed",
      expectedVersion: execution.version,
      toState: "submitted",
      submissionRef: networkTxId,
      networkTxId,
      submittedAt: blockTime,
    });
  }
  const preservedLocalFailure = execution?.state === "failed";
  if (execution && execution.state !== "succeeded" && execution.state !== "failed") {
    if (execution.state !== "submitted" && execution.state !== "ambiguous") {
      throw new Error(
        `Finalized Base evidence cannot settle execution ${execution.id} from ${execution.state}.`,
      );
    }
    store.transitionExecution({
      id: execution.id,
      expectedState: execution.state,
      expectedVersion: execution.version,
      toState: evidence.outcome === "success" ? "succeeded" : "failed",
      ambiguous: false,
      errorCode: evidence.outcome === "reverted" ? "BASE_EXECUTION_REVERTED" : null,
      errorMessage: evidence.outcome === "reverted"
        ? "Finalized Base receipt reports EVM execution reverted."
        : null,
      settledAt: blockTime,
    });
  }
  let intent = store.getPaymentIntent(row.id);
  if (intent?.state === "signed") {
    intent = store.transitionIntent({
      intentId: row.id,
      expectedState: "signed",
      expectedVersion: intent.version,
      toState: "submitted",
      actor: SYSTEM_ACTOR,
      eventType: "intent.submission_proven_by_base_finality",
      data: { receipt_id: receipt.id, network_tx_id: networkTxId },
      at: blockTime,
    });
  }
  const targetIntentState: PaymentLifecycleState = evidence.outcome === "success"
    ? "settled"
    : "failed";
  if (intent && intent.state !== targetIntentState && intent.state !== "failed") {
    store.transitionIntent({
      intentId: row.id,
      expectedState: intent.state,
      expectedVersion: intent.version,
      toState: targetIntentState,
      actor: SYSTEM_ACTOR,
      eventType: evidence.outcome === "success"
        ? "intent.base_finalized"
        : "intent.base_reverted",
      data: {
        receipt_id: receipt.id,
        consensus_id: consensusRecord.id,
        evidence_hash: consensusRecord.evidenceHash,
      },
      at: blockTime,
    });
  }
  db.query(
    `UPDATE payments SET status=?, error=?, tx_hash=?, updated_at=? WHERE id=?`,
  ).run(
    evidence.outcome === "success" ? "settled" : "failed",
    evidence.outcome === "success"
      ? preservedLocalFailure
        ? "Finalized Base evidence proves success; the earlier local execution failure is retained in its audit record."
        : null
      : "Finalized Base receipt reverted; transfer value was reversed and the exact network fee retained.",
    networkTxId,
    blockTime,
    row.id,
  );
};

export const createBaseReconciliationService = (
  dependencies: BaseReconciliationDependencies,
): BaseReconciliationService => {
  const { db, store, observer } = dependencies;
  return Object.freeze({
    getPaymentTruth(paymentId: string): PaymentTruthV1 | null {
      const row = basePayment(db, paymentId);
      if (!row || row.rail !== "evm-base") return null;
      return makeTruth(db, store, row);
    },

    async reconcilePayment(paymentId: string, signal?: AbortSignal): Promise<BaseReconcileResult> {
      const row = basePayment(db, paymentId);
      if (!row) throw new Error(`No payment ${paymentId}.`);
      if (row.rail !== "evm-base" || (row.asset !== "ETH" && row.asset !== "USDC")) {
        throw new Error("Base reconciliation supports locally signed Base ETH and native USDC only.");
      }
      const executionId = `${EXECUTION_PREFIX}${paymentId}.0`;
      const execution = store.getExecution(executionId);
      const artifact = execution?.signedArtifactId
        ? store.getSignedArtifact(execution.signedArtifactId)
        : null;
      if (
        !execution ||
        !artifact ||
        !execution.networkTxId ||
        artifact.externalTxId.toLowerCase() !== execution.networkTxId.toLowerCase() ||
        (row.tx_hash !== null &&
          row.tx_hash.toLowerCase() !== execution.networkTxId.toLowerCase())
      ) {
        throw new Error(
          "This payment has no exact durable Base signed artifact and transaction id to reconcile.",
        );
      }
      const instruction: PaymentInstruction = {
        to: row.to_addr,
        amountMinor: row.amount_minor,
        asset: row.asset,
        detail: row.detail,
      };
      const prepared = parsePreparedEvmQuote(instruction);
      if (
        execution.requestHash !== prepared.requestHash ||
        artifact.requestHash !== prepared.requestHash ||
        artifact.intentId !== paymentId
      ) {
        throw new Error("The durable Base artifact no longer matches its immutable payment quote.");
      }
      const observed = await observer.observe({
        signed_transaction: artifact.payload,
        expected_transaction_hash: execution.networkTxId as `0x${string}`,
        payment: {
          asset: row.asset,
          from: prepared.detail.from,
          beneficiary: prepared.detail.recipient,
          amount_atomic: row.amount_minor,
        },
      }, signal);
      verifyProviderSightings(observed, row, prepared, execution.networkTxId);
      const finalized = verifiedFinalizedObservation(
        observed,
        row,
        prepared,
        execution.networkTxId,
      );
      db.transaction(() => {
        for (const sighting of observed.sightings) {
          persistSighting(store, paymentId, executionId, execution.networkTxId!, sighting);
        }
        settleFinalized(db, store, row, finalized);
      }).immediate();
      const truth = makeTruth(db, store, basePayment(db, paymentId)!);
      return {
        truth,
        check: {
          state: observed.state,
          checked_at: observed.observed_at,
          available_providers: observed.providers
            .filter((provider) => provider.state !== "unavailable").length.toString(),
          unavailable_providers: observed.providers
            .filter((provider) => provider.state === "unavailable").length.toString(),
        },
      };
    },
  });
};
