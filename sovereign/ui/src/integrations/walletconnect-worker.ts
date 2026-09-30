import type SignClient from "@walletconnect/sign-client";
import { PHONE_PAIRING_MS, PHONE_RELAY, PhoneMemoryStorage, PhoneWalletError, phoneSessionAddresses,
  publicAddress, validOrigin, validPairingUri, validProjectId, type PhoneWalletErrorCode, type PhoneWorkerEvent } from "./walletconnect-watch-contract";

/** One dedicated realm per explicit pairing. Never import this module in the
 * page: terminating its Worker is the final lifecycle and memory boundary. */
const scope = globalThis as unknown as {
  postMessage(message: PhoneWorkerEvent): void;
  onmessage: ((event: MessageEvent) => void) | null;
  addEventListener(type: string, listener: (event: Event) => void): void;
  location: { origin: string };
  process?: { env: Record<string, string> };
  fetch: typeof fetch;
  XMLHttpRequest: typeof XMLHttpRequest;
  WebSocket: typeof WebSocket;
};
// 2.25.0 has no Core options switch for global sharing. Vite defines the exact
// flag expression; this realm-local shim also satisfies its typeof process
// check. It exists before SDK import and contains no inherited environment.
scope.process = { env: { DISABLE_GLOBAL_CORE: "true" } };
// SDK flags are not a universal telemetry/network guarantee. This worker needs
// only the pinned relay WebSocket; all HTTP transport is explicitly refused.
scope.fetch = async () => { throw new PhoneWalletError("phone_unavailable"); };
scope.XMLHttpRequest = class { constructor() { throw new PhoneWalletError("phone_unavailable"); } } as unknown as typeof XMLHttpRequest;
const NativeWebSocket = scope.WebSocket;
scope.WebSocket = class extends NativeWebSocket {
  constructor(url: string | URL, protocols?: string | string[]) {
    const parsed = new URL(String(url));
    if (parsed.origin !== PHONE_RELAY || parsed.pathname !== "/" || parsed.username || parsed.password || parsed.hash) throw new PhoneWalletError("phone_unavailable");
    super(url, protocols);
    this.addEventListener("message", event => {
      const data = event.data;
      const size = typeof data === "string" ? data.length : data instanceof ArrayBuffer ? data.byteLength : data instanceof Blob ? data.size : Infinity;
      if (size > 2_000_000) { event.stopImmediatePropagation(); this.close(1009, "Message too large"); fail("phone_unavailable"); }
    });
  }
};
// Never let SDK/provider error text, relay query strings, or pairing material
// reach developer-console logs. Outward messages below are fixed projections.
for (const key of ["debug", "error", "info", "log", "trace", "warn", "dir", "table"] as const) console[key] = () => undefined;

const memory = new PhoneMemoryStorage();
let client: SignClient | null = null;
let started = false, closed = false, ready = false;
let deadline = 0, sessionTopic: string | null = null;
let approved: readonly string[] = [];
let expiryTimer: ReturnType<typeof setTimeout> | undefined;
const send = (message: PhoneWorkerEvent) => { if (!closed) scope.postMessage(message); };
const fixed = (error: unknown): PhoneWalletErrorCode => {
  if (error instanceof PhoneWalletError) return error.code;
  let code: unknown;
  try { code = (error as { code?: unknown } | null)?.code; } catch { /* No raw provider values leave the worker. */ }
  return code === 4001 || code === 5000 ? "phone_declined" : "phone_unavailable";
};
const requireLive = () => {
  if (closed) throw new PhoneWalletError("phone_session_ended");
  if (Date.now() >= deadline) throw new PhoneWalletError("phone_expired");
};
const setDeadline = (expiry: number) => {
  deadline = Math.min(deadline, expiry);
  clearTimeout(expiryTimer);
  expiryTimer = setTimeout(() => fail("phone_expired"), Math.max(0, deadline - Date.now()));
  return new Date(deadline).toISOString();
};
async function close() {
  if (closed) return;
  closed = true; ready = false; approved = []; clearTimeout(expiryTimer);
  try {
    if (client) {
      const topics = [...client.session.keys, ...client.core.pairing.pairings.keys];
      await Promise.race([
        Promise.allSettled(topics.map(topic => client!.disconnect({ topic, reason: { code: 6000, message: "Address selection closed" } }))),
        new Promise(resolve => setTimeout(resolve, 500)),
      ]);
      await Promise.race([client.core.relayer.transportClose().catch(() => undefined), new Promise(resolve => setTimeout(resolve, 100))]);
    }
  } catch { /* Remote cleanup is best effort, not proof of remote revocation. */ }
  memory.clear(); sessionTopic = null; client = null;
  scope.postMessage({ type: "closed" });
}
function fail(code: PhoneWalletErrorCode) {
  if (closed) return;
  send({ type: "error", code });
  void close();
}
scope.addEventListener("unhandledrejection", event => { event.preventDefault(); fail("phone_unavailable"); });
scope.addEventListener("error", event => { event.preventDefault(); fail("phone_unavailable"); });

async function start(projectId: unknown, origin: unknown) {
  if (started || !validProjectId(projectId) || !validOrigin(origin) || origin !== scope.location.origin) throw new PhoneWalletError("phone_invalid_configuration");
  started = true; deadline = Date.now() + PHONE_PAIRING_MS; setDeadline(deadline);
  const [{ Core }, { default: SignClient }] = await Promise.all([import("@walletconnect/core"), import("@walletconnect/sign-client")]);
  requireLive();
  const core = new Core({ projectId, relayUrl: PHONE_RELAY, storage: memory, telemetryEnabled: false, logger: "silent" });
  const initialized = await SignClient.init({ core, logger: "silent", metadata: {
    name: "CashLoom local workspace", description: "Share a Base address to watch ETH and native USDC. No signing or sending.", url: origin, icons: [],
  } });
  requireLive(); client = initialized;
  // With one fresh client, any wallet/session mutation invalidates the picker.
  // The UI never automatically adopts a changed chain/account or broader scope.
  for (const event of ["session_update", "session_extend", "session_event", "session_delete", "session_expire", "proposal_expire"] as const) {
    client.on(event, () => fail(event === "session_expire" || event === "proposal_expire" ? "phone_expired" : "phone_changed"));
  }
  client.core.relayer.on("relayer_disconnect", () => { if (ready) fail("phone_changed"); });
  const connection = await client.connect({ optionalNamespaces: {
    eip155: { chains: ["eip155:8453"], methods: [], events: ["accountsChanged", "chainChanged"] },
  } });
  requireLive();
  if (!validPairingUri(connection.uri)) throw new PhoneWalletError("phone_unavailable");
  const uriExpiry = new URL(connection.uri).searchParams.get("expiryTimestamp");
  if (uriExpiry !== null) setDeadline(Number(uriExpiry) * 1000);
  requireLive();
  send({ type: "pairing", uri: connection.uri, expires_at: new Date(deadline).toISOString() });
  const session = await connection.approval();
  requireLive();
  const view = phoneSessionAddresses(session);
  const current = phoneSessionAddresses(client.session.get(session.topic));
  if (JSON.stringify(view.accounts) !== JSON.stringify(current.accounts)) throw new PhoneWalletError("phone_changed");
  sessionTopic = session.topic; approved = current.accounts; ready = true;
  send({ type: "ready", accounts: approved, expires_at: setDeadline(current.expiry) });
}
function confirm(requestId: unknown, address: unknown) {
  requireLive();
  if (!ready || !client || !sessionTopic || !Number.isSafeInteger(requestId) || typeof requestId !== "number" || requestId < 1 ||
    !publicAddress(address) || !approved.includes(address)) throw new PhoneWalletError("phone_changed");
  // No session RPC methods were granted. Recheck the current SDK session and
  // its expiry instead of introducing eth_accounts/signing permission later.
  const current = phoneSessionAddresses(client.session.get(sessionTopic));
  if (JSON.stringify(current.accounts) !== JSON.stringify(approved)) throw new PhoneWalletError("phone_changed");
  send({ type: "confirmed", request_id: requestId, address });
}
scope.onmessage = event => {
  const message = event.data;
  if (message?.type === "close") { void close(); return; }
  if (closed) return;
  if (message?.type === "start") void start(message.project_id, message.origin).catch(error => fail(fixed(error)));
  else if (message?.type === "confirm") { try { confirm(message.request_id, message.address); } catch (error) { fail(fixed(error)); } }
  else fail("phone_unavailable");
};
