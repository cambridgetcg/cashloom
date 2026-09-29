import { expect, test } from "bun:test";
import { createSessionLifecycle, type SessionInspection, type SessionStatus } from "../src/session-lifecycle";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function fakeClock() {
  let wall = 9_000_000;
  let monotonic = 0;
  let next = 0;
  const timers = new Map<number, { at: number; fn: () => void }>();
  return {
    now: () => wall,
    monotonicNow: () => monotonic,
    later: (fn: () => void, ms: number) => {
      const id = ++next;
      timers.set(id, { at: monotonic + ms, fn });
      return id as unknown as ReturnType<typeof setTimeout>;
    },
    cancel: (id: ReturnType<typeof setTimeout>) => { timers.delete(id as unknown as number); },
    advance(ms: number, runTimers = true) {
      wall += ms;
      monotonic += ms;
      if (runTimers) {
        for (const [id, timer] of [...timers]) {
          if (timer.at <= monotonic && timers.delete(id)) timer.fn();
        }
      }
    },
    shiftWall(ms: number) { wall += ms; },
  };
}

const valid = (ttl: number, isCurrent = () => true): SessionInspection => ({
  status: "valid", serverTime: 100_000, expiresAt: 100_000 + ttl, isCurrent,
});

test("cold session check uses server TTL and subtracts request time without renewing", async () => {
  const clock = fakeClock();
  const read = deferred<SessionInspection>();
  const states: SessionStatus[] = [];
  const session = createSessionLifecycle({ clock, inspect: () => read.promise, onStatus: (state) => states.push(state) });
  const checking = session.check();
  expect(states).toEqual(["checking"]);
  clock.advance(100);
  read.resolve(valid(1_000));
  await checking;
  expect(states).toEqual(["checking", "valid"]);
  clock.advance(899);
  expect(states.at(-1)).toBe("valid");
  clock.advance(1);
  expect(states.at(-1)).toBe("invalid");
  session.dispose();
});

test("focus events coalesce; offline uncertainty can retry without declaring invalid", async () => {
  const clock = fakeClock();
  const states: SessionStatus[] = [];
  const read = deferred<SessionInspection>();
  let calls = 0;
  const session = createSessionLifecycle({ clock, inspect: () => { calls++; return read.promise; }, onStatus: (state) => states.push(state) });
  const first = session.check();
  await session.check();
  await session.check();
  expect(calls).toBe(1);
  read.resolve(valid(5_000));
  await first;
  session.dispose();

  let offline = false;
  const retry = createSessionLifecycle({ clock, inspect: async () => {
    if (offline) throw new Error("offline");
    return valid(5_000);
  }, onStatus: (state) => states.push(state) });
  await retry.check();
  offline = true;
  await retry.check();
  expect(states.at(-1)).toBe("unknown");
  expect(states).not.toContain("invalid");
  offline = false;
  await retry.check();
  expect(states.at(-1)).toBe("valid");
  retry.dispose();
});

test("an unresponsive read times out, aborts, and cannot replace the retry result", async () => {
  const clock = fakeClock();
  const stalled = deferred<SessionInspection>();
  const states: SessionStatus[] = [];
  let oldSignal: AbortSignal | undefined;
  let calls = 0;
  const session = createSessionLifecycle({ clock, timeoutMs: 500, inspect: (signal) => {
    calls++;
    if (calls === 1) { oldSignal = signal; return stalled.promise; }
    return Promise.resolve(valid(5_000));
  }, onStatus: (state) => states.push(state) });
  const first = session.check();
  clock.advance(500);
  expect(oldSignal?.aborted).toBe(true);
  expect(states.at(-1)).toBe("unknown");
  await session.check();
  expect(states.at(-1)).toBe("valid");
  stalled.resolve({ status: "invalid", isCurrent: () => true });
  await first;
  expect(states.at(-1)).toBe("valid");
  session.dispose();
});

test("known expiry still ends an offline session and a hidden-tab resume checks overdue TTL", async () => {
  for (const runTimers of [true, false]) {
    const clock = fakeClock();
    const states: SessionStatus[] = [];
    let calls = 0;
    const session = createSessionLifecycle({ clock, inspect: async () => {
      if (++calls > 1) throw new Error("offline");
      return valid(1_000);
    }, onStatus: (state) => states.push(state) });
    await session.check();
    await session.check();
    expect(states.at(-1)).toBe("unknown");
    clock.advance(1_000, runTimers);
    await session.check();
    expect(states.at(-1)).toBe("invalid");
    expect(calls).toBe(2);
    session.dispose();
  }
});

test("moving the local clock back cannot extend server TTL", async () => {
  const clock = fakeClock();
  const states: SessionStatus[] = [];
  const session = createSessionLifecycle({ clock, inspect: async () => valid(1_000), onStatus: (state) => states.push(state) });
  await session.check();
  clock.shiftWall(-60_000);
  clock.advance(1_000);
  expect(states.at(-1)).toBe("invalid");
  session.dispose();
});

test("an old lifecycle cannot invalidate a newer session or update after disposal", async () => {
  const clock = fakeClock();
  const states: SessionStatus[] = [];
  let current = true;
  const session = createSessionLifecycle({ clock, inspect: async () => valid(1_000, () => current), onStatus: (state) => states.push(state) });
  await session.check();
  current = false;
  clock.advance(1_000);
  expect(states).toEqual(["checking", "valid"]);
  session.dispose();

  const late = deferred<SessionInspection>();
  const disposed = createSessionLifecycle({ clock, inspect: () => late.promise, onStatus: (state) => states.push(state) });
  const checking = disposed.check();
  disposed.dispose();
  late.resolve({ status: "invalid", isCurrent: () => true });
  await checking;
  expect(states.at(-1)).toBe("checking");
});
