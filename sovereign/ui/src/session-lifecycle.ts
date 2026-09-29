export type SessionInspection =
  | { status: "valid"; expiresAt: number; serverTime: number; isCurrent: () => boolean }
  | { status: "invalid"; isCurrent: () => boolean }
  | { status: "stale" };

export type SessionStatus = "checking" | "valid" | "unknown" | "invalid";

type Clock = {
  now: () => number;
  monotonicNow: () => number;
  later: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  cancel: (timer: ReturnType<typeof setTimeout>) => void;
};

/** A read-only session check with bounded waiting and a conservative local TTL.
 * It never renews the session. Wall and monotonic clocks together cover sleeping
 * tabs and local clock changes; the server supplies the TTL, not the local date. */
export function createSessionLifecycle(options: {
  inspect: (signal: AbortSignal) => Promise<SessionInspection>;
  onStatus: (status: SessionStatus) => void;
  timeoutMs?: number;
  clock?: Clock;
}) {
  const clock: Clock = options.clock ?? {
    now: Date.now,
    monotonicNow: () => performance.now(),
    later: (fn, ms) => setTimeout(fn, ms),
    cancel: (timer) => clearTimeout(timer),
  };
  let disposed = false;
  let ended = false;
  let requestId = 0;
  let pending: AbortController | null = null;
  let waitTimer: ReturnType<typeof setTimeout> | undefined;
  let expiryTimer: ReturnType<typeof setTimeout> | undefined;
  let expiry: { wall: number; monotonic: number; isCurrent: () => boolean } | null = null;

  function cancelWait() {
    if (waitTimer !== undefined) clock.cancel(waitTimer);
    waitTimer = undefined;
  }

  function expire() {
    if (disposed || ended || !expiry?.isCurrent()) return;
    ended = true;
    requestId++;
    pending?.abort();
    pending = null;
    cancelWait();
    options.onStatus("invalid");
  }

  function remaining() {
    return expiry ? Math.min(expiry.wall - clock.now(), expiry.monotonic - clock.monotonicNow()) : Infinity;
  }

  function scheduleExpiry() {
    if (expiryTimer !== undefined) clock.cancel(expiryTimer);
    const ms = remaining();
    if (ms <= 0) expire();
    else expiryTimer = clock.later(scheduleExpiry, Math.min(ms, 2_147_483_647));
  }

  async function check() {
    if (disposed || ended) return;
    // Timers may have been throttled or frozen while the tab was hidden.
    if (expiry?.isCurrent() && remaining() <= 0) { expire(); return; }
    if (pending) return;
    const id = ++requestId;
    const controller = new AbortController();
    pending = controller;
    const startedWall = clock.now();
    const startedMonotonic = clock.monotonicNow();
    options.onStatus("checking");
    waitTimer = clock.later(() => {
      if (disposed || id !== requestId) return;
      requestId++;
      pending = null;
      waitTimer = undefined;
      controller.abort();
      options.onStatus("unknown");
    }, options.timeoutMs ?? 8_000);
    try {
      const result = await options.inspect(controller.signal);
      if (disposed || id !== requestId) return;
      if (result.status === "stale" || !result.isCurrent()) return;
      if (result.status === "invalid") {
        ended = true;
        options.onStatus("invalid");
        return;
      }
      // Subtract the full round trip so an uncertain response cannot extend TTL.
      const elapsed = Math.max(0, clock.now() - startedWall, clock.monotonicNow() - startedMonotonic);
      const ttl = result.expiresAt - result.serverTime - elapsed;
      expiry = { wall: clock.now() + ttl, monotonic: clock.monotonicNow() + ttl, isCurrent: result.isCurrent };
      if (ttl <= 0) { expire(); return; }
      scheduleExpiry();
      options.onStatus("valid");
    } catch {
      if (!disposed && id === requestId) options.onStatus("unknown");
    } finally {
      if (id === requestId) {
        pending = null;
        cancelWait();
      }
    }
  }

  return {
    check,
    dispose() {
      disposed = true;
      requestId++;
      pending?.abort();
      pending = null;
      cancelWait();
      if (expiryTimer !== undefined) clock.cancel(expiryTimer);
    },
  };
}
