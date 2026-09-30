import { describe, expect, test } from "bun:test";
import { createPhoneWalletController, type PhoneWalletWorker } from "../src/integrations/walletconnect-watch";
import { PhoneMemoryStorage, phoneSessionAddresses, validPairingUri, validOrigin, type PhoneWorkerCommand } from "../src/integrations/walletconnect-watch-contract";

const A = `0x${"1".repeat(40)}`, B = `0x${"2".repeat(40)}`;
const URI = `wc:${"a".repeat(64)}@2?relay-protocol=irn&symKey=${"b".repeat(64)}`;
const later = () => new Date(Date.now() + 60_000).toISOString();
const session = () => ({ expiry: Math.floor(Date.now() / 1000) + 3600,
  namespaces: { eip155: { chains: ["eip155:8453"], methods: [], events: ["accountsChanged", "chainChanged"], accounts: [`eip155:8453:${A}`, `eip155:8453:${B}`] } } });
class FakeWorker implements PhoneWalletWorker {
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  commands: PhoneWorkerCommand[] = [];
  terminated = 0;
  postMessage(message: PhoneWorkerCommand) { this.commands.push(message); }
  terminate() { this.terminated++; }
  emit(message: unknown) { this.onmessage?.({ data: message } as MessageEvent); }
}
function fixture(options: { guard?: () => boolean; startupTimeoutMs?: number; confirmationTimeoutMs?: number } = {}) {
  const workers: FakeWorker[] = [];
  const controller = createPhoneWalletController({ projectId: "0".repeat(32), origin: "http://127.0.0.1:4747", isSessionCurrent: options.guard ?? (() => true),
    closeTimeoutMs: 5, ...options, workerFactory() { const worker = new FakeWorker(); workers.push(worker); return worker; } });
  return { controller, workers, async pairing() { const started = controller.start(); const worker = workers.at(-1)!; worker.emit({ type: "pairing", uri: URI, expires_at: later() }); await started; return worker; },
    async ready() { const worker = await this.pairing(); worker.emit({ type: "ready", accounts: [A, B], expires_at: later() }); return worker; } };
}

describe("WalletConnect address-only session boundary", () => {
  test("accepts empty methods, exact Base scope, multiple addresses and canonical CAIP-2 namespace form", () => {
    expect(phoneSessionAddresses(session()).accounts).toEqual([A, B]);
    const value = session(); const namespace = value.namespaces.eip155;
    expect(phoneSessionAddresses({ ...value, namespaces: { "eip155:8453": namespace } }).accounts).toEqual([A, B]);
    const { chains: _chains, ...withoutChains } = namespace;
    expect(phoneSessionAddresses({ ...value, namespaces: { eip155: withoutChains } }).accounts).toEqual([A, B]);
  });
  test.each(["personal_sign", "eth_accounts", "eth_sendTransaction", "wallet_switchEthereumChain"])("refuses extra method %s instead of accepting elevated capabilities", method => {
    const value = session(); (value.namespaces.eip155.methods as string[]) = [method];
    expect(() => phoneSessionAddresses(value)).toThrow("address-only Base");
  });
  test("refuses additional chains, accounts, namespaces, events and extension fields", () => {
    const mutate = [
      (value: any) => value.namespaces.eip155.chains.push("eip155:1"),
      (value: any) => value.namespaces.eip155.accounts.push(`eip155:1:${A}`),
      (value: any) => value.namespaces.solana = {},
      (value: any) => value.namespaces.eip155.events.push("message"),
      (value: any) => value.namespaces.eip155.events = ["accountsChanged", "accountsChanged"],
      (value: any) => value.namespaces.eip155.accounts = [],
      (value: any) => value.namespaces.eip155.accounts = Array(21).fill(`eip155:8453:${A}`),
      (value: any) => value.namespaces.eip155.accounts = [`eip155:8453:bad`],
      (value: any) => value.namespaces.eip155.extensions = { methods: ["personal_sign"] },
    ];
    for (const change of mutate) { const value = session(); change(value); expect(() => phoneSessionAddresses(value)).toThrow("address-only Base"); }
  });
  test("preserves mixed casing for backend checksum validation, while deduplicating addresses", () => {
    const value = session(), mixed = "0xAb" + "1".repeat(38);
    value.namespaces.eip155.accounts = [`eip155:8453:${mixed}`, `eip155:8453:${mixed.toLowerCase()}`];
    expect(phoneSessionAddresses(value).accounts).toEqual([mixed]);
  });
  test("refuses expired or malformed session objects with fixed errors", () => {
    expect(() => phoneSessionAddresses({ ...session(), expiry: 1 })).toThrow("expired");
    for (const value of [null, {}, { ...session(), expiry: "tomorrow" }, new Proxy({}, { get() { throw Error("raw peer secret"); } })]) {
      expect(() => phoneSessionAddresses(value)).toThrow("address-only Base");
    }
  });
  test("accepts only bounded WalletConnect v2 IRN pairing URIs and honest origins", () => {
    expect(validPairingUri(URI)).toBe(true);
    for (const uri of [URI + "&symKey=" + "c".repeat(64), URI + "&relay-data=evil", URI + "#fragment", URI.replace("@2", "@1"), URI.replace("irn", "evil"), "https://example.com"]) expect(validPairingUri(uri)).toBe(false);
    for (const origin of ["http://127.0.0.1:4747", "http://localhost:4747", "http://[::1]:4747", "https://example.test"]) expect(validOrigin(origin)).toBe(true);
    for (const origin of ["http://example.test", "https://example.test/path", "https://user:pass@example.test", "https://example.test?q=x", "null"]) expect(validOrigin(origin)).toBe(false);
  });
  test("isolates memory storage, clones values and clears all local material", async () => {
    const first = new PhoneMemoryStorage(), second = new PhoneMemoryStorage(); const input = { secret: "synthetic", nested: [1] };
    await first.setItem("key", input); input.nested.push(2);
    const read = (await first.getItem<typeof input>("key"))!; read.nested.push(3);
    expect(await first.getItem("key")).toEqual({ secret: "synthetic", nested: [1] });
    expect(await second.getKeys()).toEqual([]); first.clear(); expect(await first.getEntries()).toEqual([]);
    await expect(first.setItem("key", "x".repeat(2_000_000))).rejects.toThrow("could not connect");
  });
});

describe("phone wallet controller lifecycle", () => {
  test("constructs no worker before explicit start, never selects automatically, and clears QR on approval", async () => {
    const f = fixture(); expect(f.workers).toEqual([]); const worker = await f.pairing();
    expect(worker.commands).toEqual([{ type: "start", project_id: "0".repeat(32), origin: "http://127.0.0.1:4747" }]);
    expect(f.controller.getState()).toMatchObject({ status: "pairing", uri: URI, accounts: [] });
    worker.emit({ type: "ready", accounts: [A, B], expires_at: later() });
    expect(f.controller.getState()).toMatchObject({ status: "ready", uri: null, accounts: [A, B] });
    expect(worker.commands).toHaveLength(1); f.controller.close(); await Bun.sleep(10); expect(worker.terminated).toBe(1);
  });
  test("requires explicit listed address confirmation and preserves its exact casing", async () => {
    const f = fixture(), worker = await f.ready();
    await expect(f.controller.confirm(`0x${"3".repeat(40)}`)).rejects.toMatchObject({ code: "phone_changed" });
    const confirmed = f.controller.confirm(B); expect(f.controller.getState().status).toBe("confirming");
    const command = worker.commands.at(-1)!; expect(command).toMatchObject({ type: "confirm", address: B });
    if (command.type !== "confirm") throw Error("missing fixture command");
    worker.emit({ type: "confirmed", request_id: command.request_id, address: B });
    expect(await confirmed).toEqual({ network: "base", address: B }); expect(f.controller.getState()).toMatchObject({ status: "ready", uri: null });
    f.controller.close();
  });
  test("refuses confirmation reply substitution and exposes no raw worker error text", async () => {
    const f = fixture(), worker = await f.ready(); const pending = f.controller.confirm(A);
    worker.emit({ type: "confirmed", request_id: 999, address: B, private: "secret" });
    await expect(pending).rejects.toMatchObject({ code: "phone_changed" });
    expect(f.controller.getState()).toMatchObject({ status: "error", uri: null, accounts: [] }); expect(JSON.stringify(f.controller.getState())).not.toContain("secret");
    f.controller.close();
  });
  test.each(["phone_changed", "phone_expired", "phone_scope_refused", "phone_declined"])("clears all candidates on worker %s", async code => {
    const f = fixture(), worker = await f.ready(); worker.emit({ type: "error", code, message: "raw pairing topic" });
    expect(f.controller.getState()).toMatchObject({ status: "error", uri: null, accounts: [], error: { code } });
    expect(JSON.stringify(f.controller.getState())).not.toContain("raw pairing topic"); await Bun.sleep(10); expect(worker.terminated).toBe(1); f.controller.close();
  });
  test("cancels start and ignores late approval after close or replacement", async () => {
    const f = fixture(); const started = f.controller.start(); const old = f.workers[0]!; const oldHandler = old.onmessage!;
    f.controller.close(); await expect(started).rejects.toMatchObject({ code: "phone_session_ended" });
    const current = await f.pairing(); oldHandler({ data: { type: "ready", accounts: [A], expires_at: later() } } as MessageEvent);
    expect(f.controller.getState()).toMatchObject({ status: "pairing", accounts: [] });
    await Bun.sleep(10); expect(old.terminated).toBe(1); expect(current.terminated).toBe(0); f.controller.close();
  });
  test("terminates even when cleanup never acknowledges and ends sooner on clean worker close", async () => {
    const f = fixture(), worker = await f.pairing(); f.controller.close();
    expect(f.controller.getState()).toMatchObject({ status: "idle", uri: null, accounts: [] }); expect(worker.commands.at(-1)).toEqual({ type: "close" });
    await Bun.sleep(10); expect(worker.terminated).toBe(1);
    const next = await f.pairing(); f.controller.close(); next.emit({ type: "closed" }); expect(next.terminated).toBe(1); await Bun.sleep(10); expect(next.terminated).toBe(1);
  });
  test("pagehide can synchronously terminate without relying on timers or acknowledgments", async () => {
    const f = fixture(), worker = await f.pairing(); f.controller.close({ immediate: true });
    expect(worker.terminated).toBe(1); expect(worker.commands.at(-1)).toEqual({ type: "close" });
    expect(worker.onmessage).toBeNull(); expect(f.controller.getState()).toMatchObject({ status: "idle", uri: null, accounts: [] });
    await Bun.sleep(10); expect(worker.terminated).toBe(1);
  });
  test("rejects late owner-session results and cannot confirm after lock", async () => {
    let unlocked = true; const f = fixture({ guard: () => unlocked }); const worker = await f.pairing(); unlocked = false;
    worker.emit({ type: "ready", accounts: [A], expires_at: later() }); expect(f.controller.getState().error?.code).toBe("phone_session_ended");
    await expect(f.controller.confirm(A)).rejects.toMatchObject({ code: "phone_session_ended" }); expect(f.controller.getState().accounts).toEqual([]); f.controller.close();
  });
  test("bounds startup, pairing expiry and confirmation with independent deadlines", async () => {
    const first = fixture({ startupTimeoutMs: 5 }); await expect(first.controller.start()).rejects.toMatchObject({ code: "phone_timeout" });
    await Bun.sleep(10); expect(first.workers[0]!.terminated).toBe(1);
    const second = fixture(); const start = second.controller.start(); second.workers[0]!.emit({ type: "pairing", uri: URI, expires_at: new Date(Date.now() + 10).toISOString() }); await start;
    await Bun.sleep(15); expect(second.controller.getState().error?.code).toBe("phone_expired");
    const third = fixture({ confirmationTimeoutMs: 5 }); const worker = await third.ready();
    await expect(third.controller.confirm(A)).rejects.toMatchObject({ code: "phone_timeout" });
    worker.emit({ type: "confirmed", request_id: 1, address: A }); expect(third.controller.getState().accounts).toEqual([]); first.controller.close(); second.controller.close(); third.controller.close();
  });
  test("does not extend the original pairing deadline when approval asks for a longer session", async () => {
    const f = fixture(), started = f.controller.start(), worker = f.workers[0]!; const expiry = new Date(Date.now() + 20).toISOString();
    worker.emit({ type: "pairing", uri: URI, expires_at: expiry }); await started;
    worker.emit({ type: "ready", accounts: [A], expires_at: later() }); expect(f.controller.getState().expires_at).toBe(expiry);
    await Bun.sleep(25); expect(f.controller.getState().error?.code).toBe("phone_expired"); f.controller.close();
  });
  test("refuses malformed addresses, duplicate choices and impossible pairing metadata", async () => {
    for (const accounts of [[], [A, A], ["eip155:8453:" + A], Array(21).fill(A)]) {
      const f = fixture(), worker = await f.pairing(); worker.emit({ type: "ready", accounts, expires_at: later() });
      expect(f.controller.getState().error?.code).toBe("phone_scope_refused"); f.controller.close();
    }
    const f = fixture(), pending = f.controller.start(); f.workers[0]!.emit({ type: "pairing", uri: "https://untrusted.example", expires_at: later() });
    await expect(pending).rejects.toMatchObject({ code: "phone_unavailable" }); f.controller.close();
  });
  test("rejects missing configuration and ended owner session before creating a worker", async () => {
    let constructed = 0;
    const factory = () => { constructed++; return new FakeWorker(); };
    const bad = createPhoneWalletController({ projectId: "", origin: "http://127.0.0.1", isSessionCurrent: () => true, workerFactory: factory });
    await expect(bad.start()).rejects.toMatchObject({ code: "phone_invalid_configuration" });
    const locked = createPhoneWalletController({ projectId: "0".repeat(32), origin: "http://127.0.0.1", isSessionCurrent: () => false, workerFactory: factory });
    await expect(locked.start()).rejects.toMatchObject({ code: "phone_session_ended" }); expect(constructed).toBe(0);
  });
});
