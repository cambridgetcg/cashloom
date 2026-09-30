/** Offline browser fixture only. Runs the production worker and actual pinned
 * SDK, replacing relay publication and remote approval. Never imported by app. */
import type SignClient from "@walletconnect/sign-client";
import { PhoneMemoryStorage } from "../src/integrations/walletconnect-watch-contract";

const scope = globalThis as any;
let mode = "valid", active: SignClient | null = null, published = 0, disconnects = 0;
let underlyingFetches = 0, underlyingSockets = 0;
let approvalResolve: ((value: unknown) => void) | undefined;
const report = (value: Record<string, unknown>) => scope.postMessage({ type: "fixture_report", ...value });
scope.fetch = async () => { underlyingFetches++; throw Error("Fixture refuses HTTP"); };
scope.WebSocket = class extends EventTarget {
  static CONNECTING = 0; static OPEN = 1; static CLOSING = 2; static CLOSED = 3;
  readyState = 1;
  constructor() { super(); underlyingSockets++; }
  close() { this.readyState = 3; }
};
scope.addEventListener("message", (event: MessageEvent) => {
  const message = event.data;
  if (!message?.type?.startsWith("fixture_")) return;
  event.stopImmediatePropagation();
  if (message.type === "fixture_mode") mode = message.mode;
  if (message.type === "fixture_event") active?.events.emit(message.event, { topic: "fixture-session", id: 1, params: { namespaces: {} } } as never);
  if (message.type === "fixture_release") approvalResolve?.(active?.session.get("fixture-session"));
});
const actualPost = scope.postMessage.bind(scope);
scope.postMessage = (message: any) => {
  if (message.type === "closed" && active) {
    void active.core.storage.getKeys().then(keys => { actualPost({ type: "fixture_report", memoryKeysAfterClose: keys.length }); actualPost(message); });
  } else actualPost(message);
};
// Install the production boundary first, exactly as the real entry does before
// loading SDK modules. Only then replace transport/remote approval for testing.
await import("../src/integrations/walletconnect-worker");
const { default: ActualSignClient } = await import("@walletconnect/sign-client");
const actualInit = ActualSignClient.init.bind(ActualSignClient);
ActualSignClient.init = async options => {
  const client = await actualInit(options);
  active = client;
  // Override this initialized instance's transport, never the production worker
  // or SDK validation/crypto/proposal construction path.
  client.core.relayer.publishCustom = async () => { published++; };
  client.core.relayer.subscribe = async () => "fixture-subscription";
  let httpBlocked = false, foreignSocketBlocked = false, relayAllowed = false;
  try { await fetch("https://pulse.walletconnect.org/e"); } catch { httpBlocked = true; }
  try { new WebSocket("wss://not-the-relay.invalid/"); } catch { foreignSocketBlocked = true; }
  const relay = new WebSocket("wss://relay.walletconnect.org/"); relayAllowed = relay.readyState === WebSocket.OPEN; relay.close();
  // Assert the flag actually disables the SDK global cache in the Vite output.
  report({ initialized: true, httpBlocked, foreignSocketBlocked, relayAllowed, underlyingFetches,
    underlyingSockets, globalCoreKeys: Object.keys(scope).filter(key => key.startsWith("_walletConnectCore_")).length,
    telemetryFlag: client.core.eventClient.telemetryEnabled, memoryStorage: client.core.storage instanceof PhoneMemoryStorage,
    restoredSessions: client.session.length, metadataOriginMatches: client.metadata.url === scope.location.origin });
  const actualConnect = client.connect.bind(client);
  client.connect = async parameters => {
    const connection = await actualConnect(parameters);
    const proposal = client.proposal.getAll()[0]!;
    report({ proposedMethods: proposal.optionalNamespaces.eip155?.methods, proposedChains: proposal.optionalNamespaces.eip155?.chains,
      requiredNamespaceCount: Object.keys(proposal.requiredNamespaces).length, published });
    const address = `0x${"1".repeat(40)}`;
    const session = {
      topic: "fixture-session", expiry: Math.floor(Date.now() / 1000) + 300, acknowledged: true,
      namespaces: { eip155: { chains: ["eip155:8453"], methods: mode === "extra" ? ["personal_sign"] : [],
        events: ["accountsChanged", "chainChanged"], accounts: [`eip155:8453:${address}`] } },
    } as any;
    await client.session.set(session.topic, session);
    let uri = connection.uri;
    if (mode === "uri_expired") uri = uri?.replace(/expiryTimestamp=\d+/, "expiryTimestamp=1");
    return { uri, approval: mode === "late" ? () => new Promise(resolve => { approvalResolve = resolve; }) : async () => session };
  };
  client.disconnect = async () => { disconnects++; report({ disconnects }); };
  return client;
};
report({ prepared: true });
