import { describe, expect, it } from "bun:test";
import type {
  BaseReconcileResult,
  BaseReconciliationService,
  PaymentTruthV1,
} from "./base-reconciler.ts";
import {
  BASE_RECONCILIATION_CHAIN_ID,
  BASE_RECONCILIATION_ERROR,
  BASE_RECONCILIATION_ETH_ASSET_ID,
  createBaseReconciliationScheduler,
  type BaseReconciliationCandidate,
  type BaseReconciliationJob,
  type BaseReconciliationJobStore,
  type BaseReconciliationSchedulerOptions,
} from "./base-reconciliation-scheduler.ts";
import type { WalletKernelStore } from "./infrastructure/sqlite/store.ts";

type SqliteStoreImplementsSchedulerPort = WalletKernelStore extends BaseReconciliationJobStore
  ? true
  : false;
const sqliteStoreImplementsSchedulerPort: SqliteStoreImplementsSchedulerPort = true;

const NOW = "2026-08-23T18:00:00.000Z";
const TX = `0x${"a".repeat(64)}`;

const candidate = (
  suffix: string,
  overrides: Partial<BaseReconciliationCandidate> = {},
): BaseReconciliationCandidate => ({
  executionId: `execution.payment.${suffix}.0`,
  intentId: `payment.${suffix}`,
  signedArtifactId: `artifact.payment.${suffix}`,
  externalTxId: TX,
  networkTxId: TX,
  rail: "evm-base",
  chainId: BASE_RECONCILIATION_CHAIN_ID,
  assetId: BASE_RECONCILIATION_ETH_ASSET_ID,
  executionState: "submitted",
  ...overrides,
});

const truth = (
  intentId: string,
  overrides: Partial<PaymentTruthV1> = {},
): PaymentTruthV1 => ({
  schema_version: "cashloom.payment-truth/1",
  intent_id: intentId,
  lifecycle_state: "submitted",
  legacy_status: "submitted",
  rail: "evm-base",
  chain_id: BASE_RECONCILIATION_CHAIN_ID,
  network_tx_id: TX,
  visibility: "mempool",
  execution_result: null,
  security_level: null,
  canonicality: "unknown",
  block: null,
  fee: null,
  checked_at: null,
  observed_at: null,
  evidence: null,
  actions: {
    reconcile: true,
    exact_rebroadcast: false,
    safe_to_create_new_payment: false,
  },
  ...overrides,
});

const observation = (
  intentId: string,
  state: "pending" | "partial" | "settled",
  resultTruth = truth(intentId),
): BaseReconcileResult => ({
  truth: resultTruth,
  check: {
    state,
    checked_at: NOW,
    available_providers: "2",
    unavailable_providers: "0",
  },
});

class MemoryJobs implements BaseReconciliationJobStore {
  readonly jobs = new Map<string, BaseReconciliationJob>();
  readonly settled: Array<Record<string, unknown>> = [];
  readonly rescheduled: Array<Record<string, unknown>> = [];
  readonly paused: Array<Record<string, unknown>> = [];
  leaseSequence = 0;

  constructor(readonly candidates: BaseReconciliationCandidate[]) {}

  discoverEligibleBaseReconciliations(input: { readonly limit: number }) {
    return this.candidates.slice(0, input.limit);
  }

  enqueueBaseReconciliationJobs(
    values: readonly BaseReconciliationCandidate[],
    options: { readonly now?: string } = {},
  ) {
    const at = options.now ?? NOW;
    return values.map((value) => {
      const prior = this.jobs.get(value.executionId);
      if (prior) return prior;
      const job: BaseReconciliationJob = {
        ...value,
        id: `base-reconciliation.${value.executionId}`,
        state: "READY",
        attemptCount: 0,
        failureCount: 0,
        nextAttemptAt: at,
        leaseOwner: null,
        leaseToken: null,
        leaseUntil: null,
        lastObservation: null,
        lastErrorCode: null,
        version: 0,
        createdAt: at,
        updatedAt: at,
      };
      this.jobs.set(value.executionId, job);
      return job;
    });
  }

  claimDueBaseReconciliationJobs(input: {
    readonly limit: number;
    readonly leaseOwner: string;
    readonly leaseUntil: string;
    readonly now?: string;
  }) {
    const at = input.now ?? NOW;
    const claimed: BaseReconciliationJob[] = [];
    for (const [key, job] of this.jobs) {
      if (claimed.length >= input.limit) break;
      if (
        (job.state !== "READY" && job.state !== "BACKOFF") ||
        job.nextAttemptAt > at
      ) continue;
      const updated: BaseReconciliationJob = {
        ...job,
        state: "RUNNING",
        attemptCount: job.attemptCount + 1,
        leaseOwner: input.leaseOwner,
        leaseToken: `lease.${++this.leaseSequence}`,
        leaseUntil: input.leaseUntil,
        version: job.version + 1,
        updatedAt: at,
      };
      this.jobs.set(key, updated);
      claimed.push(updated);
    }
    return claimed;
  }

  settleBaseReconciliationJob(input: {
    readonly jobId: string;
    readonly leaseToken: string;
    readonly observation?: unknown;
    readonly now?: string;
  }) {
    const current = this.leased(input.jobId, input.leaseToken);
    this.settled.push({ ...input });
    return this.replace(current, {
      state: "SETTLED",
      lastObservation: input.observation ?? null,
      lastErrorCode: null,
      updatedAt: input.now ?? NOW,
    });
  }

  rescheduleBaseReconciliationJob(input: {
    readonly jobId: string;
    readonly leaseToken: string;
    readonly nextAttemptAt: string;
    readonly errorCode: string | null;
    readonly observation?: unknown;
    readonly incrementFailure?: boolean;
    readonly now?: string;
  }) {
    const current = this.leased(input.jobId, input.leaseToken);
    this.rescheduled.push({ ...input });
    return this.replace(current, {
      state: "BACKOFF",
      nextAttemptAt: input.nextAttemptAt,
      failureCount: current.failureCount + (input.incrementFailure === false ? 0 : 1),
      lastObservation: input.observation ?? null,
      lastErrorCode: input.errorCode,
      updatedAt: input.now ?? NOW,
    });
  }

  pauseBaseReconciliationJob(input: {
    readonly jobId: string;
    readonly leaseToken: string;
    readonly errorCode: string;
    readonly observation?: unknown;
    readonly now?: string;
  }) {
    const current = this.leased(input.jobId, input.leaseToken);
    this.paused.push({ ...input });
    return this.replace(current, {
      state: "PAUSED",
      lastObservation: input.observation ?? null,
      lastErrorCode: input.errorCode,
      updatedAt: input.now ?? NOW,
    });
  }

  reapExpiredBaseReconciliationLeases(input: { readonly now?: string } = {}) {
    const at = input.now ?? NOW;
    let count = 0;
    for (const [key, job] of this.jobs) {
      if (job.state !== "RUNNING" || job.leaseUntil === null || job.leaseUntil > at) continue;
      this.jobs.set(key, {
        ...job,
        state: "BACKOFF",
        nextAttemptAt: at,
        leaseOwner: null,
        leaseToken: null,
        leaseUntil: null,
        version: job.version + 1,
        updatedAt: at,
      });
      count += 1;
    }
    return count;
  }

  private leased(id: string, leaseToken: string): BaseReconciliationJob {
    const current = [...this.jobs.values()].find((job) => job.id === id);
    if (!current || current.state !== "RUNNING" || current.leaseToken !== leaseToken) {
      throw Object.assign(new Error("lease conflict"), {
        code: "BASE_RECONCILIATION_JOB_CONFLICT",
      });
    }
    return current;
  }

  private replace(
    current: BaseReconciliationJob,
    fields: Partial<BaseReconciliationJob>,
  ): BaseReconciliationJob {
    const updated: BaseReconciliationJob = {
      ...current,
      ...fields,
      leaseOwner: null,
      leaseToken: null,
      leaseUntil: null,
      version: current.version + 1,
    };
    this.jobs.set(current.executionId, updated);
    return updated;
  }
}

const service = (input: {
  readonly getTruth?: (paymentId: string) => PaymentTruthV1 | null;
  readonly reconcile?: (
    paymentId: string,
    signal?: AbortSignal,
  ) => Promise<BaseReconcileResult>;
} = {}): BaseReconciliationService => ({
  getPaymentTruth: input.getTruth ?? ((paymentId) => truth(paymentId)),
  reconcilePayment: input.reconcile ?? (async (paymentId) => observation(paymentId, "pending")),
});

const makeScheduler = (
  jobs: MemoryJobs,
  reconciliation: BaseReconciliationService,
  options: BaseReconciliationSchedulerOptions = {},
) => createBaseReconciliationScheduler({
  jobs,
  reconciliation,
  now: () => new Date(NOW),
  random: () => 0.5,
  options: {
    leaseOwner: "test.scheduler",
    jitterRatio: 0,
    globalTimeoutMs: 1_000,
    itemTimeoutMs: 500,
    leaseDurationMs: 2_000,
    ...options,
  },
});

describe("Base reconciliation scheduler", () => {
  it("matches the durable SQLite job-store port structurally", () => {
    expect(sqliteStoreImplementsSchedulerPort).toBeTrue();
  });

  it("is inert until explicitly started and exposes a networkless status", async () => {
    const jobs = new MemoryJobs([candidate("opt-in")]);
    const timers: Array<{ callback: () => void; cancelled: boolean }> = [];
    const scheduler = createBaseReconciliationScheduler({
      jobs,
      reconciliation: service(),
      now: () => new Date(NOW),
      scheduleTimer(callback) {
        const timer = { callback, cancelled: false };
        timers.push(timer);
        return timer;
      },
      cancelTimer(handle) {
        (handle as { cancelled: boolean }).cancelled = true;
      },
      options: { leaseOwner: "test.scheduler" },
    });

    expect(scheduler.getStatus().state).toBe("stopped");
    expect(jobs.jobs.size).toBe(0);
    scheduler.start();
    expect(scheduler.getStatus().state).toBe("idle");
    expect(timers).toHaveLength(1);
    expect(jobs.jobs.size).toBe(0);
    await scheduler.stop();
    expect(scheduler.getStatus().state).toBe("stopped");
    expect(timers[0]?.cancelled).toBeTrue();
  });

  it("only enqueues exact signed Base artifact/transaction joins", async () => {
    const jobs = new MemoryJobs([
      candidate("valid"),
      candidate("prepared", { executionState: "prepared" }),
      candidate("unlinked", { signedArtifactId: "" }),
      candidate("mismatch", { externalTxId: `0x${"b".repeat(64)}` }),
      candidate("other-chain", { chainId: "eip155:1" }),
      candidate("other-asset", { assetId: "eip155:8453/erc20:0xdead" }),
    ]);
    const reconciled: string[] = [];
    const scheduler = makeScheduler(jobs, service({
      reconcile: async (paymentId) => {
        reconciled.push(paymentId);
        return observation(paymentId, "pending");
      },
    }));

    const result = await scheduler.runOnce();

    expect(result.discovered).toBe(6);
    expect(result.eligible).toBe(1);
    expect(result.claimed).toBe(1);
    expect(reconciled).toEqual(["payment.valid"]);
    expect([...jobs.jobs.keys()]).toEqual(["execution.payment.valid.0"]);
  });

  it("settles finalized truth, pauses conflicts, and backs off pending truth", async () => {
    const jobs = new MemoryJobs([
      candidate("settled"),
      candidate("conflict"),
      candidate("pending"),
    ]);
    const reconciliation = service({
      reconcile: async (paymentId) => {
        if (paymentId.endsWith("settled")) {
          return observation(paymentId, "settled", truth(paymentId, {
            visibility: "included",
            execution_result: "success",
            security_level: "finalized",
            canonicality: "canonical",
            actions: {
              reconcile: false,
              exact_rebroadcast: false,
              safe_to_create_new_payment: true,
            },
          }));
        }
        if (paymentId.endsWith("conflict")) {
          return observation(paymentId, "partial", truth(paymentId, {
            visibility: "included",
            canonicality: "conflicted",
            actions: {
              reconcile: false,
              exact_rebroadcast: false,
              safe_to_create_new_payment: false,
            },
          }));
        }
        return observation(paymentId, "pending");
      },
    });

    const result = await makeScheduler(jobs, reconciliation, {
      baseBackoffMs: 5_000,
      maxBackoffMs: 60_000,
    }).runOnce();

    expect(result.settled).toBe(1);
    expect(result.paused).toBe(1);
    expect(result.rescheduled).toBe(1);
    expect(jobs.paused[0]?.errorCode).toBe(BASE_RECONCILIATION_ERROR.FINALITY_CONFLICT);
    expect(jobs.rescheduled[0]?.errorCode).toBeNull();
    expect(jobs.rescheduled[0]?.incrementFailure).toBeFalse();
    expect(jobs.rescheduled[0]?.nextAttemptAt).toBe("2026-08-23T18:00:05.000Z");
  });

  it("reports a durable store failure separately from a lease conflict", async () => {
    const jobs = new MemoryJobs([candidate("store-failure")]);
    jobs.settleBaseReconciliationJob = () => {
      throw new Error("simulated disk failure");
    };
    const result = await makeScheduler(jobs, service({
      reconcile: async (paymentId) => observation(paymentId, "settled", truth(paymentId, {
        visibility: "included",
        execution_result: "success",
        security_level: "finalized",
        canonicality: "canonical",
        actions: {
          reconcile: false,
          exact_rebroadcast: false,
          safe_to_create_new_payment: true,
        },
      })),
    })).runOnce();

    expect(result.lease_conflicts).toBe(0);
    expect(result.error_codes).toContain(BASE_RECONCILIATION_ERROR.STORE_UNAVAILABLE);
    expect(result.error_codes).not.toContain(BASE_RECONCILIATION_ERROR.LEASE_CONFLICT);
  });

  it("settles an already-finalized job without another provider call", async () => {
    const terminal = candidate("already-final", { executionState: "succeeded" });
    const jobs = new MemoryJobs([]);
    // The job was enqueued while eligible, then another explicit reconciliation
    // finalized its execution before this lease was claimed.
    jobs.enqueueBaseReconciliationJobs([terminal]);
    let calls = 0;
    const scheduler = makeScheduler(jobs, service({
      getTruth: (paymentId) => truth(paymentId, {
        visibility: "included",
        execution_result: "reverted",
        security_level: "finalized",
        canonicality: "canonical",
        actions: {
          reconcile: false,
          exact_rebroadcast: false,
          safe_to_create_new_payment: true,
        },
      }),
      reconcile: async (paymentId) => {
        calls += 1;
        return observation(paymentId, "settled");
      },
    }));

    const result = await scheduler.runOnce();

    expect(result.settled).toBe(1);
    expect(calls).toBe(0);
  });

  it("sanitizes upstream failures and applies bounded exponential backoff", async () => {
    const jobs = new MemoryJobs([candidate("failure")]);
    const scheduler = makeScheduler(jobs, service({
      reconcile: async () => {
        throw new Error("secret token at https://rpc.example.invalid/private-key");
      },
    }), {
      baseBackoffMs: 2_000,
      maxBackoffMs: 3_000,
    });

    await scheduler.runOnce();
    const first = jobs.jobs.get("execution.payment.failure.0")!;
    jobs.jobs.set(first.executionId, { ...first, nextAttemptAt: NOW });
    await scheduler.runOnce();

    expect(jobs.rescheduled).toHaveLength(2);
    expect(jobs.rescheduled[0]?.errorCode).toBe(BASE_RECONCILIATION_ERROR.ATTEMPT_FAILED);
    expect(JSON.stringify(jobs.rescheduled)).not.toContain("rpc.example");
    expect(JSON.stringify(jobs.rescheduled)).not.toContain("secret token");
    const stored = jobs.jobs.get("execution.payment.failure.0")!;
    expect(stored.failureCount).toBe(2);
    expect(stored.nextAttemptAt).toBe("2026-08-23T18:00:03.000Z");
  });

  it("reaps and safely retries a job abandoned after an expired lease", async () => {
    const value = candidate("crashed");
    const jobs = new MemoryJobs([]);
    jobs.enqueueBaseReconciliationJobs([value], { now: "2026-08-23T17:00:00.000Z" });
    jobs.claimDueBaseReconciliationJobs({
      limit: 1,
      leaseOwner: "crashed.process",
      leaseUntil: "2026-08-23T17:30:00.000Z",
      now: "2026-08-23T17:00:00.000Z",
    });

    const result = await makeScheduler(jobs, service()).runOnce();

    expect(result.expired_leases_reaped).toBe(1);
    expect(result.claimed).toBe(1);
    expect(result.rescheduled).toBe(1);
    expect(jobs.jobs.get(value.executionId)?.attemptCount).toBe(2);
  });

  it("never exceeds configured observer concurrency", async () => {
    const jobs = new MemoryJobs(Array.from({ length: 7 }, (_, index) => candidate(`c${index}`)));
    let active = 0;
    let maximum = 0;
    const scheduler = makeScheduler(jobs, service({
      reconcile: async (paymentId) => {
        active += 1;
        maximum = Math.max(maximum, active);
        await new Promise((resolve) => setTimeout(resolve, 5));
        active -= 1;
        return observation(paymentId, "pending");
      },
    }), { batchSize: 7, concurrency: 2 });

    const result = await scheduler.runOnce();

    expect(result.claimed).toBe(7);
    expect(maximum).toBe(2);
  });

  it("is single-flight even when runOnce is called concurrently", async () => {
    const jobs = new MemoryJobs([candidate("single")]);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const scheduler = makeScheduler(jobs, service({
      reconcile: async (paymentId) => {
        await gate;
        return observation(paymentId, "pending");
      },
    }));

    const first = scheduler.runOnce();
    await Promise.resolve();
    const second = await scheduler.runOnce();
    release();
    await first;

    expect(second.outcome).toBe("already_running");
    expect(jobs.leaseSequence).toBe(1);
  });

  it("propagates cancellation and returns the lease immediately without a failure", async () => {
    const jobs = new MemoryJobs([candidate("cancel")]);
    let observing!: () => void;
    const observingNow = new Promise<void>((resolve) => {
      observing = resolve;
    });
    const reconciliation = service({
      reconcile: (paymentId, signal) => new Promise((_resolve, reject) => {
        observing();
        signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), {
          once: true,
        });
      }),
    });
    const scheduler = makeScheduler(jobs, reconciliation);
    const controller = new AbortController();

    const running = scheduler.runOnce({ signal: controller.signal });
    await observingNow;
    controller.abort();
    const result = await running;

    expect(result.outcome).toBe("cancelled");
    expect(jobs.rescheduled[0]?.errorCode).toBe(BASE_RECONCILIATION_ERROR.CANCELLED);
    expect(jobs.rescheduled[0]?.incrementFailure).toBeFalse();
    expect(jobs.rescheduled[0]?.nextAttemptAt).toBe(NOW);
  });

  it("aborts an over-time item and persists only a stable timeout code", async () => {
    const jobs = new MemoryJobs([candidate("timeout")]);
    let sawAbort = false;
    const reconciliation = service({
      reconcile: (_paymentId, signal) => new Promise((_resolve, reject) => {
        signal?.addEventListener("abort", () => {
          sawAbort = true;
          reject(new DOMException("provider URL must not escape", "AbortError"));
        }, { once: true });
      }),
    });
    const scheduler = makeScheduler(jobs, reconciliation, {
      itemTimeoutMs: 5,
      globalTimeoutMs: 100,
      leaseDurationMs: 200,
    });

    const result = await scheduler.runOnce();

    expect(result.rescheduled).toBe(1);
    expect(sawAbort).toBeTrue();
    expect(jobs.rescheduled[0]?.errorCode).toBe(BASE_RECONCILIATION_ERROR.TIMED_OUT);
    expect(JSON.stringify(jobs.rescheduled)).not.toContain("provider URL");
  });

  it("bounds the whole batch and promptly releases work not started before its deadline", async () => {
    const jobs = new MemoryJobs([candidate("global-1"), candidate("global-2")]);
    const timers: Array<{ callback: () => void; delay: number; cancelled: boolean }> = [];
    let observing!: () => void;
    const observingNow = new Promise<void>((resolve) => {
      observing = resolve;
    });
    const reconciliation = service({
      reconcile: (_paymentId, signal) => new Promise((_resolve, reject) => {
        observing();
        signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), {
          once: true,
        });
      }),
    });
    const scheduler = createBaseReconciliationScheduler({
      jobs,
      reconciliation,
      now: () => new Date(NOW),
      random: () => 0.5,
      scheduleTimer(callback, delay) {
        const timer = { callback, delay, cancelled: false };
        timers.push(timer);
        return timer;
      },
      cancelTimer(handle) {
        (handle as { cancelled: boolean }).cancelled = true;
      },
      options: {
        leaseOwner: "test.scheduler",
        batchSize: 2,
        concurrency: 1,
        globalTimeoutMs: 100,
        itemTimeoutMs: 50,
        leaseDurationMs: 200,
        jitterRatio: 0,
      },
    });

    const running = scheduler.runOnce();
    await observingNow;
    timers.find((timer) => timer.delay === 100)!.callback();
    const result = await running;

    expect(result.error_codes).toContain(BASE_RECONCILIATION_ERROR.TIMED_OUT);
    expect(jobs.rescheduled).toHaveLength(2);
    expect(jobs.rescheduled.map((entry) => entry.errorCode)).toEqual([
      BASE_RECONCILIATION_ERROR.TIMED_OUT,
      BASE_RECONCILIATION_ERROR.TIMED_OUT,
    ]);
    expect(jobs.rescheduled.map((entry) => entry.incrementFailure)).toEqual([true, false]);
    expect(jobs.rescheduled[1]?.nextAttemptAt).toBe(NOW);
  });

  it("has no custody, signing, submission, or pay-workflow imports", async () => {
    const source = await Bun.file(
      new URL("./base-reconciliation-scheduler.ts", import.meta.url),
    ).text();
    const importedPaths = [...source.matchAll(/from\s+["']([^"']+)["']/g)]
      .map((match) => match[1]!);

    expect(importedPaths).toEqual(["./base-reconciler.ts"]);
    expect(importedPaths.some((path) => /sender|signer|vault|pay/i.test(path))).toBeFalse();
    expect(source).not.toContain("confirmPayment(");
    expect(source).not.toContain("resumePaymentBroadcast(");
  });
});
