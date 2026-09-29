import { describe, expect, test } from "bun:test";
import { createBrowserWalletController } from "../src/integrations/browser-wallet";

const A = `0x${"1".repeat(40)}`, B = `0x${"2".repeat(40)}`;
const UUID = "11111111-1111-4111-8111-111111111111";
const UUID2 = "22222222-2222-4222-8222-222222222222";
type Listener = (...args: unknown[]) => void;
class FakeProvider {
  calls: string[] = [];
  listeners = new Map<string, Set<Listener>>();
  chain = "0x2105";
  addresses = [A, B];
  handler?: (method: string) => unknown;
  request({ method }: { method: string }): unknown {
    this.calls.push(method);
    if (this.handler) return this.handler(method);
    return method === "eth_chainId" ? this.chain : this.addresses;
  }
  on(event: string, listener: Listener) {
    const set = this.listeners.get(event) ?? new Set(); set.add(listener); this.listeners.set(event, set);
  }
  removeListener(event: string, listener: Listener) { this.listeners.get(event)?.delete(listener); }
  emit(event: string, value: unknown = []) { for (const listener of [...this.listeners.get(event) ?? []]) listener(value); }
  count() { return [...this.listeners.values()].reduce((sum, set) => sum + set.size, 0); }
}
class FakeWindow extends EventTarget {
  ethereum?: unknown;
  discoveryListeners = 0;
  override addEventListener(type: string, callback: EventListenerOrEventListenerObject | null, options?: AddEventListenerOptions | boolean) {
    if (type === "eip6963:announceProvider") this.discoveryListeners++;
    super.addEventListener(type, callback, options);
  }
}
function announce(target: FakeWindow, provider: unknown, overrides: Record<string, unknown> = {}) {
  target.dispatchEvent(new CustomEvent("eip6963:announceProvider", {
    detail: { info: { uuid: UUID, name: "Example wallet", rdns: "com.example.wallet", icon: "ignored", ...overrides }, provider },
  }));
}
function fixture(options: { timeoutMs?: number; guard?: () => boolean; provider?: FakeProvider } = {}) {
  const target = new FakeWindow(), wallet = options.provider ?? new FakeProvider();
  target.addEventListener("eip6963:requestProvider", () => announce(target, wallet));
  const controller = createBrowserWalletController({ window: target as unknown as Window, isSessionCurrent: options.guard ?? (() => true), timeoutMs: options.timeoutMs });
  return { target, wallet, controller, discover: () => controller.discover() };
}
async function until(check: () => boolean) { for (let i = 0; i < 100 && !check(); i++) await Bun.sleep(1); expect(check()).toBe(true); }

describe("browser wallet discovery", () => {
  test("initializes only explicitly, retains one page listener, requests announcements after listening, and never prompts discovery", () => {
    const f = fixture();
    expect(f.target.discoveryListeners).toBe(0);
    expect(f.controller.getState().wallets).toEqual([]);
    f.discover();
    expect(f.target.discoveryListeners).toBe(1);
    expect(f.controller.getState().wallets).toEqual([{ id: UUID, name: "Example wallet", source: "eip6963" }]);
    f.controller.close(); f.discover();
    const second = createBrowserWalletController({ window: f.target as unknown as Window, isSessionCurrent: () => true });
    second.discover();
    expect(f.target.discoveryListeners).toBe(1);
    expect(f.wallet.calls).toEqual([]);
    f.controller.close(); second.close();
  });
  test("deduplicates UUID and provider identity without allowing announcements to replace either", async () => {
    const f = fixture(), other = new FakeProvider(); f.discover();
    announce(f.target, other, { name: "Impersonated", uuid: UUID });
    announce(f.target, f.wallet, { uuid: UUID2 });
    expect(f.controller.getState().wallets).toHaveLength(1);
    announce(f.target, other, { uuid: UUID2, name: "Second wallet" });
    expect(f.controller.getState().wallets).toHaveLength(2);
    await f.controller.connect(UUID);
    expect(f.wallet.calls).toContain("eth_requestAccounts"); expect(other.calls).toEqual([]);
    f.controller.close();
  });
  test("rejects malformed or oversized metadata/providers and never reads an icon", () => {
    const target = new FakeWindow();
    const c = createBrowserWalletController({ window: target as unknown as Window, isSessionCurrent: () => true }); c.discover();
    for (const overrides of [{ uuid: "x" }, { name: "" }, { name: "a".repeat(81) }, { name: "unsafe\nname" }, { name: "\u202efake" }, { rdns: "javascript:bad" }, { rdns: "a".repeat(256) }]) announce(target, new FakeProvider(), overrides);
    announce(target, { request() {} });
    announce(target, new Proxy({}, { get() { throw new Error("private-provider-detail"); } }));
    expect(c.getState().wallets).toEqual([]);
    const info = { uuid: UUID, name: "<script>plain text</script>", rdns: "com.example.wallet", get icon() { throw new Error("Icon must not be read"); } };
    target.dispatchEvent(new CustomEvent("eip6963:announceProvider", { detail: { info, provider: new FakeProvider() } }));
    expect(c.getState().wallets[0]?.name).toBe("<script>plain text</script>");
    expect(JSON.stringify(c.getState())).not.toContain("provider");
    c.close();
  });
  test("bounds a flood of otherwise valid announcements", () => {
    const target = new FakeWindow(), c = createBrowserWalletController({ window: target as unknown as Window, isSessionCurrent: () => true }); c.discover();
    for (let i = 0; i < 40; i++) announce(target, new FakeProvider(), { uuid: `${i.toString(16).padStart(8, "0")}-1111-4111-8111-111111111111` });
    expect(c.getState().wallets).toHaveLength(32); c.close();
  });
  test("uses a generic legacy fallback only without announcements and invalidates it if an announced provider appears", async () => {
    const target = new FakeWindow(), legacy = new FakeProvider(); target.ethereum = legacy;
    const c = createBrowserWalletController({ window: target as unknown as Window, isSessionCurrent: () => true }); c.discover();
    expect(c.getState().wallets).toEqual([{ id: "legacy", name: "Browser wallet (legacy)", source: "legacy" }]);
    await c.connect("legacy"); announce(target, new FakeProvider());
    expect(c.getState().wallets).toHaveLength(1); expect(c.getState().wallets[0]?.source).toBe("eip6963");
    expect(c.getState().accounts).toEqual([]); expect(c.getState().error?.code).toBe("wallet_changed"); expect(legacy.count()).toBe(0);
    await expect(c.connect("legacy")).rejects.toMatchObject({ code: "wallet_unavailable" }); c.close();
  });
});

describe("explicit Base address selection", () => {
  test("returns all addresses, never chooses or saves one, and confirms only through allowed reads", async () => {
    const f = fixture(); f.discover();
    expect(await f.controller.connect(UUID)).toEqual({ wallet_id: UUID, wallet_name: "Example wallet", accounts: [A, B] });
    expect(f.wallet.calls).toEqual(["eth_chainId", "eth_requestAccounts", "eth_accounts", "eth_chainId"]);
    expect(await f.controller.confirm(B)).toEqual({ network: "base", address: B });
    expect(f.wallet.calls.slice(4)).toEqual(["eth_chainId", "eth_accounts", "eth_chainId"]);
    expect(f.wallet.calls.every(method => ["eth_accounts", "eth_requestAccounts", "eth_chainId"].includes(method))).toBe(true);
    f.controller.close(); expect(f.wallet.count()).toBe(0);
  });
  test("accepts initial accountsChanged during permission and uses fresh accounts afterwards", async () => {
    const f = fixture(); f.wallet.handler = method => {
      if (method === "eth_chainId") return "0x2105";
      if (method === "eth_requestAccounts") { f.wallet.emit("accountsChanged", [B]); return [A]; }
      return [B];
    };
    f.discover(); expect((await f.controller.connect(UUID)).accounts).toEqual([B]);
    expect(f.controller.getState().status).toBe("ready"); f.controller.close();
  });
  test("preserves mixed case and case-insensitively deduplicates without silently repairing a checksum", async () => {
    const f = fixture(); const mixed = "0xAb" + "1".repeat(38); f.wallet.addresses = [mixed, mixed.toLowerCase(), B]; f.discover();
    expect((await f.controller.connect(UUID)).accounts).toEqual([mixed, B]);
    expect(await f.controller.confirm(mixed)).toEqual({ network: "base", address: mixed }); f.controller.close();
  });
  test("refuses non-Base before prompting and a changed chain after account permission", async () => {
    const first = fixture(); first.wallet.chain = "0x1"; first.discover();
    await expect(first.controller.connect(UUID)).rejects.toMatchObject({ code: "wallet_wrong_network" });
    expect(first.wallet.calls).toEqual(["eth_chainId"]); first.controller.close();
    const next = fixture(); let chainReads = 0; next.wallet.handler = method => method === "eth_chainId" ? (++chainReads === 1 ? "0x2105" : "0x1") : [A]; next.discover();
    await expect(next.controller.connect(UUID)).rejects.toMatchObject({ code: "wallet_wrong_network" });
    expect(next.controller.getState().accounts).toEqual([]); next.controller.close();
  });
  test.each([null, ["not-an-address"], [A, 4], Array(21).fill(A)].map(response => ({ response })))("refuses malformed account response %j", async ({ response }) => {
    const f = fixture(); f.wallet.handler = method => method === "eth_chainId" ? "0x2105" : response; f.discover();
    await expect(f.controller.connect(UUID)).rejects.toMatchObject({ code: "wallet_invalid_response" });
    expect(f.controller.getState().accounts).toEqual([]); expect(f.wallet.count()).toBe(0); f.controller.close();
  });
  test("explains when the wallet shares no addresses", async () => {
    const f = fixture(); f.wallet.addresses = []; f.discover();
    await expect(f.controller.connect(UUID)).rejects.toMatchObject({ code: "wallet_no_accounts" });
    expect(f.controller.getState().error?.message).toContain("No addresses were shared"); f.controller.close();
  });
  test.each([[4001, "wallet_denied"], [-32002, "wallet_request_pending"], [4900, "wallet_unavailable"], [4200, "wallet_unavailable"]])("sanitizes provider error %s", async (code, expected) => {
    const f = fixture(); f.wallet.handler = () => { throw { code, message: "secret-provider-detail", data: "secret" }; }; f.discover();
    await expect(f.controller.connect(UUID)).rejects.toMatchObject({ code: expected });
    expect(JSON.stringify(f.controller.getState())).not.toContain("secret"); f.controller.close();
  });
  test("pins original provider methods instead of accepting a replacement after discovery", async () => {
    const f = fixture(); f.discover(); f.wallet.request = () => { throw new Error("replaced"); };
    expect((await f.controller.connect(UUID)).accounts).toEqual([A, B]); f.controller.close();
  });
});

describe("candidate invalidation and pending work", () => {
  test.each(["accountsChanged", "chainChanged", "disconnect"])("clears candidates and removes only owned listeners on %s", async event => {
    const f = fixture(); const unrelated = () => {}; f.wallet.on(event, unrelated); f.discover(); await f.controller.connect(UUID);
    f.wallet.emit(event); expect(f.controller.getState().accounts).toEqual([]); expect(f.controller.getState().error?.code).toBe("wallet_changed");
    await expect(f.controller.confirm(A)).rejects.toMatchObject({ code: "wallet_changed" });
    expect(f.wallet.count()).toBe(1); expect(f.wallet.listeners.get(event)?.has(unrelated)).toBe(true); f.controller.close();
  });
  test.each(["chainChanged", "disconnect"])("refuses %s during initial permission even if the request resolves later", async event => {
    const f = fixture(); let resolve!: (value: unknown) => void;
    f.wallet.handler = method => method === "eth_chainId" ? "0x2105" : new Promise(r => { resolve = r; }); f.discover();
    const pending = f.controller.connect(UUID); await until(() => !!resolve); f.wallet.emit(event);
    await expect(pending).rejects.toMatchObject({ code: "wallet_changed" }); resolve([A]); await Bun.sleep(1);
    expect(f.controller.getState().accounts).toEqual([]); expect(f.wallet.count()).toBe(0); f.controller.close();
  });
  test("refuses account events during final confirmation", async () => {
    const f = fixture(); f.discover(); await f.controller.connect(UUID);
    f.wallet.handler = method => { if (method === "eth_accounts") { f.wallet.emit("accountsChanged", [B]); return [A]; } return "0x2105"; };
    await expect(f.controller.confirm(A)).rejects.toMatchObject({ code: "wallet_changed" });
    expect(f.controller.getState().accounts).toEqual([]); f.controller.close();
  });
  test("rechecks account availability without a prompt, refusing silent removal", async () => {
    const f = fixture(); f.discover(); await f.controller.connect(UUID); f.wallet.addresses = [B];
    await expect(f.controller.confirm(A)).rejects.toMatchObject({ code: "wallet_changed" });
    expect(f.wallet.calls.filter(method => method === "eth_requestAccounts")).toHaveLength(1); f.controller.close();
  });
  test("refuses a chain change during final reads even without a provider event", async () => {
    const f = fixture(); f.discover(); await f.controller.connect(UUID);
    let chainReads = 0; f.wallet.handler = method => method === "eth_chainId" ? (++chainReads === 1 ? "0x2105" : "0x1") : [A];
    await expect(f.controller.confirm(A)).rejects.toMatchObject({ code: "wallet_wrong_network" });
    expect(f.controller.getState().accounts).toEqual([]); f.controller.close();
  });
  test("suppresses late results after close and refuses connect until explicitly rediscovered", async () => {
    const f = fixture(); let resolve!: (value: unknown) => void;
    f.wallet.handler = method => method === "eth_chainId" ? "0x2105" : new Promise(r => { resolve = r; }); f.discover();
    const pending = f.controller.connect(UUID); await until(() => !!resolve); f.controller.close();
    await expect(pending).rejects.toMatchObject({ code: "wallet_session_ended" }); resolve([A]); await Bun.sleep(1);
    expect(f.controller.getState()).toMatchObject({ status: "idle", wallets: [], accounts: [], error: null });
    expect(f.wallet.count()).toBe(0); await expect(f.controller.connect(UUID)).rejects.toMatchObject({ code: "wallet_session_ended" });
  });
  test("revalidates owner session after each async read", async () => {
    let current = true; const f = fixture({ guard: () => current });
    f.wallet.handler = method => { if (method === "eth_requestAccounts") current = false; return method === "eth_chainId" ? "0x2105" : [A]; }; f.discover();
    await expect(f.controller.connect(UUID)).rejects.toMatchObject({ code: "wallet_session_ended" });
    expect(f.controller.getState().accounts).toEqual([]); expect(f.wallet.count()).toBe(0); f.controller.close();
  });
  test("times out without cancelling the wallet and prevents a second outstanding permission request across reopen", async () => {
    const f = fixture({ timeoutMs: 10 }); let resolve!: (value: unknown) => void;
    f.wallet.handler = method => method === "eth_chainId" ? "0x2105" : new Promise(r => { resolve = r; }); f.discover();
    await expect(f.controller.connect(UUID)).rejects.toMatchObject({ code: "wallet_timeout" });
    expect(f.controller.getState().accounts).toEqual([]); expect(f.wallet.count()).toBe(0);
    f.controller.close(); f.discover();
    await expect(f.controller.connect(UUID)).rejects.toMatchObject({ code: "wallet_request_pending" });
    expect(f.wallet.calls.filter(method => method === "eth_requestAccounts")).toHaveLength(1);
    resolve([A]); await Bun.sleep(1); expect(f.controller.getState().accounts).toEqual([]); f.controller.close();
  });
  test("refuses overlapping controller operations without issuing another provider request", async () => {
    const f = fixture(); let resolve!: (value: unknown) => void;
    f.wallet.handler = method => method === "eth_chainId" ? "0x2105" : new Promise(r => { resolve = r; }); f.discover();
    const pending = f.controller.connect(UUID); await until(() => !!resolve); const count = f.wallet.calls.length;
    await expect(f.controller.connect(UUID)).rejects.toMatchObject({ code: "wallet_request_pending" });
    expect(f.wallet.calls).toHaveLength(count); f.controller.close(); await expect(pending).rejects.toMatchObject({ code: "wallet_session_ended" }); resolve([A]);
  });
});
