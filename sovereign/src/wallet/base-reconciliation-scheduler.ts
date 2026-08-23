/**
 * Bounded background reconciliation for already-signed Base payments.
 *
 * This module is deliberately orchestration-only. It can observe immutable
 * signed transactions through BaseReconciliationService, but it has no
 * signing, custody, submission, or rebroadcast capability. The durable store
 * repeats candidate validation while claiming a job; the checks here are a
 * second boundary against an incorrectly implemented/injected store.
 */

import type {
  BaseReconcileResult,
  BaseReconciliationService,
  PaymentTruthV1,
} from "./base-reconciler.ts";

export const BASE_RECONCILIATION_CHAIN_ID = "eip155:8453" as const;
export const BASE_RECONCILIATION_ETH_ASSET_ID =
  `${BASE_RECONCILIATION_CHAIN_ID}/slip44:60` as const;
export const BASE_RECONCILIATION_USDC_ASSET_ID =
  `${BASE_RECONCILIATION_CHAIN_ID}/erc20:0x833589fcd6edb6e08f4c7c32d4f71b54bda02913` as const;

export const BASE_RECONCILIATION_ERROR = Object.freeze({
  CANCELLED: "BASE_RECONCILIATION_CANCELLED",
  TIMED_OUT: "BASE_RECONCILIATION_TIMED_OUT",
  ATTEMPT_FAILED: "BASE_RECONCILIATION_ATTEMPT_FAILED",
  FINALITY_CONFLICT: "BASE_RECONCILIATION_FINALITY_CONFLICT",
  MANUAL_RECOVERY_REQUIRED: "BASE_RECONCILIATION_MANUAL_RECOVERY_REQUIRED",
  INVALID_OBSERVATION: "BASE_RECONCILIATION_INVALID_OBSERVATION",
  LEASE_CONFLICT: "BASE_RECONCILIATION_LEASE_CONFLICT",
  STORE_UNAVAILABLE: "BASE_RECONCILIATION_STORE_UNAVAILABLE",
} as const);

export type BaseReconciliationErrorCode =
  typeof BASE_RECONCILIATION_ERROR[keyof typeof BASE_RECONCILIATION_ERROR];

export type BaseReconciliationJobState =
  | "READY"
  | "RUNNING"
  | "BACKOFF"
  | "SETTLED"
  | "PAUSED";

export type BaseReconciliationExecutionState =
  | "signed"
  | "submitted"
  | "ambiguous"
  | "failed";

export type BaseReconciliationObservation =
  | "pending"
  | "partial"
  | "settled"
  | "conflicted"
  | null;

/** Exact immutable join returned by discovery and repeated when a job is claimed. */
export interface BaseReconciliationCandidate {
  readonly executionId: string;
  readonly intentId: string;
  readonly signedArtifactId: string;
  readonly externalTxId: string;
  readonly networkTxId: string;
  readonly rail: string;
  readonly chainId: string;
  readonly assetId: string;
  readonly executionState: string;
}

export interface BoundBaseReconciliationCandidate extends BaseReconciliationCandidate {
  readonly rail: "evm-base";
  readonly chainId: typeof BASE_RECONCILIATION_CHAIN_ID;
  readonly assetId:
    | typeof BASE_RECONCILIATION_ETH_ASSET_ID
    | typeof BASE_RECONCILIATION_USDC_ASSET_ID;
}

export interface ExactBaseReconciliationCandidate extends BoundBaseReconciliationCandidate {
  readonly executionState: BaseReconciliationExecutionState;
}

export interface BaseReconciliationJob extends BaseReconciliationCandidate {
  readonly id: string;
  readonly state: BaseReconciliationJobState;
  readonly attemptCount: number;
  readonly failureCount: number;
  readonly nextAttemptAt: string;
  readonly leaseOwner: string | null;
  readonly leaseToken: string | null;
  readonly leaseUntil: string | null;
  readonly lastObservation: unknown;
  readonly lastErrorCode: string | null;
  readonly version: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface BaseReconciliationJobStore {
  discoverEligibleBaseReconciliations(input: {
    readonly limit: number;
  }): readonly BaseReconciliationCandidate[];
  enqueueBaseReconciliationJobs(
    candidates: readonly ExactBaseReconciliationCandidate[],
    options?: { readonly now?: string },
  ): readonly BaseReconciliationJob[];
  claimDueBaseReconciliationJobs(input: {
    readonly limit: number;
    readonly leaseOwner: string;
    readonly leaseUntil: string;
    readonly now?: string;
  }): readonly BaseReconciliationJob[];
  settleBaseReconciliationJob(input: {
    readonly jobId: string;
    readonly leaseToken: string;
    readonly observation?: BaseReconciliationObservation;
    readonly now?: string;
  }): unknown;
  rescheduleBaseReconciliationJob(input: {
    readonly jobId: string;
    readonly leaseToken: string;
    readonly nextAttemptAt: string;
    readonly errorCode: string | null;
    readonly observation?: BaseReconciliationObservation;
    readonly incrementFailure?: boolean;
    readonly now?: string;
  }): unknown;
  pauseBaseReconciliationJob(input: {
    readonly jobId: string;
    readonly leaseToken: string;
    readonly errorCode: string;
    readonly observation?: BaseReconciliationObservation;
    readonly incrementFailure?: boolean;
    readonly now?: string;
  }): unknown;
  reapExpiredBaseReconciliationLeases(input?: { readonly now?: string }): number;
}

export interface BaseReconciliationSchedulerOptions {
  /** Maximum new execution joins inspected per tick. */
  readonly discoveryLimit?: number;
  /** Maximum durable jobs leased per tick. */
  readonly batchSize?: number;
  /** Maximum simultaneous observer calls. */
  readonly concurrency?: number;
  readonly intervalMs?: number;
  readonly initialDelayMs?: number;
  readonly globalTimeoutMs?: number;
  readonly itemTimeoutMs?: number;
  readonly leaseDurationMs?: number;
  readonly baseBackoffMs?: number;
  readonly maxBackoffMs?: number;
  /** Symmetric fractional jitter in [0, 1]. Zero is useful for tests. */
  readonly jitterRatio?: number;
  readonly leaseOwner?: string;
}

export interface BaseReconciliationRunResult {
  readonly schema_version: "cashloom.base-reconciliation-run/1";
  readonly outcome: "completed" | "cancelled" | "already_running" | "store_unavailable";
  readonly started_at: string;
  readonly completed_at: string;
  readonly expired_leases_reaped: number;
  readonly discovered: number;
  readonly eligible: number;
  readonly enqueued: number;
  readonly claimed: number;
  readonly settled: number;
  readonly rescheduled: number;
  readonly paused: number;
  readonly lease_conflicts: number;
  readonly error_codes: readonly BaseReconciliationErrorCode[];
}

export interface BaseReconciliationSchedulerStatus {
  readonly schema_version: "cashloom.base-reconciliation-scheduler/1";
  readonly state: "stopped" | "idle" | "running";
  readonly lease_owner: string;
  readonly last_started_at: string | null;
  readonly last_completed_at: string | null;
  readonly last_outcome: BaseReconciliationRunResult["outcome"] | null;
  readonly last_error_codes: readonly BaseReconciliationErrorCode[];
  readonly limits: {
    readonly discovery: string;
    readonly batch: string;
    readonly concurrency: string;
    readonly interval_ms: string;
    readonly global_timeout_ms: string;
    readonly item_timeout_ms: string;
    readonly lease_duration_ms: string;
    readonly maximum_backoff_ms: string;
  };
}

export interface BaseReconciliationScheduler {
  start(): void;
  stop(): Promise<void>;
  runOnce(input?: { readonly signal?: AbortSignal }): Promise<BaseReconciliationRunResult>;
  getStatus(): BaseReconciliationSchedulerStatus;
}

export interface BaseReconciliationSchedulerDependencies {
  readonly reconciliation: BaseReconciliationService;
  readonly jobs: BaseReconciliationJobStore;
  readonly now?: () => Date;
  readonly random?: () => number;
  readonly scheduleTimer?: (callback: () => void, delayMs: number) => unknown;
  readonly cancelTimer?: (handle: unknown) => void;
  readonly options?: BaseReconciliationSchedulerOptions;
}

interface MutableRunCounts {
  expiredLeasesReaped: number;
  discovered: number;
  eligible: number;
  enqueued: number;
  claimed: number;
  settled: number;
  rescheduled: number;
  paused: number;
  leaseConflicts: number;
  errorCodes: Set<BaseReconciliationErrorCode>;
}

interface Deadline {
  readonly signal: AbortSignal;
  readonly didTimeOut: () => boolean;
  dispose(): void;
}

const DEFAULTS = Object.freeze({
  discoveryLimit: 32,
  batchSize: 8,
  concurrency: 2,
  intervalMs: 30_000,
  initialDelayMs: 0,
  globalTimeoutMs: 45_000,
  itemTimeoutMs: 15_000,
  leaseDurationMs: 60_000,
  baseBackoffMs: 5_000,
  maxBackoffMs: 15 * 60_000,
  jitterRatio: 0.2,
});

const UINT_LIMIT = 10_000;
const EVM_TRANSACTION_ID = /^0x[0-9a-fA-F]{64}$/;
const ALLOWED_ASSETS = new Set<string>([
  BASE_RECONCILIATION_ETH_ASSET_ID,
  BASE_RECONCILIATION_USDC_ASSET_ID,
]);
const ALLOWED_EXECUTION_STATES = new Set<string>([
  "signed",
  "submitted",
  "ambiguous",
  "failed",
]);

const boundedInteger = (value: number | undefined, fallback: number, label: string): number => {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved < 1 || resolved > UINT_LIMIT * 60_000) {
    throw new Error(`${label} must be a positive bounded integer.`);
  }
  return resolved;
};

const boundedCount = (
  value: number | undefined,
  fallback: number,
  maximum: number,
  label: string,
): number => {
  const resolved = boundedInteger(value, fallback, label);
  if (resolved > maximum) throw new Error(`${label} exceeds its safe bound.`);
  return resolved;
};

const iso = (date: Date): string => {
  if (!Number.isFinite(date.getTime())) throw new Error("Scheduler clock returned an invalid date.");
  return date.toISOString();
};

const addMilliseconds = (value: string, milliseconds: number): string =>
  new Date(Date.parse(value) + milliseconds).toISOString();

const candidateHasExactBinding = (
  candidate: BaseReconciliationCandidate,
): candidate is BoundBaseReconciliationCandidate =>
  candidate !== null &&
  typeof candidate === "object" &&
  typeof candidate.rail === "string" &&
  typeof candidate.chainId === "string" &&
  typeof candidate.assetId === "string" &&
  typeof candidate.executionState === "string" &&
  typeof candidate.executionId === "string" &&
  typeof candidate.intentId === "string" &&
  typeof candidate.signedArtifactId === "string" &&
  typeof candidate.externalTxId === "string" &&
  typeof candidate.networkTxId === "string" &&
  candidate.rail === "evm-base" &&
  candidate.chainId === BASE_RECONCILIATION_CHAIN_ID &&
  ALLOWED_ASSETS.has(candidate.assetId) &&
  candidate.executionId.trim() !== "" &&
  candidate.intentId.trim() !== "" &&
  candidate.signedArtifactId.trim() !== "" &&
  EVM_TRANSACTION_ID.test(candidate.externalTxId) &&
  EVM_TRANSACTION_ID.test(candidate.networkTxId) &&
  candidate.externalTxId.toLowerCase() === candidate.networkTxId.toLowerCase();

const candidateIsExact = (
  candidate: BaseReconciliationCandidate,
): candidate is ExactBaseReconciliationCandidate =>
  candidateHasExactBinding(candidate) && ALLOWED_EXECUTION_STATES.has(candidate.executionState);

const terminalTruth = (
  truth: PaymentTruthV1 | null,
): "settled" | "conflicted" | "manual" | "reconcile" => {
  if (truth === null) return "manual";
  if (truth.canonicality === "conflicted") return "conflicted";
  if (
    truth.canonicality === "canonical" &&
    truth.security_level === "finalized" &&
    truth.execution_result !== null
  ) {
    return "settled";
  }
  return truth.actions.reconcile ? "reconcile" : "manual";
};

const emptyCounts = (): MutableRunCounts => ({
  expiredLeasesReaped: 0,
  discovered: 0,
  eligible: 0,
  enqueued: 0,
  claimed: 0,
  settled: 0,
  rescheduled: 0,
  paused: 0,
  leaseConflicts: 0,
  errorCodes: new Set(),
});

const resultFrom = (
  outcome: BaseReconciliationRunResult["outcome"],
  startedAt: string,
  completedAt: string,
  counts: MutableRunCounts,
): BaseReconciliationRunResult => Object.freeze({
  schema_version: "cashloom.base-reconciliation-run/1",
  outcome,
  started_at: startedAt,
  completed_at: completedAt,
  expired_leases_reaped: counts.expiredLeasesReaped,
  discovered: counts.discovered,
  eligible: counts.eligible,
  enqueued: counts.enqueued,
  claimed: counts.claimed,
  settled: counts.settled,
  rescheduled: counts.rescheduled,
  paused: counts.paused,
  lease_conflicts: counts.leaseConflicts,
  error_codes: Object.freeze([...counts.errorCodes].sort()),
});

const makeDeadline = (
  parent: AbortSignal | undefined,
  timeoutMs: number,
  scheduleTimer: (callback: () => void, delayMs: number) => unknown,
  cancelTimer: (handle: unknown) => void,
): Deadline => {
  const controller = new AbortController();
  let timedOut = false;
  const abortFromParent = (): void => controller.abort();
  if (parent?.aborted) controller.abort();
  else parent?.addEventListener("abort", abortFromParent, { once: true });
  const handle = scheduleTimer(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  return {
    signal: controller.signal,
    didTimeOut: () => timedOut,
    dispose() {
      cancelTimer(handle);
      parent?.removeEventListener("abort", abortFromParent);
    },
  };
};

class SchedulerAbort extends Error {
  constructor(readonly timedOut: boolean) {
    super(timedOut ? "scheduler deadline" : "scheduler cancellation");
    this.name = "SchedulerAbort";
  }
}

const raceWithAbort = async <T>(operation: Promise<T>, deadline: Deadline): Promise<T> => {
  if (deadline.signal.aborted) throw new SchedulerAbort(deadline.didTimeOut());
  let rejectAbort: ((reason: SchedulerAbort) => void) | null = null;
  const aborted = new Promise<never>((_resolve, reject) => {
    rejectAbort = reject;
  });
  const onAbort = (): void => rejectAbort?.(new SchedulerAbort(deadline.didTimeOut()));
  deadline.signal.addEventListener("abort", onAbort, { once: true });
  try {
    return await Promise.race([operation, aborted]);
  } finally {
    deadline.signal.removeEventListener("abort", onAbort);
  }
};

const normalizedRandom = (random: () => number): number => {
  let value: number;
  try {
    value = random();
  } catch {
    value = 0.5;
  }
  return Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0.5;
};

const nextBackoffMs = (
  ordinal: number,
  baseMs: number,
  maximumMs: number,
  jitterRatio: number,
  random: () => number,
): number => {
  const exponent = Math.min(30, Math.max(0, ordinal - 1));
  const unjittered = Math.min(maximumMs, baseMs * 2 ** exponent);
  const factor = 1 + ((normalizedRandom(random) * 2) - 1) * jitterRatio;
  return Math.max(1, Math.min(maximumMs, Math.round(unjittered * factor)));
};

const mapConcurrent = async <T>(
  values: readonly T[],
  concurrency: number,
  worker: (value: T) => Promise<void>,
): Promise<void> => {
  let cursor = 0;
  const runners = Array.from(
    { length: Math.min(concurrency, values.length) },
    async () => {
      while (cursor < values.length) {
        const index = cursor++;
        await worker(values[index]!);
      }
    },
  );
  await Promise.all(runners);
};

/**
 * Creates an inert scheduler. Call start() explicitly only after the host has
 * processed its opt-in environment switch; construction performs no work.
 */
export const createBaseReconciliationScheduler = (
  dependencies: BaseReconciliationSchedulerDependencies,
): BaseReconciliationScheduler => {
  const { reconciliation, jobs } = dependencies;
  const options = dependencies.options ?? {};
  const discoveryLimit = boundedCount(
    options.discoveryLimit,
    DEFAULTS.discoveryLimit,
    256,
    "discoveryLimit",
  );
  const batchSize = boundedCount(options.batchSize, DEFAULTS.batchSize, 64, "batchSize");
  const concurrency = boundedCount(options.concurrency, DEFAULTS.concurrency, 64, "concurrency");
  if (concurrency > batchSize) throw new Error("concurrency cannot exceed batchSize.");
  const intervalMs = boundedInteger(options.intervalMs, DEFAULTS.intervalMs, "intervalMs");
  const initialDelayMs = options.initialDelayMs ?? DEFAULTS.initialDelayMs;
  if (!Number.isSafeInteger(initialDelayMs) || initialDelayMs < 0) {
    throw new Error("initialDelayMs must be a non-negative bounded integer.");
  }
  const globalTimeoutMs = boundedInteger(
    options.globalTimeoutMs,
    DEFAULTS.globalTimeoutMs,
    "globalTimeoutMs",
  );
  const itemTimeoutMs = boundedInteger(
    options.itemTimeoutMs,
    DEFAULTS.itemTimeoutMs,
    "itemTimeoutMs",
  );
  if (itemTimeoutMs > globalTimeoutMs) {
    throw new Error("itemTimeoutMs cannot exceed globalTimeoutMs.");
  }
  const leaseDurationMs = boundedInteger(
    options.leaseDurationMs,
    DEFAULTS.leaseDurationMs,
    "leaseDurationMs",
  );
  if (leaseDurationMs <= globalTimeoutMs) {
    throw new Error("leaseDurationMs must exceed globalTimeoutMs.");
  }
  const baseBackoffMs = boundedInteger(
    options.baseBackoffMs,
    DEFAULTS.baseBackoffMs,
    "baseBackoffMs",
  );
  const maxBackoffMs = boundedInteger(
    options.maxBackoffMs,
    DEFAULTS.maxBackoffMs,
    "maxBackoffMs",
  );
  if (baseBackoffMs > maxBackoffMs) {
    throw new Error("baseBackoffMs cannot exceed maxBackoffMs.");
  }
  const jitterRatio = options.jitterRatio ?? DEFAULTS.jitterRatio;
  if (!Number.isFinite(jitterRatio) || jitterRatio < 0 || jitterRatio > 1) {
    throw new Error("jitterRatio must be between zero and one.");
  }

  const now = dependencies.now ?? (() => new Date());
  const random = dependencies.random ?? Math.random;
  const scheduleTimer = dependencies.scheduleTimer ??
    ((callback: () => void, delayMs: number) => setTimeout(callback, delayMs));
  const cancelTimer = dependencies.cancelTimer ?? ((handle: unknown) => {
    clearTimeout(handle as ReturnType<typeof setTimeout>);
  });
  const leaseOwner = options.leaseOwner ??
    `base-reconciliation-scheduler.${crypto.randomUUID()}`;
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(leaseOwner)) {
    throw new Error("leaseOwner must be a bounded portable identifier.");
  }

  let started = false;
  let loopTimer: unknown | null = null;
  let loopController: AbortController | null = null;
  let activeController: AbortController | null = null;
  let activeRun: Promise<BaseReconciliationRunResult> | null = null;
  let lastResult: BaseReconciliationRunResult | null = null;
  let lastStartedAt: string | null = null;

  const safeWrite = (
    counts: MutableRunCounts,
    write: () => unknown,
    onSuccess: () => void,
  ): void => {
    try {
      write();
      onSuccess();
    } catch (error) {
      const code = error && typeof error === "object" && "code" in error
        ? String(error.code)
        : "";
      if (code === "BASE_RECONCILIATION_JOB_CONFLICT") {
        counts.leaseConflicts += 1;
        counts.errorCodes.add(BASE_RECONCILIATION_ERROR.LEASE_CONFLICT);
      } else {
        counts.errorCodes.add(BASE_RECONCILIATION_ERROR.STORE_UNAVAILABLE);
      }
    }
  };

  const settle = (
    job: BaseReconciliationJob,
    counts: MutableRunCounts,
    at: string,
    observation: BaseReconciliationObservation,
  ): void => {
    if (!job.leaseToken) {
      counts.leaseConflicts += 1;
      counts.errorCodes.add(BASE_RECONCILIATION_ERROR.LEASE_CONFLICT);
      return;
    }
    safeWrite(counts, () => jobs.settleBaseReconciliationJob({
      jobId: job.id,
      leaseToken: job.leaseToken!,
      observation,
      now: at,
    }), () => {
      counts.settled += 1;
    });
  };

  const pause = (
    job: BaseReconciliationJob,
    counts: MutableRunCounts,
    at: string,
    errorCode: BaseReconciliationErrorCode,
    observation: BaseReconciliationObservation = null,
    incrementFailure = false,
  ): void => {
    counts.errorCodes.add(errorCode);
    if (!job.leaseToken) {
      counts.leaseConflicts += 1;
      counts.errorCodes.add(BASE_RECONCILIATION_ERROR.LEASE_CONFLICT);
      return;
    }
    safeWrite(counts, () => jobs.pauseBaseReconciliationJob({
      jobId: job.id,
      leaseToken: job.leaseToken!,
      errorCode,
      observation,
      incrementFailure,
      now: at,
    }), () => {
      counts.paused += 1;
    });
  };

  const reschedule = (
    job: BaseReconciliationJob,
    counts: MutableRunCounts,
    at: string,
    input: {
      readonly errorCode: BaseReconciliationErrorCode | null;
      readonly observation: "pending" | "partial" | null;
      readonly incrementFailure: boolean;
      readonly immediate?: boolean;
    },
  ): void => {
    if (input.errorCode) counts.errorCodes.add(input.errorCode);
    if (!job.leaseToken) {
      counts.leaseConflicts += 1;
      counts.errorCodes.add(BASE_RECONCILIATION_ERROR.LEASE_CONFLICT);
      return;
    }
    const ordinal = input.incrementFailure
      ? job.failureCount + 1
      : job.attemptCount;
    const delay = input.immediate
      ? 0
      : nextBackoffMs(ordinal, baseBackoffMs, maxBackoffMs, jitterRatio, random);
    safeWrite(counts, () => jobs.rescheduleBaseReconciliationJob({
      jobId: job.id,
      leaseToken: job.leaseToken!,
      nextAttemptAt: addMilliseconds(at, delay),
      errorCode: input.errorCode,
      observation: input.observation,
      incrementFailure: input.incrementFailure,
      now: at,
    }), () => {
      counts.rescheduled += 1;
    });
  };

  const applyTruthWithoutNetwork = (
    job: BaseReconciliationJob,
    truth: PaymentTruthV1 | null,
    counts: MutableRunCounts,
    at: string,
  ): boolean => {
    switch (terminalTruth(truth)) {
      case "settled":
        settle(job, counts, at, "settled");
        return true;
      case "conflicted":
        pause(
          job,
          counts,
          at,
          BASE_RECONCILIATION_ERROR.FINALITY_CONFLICT,
          "conflicted",
        );
        return true;
      case "manual":
        pause(job, counts, at, BASE_RECONCILIATION_ERROR.MANUAL_RECOVERY_REQUIRED);
        return true;
      case "reconcile":
        return false;
    }
  };

  const processJob = async (
    job: BaseReconciliationJob,
    counts: MutableRunCounts,
    runSignal: AbortSignal,
    runDidTimeOut: () => boolean,
  ): Promise<void> => {
    const at = iso(now());
    if (!candidateHasExactBinding(job) || job.state !== "RUNNING") {
      pause(job, counts, at, BASE_RECONCILIATION_ERROR.MANUAL_RECOVERY_REQUIRED);
      return;
    }
    if (runSignal.aborted) {
      reschedule(job, counts, at, {
        errorCode: runDidTimeOut()
          ? BASE_RECONCILIATION_ERROR.TIMED_OUT
          : BASE_RECONCILIATION_ERROR.CANCELLED,
        observation: null,
        incrementFailure: false,
        immediate: true,
      });
      return;
    }

    try {
      const existingTruth = reconciliation.getPaymentTruth(job.intentId);
      if (applyTruthWithoutNetwork(job, existingTruth, counts, at)) return;
    } catch {
      reschedule(job, counts, at, {
        errorCode: BASE_RECONCILIATION_ERROR.ATTEMPT_FAILED,
        observation: null,
        incrementFailure: true,
      });
      return;
    }
    if (!ALLOWED_EXECUTION_STATES.has(job.executionState)) {
      pause(job, counts, at, BASE_RECONCILIATION_ERROR.MANUAL_RECOVERY_REQUIRED);
      return;
    }

    const deadline = makeDeadline(
      runSignal,
      itemTimeoutMs,
      scheduleTimer,
      cancelTimer,
    );
    try {
      const attempt = reconciliation.reconcilePayment(job.intentId, deadline.signal);
      const result: BaseReconcileResult = await raceWithAbort(attempt, deadline);
      const completedAt = iso(now());
      const terminal = terminalTruth(result.truth);
      if (terminal === "settled") {
        settle(job, counts, completedAt, result.check.state);
      } else if (terminal === "conflicted") {
        pause(
          job,
          counts,
          completedAt,
          BASE_RECONCILIATION_ERROR.FINALITY_CONFLICT,
          "conflicted",
        );
      } else if (terminal === "manual") {
        pause(
          job,
          counts,
          completedAt,
          BASE_RECONCILIATION_ERROR.MANUAL_RECOVERY_REQUIRED,
          result.check.state,
        );
      } else if (result.check.state === "pending" || result.check.state === "partial") {
        reschedule(job, counts, completedAt, {
          errorCode: null,
          observation: result.check.state,
          incrementFailure: false,
        });
      } else {
        pause(
          job,
          counts,
          completedAt,
          BASE_RECONCILIATION_ERROR.INVALID_OBSERVATION,
          "settled",
          true,
        );
      }
    } catch (error) {
      const completedAt = iso(now());
      const timedOut = runDidTimeOut() || (error instanceof SchedulerAbort
        ? error.timedOut
        : deadline.didTimeOut());
      const cancelled = !timedOut && (error instanceof SchedulerAbort || deadline.signal.aborted);
      reschedule(job, counts, completedAt, {
        errorCode: timedOut
          ? BASE_RECONCILIATION_ERROR.TIMED_OUT
          : cancelled
            ? BASE_RECONCILIATION_ERROR.CANCELLED
            : BASE_RECONCILIATION_ERROR.ATTEMPT_FAILED,
        observation: null,
        incrementFailure: !cancelled,
        immediate: cancelled,
      });
    } finally {
      deadline.dispose();
    }
  };

  const execute = async (input?: {
    readonly signal?: AbortSignal;
  }): Promise<BaseReconciliationRunResult> => {
    const startedAt = iso(now());
    lastStartedAt = startedAt;
    const counts = emptyCounts();
    const runController = new AbortController();
    activeController = runController;
    const abortRun = (): void => runController.abort();
    if (input?.signal?.aborted) runController.abort();
    else input?.signal?.addEventListener("abort", abortRun, { once: true });
    const globalDeadline = makeDeadline(
      runController.signal,
      globalTimeoutMs,
      scheduleTimer,
      cancelTimer,
    );

    try {
      if (globalDeadline.signal.aborted) {
        counts.errorCodes.add(BASE_RECONCILIATION_ERROR.CANCELLED);
        return resultFrom("cancelled", startedAt, iso(now()), counts);
      }
      let candidates: readonly BaseReconciliationCandidate[];
      let claimed: readonly BaseReconciliationJob[];
      try {
        counts.expiredLeasesReaped = jobs.reapExpiredBaseReconciliationLeases({
          now: startedAt,
        });
        if (
          !Number.isSafeInteger(counts.expiredLeasesReaped) ||
          counts.expiredLeasesReaped < 0
        ) {
          throw new Error("Invalid expired-lease count.");
        }
        candidates = jobs.discoverEligibleBaseReconciliations({ limit: discoveryLimit });
        if (!Array.isArray(candidates)) throw new Error("Invalid candidate batch.");
        counts.discovered = candidates.length;
        const eligible = candidates.filter(candidateIsExact).slice(0, discoveryLimit);
        counts.eligible = eligible.length;
        const enqueued = jobs.enqueueBaseReconciliationJobs(eligible, {
          now: startedAt,
        });
        if (!Array.isArray(enqueued)) throw new Error("Invalid enqueue result.");
        counts.enqueued = enqueued.length;
        const claimedBatch = jobs.claimDueBaseReconciliationJobs({
          limit: batchSize,
          leaseOwner,
          leaseUntil: addMilliseconds(startedAt, leaseDurationMs),
          now: startedAt,
        });
        if (!Array.isArray(claimedBatch)) throw new Error("Invalid claimed-job batch.");
        claimed = claimedBatch;
        counts.claimed = claimed.length;
      } catch {
        counts.errorCodes.add(BASE_RECONCILIATION_ERROR.STORE_UNAVAILABLE);
        return resultFrom("store_unavailable", startedAt, iso(now()), counts);
      }

      await mapConcurrent(claimed.slice(0, batchSize), concurrency, async (job) => {
        await processJob(job, counts, globalDeadline.signal, globalDeadline.didTimeOut);
      });
      const wasCancelled = runController.signal.aborted && !globalDeadline.didTimeOut();
      if (globalDeadline.didTimeOut()) {
        counts.errorCodes.add(BASE_RECONCILIATION_ERROR.TIMED_OUT);
      } else if (wasCancelled) {
        counts.errorCodes.add(BASE_RECONCILIATION_ERROR.CANCELLED);
      }
      return resultFrom(
        wasCancelled ? "cancelled" : "completed",
        startedAt,
        iso(now()),
        counts,
      );
    } finally {
      globalDeadline.dispose();
      input?.signal?.removeEventListener("abort", abortRun);
      if (activeController === runController) activeController = null;
    }
  };

  const runOnce = async (input?: {
    readonly signal?: AbortSignal;
  }): Promise<BaseReconciliationRunResult> => {
    if (activeRun) {
      const at = iso(now());
      return resultFrom("already_running", at, at, emptyCounts());
    }
    const run = execute(input);
    activeRun = run;
    try {
      const result = await run;
      lastResult = result;
      return result;
    } finally {
      if (activeRun === run) activeRun = null;
    }
  };

  const scheduleNext = (delayMs: number): void => {
    if (!started || loopController?.signal.aborted) return;
    loopTimer = scheduleTimer(() => {
      loopTimer = null;
      const controller = loopController;
      if (!started || !controller || controller.signal.aborted) return;
      void runOnce({ signal: controller.signal }).finally(() => {
        scheduleNext(intervalMs);
      });
    }, delayMs);
  };

  return Object.freeze({
    start(): void {
      if (started) return;
      started = true;
      loopController = new AbortController();
      scheduleNext(initialDelayMs);
    },

    async stop(): Promise<void> {
      if (!started && !activeRun) return;
      started = false;
      loopController?.abort();
      loopController = null;
      activeController?.abort();
      if (loopTimer !== null) cancelTimer(loopTimer);
      loopTimer = null;
      const pending = activeRun;
      if (pending) await pending;
    },

    runOnce,

    getStatus(): BaseReconciliationSchedulerStatus {
      return Object.freeze({
        schema_version: "cashloom.base-reconciliation-scheduler/1",
        state: activeRun ? "running" : started ? "idle" : "stopped",
        lease_owner: leaseOwner,
        last_started_at: lastStartedAt,
        last_completed_at: lastResult?.completed_at ?? null,
        last_outcome: lastResult?.outcome ?? null,
        last_error_codes: lastResult?.error_codes ?? Object.freeze([]),
        limits: Object.freeze({
          discovery: discoveryLimit.toString(),
          batch: batchSize.toString(),
          concurrency: concurrency.toString(),
          interval_ms: intervalMs.toString(),
          global_timeout_ms: globalTimeoutMs.toString(),
          item_timeout_ms: itemTimeoutMs.toString(),
          lease_duration_ms: leaseDurationMs.toString(),
          maximum_backoff_ms: maxBackoffMs.toString(),
        }),
      });
    },
  });
};
