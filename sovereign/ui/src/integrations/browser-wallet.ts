/** Browser address selection only. No signing, sending, chain changes, storage,
 * relay transport, or backend access. Provider metadata is self-reported. */
const messages = {
  wallet_unavailable: "This wallet is unavailable. Open your browser wallet and try again.",
  wallet_denied: "The wallet request was declined. You can choose a wallet again or paste an address.",
  wallet_request_pending: "A request is already open in your wallet. Finish or dismiss it before trying again. If it remains stuck, reload this page.",
  wallet_wrong_network: "Choose Base in your wallet, then try again. CashLoom will not switch networks for you.",
  wallet_invalid_response: "The wallet returned an unsupported response. Try again or paste a public address.",
  wallet_no_accounts: "No addresses were shared. Approve address access in your wallet or paste a public address.",
  wallet_changed: "The wallet account or network changed. Choose the wallet again before using an address.",
  wallet_timeout: "The wallet did not respond in time. Dismiss any open wallet request before trying again.",
  wallet_session_ended: "This selection has ended. Open the wallet picker again in your unlocked workspace.",
} as const;
export type BrowserWalletErrorCode = keyof typeof messages;
export class BrowserWalletError extends Error {
  constructor(readonly code: BrowserWalletErrorCode) { super(messages[code]); this.name = "BrowserWalletError"; }
}
export interface BrowserWalletChoice {
  readonly id: string;
  readonly name: string;
  readonly source: "eip6963" | "legacy";
}
export interface BrowserWalletState {
  readonly wallets: readonly BrowserWalletChoice[];
  readonly status: "idle" | "requesting" | "ready" | "error";
  readonly wallet_id: string | null;
  readonly accounts: readonly string[];
  readonly error: Readonly<{ code: BrowserWalletErrorCode; message: string }> | null;
}
export interface BrowserWalletAccounts {
  readonly wallet_id: string;
  readonly wallet_name: string;
  readonly accounts: readonly string[];
}
export interface BrowserWalletController {
  getState(): BrowserWalletState;
  subscribe(listener: (state: BrowserWalletState) => void): () => void;
  discover(): void;
  connect(walletId: string): Promise<BrowserWalletAccounts>;
  confirm(address: string): Promise<{ network: "base"; address: string }>;
  close(): void;
}

type EventListener = (...args: unknown[]) => void;
type BrowserWindow = Pick<Window, "addEventListener" | "dispatchEvent"> & { ethereum?: unknown };
type Provider = {
  object: object;
  request(method: "eth_chainId" | "eth_requestAccounts" | "eth_accounts"): Promise<unknown>;
  on(event: string, listener: EventListener): void;
  removeListener(event: string, listener: EventListener): void;
};
type Entry = { choice: BrowserWalletChoice; provider: Provider };
type Registry = { entries: Map<string, Entry>; subscribers: Set<() => void>; legacy: Entry | null };
const registries = new WeakMap<object, Registry>();
const pinnedProviders = new WeakMap<object, Provider>();
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ADDRESS = /^0x[0-9a-f]{40}$/i;
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/;
const MAX_WALLETS = 32;
const EVENTS = ["accountsChanged", "chainChanged", "disconnect"] as const;

function provider(input: unknown): Provider | null {
  try {
    if (!input || typeof input !== "object") return null;
    const pinned = pinnedProviders.get(input);
    if (pinned) return pinned;
    const raw = input as { request?: unknown; on?: unknown; removeListener?: unknown };
    const request = raw.request, on = raw.on, removeListener = raw.removeListener;
    if (typeof request !== "function" || typeof on !== "function" || typeof removeListener !== "function") return null;
    // Pin this provider and its methods. Later announcements cannot substitute it.
    let permissionPending = false;
    const handle: Provider = { object: input, request: async method => {
      if (method === "eth_requestAccounts" && permissionPending) throw new BrowserWalletError("wallet_request_pending");
      if (method === "eth_requestAccounts") permissionPending = true;
      try { return await request.call(input, { method }); }
      finally { if (method === "eth_requestAccounts") permissionPending = false; }
    },
      on: (event, listener) => { on.call(input, event, listener); },
      removeListener: (event, listener) => { removeListener.call(input, event, listener); } };
    pinnedProviders.set(input, handle);
    return handle;
  } catch { return null; }
}
function registryFor(target: BrowserWindow): Registry {
  const prior = registries.get(target);
  if (prior) return prior;
  const registry: Registry = { entries: new Map(), subscribers: new Set(), legacy: null };
  registries.set(target, registry);
  // EIP-6963 discovery is initialized only by discover(), then lives for the page.
  target.addEventListener("eip6963:announceProvider", ((event: CustomEvent) => {
    try {
      const detail = event.detail;
      if (!detail || typeof detail !== "object" || !detail.info || typeof detail.info !== "object") return;
      const { uuid, name, rdns } = detail.info;
      if (typeof uuid !== "string" || !UUID.test(uuid) || typeof name !== "string" ||
        !name.trim() || name.length > 80 || CONTROL.test(name) || typeof rdns !== "string" ||
        rdns.length > 255 || !/^[a-z0-9]+(?:[.-][a-z0-9]+)+$/i.test(rdns)) return;
      const id = uuid.toLowerCase();
      if (registry.entries.has(id) || registry.entries.size >= MAX_WALLETS) return;
      const handle = provider(detail.provider);
      if (!handle || [...registry.entries.values()].some(entry => entry.provider.object === handle.object)) return;
      // Icons and other supplied properties are never read, loaded or rendered.
      registry.entries.set(id, { choice: Object.freeze({ id, name: name.trim(), source: "eip6963" }), provider: handle });
      for (const listener of registry.subscribers) listener();
    } catch { /* Malformed announcements are not wallet errors or trusted text. */ }
  }) as globalThis.EventListener);
  return registry;
}
function accounts(input: unknown): readonly string[] {
  if (Array.isArray(input) && input.length === 0) throw new BrowserWalletError("wallet_no_accounts");
  if (!Array.isArray(input) || input.length < 1 || input.length > 20 || input.some(value => typeof value !== "string" || !ADDRESS.test(value))) {
    throw new BrowserWalletError("wallet_invalid_response");
  }
  // Preserve casing so the server can enforce mixed-case checksum validity.
  const seen = new Set<string>();
  return Object.freeze(input.filter(address => { const id = address.toLowerCase(); if (seen.has(id)) return false; seen.add(id); return true; }));
}
function requireBase(input: unknown): void {
  if (typeof input !== "string" || !/^0x[0-9a-f]{1,16}$/i.test(input)) throw new BrowserWalletError("wallet_invalid_response");
  if (BigInt(input) !== 8453n) throw new BrowserWalletError("wallet_wrong_network");
}
function refusal(error: unknown): BrowserWalletError {
  if (error instanceof BrowserWalletError) return error;
  let code: unknown;
  try { code = (error as { code?: unknown } | null)?.code; } catch { /* No provider error text is used. */ }
  return new BrowserWalletError(code === 4001 ? "wallet_denied" : code === -32002 ? "wallet_request_pending" : "wallet_unavailable");
}

export function createBrowserWalletController(options: {
  isSessionCurrent: () => boolean;
  timeoutMs?: number;
  /** Synthetic EventTarget/provider seam for isolated tests. */
  window?: BrowserWindow;
}): BrowserWalletController {
  const target: BrowserWindow | undefined = options.window ?? (typeof window === "undefined" ? undefined : window);
  const timeoutMs = Math.max(1, Math.min(options.timeoutMs ?? 30_000, 60_000));
  const listeners = new Set<(state: BrowserWalletState) => void>();
  let state: BrowserWalletState = Object.freeze({ wallets: Object.freeze([]), status: "idle", wallet_id: null, accounts: Object.freeze([]), error: null });
  let registry: Registry | null = null, selected: Entry | null = null, generation = 0, opened = false;
  let cancel: ((error: BrowserWalletError) => void) | null = null;
  let selectedListeners: Array<[string, EventListener]> = [];
  const current = () => { try { return options.isSessionCurrent(); } catch { return false; } };
  const publish = (patch: Partial<BrowserWalletState>) => {
    state = Object.freeze({ ...state, ...patch });
    for (const listener of listeners) { try { listener(state); } catch { /* UI subscribers cannot change provider handling. */ } }
  };
  const detach = () => {
    const prior = selected;
    for (const [event, listener] of selectedListeners) { try { prior?.provider.removeListener(event, listener); } catch { /* Best-effort provider cleanup; generation still invalidates callbacks. */ } }
    selectedListeners = []; selected = null;
  };
  const invalidate = (error: BrowserWalletError, show = true) => {
    generation++; cancel?.(error); cancel = null; detach();
    publish({ status: show ? "error" : "idle", wallet_id: null, accounts: Object.freeze([]), error: show ? Object.freeze({ code: error.code, message: error.message }) : null });
  };
  const refresh = () => {
    if (!registry) return;
    const entries = registry.entries.size ? [...registry.entries.values()] : registry.legacy ? [registry.legacy] : [];
    if (selected?.choice.source === "legacy" && registry.entries.size) invalidate(new BrowserWalletError("wallet_changed"));
    publish({ wallets: Object.freeze(entries.map(entry => entry.choice)) });
  };
  const check = (version: number) => {
    if (!current()) throw new BrowserWalletError("wallet_session_ended");
    if (generation !== version) throw new BrowserWalletError("wallet_changed");
  };
  const run = async <T>(version: number, work: (read: (method: "eth_chainId" | "eth_requestAccounts" | "eth_accounts") => Promise<unknown>) => Promise<T>): Promise<T> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const handle = selected?.provider;
    try {
      check(version);
      if (!handle) throw new BrowserWalletError("wallet_unavailable");
      const interrupted = new Promise<never>((_, reject) => {
        cancel = reject;
        timer = setTimeout(() => reject(new BrowserWalletError("wallet_timeout")), timeoutMs);
      });
      const read = async (method: "eth_chainId" | "eth_requestAccounts" | "eth_accounts") => {
        check(version);
        const value = await handle.request(method);
        check(version);
        return value;
      };
      const result = await Promise.race([work(read), interrupted]);
      check(version);
      return result;
    } catch (error) {
      const fixed = refusal(error);
      if (generation === version) invalidate(fixed);
      throw fixed;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      if (generation === version) cancel = null;
    }
  };
  const controller: BrowserWalletController = {
    getState: () => state,
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    discover() {
      if (!current()) { invalidate(new BrowserWalletError("wallet_session_ended")); return; }
      if (!target) { invalidate(new BrowserWalletError("wallet_unavailable")); return; }
      opened = true;
      registry = registryFor(target); registry.subscribers.add(refresh);
      target.dispatchEvent(new Event("eip6963:requestProvider"));
      if (!registry.entries.size && !registry.legacy) {
        let handle: Provider | null = null;
        try { handle = provider(target.ethereum); } catch { /* Legacy injection is untrusted. */ }
        if (handle) registry.legacy = { choice: Object.freeze({ id: "legacy", name: "Browser wallet (legacy)", source: "legacy" }), provider: handle };
      }
      refresh();
    },
    async connect(walletId) {
      if (!opened) throw new BrowserWalletError("wallet_session_ended");
      if (state.status === "requesting") throw new BrowserWalletError("wallet_request_pending");
      invalidate(new BrowserWalletError("wallet_changed"), false);
      const entry = registry?.entries.get(walletId) ?? (walletId === "legacy" && !registry?.entries.size ? registry?.legacy : null);
      if (!entry) { const error = new BrowserWalletError("wallet_unavailable"); invalidate(error); throw error; }
      selected = entry;
      const version = generation;
      let initialPermission = false;
      publish({ status: "requesting", wallet_id: entry.choice.id, error: null });
      try {
        for (const event of EVENTS) {
          const listener = () => {
            // Granting initial access commonly emits accountsChanged before the
            // permission promise resolves. Fresh reads below establish the result.
            if (event === "accountsChanged" && initialPermission) return;
            if (generation === version) invalidate(new BrowserWalletError("wallet_changed"));
          };
          selectedListeners.push([event, listener]); entry.provider.on(event, listener);
          check(version);
        }
      } catch (error) { const fixed = refusal(error); if (generation === version) invalidate(fixed); throw fixed; }
      return run(version, async read => {
        requireBase(await read("eth_chainId"));
        initialPermission = true;
        try { accounts(await read("eth_requestAccounts")); }
        finally { initialPermission = false; }
        const addresses = accounts(await read("eth_accounts"));
        requireBase(await read("eth_chainId"));
        publish({ status: "ready", accounts: addresses });
        return Object.freeze({ wallet_id: entry.choice.id, wallet_name: entry.choice.name, accounts: addresses });
      });
    },
    async confirm(address) {
      if (state.status === "requesting") throw new BrowserWalletError("wallet_request_pending");
      if (!selected || state.status !== "ready" || !state.accounts.includes(address)) throw new BrowserWalletError("wallet_changed");
      const version = generation;
      publish({ status: "requesting" });
      return run(version, async read => {
        requireBase(await read("eth_chainId"));
        const live = accounts(await read("eth_accounts"));
        requireBase(await read("eth_chainId"));
        if (!live.some(value => value.toLowerCase() === address.toLowerCase())) throw new BrowserWalletError("wallet_changed");
        publish({ status: "ready" });
        return { network: "base", address };
      });
    },
    close() {
      opened = false;
      registry?.subscribers.delete(refresh);
      invalidate(new BrowserWalletError("wallet_session_ended"), false);
      publish({ wallets: Object.freeze([]) });
    },
  };
  return controller;
}
