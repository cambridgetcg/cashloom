import { PHONE_PAIRING_MS, PhoneWalletError, isPhoneErrorCode, publicAddress, validOrigin, validPairingUri, validProjectId,
  type PhoneWalletErrorCode, type PhoneWorkerCommand } from "./walletconnect-watch-contract";
export { PhoneWalletError } from "./walletconnect-watch-contract";
export interface PhoneWalletState {
  readonly status: "idle" | "starting" | "pairing" | "ready" | "confirming" | "error";
  readonly uri: string | null;
  readonly expires_at: string | null;
  readonly accounts: readonly string[];
  readonly error: Readonly<{ code: PhoneWalletErrorCode; message: string }> | null;
}
export interface PhoneWalletWorker {
  postMessage(message: PhoneWorkerCommand): void;
  terminate(): void;
  onmessage: ((event: MessageEvent) => void) | null;
  onerror: ((event: ErrorEvent) => void) | null;
}
export interface PhoneWalletController {
  getState(): PhoneWalletState;
  subscribe(listener: (state: PhoneWalletState) => void): () => void;
  start(): Promise<void>;
  confirm(address: string): Promise<{ network: "base"; address: string }>;
  close(options?: { immediate?: boolean }): void;
}
const empty = (): PhoneWalletState => Object.freeze({ status: "idle", uri: null, expires_at: null, accounts: Object.freeze([]), error: null });
export function createPhoneWalletController(options: {
  projectId: string;
  origin: string;
  isSessionCurrent(): boolean;
  workerFactory?: () => PhoneWalletWorker;
  /** Shorter bounded deadlines for synthetic tests. */
  startupTimeoutMs?: number;
  confirmationTimeoutMs?: number;
  closeTimeoutMs?: number;
}): PhoneWalletController {
  let state = empty(), worker: PhoneWalletWorker | null = null, generation = 0, deadline = 0, requestId = 0;
  let expiryTimer: ReturnType<typeof setTimeout> | undefined, operationTimer: ReturnType<typeof setTimeout> | undefined;
  let starting: { resolve(): void; reject(error: PhoneWalletError): void } | null = null;
  let confirming: { id: number; address: string; resolve(value: { network: "base"; address: string }): void; reject(error: PhoneWalletError): void } | null = null;
  const listeners = new Set<(state: PhoneWalletState) => void>();
  const current = () => { try { return options.isSessionCurrent(); } catch { return false; } };
  const publish = (next: PhoneWalletState) => {
    state = Object.freeze(next);
    for (const listener of listeners) { try { listener(state); } catch { /* Listener errors never expose SDK state. */ } }
  };
  const endWorker = (immediate = false) => {
    const prior = worker; worker = null;
    if (!prior) return;
    if (immediate) {
      prior.onmessage = null; prior.onerror = null;
      try { prior.postMessage({ type: "close" }); } catch { /* Terminate regardless. */ }
      prior.terminate();
      return;
    }
    // The local stop is unconditional. Relay notification is only best effort.
    const timeout = setTimeout(() => { prior.onmessage = null; prior.onerror = null; prior.terminate(); }, Math.max(0, Math.min(options.closeTimeoutMs ?? 750, 1000)));
    prior.onerror = event => { event.preventDefault?.(); };
    prior.onmessage = event => {
      if (event.data?.type === "closed") { clearTimeout(timeout); prior.onmessage = null; prior.onerror = null; prior.terminate(); }
    };
    try { prior.postMessage({ type: "close" }); } catch { clearTimeout(timeout); prior.onmessage = null; prior.onerror = null; prior.terminate(); }
  };
  const stop = (code: PhoneWalletErrorCode, showError: boolean, immediate = false) => {
    generation++; clearTimeout(operationTimer); clearTimeout(expiryTimer);
    const error = new PhoneWalletError(code);
    starting?.reject(error); confirming?.reject(error); starting = null; confirming = null;
    endWorker(immediate);
    publish(showError ? { ...empty(), status: "error", error: Object.freeze({ code, message: error.message }) } : empty());
  };
  const expires = (value: unknown): string => {
    const parsed = typeof value === "string" ? Date.parse(value) : NaN;
    if (!Number.isFinite(parsed) || parsed <= Date.now()) throw new PhoneWalletError("phone_expired");
    deadline = Math.min(deadline, parsed);
    clearTimeout(expiryTimer);
    expiryTimer = setTimeout(() => stop("phone_expired", true), Math.max(0, deadline - Date.now()));
    return new Date(deadline).toISOString();
  };
  const onMessage = (version: number, event: MessageEvent) => {
    if (version !== generation || !worker) return;
    if (!current()) { stop("phone_session_ended", true); return; }
    try {
      const message = event.data;
      if (!message || typeof message !== "object") throw new PhoneWalletError("phone_unavailable");
      if (message.type === "error") { stop(isPhoneErrorCode(message.code) ? message.code : "phone_unavailable", true); return; }
      if (message.type === "pairing" && state.status === "starting") {
        if (!validPairingUri(message.uri)) throw new PhoneWalletError("phone_unavailable");
        const expiry = expires(message.expires_at);
        clearTimeout(operationTimer);
        publish({ ...empty(), status: "pairing", uri: message.uri, expires_at: expiry });
        starting?.resolve(); starting = null;
      } else if (message.type === "ready" && ["starting", "pairing"].includes(state.status)) {
        if (!Array.isArray(message.accounts) || message.accounts.length < 1 || message.accounts.length > 20 ||
          !message.accounts.every(publicAddress) || new Set(message.accounts.map((address: string) => address.toLowerCase())).size !== message.accounts.length) throw new PhoneWalletError("phone_scope_refused");
        const expiry = expires(message.expires_at);
        clearTimeout(operationTimer);
        publish({ ...empty(), status: "ready", expires_at: expiry, accounts: Object.freeze([...message.accounts]) });
        starting?.resolve(); starting = null;
      } else if (message.type === "confirmed" && state.status === "confirming" && confirming &&
        message.request_id === confirming.id && message.address === confirming.address && state.accounts.includes(message.address)) {
        if (Date.now() >= deadline) throw new PhoneWalletError("phone_expired");
        clearTimeout(operationTimer);
        const pending = confirming; confirming = null;
        publish({ ...state, status: "ready" });
        pending.resolve({ network: "base", address: message.address });
      } else throw new PhoneWalletError("phone_changed");
    } catch (error) { stop(error instanceof PhoneWalletError ? error.code : "phone_unavailable", true); }
  };
  return {
    getState: () => state,
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    async start() {
      if (worker) throw new PhoneWalletError("phone_changed");
      if (!current()) throw new PhoneWalletError("phone_session_ended");
      if (!validProjectId(options.projectId) || !validOrigin(options.origin)) throw new PhoneWalletError("phone_invalid_configuration");
      const version = ++generation;
      deadline = Date.now() + PHONE_PAIRING_MS;
      publish({ ...empty(), status: "starting" });
      try { worker = options.workerFactory ? options.workerFactory() : new Worker(new URL("./walletconnect-worker.ts", import.meta.url), { type: "module" }); }
      catch { stop("phone_unavailable", true); throw new PhoneWalletError("phone_unavailable"); }
      worker.onmessage = event => onMessage(version, event);
      worker.onerror = event => { event.preventDefault?.(); if (version === generation) stop("phone_unavailable", true); };
      const pending = new Promise<void>((resolve, reject) => { starting = { resolve, reject }; });
      operationTimer = setTimeout(() => { if (version === generation) stop("phone_timeout", true); }, Math.max(1, Math.min(options.startupTimeoutMs ?? 30_000, 30_000)));
      try { worker.postMessage({ type: "start", project_id: options.projectId, origin: options.origin }); }
      catch { stop("phone_unavailable", true); }
      return pending;
    },
    async confirm(address) {
      if (!current()) { stop("phone_session_ended", true); throw new PhoneWalletError("phone_session_ended"); }
      if (!worker || state.status !== "ready" || !state.accounts.includes(address)) throw new PhoneWalletError("phone_changed");
      if (Date.now() >= deadline) { stop("phone_expired", true); throw new PhoneWalletError("phone_expired"); }
      const version = generation, id = ++requestId;
      publish({ ...state, status: "confirming" });
      const pending = new Promise<{ network: "base"; address: string }>((resolve, reject) => { confirming = { id, address, resolve, reject }; });
      operationTimer = setTimeout(() => { if (version === generation) stop("phone_timeout", true); }, Math.max(1, Math.min(options.confirmationTimeoutMs ?? 5000, 5000)));
      try { worker.postMessage({ type: "confirm", request_id: id, address }); } catch { stop("phone_unavailable", true); }
      return pending;
    },
    close(options) { stop("phone_session_ended", false, options?.immediate === true); },
  };
}
