/**
 * Durable Base position truth: explicit network refresh, instant local reads.
 *
 * The observer is evidence-only and this service independently authenticates
 * its aggregate before append-only sightings or a finalized position snapshot
 * can enter SQLite. Normal GETs call only listPositions(); they never touch an
 * RPC. A missing or disagreeing provider never becomes a zero balance.
 */

import type { Database } from "bun:sqlite";
import {
  type BaseFinalizedPositionSnapshot,
  type BasePositionObservation,
  type BasePositionObserver,
  type BasePositionProviderSighting,
} from "./adapters/base-position-observer.ts";
import {
  BASE_CHAIN_ID,
  BASE_ETH_ASSET_ID,
  BASE_USDC_ASSET_ID,
  ensureBaseAccountProjection,
  resolveBaseAccount,
} from "./base-account-projection.ts";
import {
  fingerprintRequest,
  type ApplyBasePositionSnapshotOutcome,
  type BasePositionRefreshAttemptRecord,
  type BasePositionRecord,
  type JsonValue,
  type WalletKernelStore,
} from "./infrastructure/sqlite/index.ts";

interface LegacyPositionRow {
  account_id: string;
  asset_id: string;
  observed_atomic: string;
  pending_atomic: string;
  source: string;
  source_cursor: string | null;
  as_of: string;
  version: number;
  account_ref: string | null;
  chain_id: string | null;
  custody_mode: string;
  account_status: string;
  symbol: string;
  name: string;
  decimals: number;
  asset_kind: string;
}

export interface WalletPositionView {
  readonly account_id: string;
  readonly asset_id: string;
  readonly observed_atomic: string;
  readonly pending_atomic: string;
  readonly source: string;
  readonly source_cursor: string | null;
  readonly as_of: string;
  readonly version: number;
  readonly symbol: string;
  readonly name: string;
  readonly decimals: number;
}

export interface BaseAccountPositionView {
  readonly account_id: string;
  readonly label: string;
  readonly chain_id: typeof BASE_CHAIN_ID;
  readonly account_ref: string;
  readonly address: string;
  readonly custody_mode: "watch_only" | "local_self_custody" | "unknown";
  readonly status: "not_checked" | "finalized" | "conflicted" | "identity_invalid";
  readonly snapshot: {
    readonly snapshot_id: string;
    readonly block: {
      readonly number: string;
      readonly hash: string;
      readonly timestamp: string;
    };
    readonly evidence_hash: string;
    readonly provider_ids: readonly string[];
    readonly quorum: string;
    readonly observed_at: string;
    readonly applied_at: string;
  } | null;
  readonly positions: readonly WalletPositionView[];
  readonly identity_group: {
    readonly canonical_account_ref: string;
    readonly canonical_account_id: string;
    readonly account_ids: readonly string[];
    readonly duplicate: boolean;
  };
  readonly last_refresh: BasePositionRefreshAttemptView | null;
  readonly actions: { readonly refresh: boolean };
  readonly refusal?: {
    readonly code: "base_account_identity_invalid";
    readonly message: string;
  };
}

export interface BasePositionRefreshAttemptView {
  readonly attempt_id: string;
  readonly attempted_at: string;
  readonly outcome: BasePositionRefreshAttemptRecord["outcome"];
  readonly reason_code: string;
  readonly provider_count: string;
  readonly available_provider_count: string;
  readonly agreeing_provider_count: string;
  readonly retained_head: {
    readonly snapshot_id: string;
    readonly state: "ACTIVE" | "FROZEN";
    readonly conflict_snapshot_id: string | null;
    readonly version: string;
  } | null;
  readonly error_code: string | null;
}

export interface WalletPositionsV3 {
  readonly schema_version: "cashloom.wallet-kernel-positions/3";
  readonly generated_at: string;
  readonly positions: readonly LegacyPositionRow[];
  readonly base_accounts: readonly BaseAccountPositionView[];
}

export interface BasePositionRefreshResult {
  readonly schema_version: "cashloom.base-position-refresh/1";
  readonly outcome: ApplyBasePositionSnapshotOutcome | "partial";
  readonly observation: {
    readonly state: BasePositionObservation["state"];
    readonly reason?: BasePositionObservation["reason"];
    readonly observed_at: string;
    readonly available_providers: string;
    readonly unavailable_providers: string;
  };
  readonly account: BaseAccountPositionView;
}

export interface BasePositionService {
  listPositions(): WalletPositionsV3;
  refreshAccount(accountId: string, signal?: AbortSignal): Promise<BasePositionRefreshResult>;
}

export interface BasePositionServiceDependencies {
  readonly db: Database;
  readonly store: WalletKernelStore;
  readonly observer: BasePositionObserver;
  readonly now?: () => Date;
}

export type BasePositionServiceErrorCode =
  | "base_account_not_found"
  | "base_account_identity_invalid"
  | "base_position_conflict_frozen"
  | "base_position_refresh_cancelled"
  | "base_position_evidence_rejected";

export class BasePositionServiceError extends Error {
  constructor(
    readonly code: BasePositionServiceErrorCode,
    readonly status: 404 | 408 | 409 | 422 | 502,
    message: string,
  ) {
    super(message);
    this.name = "BasePositionServiceError";
  }
}

const canonicalUnsigned = (value: unknown): value is string =>
  typeof value === "string" && /^(0|[1-9][0-9]*)$/.test(value);

const canonicalTimestamp = (value: unknown): value is string => {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) {
    return false;
  }
  return new Date(value).toISOString() === value;
};

const BASE_PROVIDER_ERROR_CODES = new Set([
  "deadline_exceeded",
  "network_unavailable",
  "response_too_large",
  "malformed_rpc",
  "rpc_error",
  "wrong_chain",
  "finalized_head_unavailable",
  "block_mismatch",
]);

const validateBlockRef = (block: {
  readonly number: unknown;
  readonly hash: unknown;
  readonly timestamp: unknown;
}): void => {
  if (
    !canonicalUnsigned(block.number) ||
    typeof block.hash !== "string" ||
    !/^0x[0-9a-f]{64}$/.test(block.hash)
  ) {
    throw new Error("Base position evidence contains an invalid finalized block reference.");
  }
  blockTimeIso(block.timestamp);
};

const blockTimeIso = (seconds: unknown): string => {
  if (!canonicalUnsigned(seconds)) {
    throw new Error("Base position evidence contains an invalid block timestamp.");
  }
  const value = BigInt(seconds);
  if (value > 8_640_000_000_000n) {
    throw new Error("Base position evidence contains an out-of-range block timestamp.");
  }
  return new Date(Number(value * 1_000n)).toISOString();
};

const normalizedItems = (
  sighting: Pick<BasePositionProviderSighting, "balances">,
): readonly [
  { readonly assetId: typeof BASE_ETH_ASSET_ID; readonly observedAtomic: string },
  { readonly assetId: typeof BASE_USDC_ASSET_ID; readonly observedAtomic: string },
] => {
  if (!Array.isArray(sighting.balances) || sighting.balances.length !== 2) {
    throw new Error("Base position evidence must contain exactly two supported assets.");
  }
  const [eth, usdc] = sighting.balances;
  const exactKeys = (value: unknown, keys: readonly string[]): boolean =>
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).sort().join("\u0000") === [...keys].sort().join("\u0000");
  if (
    !exactKeys(eth, ["asset", "asset_id", "atomic", "decimals"]) ||
    !exactKeys(usdc, ["asset", "asset_id", "atomic", "decimals", "contract_address"]) ||
    eth?.asset !== "ETH" ||
    eth.asset_id !== BASE_ETH_ASSET_ID ||
    eth.decimals !== "18" ||
    !canonicalUnsigned(eth.atomic) ||
    usdc?.asset !== "USDC" ||
    usdc.asset_id !== BASE_USDC_ASSET_ID ||
    usdc.decimals !== "6" ||
    usdc.contract_address !== "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913" ||
    !canonicalUnsigned(usdc.atomic)
  ) {
    throw new Error("Base position evidence does not contain the exact ETH and native USDC assets.");
  }
  return [
    { assetId: BASE_ETH_ASSET_ID, observedAtomic: eth.atomic },
    { assetId: BASE_USDC_ASSET_ID, observedAtomic: usdc.atomic },
  ];
};

const evidenceBody = (
  value: Pick<
    BasePositionProviderSighting | BaseFinalizedPositionSnapshot,
    "chain_id" | "account_address" | "security_level" | "block" | "balances"
  >,
) => ({
  schema_version: "cashloom.base-position-evidence/1",
  chain_id: value.chain_id,
  account_address: value.account_address,
  security_level: value.security_level,
  block: value.block,
  balances: value.balances,
}) as const;

const validateSighting = (
  sighting: BasePositionProviderSighting,
  accountAddress: string,
): void => {
  const expectedHash = `sha256:${fingerprintRequest(evidenceBody(sighting))}`;
  if (
    sighting.schema_version !== "cashloom.base-position-sighting/1" ||
    sighting.chain_id !== BASE_CHAIN_ID ||
    sighting.account_address.toLowerCase() !== accountAddress.toLowerCase() ||
    sighting.security_level !== "FINALIZED" ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(sighting.provider_id) ||
    !/^sha256:[0-9a-f]{64}$/.test(sighting.provider_trust_domain) ||
    !/^sha256:[0-9a-f]{64}$/.test(sighting.evidence_hash) ||
    sighting.evidence_hash !== expectedHash ||
    !canonicalUnsigned(sighting.block.number) ||
    !/^0x[0-9a-f]{64}$/.test(sighting.block.hash) ||
    !canonicalTimestamp(sighting.observed_at) ||
    !canonicalTimestamp(sighting.fetched_at)
  ) {
    throw new Error("Base position observer returned a malformed provider sighting.");
  }
  blockTimeIso(sighting.block.timestamp);
  normalizedItems(sighting);
};

const validateObservation = (
  observation: BasePositionObservation,
  accountAddress: string,
): void => {
  if (
    observation.schema_version !== "cashloom.base-position-observation/1" ||
    (observation.state !== "settled" && observation.state !== "partial") ||
    observation.chain_id !== BASE_CHAIN_ID ||
    observation.account_address.toLowerCase() !== accountAddress.toLowerCase() ||
    !canonicalTimestamp(observation.observed_at) ||
    !Array.isArray(observation.providers) ||
    observation.providers.length !== 2 ||
    !Array.isArray(observation.sightings) ||
    observation.sightings.length > 2
  ) {
    throw new Error("Base position observer returned an invalid observation envelope.");
  }
  const providerIds = observation.providers.map((provider) => provider.provider_id);
  if (
    new Set(providerIds).size !== 2 ||
    providerIds.some((providerId) =>
      !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(providerId)
    )
  ) {
    throw new Error("Base position observer returned duplicate provider identities.");
  }
  for (const provider of observation.providers) {
    switch (provider.state) {
      case "unavailable":
        if (!BASE_PROVIDER_ERROR_CODES.has(provider.error_code)) {
          throw new Error("Base position observer returned an invalid provider refusal.");
        }
        break;
      case "head_observed":
        validateBlockRef(provider.finalized_head);
        break;
      case "observed":
        break;
      default:
        throw new Error("Base position observer returned an unknown provider state.");
    }
  }
  const sightingProviders = new Set<string>();
  for (const sighting of observation.sightings) {
    validateSighting(sighting, accountAddress);
    if (sightingProviders.has(sighting.provider_id)) {
      throw new Error("Base position observer returned duplicate provider sightings.");
    }
    sightingProviders.add(sighting.provider_id);
    const provider = observation.providers.find((candidate) =>
      candidate.provider_id === sighting.provider_id
    );
    if (!provider || provider.state !== "observed" || provider.sighting !== sighting) {
      throw new Error("Base position sighting has no exact matching provider result.");
    }
  }
  for (const provider of observation.providers) {
    if ((provider.state === "observed") !== sightingProviders.has(provider.provider_id)) {
      throw new Error("Base position provider results and sightings are incomplete.");
    }
  }
  if (
    new Set(observation.sightings.map((sighting) => sighting.provider_trust_domain)).size !==
      observation.sightings.length
  ) {
    throw new Error("Base position sightings do not have distinct provider trust domains.");
  }
  if (observation.state === "settled") {
    const snapshot = observation.snapshot;
    if (
      !snapshot ||
      observation.reason !== undefined ||
      observation.sightings.length !== 2 ||
      snapshot.schema_version !== "cashloom.base-position-snapshot/1" ||
      snapshot.chain_id !== BASE_CHAIN_ID ||
      snapshot.account_address.toLowerCase() !== accountAddress.toLowerCase() ||
      snapshot.security_level !== "FINALIZED" ||
      snapshot.quorum !== "2" ||
      snapshot.provider_ids.length !== 2 ||
      new Set(snapshot.provider_ids).size !== 2 ||
      !canonicalTimestamp(snapshot.observed_at) ||
      snapshot.observed_at !== observation.observed_at ||
      snapshot.evidence_hash !== `sha256:${fingerprintRequest(evidenceBody(snapshot))}` ||
      observation.sightings.some((sighting) =>
        sighting.evidence_hash !== snapshot.evidence_hash ||
        sighting.block.number !== snapshot.block.number ||
        sighting.block.hash !== snapshot.block.hash ||
        sighting.block.timestamp !== snapshot.block.timestamp ||
        !snapshot.provider_ids.includes(sighting.provider_id) ||
        fingerprintRequest(sighting.balances) !== fingerprintRequest(snapshot.balances)
      )
    ) {
      throw new Error("Base position observer returned invalid two-provider finalized consensus.");
    }
    normalizedItems(snapshot);
    blockTimeIso(snapshot.block.timestamp);
  } else if (
    observation.snapshot !== undefined ||
    (observation.reason !== "provider_unavailable" &&
      observation.reason !== "provider_disagreement") ||
    (observation.reason === "provider_unavailable" &&
      !observation.providers.some((provider) => provider.state === "unavailable"))
  ) {
    throw new Error("Base position observer returned an invalid partial observation.");
  }
};

const durableSightingBody = (sighting: BasePositionProviderSighting): JsonValue => ({
  schema_version: sighting.schema_version,
  chain_id: sighting.chain_id,
  account_address: sighting.account_address,
  security_level: sighting.security_level,
  block: {
    number: sighting.block.number,
    hash: sighting.block.hash,
    timestamp: sighting.block.timestamp,
  },
  balances: [
    {
      asset: "ETH",
      asset_id: BASE_ETH_ASSET_ID,
      atomic: sighting.balances[0].atomic,
      decimals: "18",
    },
    {
      asset: "USDC",
      asset_id: BASE_USDC_ASSET_ID,
      atomic: sighting.balances[1].atomic,
      decimals: "6",
      contract_address: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
    },
  ],
  provider_id: sighting.provider_id,
  provider_trust_domain: sighting.provider_trust_domain,
  evidence_hash: sighting.evidence_hash,
  observed_at: sighting.observed_at,
  fetched_at: sighting.fetched_at,
});

const allPositionRows = (db: Database): LegacyPositionRow[] => db.query(
  `SELECT p.account_id, p.asset_id, p.observed_atomic, p.pending_atomic,
          p.source, p.source_cursor, p.as_of, p.version,
          a.account_ref, a.chain_id, a.custody_mode, a.status AS account_status,
          s.symbol, s.name, s.decimals, s.kind AS asset_kind
   FROM wk_positions p
   JOIN wk_accounts a ON a.id=p.account_id
   JOIN wk_assets s ON s.id=p.asset_id
   ORDER BY p.account_id, p.asset_id`,
).all() as LegacyPositionRow[];

const positionView = (
  row: BasePositionRecord,
): WalletPositionView => ({
  account_id: row.accountId,
  asset_id: row.assetId,
  observed_atomic: row.observedAtomic,
  pending_atomic: row.pendingAtomic,
  source: row.source,
  source_cursor: row.sourceCursor,
  as_of: row.asOf,
  version: row.version,
  symbol: row.assetId === BASE_ETH_ASSET_ID ? "ETH" : "USDC",
  name: row.assetId === BASE_ETH_ASSET_ID ? "Ether" : "USD Coin",
  decimals: row.assetId === BASE_ETH_ASSET_ID ? 18 : 6,
});

const refreshAttemptView = (
  attempt: BasePositionRefreshAttemptRecord | undefined,
): BasePositionRefreshAttemptView | null => attempt
  ? {
      attempt_id: attempt.id,
      attempted_at: attempt.attemptedAt,
      outcome: attempt.outcome,
      reason_code: attempt.reasonCode,
      provider_count: attempt.providerCount.toString(),
      available_provider_count: attempt.availableProviderCount.toString(),
      agreeing_provider_count: attempt.agreeingProviderCount.toString(),
      retained_head: attempt.retainedHead
        ? {
            snapshot_id: attempt.retainedHead.snapshotId,
            state: attempt.retainedHead.state,
            conflict_snapshot_id: attempt.retainedHead.conflictSnapshotId,
            version: attempt.retainedHead.version.toString(),
          }
        : null,
      error_code: attempt.errorCode,
    }
  : null;

const largestEvidenceAgreement = (
  sightings: readonly BasePositionProviderSighting[],
): number => {
  const groups = new Map<string, number>();
  let largest = 0;
  for (const sighting of sightings) {
    const count = (groups.get(sighting.evidence_hash) ?? 0) + 1;
    groups.set(sighting.evidence_hash, count);
    largest = Math.max(largest, count);
  }
  return largest;
};

export const createBasePositionService = (
  dependencies: BasePositionServiceDependencies,
): BasePositionService => {
  const { db, store, observer } = dependencies;
  const now = dependencies.now ?? (() => new Date());

  const viewFor = (accountId: string): BaseAccountPositionView => {
    const account = resolveBaseAccount(db, accountId);
    const head = store.getBasePositionHead(accountId);
    const snapshot = head ? store.getBasePositionSnapshot(head.snapshotId) : null;
    const positions = head ? store.listBasePositions({ accountId }).map(positionView) : [];
    const lastRefresh = store.listBasePositionRefreshAttempts({ accountId, limit: 1 })[0];
    const accountIds = (db.query(
      `SELECT id FROM accounts
       WHERE status='ACTIVE' AND rail='CRYPTO' AND chain_id=?
         AND lower(asset_id) IN (?, ?)
         AND lower(account_ref)=lower(?)
       ORDER BY id`,
    ).all(
      BASE_CHAIN_ID,
      BASE_ETH_ASSET_ID,
      BASE_USDC_ASSET_ID,
      account.accountRef,
    ) as Array<{ id: string }>).map(({ id }) => id);
    return Object.freeze({
      account_id: account.id,
      label: account.label,
      chain_id: BASE_CHAIN_ID,
      account_ref: account.accountRef,
      address: account.address,
      custody_mode: account.custodyMode,
      status: head?.state === "FROZEN"
        ? "conflicted"
        : snapshot
          ? "finalized"
          : "not_checked",
      snapshot: snapshot && head
        ? {
            snapshot_id: snapshot.id,
            block: {
              number: snapshot.blockNumber,
              hash: snapshot.blockHash,
              timestamp: snapshot.blockTime,
            },
            evidence_hash: snapshot.evidenceHash,
            provider_ids: snapshot.providerIds,
            quorum: snapshot.quorum.toString(),
            observed_at: snapshot.decidedAt,
            applied_at: head.updatedAt,
          }
        : null,
      positions,
      identity_group: {
        canonical_account_ref: account.accountRef.toLowerCase(),
        canonical_account_id: accountIds[0] ?? account.id,
        account_ids: accountIds,
        duplicate: accountIds.length > 1,
      },
      last_refresh: refreshAttemptView(lastRefresh),
      actions: { refresh: head?.state !== "FROZEN" },
    });
  };

  const listBaseAccounts = (): BaseAccountPositionView[] => {
    const rows = db.query(
      `SELECT id,display_name,account_ref FROM accounts
       WHERE status='ACTIVE' AND rail='CRYPTO' AND chain_id=?
         AND lower(asset_id) IN (?, ?)
       ORDER BY created_at, id`,
    ).all(BASE_CHAIN_ID, BASE_ETH_ASSET_ID, BASE_USDC_ASSET_ID) as Array<{
      id: string;
      display_name: string;
      account_ref: string | null;
    }>;
    return rows.map((row) => {
      try {
        resolveBaseAccount(db, row.id);
      } catch {
        // Do not omit a malformed Base identity: agents must be able to
        // distinguish "not checked" from "cannot be checked safely".
        const prefix = `${BASE_CHAIN_ID}:`;
        const rawAddress = row.account_ref?.startsWith(prefix)
          ? row.account_ref.slice(prefix.length)
          : "";
        return {
          account_id: row.id,
          label: row.display_name,
          chain_id: BASE_CHAIN_ID,
          account_ref: row.account_ref ?? "",
          address: rawAddress,
          custody_mode: "unknown",
          status: "identity_invalid",
          snapshot: null,
          positions: [],
          identity_group: {
            canonical_account_ref: (row.account_ref ?? "").toLowerCase(),
            canonical_account_id: row.id,
            account_ids: [row.id],
            duplicate: false,
          },
          last_refresh: refreshAttemptView(
            store.listBasePositionRefreshAttempts({ accountId: row.id, limit: 1 })[0],
          ),
          actions: { refresh: false },
          refusal: {
            code: "base_account_identity_invalid",
            message: "This account is not an exact supported Base ETH or native USDC identity.",
          },
        };
      }
      // Keep identity refusal separate from a genuine local storage failure;
      // the latter must not be mislabeled as a malformed account.
      return viewFor(row.id);
    });
  };

  return Object.freeze({
    listPositions(): WalletPositionsV3 {
      const generatedAt = now().toISOString();
      return Object.freeze({
        schema_version: "cashloom.wallet-kernel-positions/3",
        generated_at: generatedAt,
        positions: allPositionRows(db),
        base_accounts: listBaseAccounts(),
      });
    },

    async refreshAccount(
      accountId: string,
      signal?: AbortSignal,
    ): Promise<BasePositionRefreshResult> {
      let account;
      const attemptedAt = now().toISOString();
      try {
        account = ensureBaseAccountProjection({ db, store }, accountId);
      } catch (error) {
        const missing = error instanceof Error &&
          error.message === "No active Base account with that id.";
        throw new BasePositionServiceError(
          missing ? "base_account_not_found" : "base_account_identity_invalid",
          missing ? 404 : 422,
          missing
            ? "No active Base account exists with that id."
            : "This account is not an exact supported Base ETH or native USDC identity.",
        );
      }
      if (store.getBasePositionHead(accountId)?.state === "FROZEN") {
        try {
          store.appendBasePositionRefreshAttempt({
            accountId,
            attemptedAt,
            outcome: "conflict",
            reasonCode: "conflict_frozen",
            providerCount: 0,
            availableProviderCount: 0,
            agreeingProviderCount: 0,
            errorCode: "base_position_conflict_frozen",
          });
        } catch {
          throw new BasePositionServiceError(
            "base_position_evidence_rejected",
            502,
            "Base position evidence was unavailable, malformed, or failed its durable proof checks.",
          );
        }
        throw new BasePositionServiceError(
          "base_position_conflict_frozen",
          409,
          "This Base position is frozen after conflicting same-height evidence and requires review.",
        );
      }
      let observation: BasePositionObservation;
      let outcome: BasePositionRefreshResult["outcome"] = "partial";
      try {
        observation = await observer.observe({ account_address: account.address }, signal);
        validateObservation(observation, account.address);
        const persistedSightings = observation.sightings.map((sighting) =>
          store.appendBasePositionSighting({
            accountId,
            providerId: sighting.provider_id,
            providerTrustDomain: sighting.provider_trust_domain,
            evidenceHash: sighting.evidence_hash,
            blockNumber: sighting.block.number,
            blockHash: sighting.block.hash,
            blockTime: blockTimeIso(sighting.block.timestamp),
            items: normalizedItems(sighting),
            body: durableSightingBody(sighting),
            observedAt: sighting.observed_at,
            fetchedAt: sighting.fetched_at,
          })
        );
        if (observation.state === "settled" && observation.snapshot) {
          const snapshot = observation.snapshot;
          outcome = store.applyBasePositionSnapshot({
            accountId,
            blockNumber: snapshot.block.number,
            blockHash: snapshot.block.hash,
            blockTime: blockTimeIso(snapshot.block.timestamp),
            evidenceHash: snapshot.evidence_hash,
            providerIds: snapshot.provider_ids,
            sightingIds: persistedSightings.map((entry) => entry.sighting.id),
            quorum: 2,
            items: normalizedItems(snapshot),
            decidedAt: snapshot.observed_at,
          }).outcome;
        }
      } catch (error) {
        if (error instanceof BasePositionServiceError) throw error;
        const cancelled = signal?.aborted ||
          (error instanceof Error && error.name === "AbortError");
        try {
          store.appendBasePositionRefreshAttempt({
            accountId,
            attemptedAt,
            outcome: cancelled ? "cancelled" : "rejected",
            reasonCode: cancelled ? "refresh_cancelled" : "evidence_rejected",
            providerCount: 2,
            availableProviderCount: 0,
            agreeingProviderCount: 0,
            errorCode: cancelled
              ? "base_position_refresh_cancelled"
              : "base_position_evidence_rejected",
          });
        } catch {
          // Preserve the stable refusal even if local durable storage itself
          // failed. Never substitute or echo the underlying provider/store text.
        }
        if (cancelled) {
          throw new BasePositionServiceError(
            "base_position_refresh_cancelled",
            408,
            "The Base position refresh was cancelled before evidence settled.",
          );
        }
        throw new BasePositionServiceError(
          "base_position_evidence_rejected",
          502,
          "Base position evidence was unavailable, malformed, or failed its durable proof checks.",
        );
      }
      const availableProviders = observation.providers.filter((provider) =>
        provider.state !== "unavailable"
      ).length;
      const unavailableProviders = observation.providers.length - availableProviders;
      try {
        store.appendBasePositionRefreshAttempt({
          accountId,
          attemptedAt,
          outcome,
          reasonCode: observation.reason ?? "finalized_quorum",
          providerCount: observation.providers.length,
          availableProviderCount: availableProviders,
          agreeingProviderCount: largestEvidenceAgreement(observation.sightings),
        });
      } catch {
        throw new BasePositionServiceError(
          "base_position_evidence_rejected",
          502,
          "Base position evidence was unavailable, malformed, or failed its durable proof checks.",
        );
      }
      return Object.freeze({
        schema_version: "cashloom.base-position-refresh/1",
        outcome,
        observation: {
          state: observation.state,
          ...(observation.reason ? { reason: observation.reason } : {}),
          observed_at: observation.observed_at,
          available_providers: availableProviders.toString(),
          unavailable_providers: unavailableProviders.toString(),
        },
        account: viewFor(accountId),
      });
    },
  });
};
