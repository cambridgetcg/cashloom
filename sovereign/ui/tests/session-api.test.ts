import { expect, test } from "bun:test";
import { api, ApiError, hasToken, inspectVaultSession, onSessionLost, setToken } from "../src/api";

function response(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
}

test("session inspection reads only private expiry metadata and does not renew the token", async () => {
  const original = globalThis.fetch;
  setToken("synthetic-session");
  let calls = 0;
  const controller = new AbortController();
  globalThis.fetch = (async (path, init) => {
    calls++;
    expect(path).toBe("/api/vault/session");
    expect(init?.body).toBeUndefined();
    expect(init?.cache).toBe("no-store");
    expect(init?.signal).toBe(controller.signal);
    expect((init?.headers as Record<string, string>).Authorization).toBe("Bearer synthetic-session");
    return response({ serverTime: "2026-09-23T12:00:00.000Z", expiresAt: "2026-09-23T12:15:00.000Z" });
  }) as typeof fetch;
  try {
    const result = await inspectVaultSession(controller.signal);
    expect(result.status).toBe("valid");
    if (result.status !== "valid") throw new Error("Expected valid session");
    expect(result.expiresAt - result.serverTime).toBe(900_000);
    expect(result.isCurrent()).toBe(true);
    expect(hasToken()).toBe(true);
    expect(calls).toBe(1);
  } finally { globalThis.fetch = original; setToken(null); }
});

test("session inspection distinguishes rejected access from offline or malformed status", async () => {
  const original = globalThis.fetch;
  setToken("synthetic-session");
  const controller = new AbortController();
  try {
    globalThis.fetch = (async () => response({ error: "locked" }, 401)) as typeof fetch;
    expect((await inspectVaultSession(controller.signal)).status).toBe("invalid");
    expect(hasToken()).toBe(true); // lifecycle owner clears it and unmounts together
    globalThis.fetch = (async () => { throw new Error("offline"); }) as typeof fetch;
    await expect(inspectVaultSession(controller.signal)).rejects.toThrow("offline");
    globalThis.fetch = (async () => response({ expiresAt: "bad date", serverTime: "bad date" })) as typeof fetch;
    await expect(inspectVaultSession(controller.signal)).rejects.toThrow("unreadable session status");
    expect(hasToken()).toBe(true);
  } finally { globalThis.fetch = original; setToken(null); }
});

test("delayed session and ordinary API 401 responses cannot clear a newly unlocked token", async () => {
  const original = globalThis.fetch;
  let lost = 0;
  onSessionLost(() => { lost++; });
  try {
    for (const inspect of [true, false]) {
      let resolve!: (value: Response) => void;
      globalThis.fetch = (() => new Promise<Response>((yes) => { resolve = yes; })) as typeof fetch;
      setToken("synthetic-old-session");
      const pending = inspect ? inspectVaultSession(new AbortController().signal) : api.trades();
      setToken("synthetic-new-session");
      resolve(response({ error: "locked", message: "Old session ended." }, 401));
      if (inspect) expect((await pending as { status: string }).status).toBe("stale");
      else await expect(pending).rejects.toThrow("Your session changed.");
      expect(hasToken()).toBe(true);
      expect(lost).toBe(0);
    }
  } finally { globalThis.fetch = original; setToken(null); onSessionLost(() => undefined); }
});

test("late successful private responses cannot reach mutation callbacks after lock or re-unlock", async () => {
  const original = globalThis.fetch;
  try {
    for (const nextToken of [null, "synthetic-new-session"]) {
      let resolve!: (value: Response) => void;
      globalThis.fetch = (() => new Promise<Response>((yes) => { resolve = yes; })) as typeof fetch;
      setToken("synthetic-old-session");
      let callbackReached = false;
      const pending = api.syncAccount("synthetic-private-account").then(() => { callbackReached = true; });
      setToken(nextToken);
      resolve(response({ balanceMinor: "987654321", imported: 1, skipped: 0 }));
      let caught: unknown;
      try { await pending; } catch (error) { caught = error; }
      expect(caught).toBeInstanceOf(ApiError);
      expect((caught as ApiError).code).toBe("session_changed");
      expect((caught as ApiError).message).toBe("Your session changed. Reopen the view to check the result.");
      expect(callbackReached).toBe(false);
      expect(hasToken()).toBe(nextToken !== null);
    }
  } finally { globalThis.fetch = original; setToken(null); }
});

test("the explicit lock acknowledgement survives immediate local clearing without exposing extra fields", async () => {
  const original = globalThis.fetch;
  let resolve!: (value: Response) => void;
  globalThis.fetch = (() => new Promise<Response>((yes) => { resolve = yes; })) as typeof fetch;
  try {
    setToken("synthetic-old-session");
    const pending = api.vaultLock();
    setToken(null);
    resolve(response({ ok: true, unexpectedPrivateField: "synthetic-private-value" }));
    expect(await pending).toEqual({ ok: true });
    expect(hasToken()).toBe(false);
  } finally { globalThis.fetch = original; setToken(null); }
});

test("unlock responses remain readable when the prior local session changes", async () => {
  const original = globalThis.fetch;
  let resolve!: (value: Response) => void;
  globalThis.fetch = (() => new Promise<Response>((yes) => { resolve = yes; })) as typeof fetch;
  try {
    setToken("synthetic-old-session");
    const pending = api.vaultUnlock("synthetic-passphrase");
    setToken(null);
    resolve(response({ ok: true, token: "synthetic-new-session" }));
    expect(await pending).toEqual({ ok: true, token: "synthetic-new-session" });
  } finally { globalThis.fetch = original; setToken(null); }
});
