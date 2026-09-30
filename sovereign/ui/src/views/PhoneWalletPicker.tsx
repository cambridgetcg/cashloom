import { useEffect, useRef, useState } from "react";
import { api, currentSessionGuard, type WalletConnectSetup } from "../api";
import { createPhoneWalletController } from "../integrations/walletconnect-watch";

type Controller = ReturnType<typeof createPhoneWalletController>;
export type PhoneWalletPickerState = ReturnType<Controller["getState"]>;
const EMPTY_STATE: PhoneWalletPickerState = { status: "idle", uri: null, expires_at: null, accounts: [], error: null };

export function phoneSetupReady(setup: WalletConnectSetup | null): setup is Extract<WalletConnectSetup, { state: "ready" }> {
  return setup?.state === "ready" && typeof setup.project_id === "string" && /^[a-f0-9]{32}$/i.test(setup.project_id);
}

export function phoneCanUseAddress(state: PhoneWalletPickerState, address: string | null, now = Date.now()): address is string {
  return state.status === "ready" && address !== null && state.accounts.includes(address) &&
    state.expires_at !== null && Date.parse(state.expires_at) > now;
}

/** The pairing secret becomes local pixels only: no image URL, text or DOM attribute. */
function PairingQrCode({ uri }: { uri: string }) {
  const canvas = useRef<HTMLCanvasElement | null>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  useEffect(() => {
    let active = true;
    const target = canvas.current;
    const clear = () => {
      active = false;
      if (target) { target.width = 0; target.height = 0; }
    };
    window.addEventListener("pagehide", clear);
    setStatus("loading");
    void (async () => {
      try {
        const { toCanvas } = await import("qrcode");
        if (!active || !target) return;
        await toCanvas(target, uri, { width: 320, margin: 4, errorCorrectionLevel: "M" });
        if (active) setStatus("ready");
      } catch { if (active) setStatus("error"); }
    })();
    return () => {
      window.removeEventListener("pagehide", clear);
      clear();
    };
  }, [uri]);
  return <div className="phone-wallet-qr">
    <canvas ref={canvas} role="img" aria-label="Wallet pairing QR code" hidden={status !== "ready"} />
    {status === "loading" && <p role="status">Preparing the QR code on this device…</p>}
    {status === "error" && <p role="alert">The QR code could not be displayed. You can copy the pairing link instead.</p>}
  </div>;
}

export function PhoneWalletPickerView({ setup, setupError, state, selectedAddress, busy, disabled, notice, onStart, onSelect, onConfirm, onCopy, onRetrySetup, onClose }: {
  setup: WalletConnectSetup | null; setupError: string | null; state: PhoneWalletPickerState;
  selectedAddress: string | null; busy: boolean; disabled: boolean; notice: string | null;
  onStart(): void; onSelect(address: string): void; onConfirm(): void; onCopy(): void; onRetrySetup(): void; onClose(): void;
}) {
  const configured = phoneSetupReady(setup);
  const pairing = state.status === "pairing" && state.uri !== null;
  return <section className="browser-wallet-picker phone-wallet-picker" aria-label="Phone wallet pairing" aria-busy={state.status === "starting" || state.status === "confirming"}>
    <h4>Connect a phone wallet</h4>
    <p>Starting pairing contacts the external Reown relay, which receives your IP address and protocol metadata. Your wallet shares approved Base addresses with this workspace. This flow requests no signature or payment and does not switch networks.</p>
    <p className="journey-note">Use your wallet’s WalletConnect scanner. After approving on your phone, return here to choose an address. Your wallet may contact its own providers.</p>
    {setup === null && !setupError && <p role="status">Checking local pairing setup…</p>}
    {setupError && <p className="form-error" role="alert">{setupError}</p>}
    {setup && !configured && <div className="phone-wallet-setup" role="status">
      <p>{setup.state === "not_configured" ? "Phone wallet pairing is not configured on this node." : "Phone wallet pairing configuration needs attention."}</p>
      <p>The node operator must set <code>CASHLOOM_WALLETCONNECT_PROJECT_ID</code> in the node’s scoped environment and restart it. You can still paste a public address or choose a browser wallet.</p>
    </div>}
    {state.status === "starting" && <p role="status">Starting pairing… You can cancel while the relay connects.</p>}
    {pairing && <>
      <PairingQrCode uri={state.uri!} />
      <p>Scan this code in your phone wallet and approve sharing Base addresses. Keep the pairing code and link private.</p>
      {state.expires_at && <p className="journey-note">Pairing expires <time dateTime={state.expires_at}>{new Date(state.expires_at).toLocaleTimeString()}</time>. A new pairing always needs another click.</p>}
      <button type="button" className="btn btn-ghost" disabled={disabled} onClick={onCopy}>Copy pairing link</button>
      <p className="watch-wallet-limit">Only paste this link into your wallet. Your clipboard may retain it after pairing ends.</p>
    </>}
    {state.status === "ready" && state.accounts.length > 0 && <fieldset className="browser-wallet-addresses" disabled={disabled || busy}>
      <legend>Choose one public address on Base</legend>
      {state.accounts.map(address => <label className="browser-wallet-address" key={address}>
        <input type="radio" name="phone-wallet-address" value={address} checked={selectedAddress === address} onChange={() => onSelect(address)} />
        <code>{address}</code>
      </label>)}
    </fieldset>}
    {state.status === "confirming" && <p role="status">Checking the approved address before copying it…</p>}
    {state.error && <p className="form-error" role="alert">{state.error.message}</p>}
    {notice && <p className="journey-note" role="status">{notice}</p>}
    <div className="btn-row">
      {configured && ["idle", "error"].includes(state.status) && <button type="button" className="btn btn-primary" disabled={disabled || busy} onClick={onStart}>{state.status === "error" ? "Start new pairing" : "Start pairing"}</button>}
      {state.status === "ready" && <button type="button" className="btn btn-primary" disabled={disabled || busy || !phoneCanUseAddress(state, selectedAddress)} onClick={onConfirm}>Use this address</button>}
      {(setupError || setup && !configured) && <button type="button" className="btn btn-ghost" disabled={disabled} onClick={onRetrySetup}>Retry setup check</button>}
      <button type="button" className="link-btn" onClick={onClose}>Cancel pairing</button>
    </div>
    <p className="watch-wallet-limit">Using an address or cancelling ends this local pairing. We try to notify your wallet; remove any remaining connection in its settings. This does not remove a saved watched account.</p>
  </section>;
}

export function PhoneWalletPicker({ disabled = false, onBusyChange, onAddress, onClose }: {
  disabled?: boolean; onBusyChange(busy: boolean): void; onAddress(address: string): void; onClose(): void;
}) {
  const [setup, setSetup] = useState<WalletConnectSetup | null>(null);
  const [setupError, setSetupError] = useState<string | null>(null);
  const [state, setState] = useState<PhoneWalletPickerState>(EMPTY_STATE);
  const [selectedAddress, setSelectedAddress] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const alive = useRef(false), pending = useRef(false), reportedBusy = useRef(false), enabled = useRef(!disabled);
  const controller = useRef<Controller | null>(null);
  const unsubscribe = useRef<(() => void) | null>(null);
  const setupGeneration = useRef(0);
  const callbacks = useRef({ onBusyChange, onAddress, onClose });
  enabled.current = !disabled;
  callbacks.current = { onBusyChange, onAddress, onClose };

  function reportBusy(value: boolean) {
    if (reportedBusy.current === value) return;
    reportedBusy.current = value; callbacks.current.onBusyChange(value);
  }
  function stopController(immediate = false) {
    unsubscribe.current?.(); unsubscribe.current = null;
    controller.current?.close({ immediate }); controller.current = null;
  }
  async function loadSetup() {
    const generation = ++setupGeneration.current;
    const session = currentSessionGuard();
    if (!alive.current || !enabled.current || !session()) return;
    setSetup(null); setSetupError(null);
    try {
      const result = await api.walletConnectSetup();
      if (!alive.current || !session() || generation !== setupGeneration.current) return;
      if (!result || !["ready", "not_configured", "invalid_configuration"].includes(result.state)) throw new Error();
      setSetup(result);
    } catch {
      if (alive.current && session() && generation === setupGeneration.current) setSetupError("The node’s pairing setup could not be checked. Retry or paste a public address.");
    }
  }
  useEffect(() => {
    alive.current = true; void loadSetup();
    const leavePage = () => {
      // A page can enter the back-forward cache without React unmounting.
      // End this selection before it can be restored as a live connection.
      alive.current = false; setupGeneration.current++;
      stopController(true); reportBusy(false);
      setState(EMPTY_STATE); setSelectedAddress(null); setNotice(null); setBusy(false);
      callbacks.current.onClose();
    };
    window.addEventListener("pagehide", leavePage);
    return () => {
      alive.current = false; setupGeneration.current++;
      window.removeEventListener("pagehide", leavePage);
      stopController(); reportBusy(false);
    };
  }, []);

  async function start() {
    const session = currentSessionGuard();
    if (!alive.current || !enabled.current || !session() || pending.current || !phoneSetupReady(setup) || !["idle", "error"].includes(state.status)) return;
    pending.current = true; setBusy(true); setNotice(null); setSelectedAddress(null); reportBusy(true); stopController();
    const instance = createPhoneWalletController({ projectId: setup.project_id, origin: window.location.origin, isSessionCurrent: () => alive.current && enabled.current && session() });
    controller.current = instance;
    unsubscribe.current = instance.subscribe(next => {
      if (!alive.current || !session() || controller.current !== instance) return;
      setState(next);
      setSelectedAddress(null);
      if (next.status !== "pairing") setNotice(null);
      reportBusy(["starting", "pairing", "confirming"].includes(next.status));
    });
    setState(instance.getState());
    try { await instance.start(); }
    catch {
      if (alive.current && session() && controller.current === instance && instance.getState().error === null) setNotice("Phone pairing could not start. Cancel and try again, or paste a public address.");
    } finally {
      pending.current = false;
      if (alive.current && session()) {
        setBusy(false);
        if (controller.current === instance) reportBusy(["starting", "pairing", "confirming"].includes(instance.getState().status));
      }
    }
  }
  async function confirm() {
    const instance = controller.current;
    const address = selectedAddress;
    const session = currentSessionGuard();
    if (!alive.current || !enabled.current || !session() || pending.current || !instance || !phoneCanUseAddress(instance.getState(), address)) return;
    pending.current = true; setBusy(true); setNotice(null); reportBusy(true);
    try {
      const result = await instance.confirm(address);
      if (!alive.current || !enabled.current || !session() || controller.current !== instance || !phoneCanUseAddress(instance.getState(), result.address)) return;
      stopController(); callbacks.current.onAddress(result.address);
    } catch {
      if (alive.current && session() && controller.current === instance && instance.getState().error === null) setNotice("The approved address could not be confirmed. Start a new pairing.");
    } finally {
      pending.current = false;
      if (alive.current && session()) { setBusy(false); reportBusy(false); }
    }
  }
  async function copyPairingLink() {
    const instance = controller.current;
    const snapshot = instance?.getState();
    const session = currentSessionGuard();
    if (!instance || !alive.current || !enabled.current || !session() || snapshot?.status !== "pairing" || !snapshot.uri || !snapshot.expires_at || Date.parse(snapshot.expires_at) <= Date.now()) return;
    try {
      await navigator.clipboard.writeText(snapshot.uri);
      if (alive.current && session() && controller.current === instance && instance.getState().uri === snapshot.uri) setNotice("Pairing link copied. Your clipboard may retain it after pairing ends.");
    } catch {
      if (alive.current && session() && controller.current === instance && instance.getState().uri === snapshot.uri) setNotice("Clipboard copying is unavailable. Scan the QR code from another device.");
    }
  }

  return <PhoneWalletPickerView setup={setup} setupError={setupError} state={state} selectedAddress={selectedAddress} busy={busy} disabled={disabled} notice={notice}
    onStart={() => void start()} onSelect={setSelectedAddress} onConfirm={() => void confirm()} onCopy={() => void copyPairingLink()}
    onRetrySetup={() => void loadSetup()} onClose={() => { stopController(); onClose(); }} />;
}
